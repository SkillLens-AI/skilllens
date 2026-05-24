"""Scanner-side data: static-scan findings + golden labels + QA metrics.

This module loads the experiment artifacts under
``实验数据/result-controlled_dataset_analysis/`` and exposes:

* the raw findings per skill (with severity × existence_confidence × default
  exploitability deduction), and
* the precision/recall/F1 metrics computed against the golden labels.

Loaders are lazy-cached on first read so the HTTP handler stays fast.
"""

from __future__ import annotations

import json
import re
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple

# --- Constants from safety_score_methodology.md -----------------------------

_SEVERITY_BASE: Dict[str, int] = {"H": 12, "M": 6, "L": 3}
_DEFAULT_EXISTENCE = 0.6
_DEFAULT_EXPLOIT = 0.6
_SECURITY_FLOOR = 10
_SECURITY_CEIL = 100

# Patterns that the scanner's prompt explicitly excludes from dynamic_test_queue
# (PE1, SC1, SC4, R2). We surface this so the UI can mark them honestly.
_NO_DYNAMIC_TEST_PATTERNS = {"PE1", "SC1", "SC4", "R2"}


# --- File locations ---------------------------------------------------------


def repo_root() -> Path:
    return Path(__file__).resolve().parent.parent


def default_scanner_dir() -> Path:
    return repo_root() / "实验数据" / "result-controlled_dataset_analysis"


def default_scans_path() -> Path:
    return default_scanner_dir() / "security_static_scans.json"


def default_golden_path() -> Path:
    return default_scanner_dir() / "all_labels_golden_modified.json"


# --- Mojibake helper --------------------------------------------------------

_MOJIBAKE_RE = re.compile(r"[�¿]")


def repair_mojibake(value: str) -> str:
    """Try to fix UTF-8 bytes that were decoded as Latin-1 then re-encoded.

    Falls back to the original string if no clean decoding exists.
    """
    if not value or not _MOJIBAKE_RE.search(value):
        return value
    for inner in ("gbk", "gb18030", "utf-8"):
        try:
            repaired = value.encode("latin-1", errors="strict").decode(inner)
            if not _MOJIBAKE_RE.search(repaired):
                return repaired
        except (UnicodeEncodeError, UnicodeDecodeError):
            continue
    return value


# --- Skill key normalization -----------------------------------------------


def normalize_skill_key(name: str) -> str:
    """Map ``Cold Chain Risk Calculator`` and ``cold-chain-risk-calculator`` to one key."""
    if not name:
        return ""
    cleaned = name.strip().lower()
    cleaned = re.sub(r"[\s_]+", "-", cleaned)
    cleaned = re.sub(r"-+", "-", cleaned)
    return cleaned


# --- Cached loaders ---------------------------------------------------------


_CACHE: Dict[str, Any] = {
    "scans_mtime": None,
    "scans_path": None,
    "golden_mtime": None,
    "golden_path": None,
    "by_key": None,  # dict[normalized_key, dict] — merged scan + golden + metrics
    "qa": None,      # full QA payload
}


def _read_json(path: Path) -> Optional[Any]:
    if not path or not path.exists():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _ensure_loaded(scans_path: Path, golden_path: Path) -> None:
    scans_mtime = scans_path.stat().st_mtime if scans_path.exists() else None
    golden_mtime = golden_path.stat().st_mtime if golden_path.exists() else None

    if (
        _CACHE["scans_mtime"] == scans_mtime
        and _CACHE["scans_path"] == str(scans_path)
        and _CACHE["golden_mtime"] == golden_mtime
        and _CACHE["golden_path"] == str(golden_path)
        and _CACHE["by_key"] is not None
    ):
        return

    scans = _read_json(scans_path) or []
    golden = _read_json(golden_path) or []

    by_key: Dict[str, Dict[str, Any]] = {}

    for entry in scans:
        if not isinstance(entry, dict):
            continue
        raw_name = repair_mojibake(str(entry.get("skill") or ""))
        key = normalize_skill_key(raw_name)
        if not key:
            key = f"unknown-{len(by_key)}"
        bucket = by_key.setdefault(
            key,
            {
                "key": key,
                "displayName": raw_name,
                "scanFindings": [],
                "goldenFindings": [],
            },
        )
        if not bucket.get("displayName"):
            bucket["displayName"] = raw_name
        for finding in entry.get("findings") or []:
            if isinstance(finding, dict):
                bucket["scanFindings"].append(finding)

    for entry in golden:
        if not isinstance(entry, dict):
            continue
        raw_name = repair_mojibake(str(entry.get("skill") or ""))
        key = normalize_skill_key(raw_name)
        bucket = by_key.setdefault(
            key,
            {
                "key": key,
                "displayName": raw_name,
                "scanFindings": [],
                "goldenFindings": [],
            },
        )
        if not bucket.get("displayName"):
            bucket["displayName"] = raw_name
        for finding in entry.get("findings") or []:
            if isinstance(finding, dict):
                bucket["goldenFindings"].append(finding)

    _CACHE["scans_path"] = str(scans_path)
    _CACHE["golden_path"] = str(golden_path)
    _CACHE["scans_mtime"] = scans_mtime
    _CACHE["golden_mtime"] = golden_mtime
    _CACHE["by_key"] = by_key
    _CACHE["qa"] = None  # invalidate derived metrics


def _all_skills(scans_path: Path, golden_path: Path) -> Dict[str, Dict[str, Any]]:
    _ensure_loaded(scans_path, golden_path)
    return _CACHE["by_key"] or {}


# --- Per-finding scoring ----------------------------------------------------


def _to_float(value: Any, default: float) -> float:
    try:
        result = float(value)
        if result != result:  # NaN guard
            return default
        return max(0.0, min(1.0, result))
    except (TypeError, ValueError):
        return default


def _score_finding(finding: Dict[str, Any]) -> Dict[str, Any]:
    """Return enriched finding with deduction + exploitability default."""
    severity = str(finding.get("severity", "")).upper()
    base = _SEVERITY_BASE.get(severity, 0)

    raw_existence = finding.get("existence_confidence")
    existence = _to_float(raw_existence, _DEFAULT_EXISTENCE)
    existence_src = "measured" if raw_existence is not None else "default"

    raw_exploit = finding.get("exploitability")
    exploit = _to_float(raw_exploit, _DEFAULT_EXPLOIT)
    exploit_src = "measured" if raw_exploit is not None else "default"
    pattern_id = str(finding.get("pattern_id") or "")
    if exploit_src == "default" and pattern_id in _NO_DYNAMIC_TEST_PATTERNS:
        # Methodology §3.3: these patterns never enter the dynamic queue,
        # so the 0.6 default is the canonical value, not a missing-data fallback.
        exploit_src = "default_excluded_from_queue"

    deduction = round(base * existence * exploit, 4)

    enriched = dict(finding)
    enriched["base_score"] = base
    enriched["existence_confidence"] = existence
    enriched["existence_confidence_src"] = existence_src
    enriched["exploitability"] = exploit
    enriched["exploitability_src"] = exploit_src
    enriched["risk_triggered"] = exploit >= 0.6
    enriched["deduction"] = deduction
    return enriched


def list_skills(
    scans_path: Path = None,
    golden_path: Path = None,
) -> List[Dict[str, Any]]:
    scans_path = scans_path or default_scans_path()
    golden_path = golden_path or default_golden_path()
    skills = _all_skills(scans_path, golden_path)
    out: List[Dict[str, Any]] = []
    for key, bucket in sorted(skills.items()):
        scan_findings = bucket.get("scanFindings") or []
        scored = [_score_finding(f) for f in scan_findings]
        deductions = sum(f["deduction"] for f in scored)
        score = max(_SECURITY_FLOOR, _SECURITY_CEIL - deductions)
        sev_counts = {"H": 0, "M": 0, "L": 0}
        for f in scored:
            sev = str(f.get("severity", "")).upper()
            if sev in sev_counts:
                sev_counts[sev] += 1
        out.append(
            {
                "key": key,
                "displayName": bucket.get("displayName") or key,
                "findingCount": len(scored),
                "severityCounts": sev_counts,
                "securityScore": round(score, 2),
                "hasGolden": bool(bucket.get("goldenFindings")),
            }
        )
    return out


def get_skill_findings(
    skill_name: str,
    scans_path: Path = None,
    golden_path: Path = None,
) -> Dict[str, Any]:
    scans_path = scans_path or default_scans_path()
    golden_path = golden_path or default_golden_path()
    skills = _all_skills(scans_path, golden_path)
    key = normalize_skill_key(skill_name)
    bucket = skills.get(key) or {
        "key": key,
        "displayName": skill_name,
        "scanFindings": [],
        "goldenFindings": [],
    }
    scored = [_score_finding(f) for f in bucket.get("scanFindings", [])]
    deductions = sum(f["deduction"] for f in scored)
    score = max(_SECURITY_FLOOR, _SECURITY_CEIL - deductions)

    sev_counts = {"H": 0, "M": 0, "L": 0}
    cat_counts: Dict[str, int] = {}
    co_count = 0
    for f in scored:
        sev = str(f.get("severity", "")).upper()
        if sev in sev_counts:
            sev_counts[sev] += 1
        cat = str(f.get("category") or "Other")
        cat_counts[cat] = cat_counts.get(cat, 0) + 1
        if isinstance(f.get("co_occurrence"), dict):
            co_count += 1

    return {
        "key": key,
        "displayName": bucket.get("displayName") or skill_name,
        "found": bool(bucket.get("scanFindings")) or bool(bucket.get("goldenFindings")),
        "securityScore": round(score, 2),
        "deductionTotal": round(deductions, 4),
        "severityCounts": sev_counts,
        "categoryCounts": cat_counts,
        "coOccurrenceCount": co_count,
        "findings": scored,
        "goldenCount": len(bucket.get("goldenFindings") or []),
    }


# --- QA metrics: scan vs golden --------------------------------------------


def _finding_keys(findings: Iterable[Dict[str, Any]]) -> List[Tuple[str, str]]:
    """One (pattern_id, file) pair per finding for matching against golden.

    Mirrors what the original metrics report does: 'matched on pattern_id'.
    We additionally bucket by file so duplicate pattern hits across files
    each count once.
    """
    out: List[Tuple[str, str]] = []
    for f in findings:
        if not isinstance(f, dict):
            continue
        pid = str(f.get("pattern_id") or "").strip()
        fname = str(f.get("file") or "").strip()
        if not pid:
            continue
        out.append((pid, fname))
    return out


def _confusion(scan: List[Tuple[str, str]], golden: List[Tuple[str, str]]) -> Tuple[int, int, int]:
    """Greedy 1:1 matching on (pattern_id, file). Falls back to pattern_id only.

    Returns (TP, FP, FN).
    """
    remaining_golden = list(golden)
    tp = 0
    unmatched_scan: List[Tuple[str, str]] = []

    for entry in scan:
        match_idx = None
        for idx, g in enumerate(remaining_golden):
            if g == entry:
                match_idx = idx
                break
        if match_idx is None:
            for idx, g in enumerate(remaining_golden):
                if g[0] == entry[0]:
                    match_idx = idx
                    break
        if match_idx is None:
            unmatched_scan.append(entry)
        else:
            tp += 1
            remaining_golden.pop(match_idx)

    return tp, len(unmatched_scan), len(remaining_golden)


def _prf(tp: int, fp: int, fn: int) -> Dict[str, float]:
    precision = tp / (tp + fp) if (tp + fp) > 0 else 0.0
    recall = tp / (tp + fn) if (tp + fn) > 0 else 0.0
    f1 = (2 * precision * recall / (precision + recall)) if (precision + recall) > 0 else 0.0
    return {
        "tp": tp,
        "fp": fp,
        "fn": fn,
        "precision": round(precision, 4),
        "recall": round(recall, 4),
        "f1": round(f1, 4),
    }


def _split_by_severity(findings: List[Dict[str, Any]]) -> Dict[str, List[Dict[str, Any]]]:
    out: Dict[str, List[Dict[str, Any]]] = {"H": [], "M": [], "L": []}
    for f in findings:
        sev = str(f.get("severity", "")).upper()
        if sev in out:
            out[sev].append(f)
    return out


def compute_qa(
    scans_path: Path = None,
    golden_path: Path = None,
) -> Dict[str, Any]:
    scans_path = scans_path or default_scans_path()
    golden_path = golden_path or default_golden_path()

    if (
        _CACHE.get("qa") is not None
        and _CACHE["scans_path"] == str(scans_path)
        and _CACHE["golden_path"] == str(golden_path)
    ):
        return _CACHE["qa"]

    skills = _all_skills(scans_path, golden_path)

    per_skill: List[Dict[str, Any]] = []
    overall_tp = overall_fp = overall_fn = 0
    by_sev: Dict[str, Dict[str, int]] = {
        "H": {"tp": 0, "fp": 0, "fn": 0},
        "M": {"tp": 0, "fp": 0, "fn": 0},
        "L": {"tp": 0, "fp": 0, "fn": 0},
    }

    for key, bucket in sorted(skills.items()):
        scan = list(bucket.get("scanFindings") or [])
        golden = list(bucket.get("goldenFindings") or [])
        if not golden and not scan:
            continue

        scan_keys = _finding_keys(scan)
        golden_keys = _finding_keys(golden)
        tp, fp, fn = _confusion(scan_keys, golden_keys)

        scan_by_sev = _split_by_severity(scan)
        gold_by_sev = _split_by_severity(golden)
        sev_breakdown: Dict[str, Dict[str, int]] = {}
        for sev in ("H", "M", "L"):
            stp, sfp, sfn = _confusion(_finding_keys(scan_by_sev[sev]), _finding_keys(gold_by_sev[sev]))
            sev_breakdown[sev] = {"tp": stp, "fp": sfp, "fn": sfn}
            by_sev[sev]["tp"] += stp
            by_sev[sev]["fp"] += sfp
            by_sev[sev]["fn"] += sfn

        prf = _prf(tp, fp, fn)
        per_skill.append(
            {
                "key": key,
                "displayName": bucket.get("displayName") or key,
                "scanCount": len(scan),
                "goldenCount": len(golden),
                **prf,
                "bySeverity": sev_breakdown,
            }
        )
        overall_tp += tp
        overall_fp += fp
        overall_fn += fn

    overall = _prf(overall_tp, overall_fp, overall_fn)
    sev_metrics = {sev: _prf(v["tp"], v["fp"], v["fn"]) for sev, v in by_sev.items()}

    payload = {
        "overall": {
            "totalSkills": len(per_skill),
            "scanFindings": sum(p["scanCount"] for p in per_skill),
            "goldenFindings": sum(p["goldenCount"] for p in per_skill),
            **overall,
        },
        "bySeverity": sev_metrics,
        "perSkill": per_skill,
    }
    _CACHE["qa"] = payload
    return payload
