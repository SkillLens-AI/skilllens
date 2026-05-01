"""
Utility test scheme generation.

Usage:
    python -m task_scheme.generate
    python -m task_scheme.generate --input-dir /path/to/skills --output-dir /path/to/out
"""

import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

import argparse

from config import TaskSchemeConfig, SKILLS_DIR, OUTPUT_DIR
from core import (
    run,
    call_api,
    parse_response,
    read_skill_md,
    collect_skill_entries,
    get_done_set,
    save_json,
)
from skills_eval.task_scheme.utility_prompts import SYSTEM_PROMPT, USER_PROMPT


# ─────────────────────────────────────────────────────────────────────────────
# Business logic: process a single skill
# ─────────────────────────────────────────────────────────────────────────────

def _make_process_fn(output_dir: Path, cfg: type[TaskSchemeConfig]):
    """
    Factory: build a process_fn with output_dir and cfg injected via closure.
    The resulting process_fn keeps the (entry) -> None signature expected by the runner.
    """
    def process_one(entry: dict) -> None:
        skill_md = read_skill_md(entry["skill_path"])

        raw = call_api(
            user_message=USER_PROMPT.format(skill_md=skill_md),
            system_message=SYSTEM_PROMPT,
            model=cfg.MODEL,
            max_tokens=cfg.MAX_TOKENS,
            api_key=cfg.API_KEY,
            api_base_url=cfg.API_BASE_URL,
        )

        result = parse_response(raw, root_type="array")

        # Save the main result
        save_json(
            result,
            output_dir / entry["skill_name"] / "utility_scheme.json",
            restore_newlines=True,
        )
        # Save the skill metadata
        save_json(
            {k: v for k, v in entry.items()},
            output_dir / entry["skill_name"] / "info.json",
        )

    return process_one


# ─────────────────────────────────────────────────────────────────────────────
# Main entry point
# ─────────────────────────────────────────────────────────────────────────────

def main(input_dir: Path, output_dir: Path, cfg=TaskSchemeConfig) -> None:
    output_dir.mkdir(parents=True, exist_ok=True)

    all_entries  = collect_skill_entries(input_dir)
    done         = get_done_set(output_dir, marker_filename="utility_scheme.json")
    tasks        = [e for e in all_entries if e["skill_name"] not in done]
    tasks.sort(key=lambda e: e["skill_name"])

    print(f"input_dir  : {input_dir}")
    print(f"output_dir : {output_dir}")
    print(f"total      : {len(all_entries)}  done={len(done)}  todo={len(tasks)}")

    if not tasks:
        print("Nothing to do — all skills already processed.")
        return

    process_fn = _make_process_fn(output_dir, cfg)
    run(
        process_fn,
        tasks,
        max_workers=cfg.MAX_WORKERS,
        max_retries=cfg.MAX_RETRIES,
        label="utility_scheme generation",
    )


def _parse_args():
    parser = argparse.ArgumentParser(description="Utility test scheme generation")
    parser.add_argument("--input-dir",  type=Path, default=SKILLS_DIR)
    parser.add_argument("--output-dir", type=Path, default=OUTPUT_DIR)
    return parser.parse_args()


if __name__ == "__main__":
    args = _parse_args()
    main(input_dir=args.input_dir, output_dir=args.output_dir)
