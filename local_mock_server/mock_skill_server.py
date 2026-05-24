#!/usr/bin/env python3

from __future__ import annotations

import argparse
import ipaddress
import json
import re
import socket
import tempfile
import time
import urllib.parse
import urllib.request
import zipfile
from datetime import datetime, timezone
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, Optional, Tuple

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8765
DEFAULT_WAIT_SECONDS = 15
DEFAULT_FETCH_TIMEOUT = 30
MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024  # 50 MB hard cap on remote zip downloads
MAX_ZIP_MEMBER_BYTES = 5 * 1024 * 1024  # 5 MB hard cap on a single SKILL.md
MAX_SKILL_TEXT_BYTES = 2 * 1024 * 1024  # 2 MB hard cap on inline skillText
TEXT_ENCODINGS = ("utf-8", "utf-8-sig", "latin-1")
TEXT_PREVIEW_SUFFIXES = {
    ".csv",
    ".json",
    ".jsonl",
    ".log",
    ".md",
    ".py",
    ".sh",
    ".sql",
    ".toml",
    ".txt",
    ".yaml",
    ".yml",
}
STATIC_ROUTES = {
    "/": ("example_home.html", "text/html; charset=utf-8"),
    "/task-results": ("task_results_view.html", "text/html; charset=utf-8"),
    "/task-results/": ("task_results_view.html", "text/html; charset=utf-8"),
    "/task-results/app.css": ("task_results_view.css", "text/css; charset=utf-8"),
    "/task-results/app.js": ("task_results_view.js", "application/javascript; charset=utf-8"),
    "/examples": ("example_home.html", "text/html; charset=utf-8"),
    "/examples/": ("example_home.html", "text/html; charset=utf-8"),
    "/examples/home.css": ("example_home.css", "text/css; charset=utf-8"),
    "/examples/skills": ("example_skills.html", "text/html; charset=utf-8"),
    "/examples/skills/": ("example_skills.html", "text/html; charset=utf-8"),
    "/examples/skills.css": ("example_skills.css", "text/css; charset=utf-8"),
    "/examples/skills.js": ("example_skills.js", "application/javascript; charset=utf-8"),
    "/examples/details": ("example_view.html", "text/html; charset=utf-8"),
    "/examples/details/": ("example_view.html", "text/html; charset=utf-8"),
    "/examples/details.css": ("example_view.css", "text/css; charset=utf-8"),
    "/examples/details.js": ("example_view.js", "application/javascript; charset=utf-8"),
    "/examples/report": ("scanner_qa.html", "text/html; charset=utf-8"),
    "/examples/report/": ("scanner_qa.html", "text/html; charset=utf-8"),
    "/examples/report.css": ("scanner_qa.css", "text/css; charset=utf-8"),
    "/examples/report.js": ("scanner_qa.js", "application/javascript; charset=utf-8"),
}

SERVER_STATE: Dict[str, Any] = {}


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def default_downloads_dir() -> Path:
    return Path.home() / "Downloads"


def default_results_dir() -> Path:
    return repo_root() / "task_results"


def default_examples_dir() -> Path:
    return repo_root() / "Example"


def default_baked_api_dir() -> Path:
    """Directory holding /lookup-shaped JSON pre-baked from docs/artifacts/data."""
    return repo_root() / "docs" / "artifacts" / "api"


def default_precomputed_path() -> Path:
    return Path(__file__).resolve().parent / "precomputed_evaluations.json"


def default_manifest_path() -> Path:
    return Path(__file__).resolve().parent / "skill_manifest.json"


def default_pricing_path() -> Path:
    return Path(__file__).resolve().parent / "model_pricing.json"


def build_adapter_index() -> Dict[str, Dict[str, Any]]:
    """Build the {owner/repo: payload} index from algorithm-side artifacts.

    Returns an empty dict if the adapter module is missing or the manifest
    cannot be loaded — the caller falls back to the manual precomputed file.
    """
    try:
        from adapter import build_index  # local import keeps server importable
    except ImportError:
        log("adapter module unavailable; skipping Example-derived index.")
        return {}
    examples_dir = SERVER_STATE.get("examplesDir")
    manifest_path = SERVER_STATE.get("manifestPath")
    pricing_path = SERVER_STATE.get("pricingPath")
    if not examples_dir or not manifest_path or not pricing_path:
        return {}
    try:
        return build_index(Path(examples_dir), Path(manifest_path), Path(pricing_path))
    except Exception as error:  # noqa: BLE001
        log("adapter build_index failed:", repr(error))
        return {}


def lookup_baked_api(baked_api_dir: Optional[Path], owner: str, repo: str) -> Optional[Dict[str, Any]]:
    """Read a pre-baked /lookup payload from ``<api_dir>/lookup/<owner>__<repo>.json``.

    Files are stored in full envelope shape (``{ok, status, evaluation, ...}``)
    so they can also be served verbatim from a static host such as GitHub
    Pages. This helper unwraps the envelope and returns just the
    ``evaluation`` dict, since the caller adds its own envelope.

    Returns ``None`` if the file is missing, unreadable, or has the wrong
    shape. Populated by ``scripts/build_lookup_index.py`` from the artifacts
    under ``docs/artifacts/data/skills/``.
    """
    if not baked_api_dir:
        return None
    file_path = baked_api_dir / "lookup" / f"{owner}__{repo}.json"
    payload = read_json_file(file_path)
    if not isinstance(payload, dict):
        return None
    evaluation = payload.get("evaluation")
    if isinstance(evaluation, dict):
        return evaluation
    # Fall back to treating the file as a raw evaluation (legacy shape).
    return payload


def lookup_precomputed(store_path: Path, owner: str, repo: str) -> Dict[str, Any]:
    """Look up an evaluation, preferring hand-curated entries over baked artifacts.

    Resolution order:
      1. ``precomputed_evaluations.json`` (hand-curated, paper-final overrides)
      2. ``docs/artifacts/api/lookup/<owner>__<repo>.json`` (baked from the
         published research artifacts via ``scripts/build_lookup_index.py``)
      3. ``adapter`` index built from ``Example/<skill>/skill_report.json``
         (legacy algorithm-side layout)
      4. ``not_evaluated``
    """
    key = f"{owner}/{repo}"

    # 1. Hand-curated precomputed entries take priority.
    if store_path.exists():
        data = read_json_file(store_path) or {}
        entry = data.get(key)
        if isinstance(entry, dict):
            return {"ok": True, "status": "ok", "evaluation": entry, "source": "precomputed"}

    # 2. Pre-baked /lookup files derived from docs/artifacts/data.
    baked_entry = lookup_baked_api(SERVER_STATE.get("bakedApiDir"), owner, repo)
    if baked_entry is not None:
        return {"ok": True, "status": "ok", "evaluation": baked_entry, "source": "artifacts"}

    # 3. Fall back to the legacy adapter index built from Example/ layout.
    adapter_index = SERVER_STATE.get("adapterIndex") or {}
    entry = adapter_index.get(key)
    if isinstance(entry, dict):
        return {"ok": True, "status": "ok", "evaluation": entry, "source": "adapter"}

    return {"ok": True, "status": "not_evaluated"}


def utc_now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def log(*parts: object) -> None:
    print("[mock_skill_server]", *parts, flush=True)


def sanitize_filename(value: str) -> str:
    return re.sub(r"[^\w.-]+", "_", value).strip("._") or "unknown"


def safe_float(value: Any) -> Optional[float]:
    if value is None:
        return None
    try:
        return float(value)
    except (TypeError, ValueError):
        return None


def read_text_file(path: Path) -> Optional[str]:
    if not path.exists() or not path.is_file():
        return None

    for encoding in TEXT_ENCODINGS:
        try:
            return path.read_text(encoding=encoding)
        except UnicodeDecodeError:
            continue
        except OSError:
            return None

    try:
        return path.read_text(encoding="utf-8", errors="replace")
    except OSError:
        return None


def read_json_value(path: Path) -> Any:
    text = read_text_file(path)
    if text is None:
        return None

    try:
        return json.loads(text)
    except json.JSONDecodeError:
        return None


def read_json_file(path: Path) -> Optional[Dict[str, Any]]:
    payload = read_json_value(path)
    if isinstance(payload, dict):
        return payload
    return None


def preview_text(text: Optional[str], limit: int = 1200) -> str:
    if not text:
        return ""
    stripped = text.strip()
    if len(stripped) <= limit:
        return stripped
    return stripped[: limit - 3].rstrip() + "..."


def summarize_text(text: Optional[str], limit: int = 220) -> str:
    if not text:
        return ""
    compact = re.sub(r"\s+", " ", text).strip()
    if len(compact) <= limit:
        return compact
    return compact[: limit - 3].rstrip() + "..."


def compact_json(value: Any, limit: int = 220) -> str:
    try:
        rendered = json.dumps(value, ensure_ascii=False)
    except TypeError:
        rendered = str(value)
    return summarize_text(rendered, limit)


def tail_lines(path: Path, count: int = 80, char_limit: int = 4000) -> str:
    text = read_text_file(path)
    if not text:
        return ""
    tail = "\n".join(text.splitlines()[-count:])
    return preview_text(tail, char_limit)


def parse_iso_datetime(value: Optional[str]) -> Optional[datetime]:
    if not value:
        return None
    normalized = value.strip()
    if normalized.endswith("Z"):
        normalized = normalized[:-1] + "+00:00"
    try:
        return datetime.fromisoformat(normalized)
    except ValueError:
        return None


def duration_seconds(started_at: Optional[str], finished_at: Optional[str]) -> Optional[float]:
    start = parse_iso_datetime(started_at)
    end = parse_iso_datetime(finished_at)
    if not start or not end:
        return None
    return max(0.0, (end - start).total_seconds())


def is_safe_zip_member(name: str) -> bool:
    # Reject absolute paths, drive letters, and traversal segments. zipfile
    # itself does not enforce this — a crafted entry like ``../../etc/passwd``
    # would otherwise be matched by a naive ``endswith("/SKILL.MD")`` check.
    if not name:
        return False
    normalized = name.replace("\\", "/")
    if normalized.startswith("/"):
        return False
    if re.match(r"^[A-Za-z]:", normalized):
        return False
    parts = [p for p in normalized.split("/") if p not in ("", ".")]
    if any(p == ".." for p in parts):
        return False
    return True


def find_skill_member(zip_file: zipfile.ZipFile) -> str:
    safe_names = [name for name in zip_file.namelist() if is_safe_zip_member(name)]

    exact_matches = [name for name in safe_names if name.upper() == "SKILL.MD"]
    if exact_matches:
        return exact_matches[0]

    nested_matches = [name for name in safe_names if name.upper().endswith("/SKILL.MD")]
    if nested_matches:
        return nested_matches[0]

    raise FileNotFoundError("Could not find SKILL.md inside the zip archive.")


def read_skill_text(zip_path: Path) -> Tuple[str, str]:
    with zipfile.ZipFile(zip_path, "r") as zip_file:
        member = find_skill_member(zip_file)
        info = zip_file.getinfo(member)
        if info.file_size > MAX_ZIP_MEMBER_BYTES:
            raise ValueError(
                f"SKILL.md inside the zip is {info.file_size} bytes, exceeding the "
                f"{MAX_ZIP_MEMBER_BYTES}-byte limit."
            )
        # Stream-read with a hard cap to defuse zip bombs that under-report sizes.
        with zip_file.open(member, "r") as fh:
            raw = fh.read(MAX_ZIP_MEMBER_BYTES + 1)
        if len(raw) > MAX_ZIP_MEMBER_BYTES:
            raise ValueError("SKILL.md exceeded the size limit during extraction.")

    for encoding in TEXT_ENCODINGS:
        try:
            return raw.decode(encoding), member
        except UnicodeDecodeError:
            continue

    raise UnicodeDecodeError("utf-8", raw, 0, 1, "Unable to decode SKILL.md with supported encodings.")


def wait_for_zip_file(zip_path: Path, wait_seconds: int) -> bool:
    deadline = time.time() + max(wait_seconds, 0)
    while time.time() <= deadline:
        if zip_path.exists() and zip_path.is_file():
            try:
                with zipfile.ZipFile(zip_path, "r") as zip_file:
                    zip_file.testzip()
                return True
            except (zipfile.BadZipFile, OSError):
                time.sleep(0.35)
                continue
        time.sleep(0.25)
    return False


def is_private_address(host: str) -> bool:
    # Block requests aimed at the loopback, link-local, private RFC1918 ranges,
    # and cloud metadata IPs. Resolves all A/AAAA records so a hostname that
    # points to 127.0.0.1 or 169.254.169.254 is rejected too.
    if not host:
        return True
    try:
        infos = socket.getaddrinfo(host, None)
    except socket.gaierror:
        return True
    for info in infos:
        sockaddr = info[4]
        try:
            addr = ipaddress.ip_address(sockaddr[0])
        except ValueError:
            return True
        if (
            addr.is_private
            or addr.is_loopback
            or addr.is_link_local
            or addr.is_multicast
            or addr.is_reserved
            or addr.is_unspecified
        ):
            return True
    return False


def download_zip_to_temp(download_url: str, slug: str, timeout_seconds: int) -> Path:
    parsed = urllib.parse.urlparse(download_url)
    if parsed.scheme not in {"http", "https"}:
        raise ValueError("downloadUrl must be http or https.")
    if not parsed.hostname:
        raise ValueError("downloadUrl is missing a hostname.")
    if is_private_address(parsed.hostname):
        raise ValueError(
            "downloadUrl resolves to a private/loopback/link-local address; refusing."
        )

    safe_slug = sanitize_filename(slug)
    temp_dir = Path(tempfile.gettempdir()) / "skilltestbench"
    temp_dir.mkdir(parents=True, exist_ok=True)
    temp_path = temp_dir / f"{safe_slug}_{int(time.time())}.zip"

    request = urllib.request.Request(
        download_url,
        headers={"User-Agent": "SkillTestBenchLocalServer/0.2"},
        method="GET",
    )

    with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
        if response.status >= 400:
            raise RuntimeError(f"Downloading zip failed with HTTP {response.status}.")

        # Honor Content-Length when present, but always read with a hard cap so
        # a server lying about its size cannot exhaust local disk/memory.
        declared = response.headers.get("Content-Length")
        if declared and declared.isdigit() and int(declared) > MAX_DOWNLOAD_BYTES:
            raise ValueError(
                f"Remote zip is {declared} bytes, exceeding the {MAX_DOWNLOAD_BYTES}-byte limit."
            )

        chunks: list[bytes] = []
        total = 0
        while True:
            chunk = response.read(64 * 1024)
            if not chunk:
                break
            total += len(chunk)
            if total > MAX_DOWNLOAD_BYTES:
                raise ValueError(
                    f"Remote zip exceeded the {MAX_DOWNLOAD_BYTES}-byte limit during download."
                )
            chunks.append(chunk)
        temp_path.write_bytes(b"".join(chunks))

    return temp_path


def score_skill(text: str) -> Dict[str, Any]:
    lines = text.splitlines()
    word_count = len(re.findall(r"\b\w+\b", text))
    heading_count = len(re.findall(r"(?m)^\s*#+\s", text))
    code_fence_count = len(re.findall(r"```", text)) // 2
    url_count = len(re.findall(r"https?://", text))
    env_var_like_count = len(re.findall(r"\b[A-Z][A-Z0-9_]{2,}\b", text))

    findings = []
    reasoning = []

    if heading_count >= 8:
        findings.append("Structured documentation: many markdown headings were found.")
        reasoning.append("Higher heading count usually means the skill is organized and easier to inspect.")
    else:
        findings.append("Relatively small heading count: structure may be flatter.")

    if code_fence_count:
        findings.append("Contains runnable examples or command snippets.")
        reasoning.append("Code fences often make a skill easier to validate manually.")
    else:
        findings.append("No fenced code blocks found.")

    if "hooks" in text.lower():
        findings.append("Mentions hooks; a reviewer should confirm what those hooks do before enabling them.")
        reasoning.append("Hook-related behavior can alter runtime behavior and is worth reviewing carefully.")

    if env_var_like_count:
        findings.append("Contains environment-variable-like tokens; verify whether they are actually required.")
        reasoning.append("Environment variables are not necessarily bad, but they are worth checking during review.")

    if "http://" in text.lower() or "https://" in text.lower():
        findings.append("Contains external URLs; these are normal in documentation, but links should still be inspected.")

    score = 55
    score += min(18, heading_count * 2)
    score += min(12, code_fence_count * 2)
    score += 5 if word_count > 300 else 0
    score -= min(10, max(url_count - 5, 0))
    score -= min(6, max(env_var_like_count - 8, 0))
    score = max(0, min(100, score))

    risk_level = "low" if score >= 80 else "medium" if score >= 60 else "high"

    return {
        "score": score,
        "riskLevel": risk_level,
        "stats": {
            "lineCount": len(lines),
            "wordCount": word_count,
            "headingCount": heading_count,
            "codeFenceCount": code_fence_count,
            "urlCount": url_count,
            "envVarLikeCount": env_var_like_count,
        },
        "findings": findings,
        "reasoning": reasoning,
    }


def evaluate_job(payload: Dict[str, Any]) -> Dict[str, Any]:
    download_url = str(payload.get("downloadUrl") or "").strip()
    page_skill_text = str(payload.get("skillText") or "").strip()
    source_page_url = str(payload.get("sourcePageUrl") or "").strip()
    owner = str(payload.get("owner") or "").strip()
    slug = str(payload.get("slug") or "").strip()
    version = str(payload.get("version") or "").strip()
    relative_download_path = str(payload.get("relativeDownloadPath") or "").strip()
    explicit_downloads_dir = str(payload.get("downloadsDir") or "").strip()

    if not download_url and not page_skill_text:
        raise ValueError("Payload is missing both downloadUrl and skillText.")
    if not slug:
        raise ValueError("Payload is missing slug.")
    if len(page_skill_text.encode("utf-8", errors="ignore")) > MAX_SKILL_TEXT_BYTES:
        raise ValueError(
            f"skillText exceeds the {MAX_SKILL_TEXT_BYTES}-byte limit; refusing to score."
        )

    if page_skill_text and not download_url:
        evaluation = score_skill(page_skill_text)
        return {
            "ok": True,
            "evaluatedAt": utc_now_iso(),
            "sourcePageUrl": source_page_url,
            "owner": owner,
            "slug": slug,
            "version": version,
            "expectedLocalPath": "",
            "zipSourcePath": source_page_url,
            "extractionMode": "page_text",
            "extractedMember": "SKILL.md",
            "skillText": page_skill_text,
            "evaluation": evaluation,
            "serverNote": "The local server evaluated SKILL.md text extracted directly from the current page.",
        }

    wait_seconds = int(payload.get("waitForLocalDownloadSeconds") or DEFAULT_WAIT_SECONDS)
    fetch_timeout = int(payload.get("fetchTimeoutSeconds") or DEFAULT_FETCH_TIMEOUT)
    downloads_dir = Path(explicit_downloads_dir) if explicit_downloads_dir else default_downloads_dir()
    expected_local_zip = downloads_dir / relative_download_path if relative_download_path else None

    extraction_mode = "download_url_fallback"
    zip_source_path = ""
    server_note = ""
    zip_path: Optional[Path] = None

    if expected_local_zip:
        log("Trying local zip first:", expected_local_zip)
        if wait_for_zip_file(expected_local_zip, wait_seconds):
            extraction_mode = "local_download"
            zip_path = expected_local_zip
            zip_source_path = str(expected_local_zip)
            server_note = (
                "The local server found the browser-downloaded zip in your Downloads folder and extracted SKILL.md from that local copy."
            )
        else:
            log("Local zip was not found or not ready within timeout. Falling back to direct fetch.")
            server_note = (
                "The local server did not find the expected zip under your Downloads folder in time, "
                "so it downloaded the same zip locally as a fallback. "
                "If you want exact on-disk reading every time, pass --downloads-dir to the server if Chrome uses a custom Downloads location."
            )

    if zip_path is None and page_skill_text:
        evaluation = score_skill(page_skill_text)
        return {
            "ok": True,
            "evaluatedAt": utc_now_iso(),
            "sourcePageUrl": source_page_url,
            "owner": owner,
            "slug": slug,
            "version": version,
            "expectedLocalPath": str(expected_local_zip) if expected_local_zip else "",
            "zipSourcePath": source_page_url,
            "extractionMode": "page_text_fallback",
            "extractedMember": "SKILL.md",
            "skillText": page_skill_text,
            "evaluation": evaluation,
            "serverNote": (
                "The local server did not find a readable browser-downloaded zip in time, "
                "so it evaluated SKILL.md text extracted directly from the current page."
            ),
        }

    if zip_path is None:
        zip_path = download_zip_to_temp(download_url, slug, fetch_timeout)
        zip_source_path = str(zip_path)

    skill_text, extracted_member = read_skill_text(zip_path)
    evaluation = score_skill(skill_text)

    return {
        "ok": True,
        "evaluatedAt": utc_now_iso(),
        "sourcePageUrl": source_page_url,
        "owner": owner,
        "slug": slug,
        "version": version,
        "expectedLocalPath": str(expected_local_zip) if expected_local_zip else "",
        "zipSourcePath": zip_source_path,
        "extractionMode": extraction_mode,
        "extractedMember": extracted_member,
        "skillText": skill_text,
        "evaluation": evaluation,
        "serverNote": server_note or "The local server extracted SKILL.md successfully.",
    }


def resolve_results_dir(raw_path: Optional[str]) -> Path:
    base_dir = raw_path or str(SERVER_STATE["resultsDir"])
    results_dir = Path(base_dir).expanduser().resolve()
    if not results_dir.exists() or not results_dir.is_dir():
        raise FileNotFoundError(f"Results directory does not exist: {results_dir}")
    return results_dir


def resolve_examples_dir(raw_path: Optional[str]) -> Path:
    base_dir = raw_path or str(SERVER_STATE["examplesDir"])
    examples_dir = Path(base_dir).expanduser().resolve()
    if not examples_dir.exists() or not examples_dir.is_dir():
        raise FileNotFoundError(f"Examples directory does not exist: {examples_dir}")
    return examples_dir


def category_label(value: str) -> str:
    compact = re.sub(r"[-_]+", " ", value or "").strip()
    return compact.title() if compact else "Unknown"


def unique_strings(values: list[str]) -> list[str]:
    seen: set[str] = set()
    items: list[str] = []
    for value in values:
        compact = re.sub(r"\s+", " ", str(value or "")).strip()
        if not compact or compact in seen:
            continue
        seen.add(compact)
        items.append(compact)
    return items


def extract_output_targets(instruction: str) -> list[str]:
    matches = re.findall(r"/app/output/[\w./-]+", instruction or "")
    return unique_strings(matches)


def first_paragraph(text: str) -> str:
    parts = re.split(r"\n\s*\n", text or "")
    for part in parts:
        compact = summarize_text(part, 240)
        if compact:
            return compact
    return summarize_text(text, 240)


def infer_task_utility_label(skill_name: str, scenario: Dict[str, Any]) -> str:
    instruction = (scenario.get("instruction") or "").lower()
    test_mechanism = (scenario.get("test_mechanism") or "").lower()
    combined = f"{instruction}\n{test_mechanism}"

    if "critical summary" in combined or "paper_summaries.md" in combined or "seminar presentation" in combined:
        return "Critical paper summaries"
    if "literature review" in combined:
        return "Literature review synthesis"
    if "research proposal" in combined or "proposed study" in combined:
        return "Research proposal drafting"
    if "peer review" in combined and ("three arxiv" in combined or "all three papers" in combined or "comparative" in combined):
        return "Comparative multi-paper review"
    if "peer review" in combined or "program committee" in combined:
        return "Single-paper peer review"
    if "theoretical" in combined or "monograph" in combined or "proof" in combined:
        return "Theoretical paper review"
    if "orientacao_patricia" in combined or "nota_interna_juridica" in combined:
        return "Victim guidance plus internal legal note"
    if "feminicidio" in combined or "121-a" in combined:
        return "Criminal homicide/feminicide opinion"
    if "parecer" in combined or "legal opinion" in combined or "opinion" in combined:
        return "Criminal legal opinion"
    if skill_name == "academic-researcher":
        return "Academic writing and synthesis task"
    if skill_name == "academic-paper-review":
        return "Research review and evaluation task"
    if skill_name == "advogado-criminal":
        return "Criminal law analysis task"
    return "Structured skill evaluation task"


def build_example_trial_index(examples_dir: Path) -> Dict[str, Path]:
    trial_index: Dict[str, Path] = {}
    for result_path in examples_dir.rglob("result.json"):
        trial_dir = result_path.parent
        trial_index[trial_dir.name] = trial_dir
    return trial_index


def extract_trial_name(raw_path: str) -> str:
    compact = str(raw_path or "").strip().rstrip("/\\")
    if not compact:
        return ""
    return Path(compact).name


def build_run_condition(run_path: str, trial_index: Dict[str, Path]) -> Dict[str, Any]:
    trial_name = extract_trial_name(run_path)
    trial_dir = trial_index.get(trial_name)
    if not trial_name or not trial_dir:
        return {
            "trialName": trial_name,
            "resolved": False,
            "status": "unknown",
            "reward": None,
            "durationSec": None,
            "hasException": False,
            "exceptionType": "",
            "exceptionMessage": "",
            "tests": {"tests": 0, "passed": 0, "failed": 0, "skipped": 0, "pending": 0, "other": 0},
            "tokens": {"input": 0, "cache": 0, "output": 0, "total": 0},
        }

    summary = build_trial_summary(trial_dir, trial_dir.parent)
    if not summary:
        return {
            "trialName": trial_name,
            "resolved": False,
            "status": "unknown",
            "reward": None,
            "durationSec": None,
            "hasException": False,
            "exceptionType": "",
            "exceptionMessage": "",
            "tests": {"tests": 0, "passed": 0, "failed": 0, "skipped": 0, "pending": 0, "other": 0},
            "tokens": {"input": 0, "cache": 0, "output": 0, "total": 0},
        }

    summary["resolved"] = True
    return summary


def count_condition_statuses(runs: list[Dict[str, Any]]) -> Dict[str, int]:
    counts = {"passed": 0, "failed": 0, "warning": 0, "error": 0, "unknown": 0}
    for run in runs:
        status = str(run.get("status") or "unknown")
        counts[status] = counts.get(status, 0) + 1
    return counts


def count_condition_exceptions(runs: list[Dict[str, Any]]) -> int:
    return sum(1 for run in runs if run.get("hasException"))


def build_example_summary(skill_dir: Path, trial_index: Dict[str, Path]) -> Optional[Dict[str, Any]]:
    skill_report = read_json_file(skill_dir / "skill_report.json")
    info = read_json_file(skill_dir / "info.json") or {}
    utility_scheme = read_json_value(skill_dir / "utility_scheme.json")
    if not skill_report or not isinstance(utility_scheme, list):
        return None

    utility = (skill_report.get("utility") or {}) if isinstance(skill_report, dict) else {}
    details = utility.get("details") or []
    scenario_map = {
        str(item.get("scenario_id") or ""): item
        for item in utility_scheme
        if isinstance(item, dict)
    }

    capability_pool: list[str] = []
    task_types: list[Dict[str, Any]] = []
    scenario_summaries: list[Dict[str, Any]] = []
    wi_runs: list[Dict[str, Any]] = []
    wo_runs: list[Dict[str, Any]] = []
    wi_wins = 0
    wo_wins = 0
    ties = 0

    for detail in details:
        if not isinstance(detail, dict):
            continue

        scenario_id = str(detail.get("scenario_id") or "")
        scenario_meta = scenario_map.get(scenario_id, {})
        capability_pool.extend(
            item for item in (scenario_meta.get("core_capability_analysis") or []) if isinstance(item, str)
        )

        utility_label = infer_task_utility_label(str(skill_report.get("skill_name") or ""), scenario_meta)
        output_targets = extract_output_targets(str(scenario_meta.get("instruction") or ""))
        task_types.append(
            {
                "scenarioId": scenario_id,
                "label": utility_label,
                "level": scenario_meta.get("level") or "",
                "outputTargets": output_targets,
                "headline": first_paragraph(str(scenario_meta.get("test_mechanism") or scenario_meta.get("instruction") or "")),
            }
        )

        wi_run = build_run_condition(str(detail.get("wi_path") or ""), trial_index)
        wo_run = build_run_condition(str(detail.get("wo_path") or ""), trial_index)
        wi_runs.append(wi_run)
        wo_runs.append(wo_run)

        wi_passed = int(detail.get("wi_passed_items") or 0)
        wo_passed = int(detail.get("wo_passed_items") or 0)
        total_items = int(detail.get("total_items") or 0)
        if wi_passed > wo_passed:
            winner = "wi"
            wi_wins += 1
        elif wo_passed > wi_passed:
            winner = "wo"
            wo_wins += 1
        else:
            winner = "tie"
            ties += 1

        scenario_summaries.append(
            {
                "scenarioId": scenario_id,
                "label": utility_label,
                "level": scenario_meta.get("level") or "",
                "instructionPreview": first_paragraph(str(scenario_meta.get("instruction") or "")),
                "testMechanismPreview": first_paragraph(str(scenario_meta.get("test_mechanism") or "")),
                "coreCapabilities": [
                    item for item in (scenario_meta.get("core_capability_analysis") or []) if isinstance(item, str)
                ],
                "outputTargets": output_targets,
                "totalItems": total_items,
                "wiPassedItems": wi_passed,
                "woPassedItems": wo_passed,
                "wiPassRate": (wi_passed / total_items) if total_items else 0.0,
                "woPassRate": (wo_passed / total_items) if total_items else 0.0,
                "winner": winner,
                "judgeError": detail.get("judge_error") or "",
                "error": detail.get("error"),
                "utilitySummary": detail.get("utility_summary") or "",
                "skillCondition": {
                    "wiSkillUsed": bool(detail.get("wi_skill_used")),
                    "woSkillUsed": bool(detail.get("wo_skill_used")),
                    "wiSkillExpected": bool(detail.get("wi_skill_expected")),
                    "woSkillExpected": bool(detail.get("wo_skill_expected")),
                    "wiSkillMatched": bool(detail.get("wi_skill_matched")),
                    "woSkillMatched": bool(detail.get("wo_skill_matched")),
                },
                "wiRun": wi_run,
                "woRun": wo_run,
            }
        )

    scenario_count = len(scenario_summaries)
    total_items = int(utility.get("total_items") or 0)
    wi_passed_items = int(utility.get("wi_passed_items") or 0)
    wo_passed_items = int(utility.get("wo_passed_items") or 0)
    wi_pass_rate = (wi_passed_items / total_items) if total_items else 0.0
    wo_pass_rate = (wo_passed_items / total_items) if total_items else 0.0

    wi_tokens = utility.get("wi_token_consumption") or {}
    wo_tokens = utility.get("wo_token_consumption") or {}
    wi_total_tokens = int(wi_tokens.get("n_input_tokens") or 0) + int(wi_tokens.get("n_cache_tokens") or 0) + int(wi_tokens.get("n_output_tokens") or 0)
    wo_total_tokens = int(wo_tokens.get("n_input_tokens") or 0) + int(wo_tokens.get("n_cache_tokens") or 0) + int(wo_tokens.get("n_output_tokens") or 0)

    wi_matched_count = sum(1 for item in scenario_summaries if item["skillCondition"]["wiSkillMatched"])
    wo_matched_count = sum(1 for item in scenario_summaries if item["skillCondition"]["woSkillMatched"])
    wi_used_count = sum(1 for item in scenario_summaries if item["skillCondition"]["wiSkillUsed"])
    wo_used_count = sum(1 for item in scenario_summaries if item["skillCondition"]["woSkillUsed"])

    return {
        "skillName": skill_report.get("skill_name") or skill_dir.name,
        "owner": info.get("owner") or "",
        "category": info.get("category") or "",
        "categoryLabel": category_label(str(info.get("category") or "")),
        "skillPath": info.get("skill_path") or "",
        "scenarioCount": scenario_count,
        "scenarioIds": [item["scenarioId"] for item in scenario_summaries],
        "domainCoverage": {
            "category": info.get("category") or "",
            "categoryLabel": category_label(str(info.get("category") or "")),
            "owner": info.get("owner") or "",
            "coverageCount": len(unique_strings(capability_pool)),
            "capabilityHighlights": unique_strings(capability_pool),
        },
        "taskUtilityType": {
            "items": task_types,
        },
        "skillCondition": {
            "wiExpectedCount": int(utility.get("wi_skill_expected") or 0),
            "woExpectedCount": int(utility.get("wo_skill_expected") or 0),
            "wiMatchedCount": wi_matched_count,
            "woMatchedCount": wo_matched_count,
            "wiUsedCount": wi_used_count,
            "woUsedCount": wo_used_count,
        },
        "effectiveness": {
            "totalItems": total_items,
            "wiPassedItems": wi_passed_items,
            "woPassedItems": wo_passed_items,
            "wiPassRate": wi_pass_rate,
            "woPassRate": wo_pass_rate,
            "passDeltaItems": wi_passed_items - wo_passed_items,
            "passDeltaRate": wi_pass_rate - wo_pass_rate,
            "wiWins": wi_wins,
            "woWins": wo_wins,
            "ties": ties,
        },
        "costApiUsage": {
            "wiTokens": {
                "input": int(wi_tokens.get("n_input_tokens") or 0),
                "cache": int(wi_tokens.get("n_cache_tokens") or 0),
                "output": int(wi_tokens.get("n_output_tokens") or 0),
                "total": wi_total_tokens,
            },
            "woTokens": {
                "input": int(wo_tokens.get("n_input_tokens") or 0),
                "cache": int(wo_tokens.get("n_cache_tokens") or 0),
                "output": int(wo_tokens.get("n_output_tokens") or 0),
                "total": wo_total_tokens,
            },
            "tokenDelta": wi_total_tokens - wo_total_tokens,
        },
        "executionTime": {
            "wiSeconds": safe_float(utility.get("wi_agent_execuation_time")),
            "woSeconds": safe_float(utility.get("wo_agent_execuation_time")),
            "deltaSeconds": safe_float(utility.get("wi_agent_execuation_time")) - safe_float(utility.get("wo_agent_execuation_time"))
            if safe_float(utility.get("wi_agent_execuation_time")) is not None and safe_float(utility.get("wo_agent_execuation_time")) is not None
            else None,
        },
        "reliabilityError": {
            "wiExceptionScenarios": count_condition_exceptions(wi_runs),
            "woExceptionScenarios": count_condition_exceptions(wo_runs),
            "wiStatusCounts": count_condition_statuses(wi_runs),
            "woStatusCounts": count_condition_statuses(wo_runs),
        },
        "scenarios": scenario_summaries,
    }


def _scanner_stub_example(skill: Dict[str, Any]) -> Dict[str, Any]:
    """Render a scanner-only skill as a stub example so the browse page can list it.

    Stubs carry empty utility/cost (the controlled-dataset corpus has no paired
    runs) but do show up so users can click through to the detail page and see
    real Safety findings rendered by the static-scan pipeline.
    """
    return {
        "skillName": skill["displayName"],
        "owner": "—",
        "category": "safety_only",
        "categoryLabel": "Safety audited",
        "skillPath": "",
        "scenarioCount": 0,
        "scenarioIds": [],
        "domainCoverage": {
            "category": "safety_only",
            "categoryLabel": "Safety audited",
            "owner": "—",
            "coverageCount": 0,
            "capabilityHighlights": [],
        },
        "taskUtilityType": {"items": []},
        "skillCondition": {
            "wiExpectedCount": 0, "woExpectedCount": 0,
            "wiMatchedCount": 0, "woMatchedCount": 0,
            "wiUsedCount": 0, "woUsedCount": 0,
        },
        "effectiveness": {
            "totalItems": 0, "wiPassedItems": 0, "woPassedItems": 0,
            "wiPassRate": 0.0, "woPassRate": 0.0,
            "passDeltaItems": 0, "passDeltaRate": 0.0,
            "wiWins": 0, "woWins": 0, "ties": 0,
        },
        "costApiUsage": {
            "wiTokens": {"input": 0, "cache": 0, "output": 0, "total": 0},
            "woTokens": {"input": 0, "cache": 0, "output": 0, "total": 0},
            "tokenDelta": 0,
        },
        "executionTime": {"wiSeconds": 0.0, "woSeconds": 0.0, "deltaSeconds": 0.0},
        "reliabilityError": {
            "wiExceptionScenarios": 0, "woExceptionScenarios": 0,
            "wiStatusCounts": {}, "woStatusCounts": {},
        },
        "scenarios": [],
        "source": "safety_only",
        "scannerSummary": {
            "findingCount": skill.get("findingCount", 0),
            "severityCounts": skill.get("severityCounts", {}),
            "securityScore": skill.get("securityScore", 100),
        },
    }


def build_examples_dashboard(examples_dir: Path) -> Dict[str, Any]:
    trial_index = build_example_trial_index(examples_dir)
    skill_dirs = sorted(
        path for path in examples_dir.iterdir()
        if path.is_dir() and (path / "skill_report.json").exists()
    )
    examples = [item for item in (build_example_summary(path, trial_index) for path in skill_dirs) if item]

    # Merge scanner-only skills as stubs so the Safety axis is observable in the UI
    try:
        import scanner_data as _sd
        existing = {item["skillName"] for item in examples}
        scanner_skills = _sd.list_skills()
        for skill in scanner_skills:
            if skill["displayName"] in existing or skill["key"] in existing:
                continue
            examples.append(_scanner_stub_example(skill))
    except Exception as error:  # noqa: BLE001
        log(f"scanner stub merge skipped: {error}")

    # Demo-phase synthetic entries. File is optional — delete demo_examples.json
    # to remove these from the listing.
    demo_path = Path(__file__).resolve().parent / "demo_examples.json"
    if demo_path.exists():
        try:
            demo_entries = json.loads(demo_path.read_text(encoding="utf-8"))
            existing = {item["skillName"] for item in examples}
            for entry in demo_entries:
                name = entry.get("skillName")
                if name and name not in existing:
                    examples.append(entry)
                    existing.add(name)
        except (OSError, json.JSONDecodeError) as error:
            log(f"demo examples merge skipped: {error}")

    examples.sort(key=lambda item: item["skillName"])

    total_scenarios = sum(int(item.get("scenarioCount") or 0) for item in examples)
    total_items = sum(int((item.get("effectiveness") or {}).get("totalItems") or 0) for item in examples)
    wi_passed_items = sum(int((item.get("effectiveness") or {}).get("wiPassedItems") or 0) for item in examples)
    wo_passed_items = sum(int((item.get("effectiveness") or {}).get("woPassedItems") or 0) for item in examples)
    wi_tokens_total = sum(int(((item.get("costApiUsage") or {}).get("wiTokens") or {}).get("total") or 0) for item in examples)
    wo_tokens_total = sum(int(((item.get("costApiUsage") or {}).get("woTokens") or {}).get("total") or 0) for item in examples)
    wi_seconds_total = sum(float((item.get("executionTime") or {}).get("wiSeconds") or 0) for item in examples)
    wo_seconds_total = sum(float((item.get("executionTime") or {}).get("woSeconds") or 0) for item in examples)
    wi_wins = sum(int((item.get("effectiveness") or {}).get("wiWins") or 0) for item in examples)
    wo_wins = sum(int((item.get("effectiveness") or {}).get("woWins") or 0) for item in examples)
    ties = sum(int((item.get("effectiveness") or {}).get("ties") or 0) for item in examples)
    wi_exception_scenarios = sum(int((item.get("reliabilityError") or {}).get("wiExceptionScenarios") or 0) for item in examples)
    wo_exception_scenarios = sum(int((item.get("reliabilityError") or {}).get("woExceptionScenarios") or 0) for item in examples)

    return {
        "root": {
            "examplesDir": str(examples_dir),
            "nExamples": len(examples),
            "nScenarios": total_scenarios,
        },
        "overview": {
            "totalItems": total_items,
            "wiPassedItems": wi_passed_items,
            "woPassedItems": wo_passed_items,
            "wiPassRate": (wi_passed_items / total_items) if total_items else 0.0,
            "woPassRate": (wo_passed_items / total_items) if total_items else 0.0,
            "wiTokensTotal": wi_tokens_total,
            "woTokensTotal": wo_tokens_total,
            "wiSecondsTotal": wi_seconds_total,
            "woSecondsTotal": wo_seconds_total,
            "wiWins": wi_wins,
            "woWins": wo_wins,
            "ties": ties,
            "wiExceptionScenarios": wi_exception_scenarios,
            "woExceptionScenarios": wo_exception_scenarios,
        },
        "examples": examples,
    }


def get_ctrf_summary(ctrf_data: Optional[Dict[str, Any]]) -> Dict[str, int]:
    summary = ((ctrf_data or {}).get("results") or {}).get("summary") or {}
    return {
        "tests": int(summary.get("tests") or 0),
        "passed": int(summary.get("passed") or 0),
        "failed": int(summary.get("failed") or 0),
        "skipped": int(summary.get("skipped") or 0),
        "pending": int(summary.get("pending") or 0),
        "other": int(summary.get("other") or 0),
    }


def get_reward(result_data: Dict[str, Any], reward_path: Path) -> Optional[float]:
    rewards = ((result_data.get("verifier_result") or {}).get("rewards") or {})
    if "reward" in rewards:
        return safe_float(rewards.get("reward"))
    raw_reward = read_text_file(reward_path)
    if raw_reward is None:
        return None
    return safe_float(raw_reward.strip())


def classify_trial_status(reward: Optional[float], failed_tests: int, exception_info: Any) -> str:
    has_exception = bool(exception_info)
    if has_exception and reward is not None and reward >= 1.0 and failed_tests == 0:
        return "warning"
    if has_exception:
        return "error"
    if failed_tests > 0:
        return "failed"
    if reward is not None:
        return "passed" if reward >= 1.0 else "failed"
    return "unknown"


def get_status_rank(status: str) -> int:
    return {
        "error": 0,
        "warning": 1,
        "failed": 2,
        "passed": 3,
        "unknown": 4,
    }.get(status, 5)


def build_trial_summary(trial_dir: Path, results_dir: Path) -> Optional[Dict[str, Any]]:
    result_path = trial_dir / "result.json"
    result_data = read_json_file(result_path)
    if not result_data:
        return None

    ctrf_path = trial_dir / "verifier" / "ctrf.json"
    trajectory_path = trial_dir / "agent" / "trajectory.json"
    reward_path = trial_dir / "verifier" / "reward.txt"
    ctrf_data = read_json_file(ctrf_path)
    trajectory_data = read_json_file(trajectory_path)
    reward = get_reward(result_data, reward_path)
    tests = get_ctrf_summary(ctrf_data)
    exception_info = result_data.get("exception_info")
    status = classify_trial_status(reward, tests["failed"], exception_info)
    agent_result = result_data.get("agent_result") or {}
    agent_info = result_data.get("agent_info") or {}
    config = result_data.get("config") or {}
    trajectory_steps = (trajectory_data or {}).get("steps") or []

    input_tokens = int(agent_result.get("n_input_tokens") or 0)
    cache_tokens = int(agent_result.get("n_cache_tokens") or 0)
    output_tokens = int(agent_result.get("n_output_tokens") or 0)

    return {
        "trialName": result_data.get("trial_name") or trial_dir.name,
        "taskName": result_data.get("task_name") or trial_dir.name,
        "status": status,
        "reward": reward,
        "startedAt": result_data.get("started_at"),
        "finishedAt": result_data.get("finished_at"),
        "durationSec": duration_seconds(result_data.get("started_at"), result_data.get("finished_at")),
        "agentName": agent_info.get("name") or ((config.get("agent") or {}).get("name")) or "unknown",
        "agentVersion": agent_info.get("version") or "",
        "modelName": ((config.get("agent") or {}).get("model_name")) or "",
        "tests": tests,
        "hasException": bool(exception_info),
        "exceptionType": (exception_info or {}).get("exception_type") or "",
        "exceptionMessage": summarize_text((exception_info or {}).get("exception_message") or "", 160),
        "tokens": {
            "input": input_tokens,
            "cache": cache_tokens,
            "output": output_tokens,
            "total": input_tokens + cache_tokens + output_tokens,
        },
        "costUsd": agent_result.get("cost_usd"),
        "trajectory": {
            "schemaVersion": (trajectory_data or {}).get("schema_version") or "",
            "stepCount": len(trajectory_steps),
            "sessionId": (trajectory_data or {}).get("session_id") or "",
        },
        "paths": {
            "trialDir": str(trial_dir),
            "trialDirRelative": str(trial_dir.relative_to(results_dir.parent)),
            "resultJson": str(result_path),
            "ctrfJson": str(ctrf_path) if ctrf_path.exists() else "",
            "trajectoryJson": str(trajectory_path) if trajectory_path.exists() else "",
        },
    }


def build_job_summary(results_dir: Path) -> Dict[str, Any]:
    root_result = read_json_file(results_dir / "result.json") or {}
    root_config = read_json_file(results_dir / "config.json") or {}
    trial_dirs = sorted(path for path in results_dir.iterdir() if path.is_dir() and (path / "result.json").exists())
    trials = [summary for summary in (build_trial_summary(path, results_dir) for path in trial_dirs) if summary]
    trials.sort(key=lambda item: (get_status_rank(item["status"]), item["taskName"], item["trialName"]))

    status_counts = {"passed": 0, "failed": 0, "warning": 0, "error": 0, "unknown": 0}
    rewards = []
    durations = []
    input_tokens = 0
    cache_tokens = 0
    output_tokens = 0
    agent_buckets: Dict[tuple[str, str], int] = {}

    for trial in trials:
        status_counts[trial["status"]] = status_counts.get(trial["status"], 0) + 1

        reward = trial.get("reward")
        if reward is not None:
            rewards.append(float(reward))

        duration = trial.get("durationSec")
        if duration is not None:
            durations.append(float(duration))

        input_tokens += int(trial["tokens"]["input"])
        cache_tokens += int(trial["tokens"]["cache"])
        output_tokens += int(trial["tokens"]["output"])

        key = (trial["agentName"], trial["modelName"])
        agent_buckets[key] = agent_buckets.get(key, 0) + 1

    agents = [
        {
            "agentName": agent_name,
            "modelName": model_name,
            "nTrials": count,
        }
        for (agent_name, model_name), count in sorted(agent_buckets.items(), key=lambda item: (-item[1], item[0][0], item[0][1]))
    ]

    n_trials = len(trials)
    pass_like = status_counts["passed"] + status_counts["warning"]

    return {
        "job": {
            "id": root_result.get("id") or "",
            "jobName": root_config.get("job_name") or results_dir.name,
            "resultsDir": str(results_dir),
            "startedAt": root_result.get("started_at"),
            "finishedAt": root_result.get("finished_at"),
            "durationSec": duration_seconds(root_result.get("started_at"), root_result.get("finished_at")),
            "nTotalTrials": int(root_result.get("n_total_trials") or n_trials),
            "nListedTrials": n_trials,
        },
        "overview": {
            "statusCounts": status_counts,
            "successRate": (pass_like / n_trials) if n_trials else 0.0,
            "meanReward": (sum(rewards) / len(rewards)) if rewards else None,
            "meanDurationSec": (sum(durations) / len(durations)) if durations else None,
            "tokens": {
                "input": input_tokens,
                "cache": cache_tokens,
                "output": output_tokens,
                "total": input_tokens + cache_tokens + output_tokens,
            },
        },
        "agents": agents,
        "trials": trials,
        "rootStats": root_result.get("stats") or {},
        "config": {
            "nAttempts": root_config.get("n_attempts"),
            "orchestratorType": ((root_config.get("orchestrator") or {}).get("type")) or "",
            "environmentType": ((root_config.get("environment") or {}).get("type")) or "",
            "nConcurrentTrials": ((root_config.get("orchestrator") or {}).get("n_concurrent_trials")),
        },
    }


def normalize_observation(observation: Any) -> str:
    if not observation:
        return ""
    if isinstance(observation, str):
        return summarize_text(observation, 500)
    if isinstance(observation, dict):
        results = observation.get("results")
        if isinstance(results, list):
            parts = []
            for result in results[:3]:
                if isinstance(result, dict):
                    parts.append(summarize_text(result.get("content") or compact_json(result), 280))
                else:
                    parts.append(summarize_text(str(result), 280))
            return "\n".join(part for part in parts if part)
        return summarize_text(compact_json(observation, 500), 500)
    return summarize_text(str(observation), 500)


def normalize_step(step: Dict[str, Any]) -> Dict[str, Any]:
    raw_tool_calls = step.get("tool_calls") or []
    tool_calls = []
    for tool_call in raw_tool_calls:
        if not isinstance(tool_call, dict):
            continue
        tool_calls.append(
            {
                "name": tool_call.get("function_name") or tool_call.get("name") or "tool",
                "argumentsPreview": compact_json(tool_call.get("arguments") or {}, 240),
            }
        )

    metrics = step.get("metrics") or {}
    return {
        "stepId": step.get("step_id"),
        "timestamp": step.get("timestamp"),
        "source": step.get("source") or "unknown",
        "modelName": step.get("model_name") or "",
        "message": preview_text(step.get("message") or "", 1200),
        "reasoning": preview_text(step.get("reasoning_content") or "", 1200),
        "toolCalls": tool_calls,
        "observationPreview": normalize_observation(step.get("observation")),
        "promptTokens": metrics.get("prompt_tokens") or 0,
        "completionTokens": metrics.get("completion_tokens") or 0,
        "cachedTokens": metrics.get("cached_tokens") or 0,
    }


def collect_failed_tests(ctrf_data: Optional[Dict[str, Any]], limit: int = 20) -> list[Dict[str, Any]]:
    tests = ((ctrf_data or {}).get("results") or {}).get("tests") or []
    failed = []
    for test in tests:
        if not isinstance(test, dict) or test.get("status") != "failed":
            continue
        failed.append(
            {
                "name": test.get("name") or "",
                "filePath": test.get("file_path") or "",
                "message": test.get("message") or "",
                "duration": test.get("duration"),
                "tracePreview": preview_text(test.get("trace") or "", 1800),
            }
        )
        if len(failed) >= limit:
            break
    return failed


def collect_output_previews(output_dir: Path, limit_files: int = 8) -> list[Dict[str, Any]]:
    if not output_dir.exists() or not output_dir.is_dir():
        return []

    previews = []
    for path in sorted(output_dir.rglob("*")):
        if len(previews) >= limit_files:
            break
        if not path.is_file():
            continue

        item = {
            "relativePath": str(path.relative_to(output_dir)),
            "sizeBytes": path.stat().st_size,
            "kind": "binary",
            "preview": "",
        }

        if path.suffix.lower() in TEXT_PREVIEW_SUFFIXES:
            item["kind"] = "text"
            item["preview"] = preview_text(read_text_file(path), 2400)

        previews.append(item)

    return previews


def build_trial_detail(results_dir: Path, trial_name: str) -> Dict[str, Any]:
    if not trial_name:
        raise ValueError("trialName is required.")

    trial_dir = (results_dir / trial_name).resolve()
    if trial_dir.parent != results_dir.resolve() or not trial_dir.exists() or not trial_dir.is_dir():
        raise FileNotFoundError(f"Trial directory does not exist: {trial_name}")

    summary = build_trial_summary(trial_dir, results_dir)
    if not summary:
        raise FileNotFoundError(f"Trial result.json is missing or unreadable: {trial_name}")

    result_data = read_json_file(trial_dir / "result.json") or {}
    ctrf_data = read_json_file(trial_dir / "verifier" / "ctrf.json") or {}
    trajectory_data = read_json_file(trial_dir / "agent" / "trajectory.json") or {}
    trajectory_steps = (trajectory_data.get("steps") or []) if isinstance(trajectory_data, dict) else []

    return {
        "trial": summary,
        "result": {
            "trialUri": result_data.get("trial_uri") or "",
            "taskPath": ((result_data.get("task_id") or {}).get("path")) or "",
            "startedAt": result_data.get("started_at"),
            "finishedAt": result_data.get("finished_at"),
            "environmentSetup": result_data.get("environment_setup") or {},
            "agentSetup": result_data.get("agent_setup") or {},
            "agentExecution": result_data.get("agent_execution") or {},
            "verifier": result_data.get("verifier") or {},
        },
        "verifier": {
            "summary": get_ctrf_summary(ctrf_data),
            "failedTests": collect_failed_tests(ctrf_data),
            "stdoutPreview": tail_lines(trial_dir / "verifier" / "test-stdout.txt", count=120, char_limit=6000),
        },
        "exception": {
            "info": result_data.get("exception_info"),
            "textPreview": preview_text(read_text_file(trial_dir / "exception.txt"), 5000),
        },
        "trajectory": {
            "schemaVersion": trajectory_data.get("schema_version") or "",
            "sessionId": trajectory_data.get("session_id") or "",
            "finalMetrics": trajectory_data.get("final_metrics") or {},
            "steps": [normalize_step(step) for step in trajectory_steps if isinstance(step, dict)],
        },
        "logs": {
            "trialLogTail": tail_lines(trial_dir / "trial.log", count=120, char_limit=6000),
            "networkLogTail": tail_lines(trial_dir / "network" / "network_log.jsonl", count=40, char_limit=6000),
        },
        "outputs": collect_output_previews(trial_dir / "agent" / "downloads" / "app" / "output"),
    }


def read_static_asset(filename: str) -> bytes:
    asset_path = Path(__file__).resolve().parent / filename
    if not asset_path.exists() or not asset_path.is_file():
        raise FileNotFoundError(filename)
    return asset_path.read_bytes()


class RequestHandler(BaseHTTPRequestHandler):
    server_version = "SkillTestBenchMock/0.2"

    def log_message(self, format: str, *args: object) -> None:
        log(self.address_string(), "-", format % args)

    def _send_json(self, status_code: int, payload: Dict[str, Any]) -> None:
        encoded = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(encoded)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Private-Network", "true")
        self.end_headers()
        self.wfile.write(encoded)

    def _send_bytes(self, status_code: int, payload: bytes, content_type: str) -> None:
        self.send_response(status_code)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_OPTIONS(self) -> None:
        self._send_json(204, {"ok": True})

    def do_GET(self) -> None:
        parsed = urllib.parse.urlparse(self.path)
        query = urllib.parse.parse_qs(parsed.query)

        if parsed.path in STATIC_ROUTES:
            filename, content_type = STATIC_ROUTES[parsed.path]
            try:
                self._send_bytes(200, read_static_asset(filename), content_type)
            except FileNotFoundError:
                self._send_json(404, {"ok": False, "error": f"Missing static asset: {filename}"})
            return

        if parsed.path == "/health":
            self._send_json(
                200,
                {
                    "ok": True,
                    "service": "skilltestbench-local-mock",
                    "startedAt": SERVER_STATE["startedAt"],
                    "downloadsDir": str(SERVER_STATE["downloadsDir"]),
                    "resultsDir": str(SERVER_STATE["resultsDir"]),
                    "examplesDir": str(SERVER_STATE["examplesDir"]),
                    "precomputedPath": str(SERVER_STATE["precomputedPath"]),
                    "manifestPath": str(SERVER_STATE.get("manifestPath", "")),
                    "pricingPath": str(SERVER_STATE.get("pricingPath", "")),
                    "adapterIndexSize": len(SERVER_STATE.get("adapterIndex") or {}),
                },
            )
            return

        if parsed.path == "/lookup":
            owner = (query.get("owner") or [""])[0].strip()
            repo = (query.get("repo") or [""])[0].strip()
            if not owner or not repo:
                self._send_json(400, {"ok": False, "error": "owner and repo are required"})
                return
            result = lookup_precomputed(SERVER_STATE["precomputedPath"], owner, repo)
            self._send_json(200, result)
            return

        # Static-style lookup mirrors how GitHub Pages serves the baked files,
        # so the same extension URL builder works against the local server and
        # the public artifacts host. Filenames use ``<owner>__<repo>.json``.
        if parsed.path.startswith("/lookup/") and parsed.path.endswith(".json"):
            stem = parsed.path[len("/lookup/"):-len(".json")]
            if "__" not in stem:
                self._send_json(404, {"ok": False, "error": "expected /lookup/<owner>__<repo>.json"})
                return
            owner, _, repo = stem.partition("__")
            owner = owner.strip()
            repo = repo.strip()
            if not owner or not repo:
                self._send_json(400, {"ok": False, "error": "owner and repo are required"})
                return
            result = lookup_precomputed(SERVER_STATE["precomputedPath"], owner, repo)
            self._send_json(200, result)
            return

        if parsed.path == "/api/task-results/summary":
            try:
                results_dir = resolve_results_dir((query.get("resultsDir") or [""])[0] or None)
                payload = build_job_summary(results_dir)
                payload["ok"] = True
                self._send_json(200, payload)
            except Exception as error:  # noqa: BLE001
                self._send_json(400, {"ok": False, "error": str(error)})
            return

        if parsed.path == "/api/task-results/trial":
            try:
                results_dir = resolve_results_dir((query.get("resultsDir") or [""])[0] or None)
                trial_name = (query.get("trialName") or [""])[0]
                payload = build_trial_detail(results_dir, trial_name)
                payload["ok"] = True
                self._send_json(200, payload)
            except Exception as error:  # noqa: BLE001
                self._send_json(400, {"ok": False, "error": str(error)})
            return

        if parsed.path == "/api/examples/summary":
            try:
                examples_dir = resolve_examples_dir((query.get("examplesDir") or [""])[0] or None)
                payload = build_examples_dashboard(examples_dir)
                payload["ok"] = True
                self._send_json(200, payload)
            except Exception as error:  # noqa: BLE001
                self._send_json(400, {"ok": False, "error": str(error)})
            return

        if parsed.path == "/api/scanner/skills":
            try:
                import scanner_data as _sd
                self._send_json(200, {"ok": True, "skills": _sd.list_skills()})
            except Exception as error:  # noqa: BLE001
                self._send_json(500, {"ok": False, "error": str(error)})
            return

        if parsed.path == "/api/scanner/findings":
            try:
                import scanner_data as _sd
                skill = (query.get("skill") or [""])[0]
                if not skill:
                    self._send_json(400, {"ok": False, "error": "skill query parameter required"})
                    return
                payload = _sd.get_skill_findings(skill)
                payload["ok"] = True
                self._send_json(200, payload)
            except Exception as error:  # noqa: BLE001
                self._send_json(500, {"ok": False, "error": str(error)})
            return

        if parsed.path == "/api/scanner/qa":
            try:
                import scanner_data as _sd
                payload = _sd.compute_qa()
                payload["ok"] = True
                self._send_json(200, payload)
            except Exception as error:  # noqa: BLE001
                self._send_json(500, {"ok": False, "error": str(error)})
            return

        self._send_json(404, {"ok": False, "error": f"Unknown path: {parsed.path}"})

    def _check_admin_auth(self) -> bool:
        """Return True when the request carries the configured admin token.

        When ``--admin-token`` is empty (the default for local dev) we still
        require that the request come from a loopback peer, so a hostile page
        on the same machine cannot trigger admin actions through CORS.
        """
        peer = self.client_address[0] if self.client_address else ""
        if peer not in ("127.0.0.1", "::1"):
            return False
        configured = SERVER_STATE.get("adminToken") or ""
        if not configured:
            return True
        provided = self.headers.get("X-Admin-Token", "")
        return provided == configured

    def do_POST(self) -> None:
        parsed = urllib.parse.urlparse(self.path)

        if parsed.path == "/admin/refresh":
            if not self._check_admin_auth():
                self._send_json(403, {"ok": False, "error": "Forbidden."})
                return
            old_size = len(SERVER_STATE.get("adapterIndex") or {})
            try:
                SERVER_STATE["adapterIndex"] = build_adapter_index()
            except Exception as error:  # noqa: BLE001
                log("Adapter refresh failed:", repr(error))
                self._send_json(500, {"ok": False, "error": str(error)})
                return
            new_size = len(SERVER_STATE.get("adapterIndex") or {})
            log(f"Adapter index refreshed: {old_size} -> {new_size} entries.")
            self._send_json(
                200,
                {
                    "ok": True,
                    "previousSize": old_size,
                    "currentSize": new_size,
                    "refreshedAt": utc_now_iso(),
                },
            )
            return

        if parsed.path != "/evaluate":
            self._send_json(404, {"ok": False, "error": f"Unknown path: {parsed.path}"})
            return

        try:
            length = int(self.headers.get("Content-Length", "0") or 0)
            if length < 0 or length > MAX_DOWNLOAD_BYTES:
                self._send_json(413, {"ok": False, "error": "Request body too large."})
                return
            body = self.rfile.read(length) if length else b"{}"
            payload = json.loads(body.decode("utf-8") or "{}")
            self._send_json(200, evaluate_job(payload))
        except json.JSONDecodeError as error:
            self._send_json(400, {"ok": False, "error": f"Invalid JSON: {error}"})
        except Exception as error:  # noqa: BLE001
            log("Evaluation failed:", repr(error))
            self._send_json(500, {"ok": False, "error": str(error)})


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description="Local mock server for the SkillTestBench Chrome extension.")
    parser.add_argument("--host", default=DEFAULT_HOST, help=f"Bind host. Default: {DEFAULT_HOST}")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT, help=f"Bind port. Default: {DEFAULT_PORT}")
    parser.add_argument(
        "--downloads-dir",
        default=str(default_downloads_dir()),
        help="Path to the browser Downloads folder. Use this if Chrome does not use ~/Downloads.",
    )
    parser.add_argument(
        "--results-dir",
        default=str(default_results_dir()),
        help="Path to a Harbor-style results directory. This powers the local task-results viewer.",
    )
    parser.add_argument(
        "--examples-dir",
        default=str(default_examples_dir()),
        help="Path to the Example directory. This powers the local Example viewer.",
    )
    parser.add_argument(
        "--baked-api-dir",
        default=str(default_baked_api_dir()),
        help=(
            "Path to pre-baked /lookup-shaped artifacts "
            "(generated by scripts/build_lookup_index.py). "
            "Pass an empty string to disable."
        ),
    )
    parser.add_argument(
        "--precomputed",
        default=str(default_precomputed_path()),
        help="Path to a JSON file with pre-computed SkillTestBench results, keyed by owner/repo.",
    )
    parser.add_argument(
        "--manifest",
        default=str(default_manifest_path()),
        help="Path to skill_manifest.json (skill_name -> owner/repo + provenance).",
    )
    parser.add_argument(
        "--pricing",
        default=str(default_pricing_path()),
        help="Path to model_pricing.json (per-million-token USD rates).",
    )
    parser.add_argument(
        "--admin-token",
        default="",
        help="Optional shared secret required as X-Admin-Token on /admin/* endpoints. "
             "Empty (default) accepts any loopback request without a token.",
    )
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    downloads_dir = Path(args.downloads_dir).expanduser().resolve()
    results_dir = Path(args.results_dir).expanduser().resolve()
    examples_dir = Path(args.examples_dir).expanduser().resolve()
    raw_baked = (args.baked_api_dir or "").strip()
    baked_api_dir: Optional[Path] = (
        Path(raw_baked).expanduser().resolve() if raw_baked else None
    )
    precomputed_path = Path(args.precomputed).expanduser().resolve()
    manifest_path = Path(args.manifest).expanduser().resolve()
    pricing_path = Path(args.pricing).expanduser().resolve()

    SERVER_STATE["startedAt"] = utc_now_iso()
    SERVER_STATE["downloadsDir"] = downloads_dir
    SERVER_STATE["resultsDir"] = results_dir
    SERVER_STATE["examplesDir"] = examples_dir
    SERVER_STATE["bakedApiDir"] = baked_api_dir
    SERVER_STATE["precomputedPath"] = precomputed_path
    SERVER_STATE["manifestPath"] = manifest_path
    SERVER_STATE["pricingPath"] = pricing_path
    SERVER_STATE["adminToken"] = args.admin_token
    SERVER_STATE["adapterIndex"] = build_adapter_index()

    log("Starting local mock server...")
    log("Listening on:", f"http://{args.host}:{args.port}")
    log("Using Downloads directory:", downloads_dir)
    log("Using task-results directory:", results_dir)
    log("Using examples directory:", examples_dir)
    if baked_api_dir is not None:
        baked_lookup_dir = baked_api_dir / "lookup"
        baked_count = (
            len(list(baked_lookup_dir.glob("*.json")))
            if baked_lookup_dir.exists()
            else 0
        )
        log(
            "Using baked API directory:",
            baked_api_dir,
            f"({baked_count} owner/repo entries)"
            if baked_count
            else "(empty; run scripts/build_lookup_index.py)",
        )
    else:
        log("Baked API directory: disabled")
    log("Using precomputed evaluations:", precomputed_path)
    log("Using skill manifest:", manifest_path)
    log("Using model pricing:", pricing_path)
    log("Adapter-derived entries:", len(SERVER_STATE.get("adapterIndex") or {}))
    log("Health check:", f"http://{args.host}:{args.port}/health")
    log("Lookup endpoint:", f"http://{args.host}:{args.port}/lookup?owner=<owner>&repo=<repo>")
    log(
        "Admin refresh:",
        f"POST http://{args.host}:{args.port}/admin/refresh"
        + (" (X-Admin-Token required)" if args.admin_token else " (loopback only, no token required)"),
    )
    log("Task-results viewer:", f"http://{args.host}:{args.port}/task-results")
    log("Example viewer:", f"http://{args.host}:{args.port}/examples")

    httpd = ThreadingHTTPServer((args.host, args.port), RequestHandler)
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        log("Shutting down.")
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
