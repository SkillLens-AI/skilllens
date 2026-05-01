"""Bake docs/artifacts/data/skills/*.json into /lookup-shaped JSON.

The Chrome extension keys panels by ``owner/repo``. The published research
artifacts under ``docs/artifacts/data/skills/`` ship one file per skill with
a richer per-run breakdown. This script collapses the runs into the U/S/C
schema the extension expects and writes the result under
``docs/artifacts/api/`` so it can be served either directly from GitHub
Pages (zero-config mode) or via the local mock server (self-host mode).

Outputs
-------
* ``docs/artifacts/api/lookup/<owner>__<repo>.json`` — one per owner/repo
* ``docs/artifacts/api/index.json`` — listing of available owner/repo keys
"""

from __future__ import annotations

import argparse
import json
import sys
from collections import defaultdict
from pathlib import Path
from typing import Any, Dict, Iterable, List, Optional, Tuple


REPO_ROOT = Path(__file__).resolve().parent.parent
DEFAULT_SKILLS_DIR = REPO_ROOT / "docs" / "artifacts" / "data" / "skills"
DEFAULT_OUT_DIR = REPO_ROOT / "docs" / "artifacts" / "api"

# Owners whose skills all live under a single monorepo. Anything not listed
# here defaults to treating each skill as its own repo (owner/<skill_name>).
# Verified against actual GitHub repositories at build time — if you add a
# new owner here, the per-skill files for that owner collapse into one
# aggregated owner/repo payload.
KNOWN_MONOREPOS: Dict[str, str] = {
    "anthropics": "skills",
    "obra": "superpowers",
    "sickn33": "antigravity-awesome-skills",
    "theneoai": "awesome-skills",
    "k-dense-ai": "scientific-agent-skills",
    "alirezarezvani": "claude-skills",
}

SAFETY_RANK = {"unknown": 0, "low": 1, "medium": 2, "high": 3}
SAFETY_RANK_REVERSE = {v: k for k, v in SAFETY_RANK.items()}
SEVERITY_TO_LEVEL = {
    "N/A": "unknown",
    "": "unknown",
    "L": "low",
    "M": "medium",
    "H": "high",
}


def safe_int(value: Any) -> int:
    try:
        return int(value)
    except (TypeError, ValueError):
        return 0


def safe_float(value: Any) -> float:
    try:
        return float(value)
    except (TypeError, ValueError):
        return 0.0


def safe_div(num: float, den: float) -> Optional[float]:
    if den <= 0:
        return None
    return num / den


def resolve_owner_repo(owner: str, skill_name: str) -> Optional[Tuple[str, str]]:
    """Map (owner, skill_name) to (owner, repo). Skip entries without an owner.

    Both fields are lowercased so the resulting filename matches the URL the
    extension constructs (which also lowercases owner/repo before fetching).
    GitHub treats owner/repo as case-insensitive at resolution time but
    preserves display case, so normalising on disk is the safer invariant.
    """
    owner = (owner or "").strip().lower()
    if not owner:
        return None
    skill_name = (skill_name or "").strip().lower()
    if owner in KNOWN_MONOREPOS:
        return owner, KNOWN_MONOREPOS[owner]
    return owner, skill_name


def classify_severity(label: Any) -> str:
    return SEVERITY_TO_LEVEL.get(str(label or "").strip().upper(), "unknown")


def worst_severity(levels: Iterable[str]) -> str:
    ranks = [SAFETY_RANK.get(level, 0) for level in levels]
    return SAFETY_RANK_REVERSE.get(max(ranks), "unknown") if ranks else "unknown"


def aggregate_utility(util_runs: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Average pass-rate gain across utility-focused runs."""
    if not util_runs:
        return {
            "deltaPassAt1": None,
            "baseline": None,
            "withSkill": None,
            "tasks": 0,
            "items": 0,
            "wiPassedItems": 0,
            "woPassedItems": 0,
        }

    items = sum(safe_int(r.get("total_items")) for r in util_runs)
    wi = sum(safe_int(r.get("wi_passed")) for r in util_runs)
    wo = sum(safe_int(r.get("wo_passed")) for r in util_runs)
    tasks = sum(safe_int(r.get("valid_scenarios")) for r in util_runs)

    baseline = safe_div(wo, items)
    with_skill = safe_div(wi, items)
    delta = (
        with_skill - baseline
        if (baseline is not None and with_skill is not None)
        else None
    )

    return {
        "deltaPassAt1": round(delta, 4) if delta is not None else None,
        "baseline": round(baseline, 4) if baseline is not None else None,
        "withSkill": round(with_skill, 4) if with_skill is not None else None,
        "tasks": tasks,
        "items": items,
        "wiPassedItems": wi,
        "woPassedItems": wo,
    }


def aggregate_safety(sec_runs: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Worst-of severity + summed static findings across security-focused runs."""
    if not sec_runs:
        return {
            "riskLevel": "unknown",
            "staticHits": 0,
            "staticTaxonomy": [],
            "runtimeFlags": [],
            "riskTriggerRate": 0.0,
            "evaluated": False,
        }

    levels = [classify_severity(r.get("overall_severity")) for r in sec_runs]
    static_hits = sum(safe_int(r.get("static_findings")) for r in sec_runs)
    severity_counts = defaultdict(int)
    for r in sec_runs:
        for sev, count in (r.get("by_severity") or {}).items():
            severity_counts[str(sev).upper()] += safe_int(count)

    total_findings = sum(severity_counts.values())
    return {
        "riskLevel": worst_severity(levels),
        "staticHits": static_hits,
        "staticTaxonomy": [],
        "runtimeFlags": [],
        "riskTriggerRate": 0.0,
        "evaluated": bool(levels) and any(l != "unknown" for l in levels)
        or static_hits > 0
        or total_findings > 0,
        "severityCounts": dict(severity_counts),
    }


def aggregate_cost(util_runs: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Average delta-time / delta-tokens across utility runs."""
    if not util_runs:
        return {
            "deltaTimeSec": None,
            "deltaTokens": None,
            "deltaUsd": None,
            "pricingModel": None,
        }

    deltas_time = []
    deltas_tokens = []
    for r in util_runs:
        wi_t = safe_float(r.get("wi_time"))
        wo_t = safe_float(r.get("wo_time"))
        deltas_time.append(wi_t - wo_t)

        wi_tok = r.get("wi_token_consumption") or {}
        wo_tok = r.get("wo_token_consumption") or {}
        if isinstance(wi_tok, dict) and isinstance(wo_tok, dict) and wi_tok and wo_tok:
            wi_total = sum(safe_int(v) for v in wi_tok.values())
            wo_total = sum(safe_int(v) for v in wo_tok.values())
            deltas_tokens.append(wi_total - wo_total)

    avg_time = (
        round(sum(deltas_time) / len(deltas_time), 2) if deltas_time else None
    )
    avg_tokens = (
        int(round(sum(deltas_tokens) / len(deltas_tokens)))
        if deltas_tokens
        else None
    )

    return {
        "deltaTimeSec": avg_time,
        "deltaTokens": avg_tokens,
        "deltaUsd": None,  # token pricing not in artifacts; left for adapter
        "pricingModel": None,
    }


def build_payload(skill_json: Dict[str, Any]) -> Optional[Dict[str, Any]]:
    """Turn one artifact file into one plugin payload, or None if unusable."""
    skill_name = skill_json.get("skill_name") or ""
    owner_raw = skill_json.get("owner") or ""
    mapped = resolve_owner_repo(owner_raw, skill_name)
    if not mapped or not skill_name:
        return None
    owner, repo = mapped

    runs_dict = skill_json.get("runs") or {}
    util_runs = []
    sec_runs = []
    harnesses = set()
    models = set()
    for run_id, run in runs_dict.items():
        if not isinstance(run, dict):
            continue
        axis = run.get("axis") or ""
        utility_block = run.get("utility") or {}
        security_block = run.get("security") or {}
        harness = run.get("harness")
        model = run.get("model")
        if harness:
            harnesses.add(str(harness))
        if model:
            models.add(str(model))

        if axis in ("utility", "both") and isinstance(utility_block, dict):
            util_runs.append(utility_block)
        if axis in ("security", "both") and isinstance(security_block, dict):
            sec_runs.append(security_block)

    return {
        "skillName": skill_name,
        "owner": owner,
        "repo": repo,
        "skillPath": skill_name,
        "category": skill_json.get("category") or "",
        "evaluatedAt": "",
        "commit": "",
        "source": "skilllens_artifacts_v1",
        "utility": aggregate_utility(util_runs),
        "safety": aggregate_safety(sec_runs),
        "cost": aggregate_cost(util_runs),
        "provenance": {
            "harness": sorted(harnesses),
            "model": sorted(models),
            "judgeModel": "",
            "runCount": len(runs_dict),
        },
    }


def aggregate_repo(payloads: List[Dict[str, Any]]) -> Dict[str, Any]:
    """Combine multiple skill payloads sharing one owner/repo (monorepos)."""
    if len(payloads) == 1:
        return payloads[0]

    base = dict(payloads[0])

    # Utility: pooled item counts -> recomputed rates
    total_items = sum(safe_int(p["utility"].get("items")) for p in payloads)
    wi = sum(safe_int(p["utility"].get("wiPassedItems")) for p in payloads)
    wo = sum(safe_int(p["utility"].get("woPassedItems")) for p in payloads)
    tasks = sum(safe_int(p["utility"].get("tasks")) for p in payloads)
    baseline = safe_div(wo, total_items)
    with_skill = safe_div(wi, total_items)
    delta = (
        with_skill - baseline
        if (baseline is not None and with_skill is not None)
        else None
    )
    base["utility"] = {
        "deltaPassAt1": round(delta, 4) if delta is not None else None,
        "baseline": round(baseline, 4) if baseline is not None else None,
        "withSkill": round(with_skill, 4) if with_skill is not None else None,
        "tasks": tasks,
        "items": total_items,
        "wiPassedItems": wi,
        "woPassedItems": wo,
    }

    # Safety: worst-of severity
    worst_rank = max(
        SAFETY_RANK.get(p["safety"].get("riskLevel", "unknown"), 0)
        for p in payloads
    )
    static_hits = sum(safe_int(p["safety"].get("staticHits")) for p in payloads)
    sev_total: Dict[str, int] = defaultdict(int)
    for p in payloads:
        for sev, count in (p["safety"].get("severityCounts") or {}).items():
            sev_total[sev] += safe_int(count)
    base["safety"] = {
        "riskLevel": SAFETY_RANK_REVERSE.get(worst_rank, "unknown"),
        "staticHits": static_hits,
        "staticTaxonomy": [],
        "runtimeFlags": [],
        "riskTriggerRate": 0.0,
        "evaluated": any(p["safety"].get("evaluated") for p in payloads),
        "severityCounts": dict(sev_total),
    }

    # Cost: summed deltas (these are per-skill, so a monorepo's totals stack)
    times = [
        p["cost"].get("deltaTimeSec")
        for p in payloads
        if p["cost"].get("deltaTimeSec") is not None
    ]
    toks = [
        p["cost"].get("deltaTokens")
        for p in payloads
        if p["cost"].get("deltaTokens") is not None
    ]
    base["cost"] = {
        "deltaTimeSec": round(sum(times), 2) if times else None,
        "deltaTokens": int(sum(toks)) if toks else None,
        "deltaUsd": None,
        "pricingModel": None,
    }

    skill_names = [p.get("skillName", "") for p in payloads if p.get("skillName")]
    base["skillName"] = ", ".join(skill_names[:3]) + (
        f" (+{len(skill_names) - 3} more)" if len(skill_names) > 3 else ""
    )
    base["includedSkills"] = skill_names

    harnesses: set[str] = set()
    models: set[str] = set()
    for p in payloads:
        prov = p.get("provenance") or {}
        for h in prov.get("harness") or []:
            harnesses.add(h)
        for m in prov.get("model") or []:
            models.add(m)
    base["provenance"] = {
        "harness": sorted(harnesses),
        "model": sorted(models),
        "judgeModel": "",
        "runCount": sum(
            safe_int((p.get("provenance") or {}).get("runCount")) for p in payloads
        ),
    }

    return base


def _fmt_delta(value: Any) -> str:
    if value is None:
        return "—"
    try:
        v = float(value)
    except (TypeError, ValueError):
        return "—"
    sign = "+" if v > 0 else ("" if v == 0 else "")
    return f"{sign}{v:.3f}"


def _fmt_risk_class(level: str) -> str:
    return {
        "low": "risk-low",
        "medium": "risk-medium",
        "high": "risk-high",
    }.get(level, "risk-unknown")


def render_lookup_html(entries: List[Dict[str, Any]]) -> str:
    """Render a self-contained browseable HTML index of lookup entries."""
    import html as _html

    rows = []
    for e in entries:
        owner = _html.escape(str(e.get("owner", "")))
        repo = _html.escape(str(e.get("repo", "")))
        file_rel = _html.escape(str(e.get("file", "")).rsplit("/", 1)[-1])
        risk = str(e.get("riskLevel") or "unknown")
        delta = e.get("deltaPassAt1")
        rows.append(
            f'<tr>'
            f'<td><a href="./{file_rel}">{owner}/{repo}</a></td>'
            f'<td class="num">{int(e.get("skillCount", 0))}</td>'
            f'<td class="num">{_html.escape(_fmt_delta(delta))}</td>'
            f'<td><span class="pill {_fmt_risk_class(risk)}">{_html.escape(risk)}</span></td>'
            f'</tr>'
        )

    body_rows = "\n      ".join(rows)
    total = len(entries)
    skills = sum(int(e.get("skillCount", 0)) for e in entries)

    return f"""<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>SkillLens — lookup index ({total} entries)</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta name="robots" content="noindex">
  <style>
    :root {{ color-scheme: light dark; }}
    body {{ font: 14px/1.45 system-ui, sans-serif; max-width: 1000px; margin: 2rem auto; padding: 0 1rem; }}
    h1 {{ font-size: 1.4rem; margin: 0 0 .25rem; }}
    p.lede {{ color: #666; margin: 0 0 1.5rem; }}
    .controls {{ margin: 0 0 .75rem; }}
    .controls input {{ padding: .4rem .55rem; font: inherit; min-width: 18rem; border: 1px solid #ccc; border-radius: 4px; }}
    table {{ border-collapse: collapse; width: 100%; font-size: 13px; }}
    th, td {{ text-align: left; padding: .35rem .5rem; border-bottom: 1px solid #e5e5e5; }}
    th {{ background: #f7f7f7; font-weight: 600; cursor: pointer; user-select: none; }}
    th:hover {{ background: #eee; }}
    td.num {{ text-align: right; font-variant-numeric: tabular-nums; }}
    a {{ color: #2952c5; text-decoration: none; }}
    a:hover {{ text-decoration: underline; }}
    .pill {{ display: inline-block; padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: .04em; }}
    .risk-low {{ background: #d4edda; color: #155724; }}
    .risk-medium {{ background: #fff3cd; color: #856404; }}
    .risk-high {{ background: #f8d7da; color: #721c24; }}
    .risk-unknown {{ background: #eaeaea; color: #555; }}
    footer {{ margin: 2rem 0 0; color: #888; font-size: 12px; }}
  </style>
</head>
<body>
  <h1>SkillLens lookup index</h1>
  <p class="lede">
    {total} owner/repo entries · {skills} skills aggregated.
    Each row links to the per-repo <code>/lookup/&lt;owner&gt;__&lt;repo&gt;.json</code>
    payload the browser extension consumes. Machine-readable form:
    <a href="../index.json"><code>../index.json</code></a>.
  </p>
  <div class="controls">
    <input id="filter" type="search" placeholder="Filter by owner or repo…" autocomplete="off">
  </div>
  <table id="lookup">
    <thead>
      <tr>
        <th data-key="repo">owner / repo</th>
        <th data-key="skillCount" class="num">skills</th>
        <th data-key="delta" class="num">Δ pass@1</th>
        <th data-key="risk">risk</th>
      </tr>
    </thead>
    <tbody>
      {body_rows}
    </tbody>
  </table>
  <footer>
    Generated by <code>scripts/build_lookup_index.py</code> from
    <code>docs/artifacts/data/skills/</code>.
  </footer>
  <script>
    // Client-side filter — no network calls, runs over the rendered rows.
    const input = document.getElementById("filter");
    const rows = Array.from(document.querySelectorAll("#lookup tbody tr"));
    input.addEventListener("input", () => {{
      const q = input.value.trim().toLowerCase();
      for (const tr of rows) {{
        tr.style.display = !q || tr.textContent.toLowerCase().includes(q) ? "" : "none";
      }}
    }});
    // Click-to-sort on column headers.
    const tbody = document.querySelector("#lookup tbody");
    document.querySelectorAll("#lookup th").forEach((th, idx) => {{
      let asc = true;
      th.addEventListener("click", () => {{
        const sorted = rows.slice().sort((a, b) => {{
          const aText = a.children[idx].textContent.trim();
          const bText = b.children[idx].textContent.trim();
          const aNum = parseFloat(aText);
          const bNum = parseFloat(bText);
          if (!isNaN(aNum) && !isNaN(bNum)) return asc ? aNum - bNum : bNum - aNum;
          return asc ? aText.localeCompare(bText) : bText.localeCompare(aText);
        }});
        asc = !asc;
        for (const tr of sorted) tbody.appendChild(tr);
      }});
    }});
  </script>
</body>
</html>
"""


def main(argv: Optional[List[str]] = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--skills-dir",
        default=str(DEFAULT_SKILLS_DIR),
        help="Directory holding per-skill artifact JSON files",
    )
    parser.add_argument(
        "--out-dir",
        default=str(DEFAULT_OUT_DIR),
        help="Where to write the baked /lookup-shaped output",
    )
    args = parser.parse_args(argv)

    skills_dir = Path(args.skills_dir)
    out_dir = Path(args.out_dir)
    lookup_dir = out_dir / "lookup"
    lookup_dir.mkdir(parents=True, exist_ok=True)

    if not skills_dir.exists():
        print(f"ERROR: skills dir not found: {skills_dir}", file=sys.stderr)
        return 1

    grouped: Dict[Tuple[str, str], List[Dict[str, Any]]] = defaultdict(list)
    skipped_no_owner = 0
    failed = 0

    for path in sorted(skills_dir.glob("*.json")):
        try:
            skill_json = json.loads(path.read_text(encoding="utf-8"))
        except (json.JSONDecodeError, OSError) as exc:
            print(f"WARN: cannot read {path.name}: {exc}", file=sys.stderr)
            failed += 1
            continue

        payload = build_payload(skill_json)
        if payload is None:
            skipped_no_owner += 1
            continue
        grouped[(payload["owner"], payload["repo"])].append(payload)

    written: List[Dict[str, Any]] = []
    for (owner, repo), payloads in sorted(grouped.items()):
        merged = aggregate_repo(payloads)
        envelope = {
            "ok": True,
            "status": "ok",
            "evaluation": merged,
            "source": "artifacts",
        }
        filename = f"{owner}__{repo}.json"
        (lookup_dir / filename).write_text(
            json.dumps(envelope, ensure_ascii=False, indent=2),
            encoding="utf-8",
        )
        written.append(
            {
                "owner": owner,
                "repo": repo,
                "file": f"lookup/{filename}",
                "skillCount": len(payloads),
                "deltaPassAt1": merged.get("utility", {}).get("deltaPassAt1"),
                "riskLevel": merged.get("safety", {}).get("riskLevel", "unknown"),
            }
        )

    index = {
        "schema": "skilllens_lookup_index_v1",
        "generatedFrom": str(skills_dir.relative_to(REPO_ROOT)),
        "entries": written,
        "totals": {
            "entries": len(written),
            "skillsProcessed": sum(len(v) for v in grouped.values()),
            "skippedNoOwner": skipped_no_owner,
            "failedReads": failed,
        },
    }
    (out_dir / "index.json").write_text(
        json.dumps(index, ensure_ascii=False, indent=2),
        encoding="utf-8",
    )

    (lookup_dir / "index.html").write_text(
        render_lookup_html(written),
        encoding="utf-8",
    )

    print(
        f"Wrote {len(written)} owner/repo entries "
        f"({index['totals']['skillsProcessed']} skills, "
        f"skipped {skipped_no_owner} without owner, "
        f"{failed} read failures) -> {lookup_dir}"
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
