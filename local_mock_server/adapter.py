"""Translate algorithm-side skill_report.json into the plugin's U/S/C schema.

The algorithm team produces one ``skill_report.json`` per skill under
``Example/<skill_name>/``. The Chrome extension expects a different shape
keyed by ``owner/repo``. This adapter is the single place that bridges the
two, so neither side needs to renegotiate field names when the harness
evolves.

Inputs
------
* ``Example/<skill_name>/skill_report.json``  — utility / security totals
* ``Example/<skill_name>/security_static_scan.json`` (optional) — static scan
* ``skill_manifest.json`` — skill_name → owner/repo mapping + provenance
* ``model_pricing.json`` — per-million-token USD rates per model

Output
------
A dict matching the ``schema.json`` /lookup payload shape, plus an extra
``provenance`` block with harness/model/judge identifiers.
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any, Dict, Iterable, Optional


SAFETY_LEVEL_THRESHOLDS = (
    # (max_risk_rate_inclusive, label)
    (0.10, "low"),
    (0.40, "medium"),
    (1.01, "high"),
)


def _read_json(path: Path) -> Optional[Dict[str, Any]]:
    if not path.exists() or not path.is_file():
        return None
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError):
        return None


def load_manifest(manifest_path: Path) -> Dict[str, Dict[str, Any]]:
    """Return ``{skill_name: entry}`` from the manifest file."""
    payload = _read_json(manifest_path) or {}
    skills = payload.get("skills") or []
    out: Dict[str, Dict[str, Any]] = {}
    for entry in skills:
        if isinstance(entry, dict) and entry.get("skill_name"):
            out[entry["skill_name"]] = entry
    return out


def load_pricing(pricing_path: Path) -> Dict[str, Any]:
    return _read_json(pricing_path) or {"models": {}, "default": ""}


def _safe_int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def _safe_float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def _safe_div(num: float, den: float) -> Optional[float]:
    if den <= 0:
        return None
    return num / den


def _token_total(consumption: Optional[Dict[str, Any]]) -> Dict[str, int]:
    consumption = consumption or {}
    inp = _safe_int(consumption.get("n_input_tokens"))
    cache = _safe_int(consumption.get("n_cache_tokens"))
    out = _safe_int(consumption.get("n_output_tokens"))
    return {"input": inp, "cache": cache, "output": out, "total": inp + cache + out}


def _cost_usd(tokens: Dict[str, int], pricing_for_model: Optional[Dict[str, float]]) -> Optional[float]:
    if not pricing_for_model:
        return None
    rate_in = _safe_float(pricing_for_model.get("input"))
    rate_cache = _safe_float(pricing_for_model.get("cache_read"))
    rate_out = _safe_float(pricing_for_model.get("output"))
    per_million = (
        tokens["input"] * rate_in
        + tokens["cache"] * rate_cache
        + tokens["output"] * rate_out
    )
    return round(per_million / 1_000_000, 6)


def _classify_safety(risk_rate: float) -> str:
    for upper, label in SAFETY_LEVEL_THRESHOLDS:
        if risk_rate <= upper:
            return label
    return "high"


def _build_utility(report_utility: Dict[str, Any]) -> Dict[str, Any]:
    total = _safe_int(report_utility.get("total_items"))
    wi = _safe_int(report_utility.get("wi_passed_items"))
    wo = _safe_int(report_utility.get("wo_passed_items"))
    baseline = _safe_div(wo, total)
    with_skill = _safe_div(wi, total)
    delta = (with_skill - baseline) if (baseline is not None and with_skill is not None) else None
    return {
        "deltaPassAt1": round(delta, 4) if delta is not None else None,
        "baseline": round(baseline, 4) if baseline is not None else None,
        "withSkill": round(with_skill, 4) if with_skill is not None else None,
        "tasks": _safe_int(report_utility.get("scenario_num")),
        "items": total,
        "wiPassedItems": wi,
        "woPassedItems": wo,
    }


def _build_safety(
    report_security: Optional[Dict[str, Any]],
    static_scan: Optional[Dict[str, Any]],
) -> Dict[str, Any]:
    """Derive U/S/C safety axis from the algorithm-side security artifacts.

    ``report_security`` comes from the security judge summary (rate-style).
    ``static_scan`` comes from the static scanner (taxonomy-style).
    Both are optional — if neither exists we return an "unknown" stub so the
    panel can still render.
    """
    runtime_flags: list[str] = []
    risk_triggered = 0
    total_entries = 0

    if isinstance(report_security, dict) and report_security:
        total_entries = _safe_int(report_security.get("total_entries"))
        risk_triggered = _safe_int(report_security.get("risk_triggered"))
        for scenario in report_security.get("scenarios") or []:
            if isinstance(scenario, dict) and scenario.get("risk_triggered"):
                runtime_flags.append(str(scenario.get("scenario_id") or "risk"))

    static_hits = 0
    static_taxonomy: list[str] = []
    if isinstance(static_scan, dict) and static_scan:
        findings = static_scan.get("findings") or static_scan.get("hits") or []
        if isinstance(findings, list):
            static_hits = len(findings)
            for finding in findings:
                if isinstance(finding, dict):
                    label = finding.get("category") or finding.get("taxonomy") or finding.get("type")
                    if label:
                        static_taxonomy.append(str(label))

    risk_rate = (risk_triggered / total_entries) if total_entries else 0.0
    has_signal = bool(static_hits) or bool(total_entries)

    return {
        "riskLevel": _classify_safety(risk_rate) if has_signal else "unknown",
        "staticHits": static_hits,
        "staticTaxonomy": sorted(set(static_taxonomy)),
        "runtimeFlags": runtime_flags,
        "riskTriggerRate": round(risk_rate, 4),
        "evaluated": has_signal,
    }


def _build_cost(report_utility: Dict[str, Any], pricing: Dict[str, Any], model: str) -> Dict[str, Any]:
    wi_time = _safe_float(report_utility.get("wi_agent_execuation_time"))
    wo_time = _safe_float(report_utility.get("wo_agent_execuation_time"))
    wi_tokens = _token_total(report_utility.get("wi_token_consumption"))
    wo_tokens = _token_total(report_utility.get("wo_token_consumption"))

    pricing_for_model = (pricing.get("models") or {}).get(model)
    wi_usd = _cost_usd(wi_tokens, pricing_for_model)
    wo_usd = _cost_usd(wo_tokens, pricing_for_model)

    delta_tokens = wi_tokens["total"] - wo_tokens["total"]
    delta_time = round(wi_time - wo_time, 2)
    delta_usd: Optional[float] = None
    if wi_usd is not None and wo_usd is not None:
        delta_usd = round(wi_usd - wo_usd, 6)

    return {
        "deltaTimeSec": delta_time,
        "deltaTokens": delta_tokens,
        "deltaUsd": delta_usd,
        "wiTokens": wi_tokens,
        "woTokens": wo_tokens,
        "wiTimeSec": round(wi_time, 2),
        "woTimeSec": round(wo_time, 2),
        "pricingModel": model if pricing_for_model else None,
    }


def adapt_report(
    skill_report: Dict[str, Any],
    manifest_entry: Dict[str, Any],
    pricing: Dict[str, Any],
) -> Dict[str, Any]:
    """Map a single ``skill_report.json`` payload to the plugin shape."""
    utility_raw = skill_report.get("utility") or {}
    security_raw = skill_report.get("security") if isinstance(skill_report.get("security"), dict) else {}

    evaluator = manifest_entry.get("evaluator") or {}
    model = evaluator.get("model") or pricing.get("default", "")

    return {
        "skillName": skill_report.get("skill_name") or manifest_entry.get("skill_name", ""),
        "owner": manifest_entry.get("owner", ""),
        "repo": manifest_entry.get("repo", ""),
        "skillPath": manifest_entry.get("skillPath", ""),
        "evaluatedAt": manifest_entry.get("evaluatedAt", ""),
        "commit": manifest_entry.get("commit", ""),
        "source": "skilltestbench_v1",
        "utility": _build_utility(utility_raw),
        "safety": _build_safety(security_raw, _read_json(_static_scan_path(manifest_entry))),
        "cost": _build_cost(utility_raw, pricing, model),
        "provenance": {
            "harness": evaluator.get("harness", ""),
            "model": model,
            "judgeModel": evaluator.get("judgeModel", ""),
        },
    }


def _static_scan_path(manifest_entry: Dict[str, Any]) -> Path:
    """Resolve the optional static-scan sidecar next to skill_report.json."""
    examples_dir = manifest_entry.get("_examplesDir")
    skill_name = manifest_entry.get("skill_name", "")
    if not examples_dir or not skill_name:
        return Path("/nonexistent")
    return Path(examples_dir) / skill_name / "security_static_scan.json"


_SAFETY_RANK = {"unknown": 0, "low": 1, "medium": 2, "high": 3}
_SAFETY_RANK_REVERSE = {v: k for k, v in _SAFETY_RANK.items()}


def aggregate_repo_payloads(payloads: list[Dict[str, Any]]) -> Dict[str, Any]:
    """Combine multiple per-skill payloads sharing one ``owner/repo``.

    A monorepo like ``anthropics/skills`` ships many skills under different
    paths but the plugin keys panels by ``owner/repo``. We roll utility/cost
    counts up, take the worst safety level, and list contributing skills.
    """
    if len(payloads) == 1:
        return payloads[0]

    # Use the first entry as the spine for repo-level metadata.
    base = dict(payloads[0])

    total_items = sum(_safe_int(p["utility"].get("items")) for p in payloads)
    wi_passed = sum(_safe_int(p["utility"].get("wiPassedItems")) for p in payloads)
    wo_passed = sum(_safe_int(p["utility"].get("woPassedItems")) for p in payloads)
    tasks_sum = sum(_safe_int(p["utility"].get("tasks")) for p in payloads)
    baseline = _safe_div(wo_passed, total_items)
    with_skill = _safe_div(wi_passed, total_items)
    delta = (with_skill - baseline) if (baseline is not None and with_skill is not None) else None
    base["utility"] = {
        "deltaPassAt1": round(delta, 4) if delta is not None else None,
        "baseline": round(baseline, 4) if baseline is not None else None,
        "withSkill": round(with_skill, 4) if with_skill is not None else None,
        "tasks": tasks_sum,
        "items": total_items,
        "wiPassedItems": wi_passed,
        "woPassedItems": wo_passed,
    }

    delta_time = round(sum(_safe_float(p["cost"].get("deltaTimeSec")) for p in payloads), 2)
    delta_tokens = sum(_safe_int(p["cost"].get("deltaTokens")) for p in payloads)
    usd_values = [p["cost"].get("deltaUsd") for p in payloads if p["cost"].get("deltaUsd") is not None]
    delta_usd = round(sum(usd_values), 6) if usd_values else None
    base["cost"] = {
        "deltaTimeSec": delta_time,
        "deltaTokens": delta_tokens,
        "deltaUsd": delta_usd,
        "pricingModel": payloads[0]["cost"].get("pricingModel"),
    }

    worst_rank = max(_SAFETY_RANK.get(p["safety"].get("riskLevel", "unknown"), 0) for p in payloads)
    static_hits_total = sum(_safe_int(p["safety"].get("staticHits")) for p in payloads)
    taxonomy_union = sorted({
        tag
        for p in payloads
        for tag in p["safety"].get("staticTaxonomy", [])
    })
    runtime_flags_union = [
        flag for p in payloads for flag in p["safety"].get("runtimeFlags", [])
    ]
    any_evaluated = any(p["safety"].get("evaluated") for p in payloads)
    base["safety"] = {
        "riskLevel": _SAFETY_RANK_REVERSE.get(worst_rank, "unknown"),
        "staticHits": static_hits_total,
        "staticTaxonomy": taxonomy_union,
        "runtimeFlags": runtime_flags_union,
        "evaluated": any_evaluated,
    }

    skill_names = [p.get("skillName", "") for p in payloads if p.get("skillName")]
    base["skillName"] = ", ".join(skill_names)
    base["includedSkills"] = skill_names

    return base


def build_index(
    examples_dir: Path,
    manifest_path: Path,
    pricing_path: Path,
) -> Dict[str, Dict[str, Any]]:
    """Return ``{owner/repo: plugin_payload}`` for every skill in the manifest.

    Skills that the manifest references but whose ``skill_report.json`` is
    missing or unreadable are silently skipped. When several skills share an
    ``owner/repo`` they are aggregated into one repo-level payload.
    """
    manifest = load_manifest(manifest_path)
    pricing = load_pricing(pricing_path)
    grouped: Dict[str, list[Dict[str, Any]]] = {}

    for skill_name, entry in manifest.items():
        report_path = examples_dir / skill_name / "skill_report.json"
        report = _read_json(report_path)
        if not report:
            continue
        owner = entry.get("owner")
        repo = entry.get("repo")
        if not owner or not repo:
            continue
        ctx_entry = dict(entry)
        ctx_entry["_examplesDir"] = str(examples_dir)
        grouped.setdefault(f"{owner}/{repo}", []).append(adapt_report(report, ctx_entry, pricing))

    return {key: aggregate_repo_payloads(payloads) for key, payloads in grouped.items()}


def cli_main(argv: Optional[Iterable[str]] = None) -> int:
    """Quick CLI: render the index to stdout for inspection."""
    import argparse

    parser = argparse.ArgumentParser(description="Adapter: skill_report.json -> plugin shape.")
    parser.add_argument(
        "--examples-dir",
        default=str(Path(__file__).resolve().parent.parent / "Example"),
    )
    parser.add_argument(
        "--manifest",
        default=str(Path(__file__).resolve().parent / "skill_manifest.json"),
    )
    parser.add_argument(
        "--pricing",
        default=str(Path(__file__).resolve().parent / "model_pricing.json"),
    )
    parser.add_argument(
        "--out",
        default="",
        help="If provided, write the index to this path; otherwise print to stdout.",
    )
    args = parser.parse_args(list(argv) if argv is not None else None)

    index = build_index(
        Path(args.examples_dir),
        Path(args.manifest),
        Path(args.pricing),
    )
    rendered = json.dumps(index, ensure_ascii=False, indent=2)

    if args.out:
        Path(args.out).write_text(rendered, encoding="utf-8")
        print(f"Wrote {len(index)} entries -> {args.out}")
    else:
        print(rendered)
    return 0


if __name__ == "__main__":
    raise SystemExit(cli_main())
