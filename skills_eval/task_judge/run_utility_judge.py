"""
Utility LLM Judge batch entry point.

Usage:
    python -m task_judge.run_utility_judge

Workflow:
    1. Call judge_collector to gather every JudgeEntry (Ux + wi/wo paths)
    2. Filter out entries missing wi_path
    3. Use the runner to execute judge_logic.utility_judge_one_entry in parallel
    4. Write each result to RESULT_DIR/<skill_name>/judges/<scenario_id>_judge.json
    5. Aggregate into RESULT_DIR/<skill_name>/skill_report.json
    6. Write the summary file RESULT_DIR/utility_judge_summary.json

Scoring scheme (two independent dimensions; not combined into a single overall score):

  pass_rate_gain (effectiveness)
  ┌──────────────────────────────────────────────────────────────┐
  │  Precondition: wi_skill_matched=True and wo_skill_matched=True │
  │  wi_passed = 0                → 0                           │
  │  0 < wi_passed ≤ wo_passed   → 0                           │
  │  wi_passed > wo_passed        → (wi-wo) / total_items       │
  └──────────────────────────────────────────────────────────────┘

  efficiency_score (efficiency)
  ┌──────────────────────────────────────────────────────────────┐
  │  Precondition: wi_passed > 0 and wo_passed > 0                  │
  │  time_score  = clamp((wo_time  - wi_time)  / wo_time,  0, 0.5) / 0.5│
  │  token_score = clamp((wo_token - wi_token) / wo_token, 0, 0.5) / 0.5│
  │  efficiency_score = (time_score + token_score) / 2          │
  │  Returns null when the precondition is not met                  │
  └──────────────────────────────────────────────────────────────┘
"""

import argparse
import json
import sys
from pathlib import Path

# Ensure the project root is on sys.path (supports running from the project root or task_judge/)
_HERE = Path(__file__).resolve().parent
_ROOT = _HERE.parent
if str(_ROOT) not in sys.path:
    sys.path.insert(0, str(_ROOT))

from config import JudgeConfig
from skills_eval.core.runner import run
from skills_eval.core.judge_collector import collect_judge_entries
from skills_eval.core.fs_utils import save_json
from skills_eval.task_judge.judge_logic import utility_judge_one_entry


# ─────────────────────────────────────────────────────────────────────────────
# process_fn (passed to the runner)
# ─────────────────────────────────────────────────────────────────────────────

def _make_process_fn(result_dir: Path, cfg: JudgeConfig):
    """Factory: return a closure that captures result_dir and cfg."""

    def process_fn(entry: dict) -> None:
        result = utility_judge_one_entry(
            entry,
            model=cfg.MODEL,
            max_tokens=cfg.MAX_TOKENS,
            api_key=cfg.API_KEY,
            api_base_url=cfg.API_BASE_URL,
        )

        # Save a single result using folder_name (the actual folder name) rather than skill_name
        folder_name = entry.get("folder_name", entry["skill_name"])
        scenario_id = entry["scenario_id"]
        out_path = result_dir / folder_name / "judges" / f"{scenario_id}_judge.json"
        save_json(result, out_path)

        # If the judgement errored, raise an exception so the runner retries
        if result.get("error"):
            raise RuntimeError(f"judge failed: {result['error']}")

    return process_fn


# ─────────────────────────────────────────────────────────────────────────────
# Summary
# ─────────────────────────────────────────────────────────────────────────────

def _write_summary(result_dir: Path) -> None:
    """Scan the utility results under result_dir/judges/ and generate the summary file."""
    all_results = []
    for judge_file in sorted(result_dir.rglob("judges/*_judge.json")):
        try:
            data = json.loads(judge_file.read_text(encoding="utf-8"))
            if "wi_passed_items" in data or "wo_passed_items" in data:
                all_results.append(data)
        except Exception as e:
            print(f"[summary] Skipping invalid file {judge_file}: {e}")

    if not all_results:
        print("[summary] No judgement results found; skipping summary")
        return

    # Group by skill_name
    skill_stats: dict[str, dict] = {}
    for r in all_results:
        sn = r.get("skill_name", "unknown")
        if sn not in skill_stats:
            skill_stats[sn] = {
                "skill_name":        sn,
                "scenario_count":    0,
                "total_items":       0,
                "wi_passed_items":   0,
                "wo_passed_items":   0,
                "wi_skill_matched":  0,
                "wo_skill_matched":  0,
                "scenarios":         [],
            }

        sc = skill_stats[sn]
        sc["scenario_count"]   += 1
        sc["total_items"]      += r.get("total_items", 0)
        sc["wi_passed_items"]  += r.get("wi_passed_items", 0)
        sc["wo_passed_items"]  += r.get("wo_passed_items", 0)
        sc["wi_skill_matched"] += 1 if r.get("wi_skill_matched") else 0
        sc["wo_skill_matched"] += 1 if r.get("wo_skill_matched") else 0

        # Scenario-level scoring: computed on the fly
        scenario_scores = _compute_scenario_scores(r)
        sc["scenarios"].append({
            "scenario_id":              r.get("scenario_id"),
            "valid":                    scenario_scores["valid"],
            "pass_rate_gain":           scenario_scores["pass_rate_gain"],
            "efficiency_score":         scenario_scores["efficiency_score"],
            "time_score":               scenario_scores["time_score"],
            "token_score":              scenario_scores["token_score"],
            "wi_passed":                r.get("wi_passed_items", 0),
            "wo_passed":                r.get("wo_passed_items", 0),
            "total_items":              r.get("total_items", 0),
            "wi_agent_execuation_time": r.get("wi_agent_execuation_time"),
            "wo_agent_execuation_time": r.get("wo_agent_execuation_time"),
            "wi_token_consumption":     r.get("wi_token_consumption"),
            "wo_token_consumption":     r.get("wo_token_consumption"),
            "wi_skill_matched":         r.get("wi_skill_matched", False),
            "wo_skill_matched":         r.get("wo_skill_matched", False),
            "error":                    r.get("error"),
        })

    summary = {
        "total_entries": len(all_results),
        "skills":        list(skill_stats.values()),
    }

    summary_path = result_dir / "utility_judge_summary.json"
    save_json(summary, summary_path)
    print(f"\n[summary] Wrote: {summary_path}")
    print(f"[summary] {len(all_results)} judgement(s) across {len(skill_stats)} skill(s)")

    for sn, stat in skill_stats.items():
        n = stat["scenario_count"]
        t = stat["total_items"]
        valid_sc = [s for s in stat["scenarios"] if s["valid"]]
        eff_sc   = [s for s in valid_sc if s["efficiency_score"] is not None]
        avg_prg  = (
            round(sum(s["pass_rate_gain"] for s in valid_sc) / len(valid_sc), 4)
            if valid_sc else None
        )
        avg_eff  = (
            round(sum(s["efficiency_score"] for s in eff_sc) / len(eff_sc), 4)
            if eff_sc else None
        )
        print(
            f"  {sn}: scenarios={n}  "
            f"pass_rate_gain={avg_prg}  "
            f"efficiency_score={avg_eff}  "
            f"wi={stat['wi_passed_items']}/{t}  "
            f"wo={stat['wo_passed_items']}/{t}  "
            f"wi_skill_matched={stat['wi_skill_matched']}/{n}  "
            f"wo_skill_matched={stat['wo_skill_matched']}/{n}"
        )


def _compute_scenario_scores(data: dict) -> dict:
    """
    Compute pass_rate_gain and efficiency_score for a single scenario's judge result.

    Returns
    -------
    dict containing the following fields:
        valid             : bool
        invalid_reason    : str | None
        pass_rate_gain    : float | None   ([0, 1] when valid)
        efficiency_score  : float | None   ([0, 1] when the precondition is met, otherwise null)
        time_score        : float | None
        token_score       : float | None
        wi_passed         : int | None
        wo_passed         : int | None
        total_items       : int | None
    """
    scenario_id = data.get("scenario_id", "")

    # ── LLM judge failure detection (takes precedence over the validity check)
    if data.get("error"):
        return {
            "scenario_id":     scenario_id,
            "valid":           False,
            "invalid_reason":  f"judge_failed: {data['error']}",
            "pass_rate_gain":  None,
            "efficiency_score": None,
            "time_score":      None,
            "token_score":     None,
            "wi_passed":       None,
            "wo_passed":       None,
            "total_items":     None,
        }

    # ── Validity check
    # wi_skill_matched=True: wi actually invoked the skill (matches expectation)
    # wo_skill_matched=True: wo did not invoke the skill (matches expectation)
    wi_matched = data.get("wi_skill_matched", False)
    wo_matched = data.get("wo_skill_matched", False)

    if not (wi_matched is True and wo_matched is True):
        parts = []
        if wi_matched is not True:
            parts.append(f"wi_skill_matched={wi_matched} (expected True; wi did not invoke the skill as expected)")
        if wo_matched is not True:
            parts.append(f"wo_skill_matched={wo_matched} (expected True; wo did not skip the skill as expected)")
        return {
            "scenario_id":     scenario_id,
            "valid":           False,
            "invalid_reason":  "; ".join(parts),
            "pass_rate_gain":  None,
            "efficiency_score": None,
            "time_score":      None,
            "token_score":     None,
            "wi_passed":       None,
            "wo_passed":       None,
            "total_items":     None,
        }

    total     = data.get("total_items", 0)
    wi_passed = data.get("wi_passed_items", 0)
    wo_passed = data.get("wo_passed_items", 0)

    # ── Dimension 1: pass_rate_gain
    if total > 0 and wi_passed > wo_passed:
        pass_rate_gain = (wi_passed - wo_passed) / total
    else:
        pass_rate_gain = 0.0

    # ── Dimension 2: efficiency_score
    # Precondition: both wi and wo completed at least one item; otherwise efficiency comparison is meaningless
    wi_time = data.get("wi_agent_execuation_time") or 0.0
    wo_time = data.get("wo_agent_execuation_time") or 0.0

    wi_tc  = data.get("wi_token_consumption") or {}
    wo_tc  = data.get("wo_token_consumption") or {}
    wi_eff = (wi_tc.get("n_input_tokens") or 0) - (wi_tc.get("n_cache_tokens") or 0)
    wo_eff = (wo_tc.get("n_input_tokens") or 0) - (wo_tc.get("n_cache_tokens") or 0)

    if wi_passed > 0 and wo_passed > 0:
        time_score = (
            max(0.0, min(0.5, (wo_time - wi_time) / wo_time)) / 0.5
            if wo_time > 0 else 0.0
        )
        token_score = (
            max(0.0, min(0.5, (wo_eff - wi_eff) / wo_eff)) / 0.5
            if wo_eff > 0 else 0.0
        )
        efficiency_score = (time_score + token_score) / 2.0
    else:
        time_score       = None
        token_score      = None
        efficiency_score = None

    return {
        "scenario_id":     scenario_id,
        "valid":           True,
        "invalid_reason":  None,
        "pass_rate_gain":  round(pass_rate_gain, 4),
        "efficiency_score": round(efficiency_score, 4) if efficiency_score is not None else None,
        "time_score":      round(time_score,  4) if time_score  is not None else None,
        "token_score":     round(token_score, 4) if token_score is not None else None,
        "wi_passed":       wi_passed,
        "wo_passed":       wo_passed,
        "total_items":     total,
    }


def _compute_utility_score(details: list[dict]) -> dict:
    """
    Aggregate scoring across all scenario judge results for a single skill.

    Returns
    -------
    dict containing the following fields:
        pass_rate_gain            : float | None   (mean across valid scenarios)
        efficiency_score          : float | None   (mean across scenarios meeting the precondition)
        valid_scenario_count      : int
        invalid_scenario_count    : int
        efficiency_scenario_count : int
        scenarios                 : list[dict]
        invalid_scenarios         : list[dict]
    """
    scenario_results: list[dict] = []
    for data in details:
        scenario_results.append(_compute_scenario_scores(data))

    valid_results   = [s for s in scenario_results if s["valid"]]
    invalid_results = [s for s in scenario_results if not s["valid"]]

    # pass_rate_gain: mean across all valid scenarios
    if valid_results:
        avg_pass_rate_gain = round(
            sum(s["pass_rate_gain"] for s in valid_results) / len(valid_results), 4
        )
    else:
        avg_pass_rate_gain = None

    # efficiency_score: mean across scenarios with wi_passed>0 and wo_passed>0
    eff_results = [s for s in valid_results if s["efficiency_score"] is not None]
    if eff_results:
        avg_efficiency_score = round(
            sum(s["efficiency_score"] for s in eff_results) / len(eff_results), 4
        )
    else:
        avg_efficiency_score = None

    return {
        "pass_rate_gain":            avg_pass_rate_gain,
        "efficiency_score":          avg_efficiency_score,
        "valid_scenario_count":      len(valid_results),
        "invalid_scenario_count":    len(invalid_results),
        "efficiency_scenario_count": len(eff_results),
        "scenarios":                 scenario_results,
        "invalid_scenarios": [
            {"scenario_id": s["scenario_id"], "reason": s["invalid_reason"]}
            for s in invalid_results
        ],
    }


def _aggregate_skill_reports(result_dir: Path) -> None:
    """
    Scan every <skill_name>/judges/Ux_judge.json under result_dir,
    aggregating into <skill_name>/skill_report.json.

    Structure of skill_report.json:
    {
        "skill_name": str,
        "utility": {
            "scenario_num": int,
            "total_items": int,
            "wi_passed_items": int,
            "wo_passed_items": int,
            "wi_agent_execuation_time": float,   # seconds (summed across scenarios)
            "wo_agent_execuation_time": float,
            "wi_token_consumption": {
                "n_input_tokens": int,
                "n_cache_tokens": int,
                "n_output_tokens": int,
            },
            "wo_token_consumption": {...},
            "wi_skill_expected": int,   # count where wi_skill_expected=True
            "wo_skill_expected": int,   # count where wo_skill_expected=True
            "details": [raw Ux_judge data ...],
        },
        "security": {}
    }
    """
    # Find every skill_name directory
    skill_dirs = [
        d for d in result_dir.iterdir()
        if d.is_dir() and d.name not in ("jobs", "__pycache__")
    ]

    for skill_dir in sorted(skill_dirs):
        judges_dir = skill_dir / "judges"
        if not judges_dir.is_dir():
            continue

        # Collect every Ux_judge.json
        judge_files = sorted(judges_dir.glob("U*_judge.json"))
        if not judge_files:
            continue

        all_details: list[dict] = []
        scenario_num = 0
        total_items = 0
        wi_passed_items = 0
        wo_passed_items = 0
        wi_agent_execuation_time = 0.0
        wo_agent_execuation_time = 0.0
        wi_input_tokens = 0
        wi_cache_tokens = 0
        wi_output_tokens = 0
        wo_input_tokens = 0
        wo_cache_tokens = 0
        wo_output_tokens = 0
        wi_skill_matched_count = 0
        wo_skill_matched_count = 0

        for jf in judge_files:
            try:
                data = json.loads(jf.read_text(encoding="utf-8"))
            except Exception as e:
                print(f"[skill_report] Skipping invalid file {jf}: {e}")
                continue

            all_details.append(data)
            scenario_num += 1
            total_items += data.get("total_items", 0)
            wi_passed_items += data.get("wi_passed_items", 0)
            wo_passed_items += data.get("wo_passed_items", 0)
            wi_agent_execuation_time += data.get("wi_agent_execuation_time", 0) or 0
            wo_agent_execuation_time += data.get("wo_agent_execuation_time", 0) or 0

            wi_tc = data.get("wi_token_consumption") or {}
            wo_tc = data.get("wo_token_consumption") or {}
            wi_input_tokens += wi_tc.get("n_input_tokens", 0) or 0
            wi_cache_tokens += wi_tc.get("n_cache_tokens", 0) or 0
            wi_output_tokens += wi_tc.get("n_output_tokens", 0) or 0
            wo_input_tokens += wo_tc.get("n_input_tokens", 0) or 0
            wo_cache_tokens += wo_tc.get("n_cache_tokens", 0) or 0
            wo_output_tokens += wo_tc.get("n_output_tokens", 0) or 0

            if data.get("wi_skill_matched"):
                wi_skill_matched_count += 1
            if data.get("wi_skill_matched"):
                wo_skill_matched_count += 1

        # Read the existing skill_report.json (preserve the security section)
        report_path = skill_dir / "skill_report.json"
        if report_path.exists():
            try:
                report = json.loads(report_path.read_text(encoding="utf-8"))
            except Exception:
                report = {"skill_name": skill_dir.name, "utility": {}, "security": {}}
        else:
            report = {"skill_name": skill_dir.name, "utility": {}, "security": {}}

        report["skill_name"] = skill_dir.name
        # Compute averages (avoiding division by zero)
        _n = scenario_num if scenario_num > 0 else 1
        _scores = _compute_utility_score(all_details)
        report["utility"] = {
            # ── Top-level scoring (two independent dimensions)
            "pass_rate_gain":            _scores["pass_rate_gain"],
            "efficiency_score":          _scores["efficiency_score"],
            # ── Validity statistics
            "valid_scenario_count":      _scores["valid_scenario_count"],
            "invalid_scenario_count":    _scores["invalid_scenario_count"],
            "efficiency_scenario_count": _scores["efficiency_scenario_count"],
            # ── Existing statistics fields preserved verbatim
            "scenario_num":              scenario_num,
            "total_items":               total_items,
            "wi_passed_items":           wi_passed_items,
            "wo_passed_items":           wo_passed_items,
            "wi_agent_execuation_time":  round(wi_agent_execuation_time, 2),
            "wo_agent_execuation_time":  round(wo_agent_execuation_time, 2),
            "wi_avg_execuation_time":    round(wi_agent_execuation_time / _n, 2),
            "wo_avg_execuation_time":    round(wo_agent_execuation_time / _n, 2),
            "wi_token_consumption": {
                "n_input_tokens":         wi_input_tokens,
                "n_cache_tokens":         wi_cache_tokens,
                "n_output_tokens":        wi_output_tokens,
                "n_effective_tokens":     wi_input_tokens - wi_cache_tokens,
                "n_avg_effective_tokens": round((wi_input_tokens - wi_cache_tokens) / _n),
            },
            "wo_token_consumption": {
                "n_input_tokens":         wo_input_tokens,
                "n_cache_tokens":         wo_cache_tokens,
                "n_output_tokens":        wo_output_tokens,
                "n_effective_tokens":     wo_input_tokens - wo_cache_tokens,
                "n_avg_effective_tokens": round((wo_input_tokens - wo_cache_tokens) / _n),
            },
            "wi_skill_matched_count": wi_skill_matched_count,
            "wo_skill_matched_count": wo_skill_matched_count,
            # ── Per-scenario scoring breakdown
            "scenarios":         _scores["scenarios"],
            "invalid_scenarios": _scores["invalid_scenarios"],
            # ── Raw judge data
            "details":           all_details,
        }

        save_json(report, report_path)
        print(
            f"[skill_report] {skill_dir.name}: "
            f"{scenario_num} scenarios, "
            f"pass_rate_gain={_scores['pass_rate_gain']}, "
            f"efficiency_score={_scores['efficiency_score']}, "
            f"wi={wi_passed_items}/{total_items}, "
            f"wo={wo_passed_items}/{total_items}"
        )


# ─────────────────────────────────────────────────────────────────────────────
# Main function
# ─────────────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(description="Utility LLM Judge batch processor")
    parser.add_argument("--skip-missing-wo", action="store_true",
                        help="Skip entries missing wo_path (default: judge anyway)")
    args = parser.parse_args()

    cfg = JudgeConfig()

    result_dir = cfg.RESULT_DIR

    # ── 1. Collect JudgeEntry
    print(f"[main] Collecting JudgeEntry...")
    print(f"  OUTPUT_DIR = {cfg.OUTPUT_DIR}")
    print(f"  JOB_DIR    = {cfg.JOB_DIR}")
    entries = collect_judge_entries(cfg.OUTPUT_DIR, cfg.JOB_DIR)

    if not entries:
        print("[main] No JudgeEntry found; exiting")
        sys.exit(1)

    # ── 2. Filter (wi_path required; wo_path optional)
    valid_entries = []
    skipped = 0
    for e in entries:
        if not e.get("wi_path"):
            print(f"[main] Skipped (wi_path missing): {e['task_key']}")
            skipped += 1
            continue
        if args.skip_missing_wo and not e.get("wo_path"):
            print(f"[main] Skipped (wo_path missing): {e['task_key']}")
            skipped += 1
            continue
        valid_entries.append(e)

    print(f"\n[main] {len(entries)} entries total; {skipped} skipped; {len(valid_entries)} ready to judge")

    if not valid_entries:
        print("[main] No valid entries; exiting")
        sys.exit(1)

    remaining = []
    for e in valid_entries:
        out = result_dir / e["folder_name"] / "judges" / f"{e['scenario_id']}_judge.json"
        if out.is_file():
            print(f"[main] Already complete; skipping: {e['task_key']}")
        else:
            remaining.append(e)

    print(f"[main] Remaining to process: {len(remaining)}\n")

    if not remaining:
        print("[main] All complete")

        _aggregate_skill_reports(result_dir)

        _write_summary(result_dir)
        return

    # ── 4. Execute in parallel
    process_fn = _make_process_fn(result_dir, cfg)
    succeeded, failed = run(
        process_fn,
        remaining,
        max_workers=cfg.MAX_WORKERS,
        # max_workers=1,
        max_retries=cfg.MAX_RETRIES,
        id_key="task_key",
        label="utility judge tasks",
    )

    # Aggregate per <skill_name> into skill_report.json
    _aggregate_skill_reports(result_dir)

    # ── 5. Summarize
    _write_summary(result_dir)


if __name__ == "__main__":
    main()