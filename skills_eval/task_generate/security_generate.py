#!/usr/bin/env python3
"""
Harbor task generation script (parallel).

Batch-generate Harbor task configurations from security_scheme.json.
"""

import argparse
import json
import sys
from pathlib import Path
import shutil

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from config import BaseConfig, OUTPUT_DIR
from core import (
    run,
    call_claude_cli_arg,
    assert_dependencies,
    collect_task_entries,
    copy_skill_to_env,
    save_json,
)

# ─────────────────────────────────────────────────────────────────────────────
# Default paths
# ─────────────────────────────────────────────────────────────────────────────

_DEFAULT_DATASET_DIR = OUTPUT_DIR
_DEFAULT_OUTPUTS_DIR = OUTPUT_DIR
_DEFAULT_LOGS_DIR    = OUTPUT_DIR
_DEFAULT_PROMPT_FILE = Path(__file__).resolve().parent / "system_prompt_security_task_generation.md"
_VALIDATE_SCRIPT     = Path(__file__).resolve().parent / "validate.sh"


# ─────────────────────────────────────────────────────────────────────────────
# Business logic: process a single task
# ─────────────────────────────────────────────────────────────────────────────

def _make_process_fn(outputs_dir: Path, logs_dir: Path, prompt_file: Path):
    """
    Factory: inject path parameters via closure and return a process_fn matching the runner interface.
    process_fn signature: (entry: dict) -> None; raised exceptions are treated as failures and retried by the runner.
    """
    def process_one(entry: dict) -> None:
        task_name  = entry["task_name"]
        run_type   = entry.get("run_type", "security")
        suffix     = "_run" if run_type == "security" else f"_{run_type}_skills"
        output_dir = outputs_dir / f"{entry['skill_name']}" / "tasks" / "security" / f"{task_name}{suffix}"
        log_file   = logs_dir / f"{entry['skill_name']}" / "logs" / f"{task_name}_task_generation.log"

        output_dir.mkdir(parents=True, exist_ok=True)

        # Look up skill_path; fall back to the original security skills directory if missing
        skill_path = entry.get('skill_path')
        if skill_path is None:
            # Default paths: dataset/injected_security_skills/security/security/<skill_name>
            default_base = ROOT / "dataset" / "injected_security_skills" / "security" / "security"
            skill_path = str(default_base / entry['skill_name'])
        path = Path(skill_path) / "SKILL.md"
        if not path.is_file():
            raise FileNotFoundError(f"SKILL.md not found in {skill_path}")
        skill_md = path.read_text(encoding="utf-8")

        # ── 1. Call the claude CLI to generate task files ──────────────────
        user_message = (
            f"Generate a complete Harbor task for security test of the agent skill {entry['skill_name']} at the path {output_dir}/ "
            f"from this JSON specification. Create all required files "
            f"(task.toml, instruction.md, environment/Dockerfile, tests/test.sh, solution/solve.sh) "
            f"and any additional files needed. Here is the task specification:\n\n"
            f"{json.dumps(entry['scheme'], ensure_ascii=False)}"
            f"\n\nHere is the SKILL.md of the agent skill:\n"
            f"--------------------------------"
            f"\n{skill_md}\n"
            f"--------------------------------"
        )
        call_claude_cli_arg(user_message, prompt_file, log_file=log_file)

        # ── 2. Validate the generated output ────────────────────────────────
        if _VALIDATE_SCRIPT.is_file():
            _run_validate(output_dir)

        # ── 3. Copy the skill directory into environment/skills ─────────────
        copy_skill_to_env(entry, output_dir)

    return process_one


def _run_validate(output_dir: Path) -> None:
    """Run validate.sh; raise RuntimeError on non-zero exit (the runner handles retry)."""
    import subprocess
    result = subprocess.run(
        ["bash", str(_VALIDATE_SCRIPT), str(output_dir)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        output = (result.stdout + result.stderr).strip()
        raise RuntimeError(f"Validation failed for {output_dir.name}: {output}")


# ─────────────────────────────────────────────────────────────────────────────
# Post-processing: print a NEEDS_HUMAN status overview
# ─────────────────────────────────────────────────────────────────────────────

def _print_needs_human_overview(outputs_dir: Path) -> None:
    needs_human_count = 0
    print("\n--- Status Overview ---")
    for task_dir in sorted(outputs_dir.glob("*/")):
        if not task_dir.is_dir():
            continue
        nh_file = task_dir / "NEEDS_HUMAN.md"
        if nh_file.exists():
            needs_human_count += 1
            try:
                item_count = sum(
                    1 for line in nh_file.read_text(encoding="utf-8").splitlines()
                    if line.startswith("- [ ]")
                )
            except Exception:
                item_count = 0
            print(f"  {task_dir.name} — NEEDS HUMAN ({item_count} items)")
        else:
            print(f"  {task_dir.name} — ready")

    if needs_human_count > 0:
        print(f"\nWARNING: {needs_human_count} task(s) need human action.")
        print("  Run: bash status.sh          (overview)")
        print("  Run: bash status.sh <task>   (details)")


# ─────────────────────────────────────────────────────────────────────────────
# Main entry point
# ─────────────────────────────────────────────────────────────────────────────

def main(
    dataset_dir: Path,
    outputs_dir: Path,
    logs_dir: Path,
    prompt_file: Path,
    workers: int,
) -> None:
    if not dataset_dir.is_dir():
        print(f"ERROR: Dataset path does not exist: {dataset_dir}")
        sys.exit(1)
    if not prompt_file.is_file():
        print(f"ERROR: System prompt file does not exist: {prompt_file}")
        sys.exit(1)

    assert_dependencies("claude", "jq")

    outputs_dir.mkdir(parents=True, exist_ok=True)
    logs_dir.mkdir(parents=True, exist_ok=True)

    all_entries = collect_task_entries(dataset_dir, marker="security_scheme.json")
    done = {
        d.name for d in outputs_dir.iterdir()
        if d.is_dir() and (d / "tasks" / "security").is_dir()
    }
    tasks       = [e for e in all_entries if e["skill_name"] not in done]

    print(f"dataset_dir : {dataset_dir}")
    print(f"outputs_dir : {outputs_dir}")
    print(f"prompt_file : {prompt_file}")
    print(f"total       : {len(all_entries)}  done={len(done)}  todo={len(tasks)}")

    if not tasks:
        print("Nothing to do — all tasks already generated.")
        return

    process_fn = _make_process_fn(outputs_dir, logs_dir, prompt_file)
    succeeded, failed = run(
        process_fn,
        tasks,
        # max_workers=1,
        max_workers=workers,
        max_retries=BaseConfig.MAX_RETRIES,
        id_key="task_name",
        label="utilitytask generation",
    )

    save_json(
        {"total": len(all_entries), "done_prev": len(done),
         "succeeded": succeeded, "failed": failed},
        logs_dir / "security_task_generation_summary.json",
    )
    print(f"\nSummary saved to: {logs_dir / 'security_task_generation_summary.json'}")

    _print_needs_human_overview(outputs_dir)
    print()
    sys.exit(len(failed))


def _parse_args():
    parser = argparse.ArgumentParser(description="Harbor task generation (parallel)")
    parser.add_argument(
        "dataset_path", type=Path, nargs="?", default=_DEFAULT_DATASET_DIR,
        help="Dataset root directory containing task_scheme.json",
    )
    parser.add_argument("--prompt-file", type=Path, default=_DEFAULT_PROMPT_FILE)
    parser.add_argument("--outputs-dir", type=Path, default=_DEFAULT_OUTPUTS_DIR)
    parser.add_argument("--logs-dir",    type=Path, default=_DEFAULT_LOGS_DIR)
    parser.add_argument("--workers",     type=int,  default=BaseConfig.MAX_WORKERS)
    return parser.parse_args()


if __name__ == "__main__":
    args = _parse_args()
    main(
        dataset_dir=args.dataset_path,
        outputs_dir=args.outputs_dir,
        logs_dir=args.logs_dir,
        prompt_file=args.prompt_file,
        # workers=args.workers,
        workers=13,
    )