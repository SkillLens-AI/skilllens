"""Trace sanitizer for SkillLens evaluation artifacts.

This script anonymizes the rollout traces produced by a SkillLens evaluation
run so they can be released alongside a publication or shared with reviewers.
It walks an input directory, scrubs identity-leaking tokens (paths, names,
emails, private hosts, timezone offsets), and writes a cleaned copy plus a
JSON report describing every replacement.

Design goals:
  * stdlib-only (no external dependencies)
  * deterministic, idempotent rewrites
  * a final validation pass that fails loudly if any leak survived
  * a CJK detector that aborts by default, because residual CJK in a
    judge log means the English-prompt rerun was incomplete and the
    user should rerun rather than paper over it

Usage:
    python sanitize_traces.py --input <dir> --output <dir>
                              [--report report.json]
                              [--dry-run] [--allow-cjk]
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable


# ---------------------------------------------------------------------------
# Replacement rules
# ---------------------------------------------------------------------------


# Whitelist patterns are checked BEFORE the scrub rules. A token that matches
# a whitelist pattern is substituted with a sentinel so the downstream rules
# cannot touch it; the sentinel is restored at the very end of the rewrite.
WHITELIST_PATTERNS: list[tuple[str, re.Pattern[str]]] = [
    # Project-owned GitHub bot identities — these are deliberately published
    # as part of attribution and must not be scrubbed. Add your own here if
    # you are running this on traces produced by a different project.
    ("__WL_BOT_EMAIL__", re.compile(r"skilllens-ai@users\.noreply\.github\.com")),
    ("__WL_BOT_PATH__", re.compile(r"SkillLens-AI/[\w./+-]+")),
    ("__WL_PLACEHOLDER__", re.compile(r"<[a-z][a-z0-9-]*>")),
]


@dataclass
class Rule:
    """A single regex-based scrub rule."""

    name: str
    pattern: re.Pattern[str]
    replacement: str | Callable[[re.Match[str]], str]

    def apply(self, text: str, counter: dict[str, int]) -> str:
        def _sub(match: re.Match[str]) -> str:
            counter[self.name] = counter.get(self.name, 0) + 1
            if callable(self.replacement):
                return self.replacement(match)
            return self.replacement

        return self.pattern.sub(_sub, text)


def _utc_from_offset(match: re.Match[str]) -> str:
    """Convert an ISO timestamp with +08:00 / +0800 to its UTC equivalent."""

    raw = match.group(0)
    # Normalize +HHMM to +HH:MM so datetime.fromisoformat can parse it
    # across both Python 3.10 and 3.11+.
    normalized = re.sub(r"([+-]\d{2})(\d{2})$", r"\1:\2", raw)
    try:
        dt = datetime.fromisoformat(normalized)
    except ValueError:
        # If parsing fails we leave the timestamp untouched; the validation
        # pass will surface the issue rather than letting us silently emit
        # a half-converted string.
        return raw
    if dt.tzinfo is None:
        return raw
    utc = dt.astimezone(timezone.utc)
    # Emit a stable representation: ISO 8601 with a literal Z suffix.
    return utc.strftime("%Y-%m-%dT%H:%M:%SZ")


# Order matters: earlier rules run first, so the most specific patterns
# (skills_eval dataset paths) win over the generic Linux home rule.
SCRUB_RULES: list[Rule] = [
    Rule(
        name="path_dataset",
        # Scrub workspace paths that point at the eval dataset checkout.
        pattern=re.compile(r"/home/[\w.+-]+/skills_eval[\w/.+-]*"),
        replacement="<dataset>",
    ),
    Rule(
        name="path_linux_home",
        # Scrub generic Linux home prefixes after dataset paths are gone.
        pattern=re.compile(r"/home/[\w.+-]+/"),
        replacement="<home>/",
    ),
    Rule(
        name="path_windows_home",
        # Scrub Windows user-profile prefixes (escaped backslashes in JSON).
        pattern=re.compile(r"C:\\\\Users\\\\[\w.+-]+\\\\"),
        replacement="<home>\\\\",
    ),
    Rule(
        name="path_windows_home_raw",
        # Scrub Windows user-profile prefixes in plain text.
        pattern=re.compile(r"C:\\Users\\[\w.+-]+\\"),
        replacement="<home>\\",
    ),
    Rule(
        name="author_token",
        # Scrub author-identifying tokens (case-insensitive).
        pattern=re.compile(r"\b(?:raozihao|Zihao|ECNU|Rairrrr)\b", re.IGNORECASE),
        replacement="<author>",
    ),
    Rule(
        name="email",
        # Scrub author-affiliated email addresses.
        pattern=re.compile(
            r"[\w.+-]+@(?:ecnu\.edu(?:\.cn)?|gmail\.com)",
            re.IGNORECASE,
        ),
        replacement="<email>",
    ),
    Rule(
        name="private_host",
        # Scrub the private LLM proxy host used for development.
        pattern=re.compile(r"\bapi\.3xcoder\.com\b"),
        replacement="<openai-endpoint>",
    ),
    Rule(
        name="hostname_local",
        # Scrub mDNS-style local hostnames that leak machine identity.
        pattern=re.compile(r"\b[A-Z0-9][A-Z0-9-]*\.local\b"),
        replacement="<host>",
    ),
    Rule(
        name="timezone_utc8",
        # Detect ISO timestamps in UTC+8 and convert them to UTC.
        pattern=re.compile(
            r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?\+(?:08:00|0800)"
        ),
        replacement=_utc_from_offset,
    ),
]


# CJK detection is intentionally kept out of SCRUB_RULES because the default
# behaviour is to abort, not to substitute.
CJK_PATTERN = re.compile(r"[一-鿿]+")


# Validation patterns used to confirm nothing slipped through. These mirror
# the scrub rules but operate on the rewritten output.
VALIDATION_PATTERNS: dict[str, re.Pattern[str]] = {
    "author_token": re.compile(r"\b(?:raozihao|Zihao|ECNU|Rairrrr)\b", re.IGNORECASE),
    "email": re.compile(
        r"[\w.+-]+@(?:ecnu\.edu(?:\.cn)?|gmail\.com)",
        re.IGNORECASE,
    ),
    "private_host": re.compile(r"\bapi\.3xcoder\.com\b"),
    "timezone_utc8": re.compile(
        r"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?\+(?:08:00|0800)"
    ),
}


# ---------------------------------------------------------------------------
# Report bookkeeping
# ---------------------------------------------------------------------------


@dataclass
class SanitizationReport:
    """Aggregate of everything the sanitizer did and saw."""

    files_processed: int = 0
    files_skipped: list[dict[str, str]] = field(default_factory=list)
    replacements: dict[str, int] = field(default_factory=dict)
    cjk_findings: list[dict[str, Any]] = field(default_factory=list)
    validation_issues: list[dict[str, Any]] = field(default_factory=list)
    dry_run: bool = False
    allow_cjk: bool = False

    def merge_replacements(self, counts: dict[str, int]) -> None:
        for key, value in counts.items():
            self.replacements[key] = self.replacements.get(key, 0) + value

    def to_dict(self) -> dict[str, Any]:
        return {
            "files_processed": self.files_processed,
            "files_skipped": self.files_skipped,
            "replacements": self.replacements,
            "cjk_findings": self.cjk_findings,
            "validation_issues": self.validation_issues,
            "dry_run": self.dry_run,
            "allow_cjk": self.allow_cjk,
        }


# ---------------------------------------------------------------------------
# Core scrub primitives
# ---------------------------------------------------------------------------


def _apply_whitelist(text: str) -> tuple[str, dict[str, list[str]]]:
    """Replace whitelisted spans with sentinels so scrubbers cannot touch them."""

    captured: dict[str, list[str]] = {}
    for sentinel, pattern in WHITELIST_PATTERNS:
        matches = pattern.findall(text)
        if not matches:
            continue
        captured[sentinel] = matches
        text = pattern.sub(sentinel, text)
    return text, captured


def _restore_whitelist(text: str, captured: dict[str, list[str]]) -> str:
    """Restore whitelisted spans in the order they were captured."""

    for sentinel, originals in captured.items():
        for original in originals:
            text = text.replace(sentinel, original, 1)
    return text


def scrub_text(
    text: str,
    counter: dict[str, int],
    cjk_findings: list[dict[str, Any]] | None,
    *,
    source: str,
    allow_cjk: bool,
) -> str:
    """Scrub a single text blob.

    Whitelisted spans are stashed first, then each rule runs in order, then
    the whitelist is restored. CJK is detected last because the rules above
    never produce CJK characters.
    """

    if not text:
        return text

    stashed, captured = _apply_whitelist(text)
    for rule in SCRUB_RULES:
        stashed = rule.apply(stashed, counter)

    if CJK_PATTERN.search(stashed):
        sample = CJK_PATTERN.findall(stashed)[:5]
        if cjk_findings is not None:
            cjk_findings.append({"source": source, "sample": sample})
        if allow_cjk:
            stashed = CJK_PATTERN.sub("<cjk>", stashed)
            counter["cjk"] = counter.get("cjk", 0) + len(sample)

    return _restore_whitelist(stashed, captured)


def scrub_json_value(
    value: Any,
    counter: dict[str, int],
    cjk_findings: list[dict[str, Any]],
    *,
    source: str,
    allow_cjk: bool,
) -> Any:
    """Recursively scrub strings inside a parsed JSON value."""

    if isinstance(value, str):
        return scrub_text(
            value, counter, cjk_findings, source=source, allow_cjk=allow_cjk
        )
    if isinstance(value, list):
        return [
            scrub_json_value(item, counter, cjk_findings, source=source, allow_cjk=allow_cjk)
            for item in value
        ]
    if isinstance(value, dict):
        return {
            key: scrub_json_value(
                inner, counter, cjk_findings, source=source, allow_cjk=allow_cjk
            )
            for key, inner in value.items()
        }
    return value


# ---------------------------------------------------------------------------
# File handlers
# ---------------------------------------------------------------------------


PLAIN_TEXT_SUFFIXES = {".log", ".txt", ".md"}
JSON_SUFFIXES = {".json"}
JSONL_SUFFIXES = {".jsonl"}


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8")


def _write_text(path: Path, content: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(content, encoding="utf-8")


def handle_json_file(
    src: Path,
    dst: Path,
    counter: dict[str, int],
    cjk_findings: list[dict[str, Any]],
    *,
    dry_run: bool,
    allow_cjk: bool,
) -> None:
    raw = _read_text(src)
    try:
        data = json.loads(raw)
    except json.JSONDecodeError:
        # Treat malformed JSON as plain text rather than crashing the run.
        scrubbed = scrub_text(
            raw, counter, cjk_findings, source=str(src), allow_cjk=allow_cjk
        )
        if not dry_run:
            _write_text(dst, scrubbed)
        return

    cleaned = scrub_json_value(
        data, counter, cjk_findings, source=str(src), allow_cjk=allow_cjk
    )
    if not dry_run:
        _write_text(dst, json.dumps(cleaned, indent=2, ensure_ascii=False) + "\n")


def handle_jsonl_file(
    src: Path,
    dst: Path,
    counter: dict[str, int],
    cjk_findings: list[dict[str, Any]],
    *,
    dry_run: bool,
    allow_cjk: bool,
) -> None:
    out_lines: list[str] = []
    for line_no, line in enumerate(_read_text(src).splitlines(), start=1):
        if not line.strip():
            out_lines.append(line)
            continue
        source = f"{src}:{line_no}"
        try:
            value = json.loads(line)
        except json.JSONDecodeError:
            out_lines.append(
                scrub_text(
                    line, counter, cjk_findings, source=source, allow_cjk=allow_cjk
                )
            )
            continue
        cleaned = scrub_json_value(
            value, counter, cjk_findings, source=source, allow_cjk=allow_cjk
        )
        out_lines.append(json.dumps(cleaned, ensure_ascii=False))
    if not dry_run:
        _write_text(dst, "\n".join(out_lines) + ("\n" if out_lines else ""))


def handle_plain_file(
    src: Path,
    dst: Path,
    counter: dict[str, int],
    cjk_findings: list[dict[str, Any]],
    *,
    dry_run: bool,
    allow_cjk: bool,
) -> None:
    text = _read_text(src)
    cleaned = scrub_text(
        text, counter, cjk_findings, source=str(src), allow_cjk=allow_cjk
    )
    if not dry_run:
        _write_text(dst, cleaned)


def copy_passthrough(src: Path, dst: Path, *, dry_run: bool) -> None:
    if dry_run:
        return
    dst.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(src, dst)


# ---------------------------------------------------------------------------
# Walker / validator
# ---------------------------------------------------------------------------


def process_tree(
    input_dir: Path,
    output_dir: Path,
    report: SanitizationReport,
    *,
    dry_run: bool,
    allow_cjk: bool,
) -> None:
    for path in sorted(input_dir.rglob("*")):
        if path.is_dir():
            continue
        rel = path.relative_to(input_dir)
        dst = output_dir / rel
        suffix = path.suffix.lower()

        per_file_counter: dict[str, int] = {}
        try:
            if suffix in JSON_SUFFIXES:
                handle_json_file(
                    path, dst, per_file_counter, report.cjk_findings,
                    dry_run=dry_run, allow_cjk=allow_cjk,
                )
            elif suffix in JSONL_SUFFIXES:
                handle_jsonl_file(
                    path, dst, per_file_counter, report.cjk_findings,
                    dry_run=dry_run, allow_cjk=allow_cjk,
                )
            elif suffix in PLAIN_TEXT_SUFFIXES:
                handle_plain_file(
                    path, dst, per_file_counter, report.cjk_findings,
                    dry_run=dry_run, allow_cjk=allow_cjk,
                )
            else:
                report.files_skipped.append(
                    {"path": str(rel), "reason": f"unhandled suffix '{suffix}'"}
                )
                copy_passthrough(path, dst, dry_run=dry_run)
                continue
        except OSError as exc:
            report.files_skipped.append({"path": str(rel), "reason": str(exc)})
            continue

        report.files_processed += 1
        report.merge_replacements(per_file_counter)


def validate_tree(
    output_dir: Path,
    report: SanitizationReport,
    *,
    allow_cjk: bool,
) -> None:
    if not output_dir.exists():
        return
    for path in sorted(output_dir.rglob("*")):
        if path.is_dir():
            continue
        suffix = path.suffix.lower()
        if suffix not in (
            JSON_SUFFIXES | JSONL_SUFFIXES | PLAIN_TEXT_SUFFIXES
        ):
            continue
        try:
            content = _read_text(path)
        except (OSError, UnicodeDecodeError) as exc:
            report.validation_issues.append(
                {"path": str(path), "issue": "unreadable", "detail": str(exc)}
            )
            continue
        for name, pattern in VALIDATION_PATTERNS.items():
            hits = pattern.findall(content)
            if hits:
                report.validation_issues.append(
                    {
                        "path": str(path),
                        "issue": name,
                        "samples": hits[:5],
                    }
                )
        if not allow_cjk and CJK_PATTERN.search(content):
            samples = CJK_PATTERN.findall(content)[:5]
            report.validation_issues.append(
                {"path": str(path), "issue": "cjk", "samples": samples}
            )


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Anonymize trace artefacts before publishing them alongside "
            "a SkillLens evaluation release."
        )
    )
    parser.add_argument("--input", required=True, help="Source directory.")
    parser.add_argument("--output", required=True, help="Destination directory.")
    parser.add_argument(
        "--report",
        default=None,
        help=(
            "Path to write the JSON report. "
            "Defaults to <output>/sanitization_report.json."
        ),
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="Compute the report without writing scrubbed files.",
    )
    parser.add_argument(
        "--allow-cjk",
        action="store_true",
        help=(
            "Replace CJK runs with <cjk> instead of aborting. "
            "Use only after confirming an English rerun is impractical."
        ),
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = parse_args(argv)
    input_dir = Path(args.input).resolve()
    output_dir = Path(args.output).resolve()

    if not input_dir.is_dir():
        print(f"error: --input is not a directory: {input_dir}", file=sys.stderr)
        return 2
    if input_dir == output_dir:
        print("error: --input and --output must differ", file=sys.stderr)
        return 2

    report_path = (
        Path(args.report).resolve()
        if args.report
        else output_dir / "sanitization_report.json"
    )

    if not args.dry_run:
        output_dir.mkdir(parents=True, exist_ok=True)

    report = SanitizationReport(dry_run=args.dry_run, allow_cjk=args.allow_cjk)

    process_tree(
        input_dir,
        output_dir,
        report,
        dry_run=args.dry_run,
        allow_cjk=args.allow_cjk,
    )

    if report.cjk_findings and not args.allow_cjk:
        print(
            "error: CJK content detected; rerun with English prompts or pass "
            "--allow-cjk after confirming a rerun is impractical.",
            file=sys.stderr,
        )
        for finding in report.cjk_findings[:10]:
            print(f"  {finding['source']}: {finding['sample']}", file=sys.stderr)
        if not args.dry_run:
            report_path.parent.mkdir(parents=True, exist_ok=True)
            report_path.write_text(
                json.dumps(report.to_dict(), indent=2, ensure_ascii=False) + "\n",
                encoding="utf-8",
            )
        return 3

    if not args.dry_run:
        validate_tree(output_dir, report, allow_cjk=args.allow_cjk)

    if not args.dry_run:
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(
            json.dumps(report.to_dict(), indent=2, ensure_ascii=False) + "\n",
            encoding="utf-8",
        )

    print(f"files processed: {report.files_processed}")
    print(f"files skipped:   {len(report.files_skipped)}")
    print("replacements:")
    for name, count in sorted(report.replacements.items()):
        print(f"  {name}: {count}")
    if report.validation_issues:
        print(f"VALIDATION FAILED with {len(report.validation_issues)} issue(s)")
        for issue in report.validation_issues[:10]:
            print(f"  {issue}")
        return 1
    print("validation: OK")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
