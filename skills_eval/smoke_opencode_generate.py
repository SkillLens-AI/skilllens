"""
OpenCode smoke test — task generation.

Reads existing utility_scheme.json files, substitutes `/skill-name` with
plain text so OpenCode's native skill tool can discover and load the skill
automatically (no special invocation syntax needed).

Output: opencode_smoke/<skill_name>/tasks/<task_id>_wi_skills/

Edit SKILLS_TO_TEST to choose which skills to generate.

Usage:
    cd ${SKILLLENS_ROOT}
    python -m skills_eval.smoke_opencode_generate
"""

import json
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "skills_eval"))

from skills_eval.core.fs_utils import copy_skill_to_env
from skills_eval.core.llm_client import assert_dependencies, call_claude_cli_arg
from skills_eval.core.task_id import make_task_id

# ── configure here ────────────────────────────────────────────────────────────
SKILLS_TO_TEST = [
    "editor",
    "legal-advisor",
    "food-safety-manager",
]

SOURCE_DIR  = ROOT / "selected_output"           # where utility_scheme.json lives
SMOKE_DIR   = ROOT / "opencode_smoke"            # output
PROMPT_FILE = ROOT / "skills_eval" / "task_generate" / "system_prompt_utility_task_generation.md"
# ─────────────────────────────────────────────────────────────────────────────


def _patch_instruction(scheme: dict) -> dict:
    """Replace `/skill-name` with plain text for OpenCode.

    OpenCode discovers skills from ~/.config/opencode/skills/ via its native
    skill tool — no special slash or dollar syntax needed.  Replace the
    backtick-slash form with natural language so the agent understands the
    intent and can still locate the skill by name.
    """
    skill_name = scheme.get("skill_name", "")
    instruction = scheme.get("instruction", "")
    patched = instruction.replace(f"`/{skill_name}`", f"the {skill_name} skill")
    return {**scheme, "instruction": patched}


def _generate_task(scheme: dict, info: dict) -> None:
    skill_name  = scheme["skill_name"]
    scenario_id = scheme["scenario_id"]
    task_id     = make_task_id(skill_name, scenario_id, "utility")
    task_name   = f"{task_id}_wi_skills"
    output_dir  = SMOKE_DIR / skill_name / "tasks" / task_name
    log_file    = SMOKE_DIR / skill_name / "logs" / f"{task_name}.log"

    if (output_dir / "task.toml").exists():
        print(f"  [skip] already generated: {task_name}")
        return

    output_dir.mkdir(parents=True, exist_ok=True)

    user_message = (
        f"Generate a complete Harbor task at the path {output_dir}/ "
        f"from this JSON specification. Create all required files "
        f"(task.toml, instruction.md, environment/Dockerfile, tests/test.sh, solution/solve.sh) "
        f"and any additional files needed. Here is the task specification:\n\n"
        f"{json.dumps(scheme, ensure_ascii=False)}"
    )

    call_claude_cli_arg(user_message, PROMPT_FILE, log_file=log_file)

    # Copy skill into environment/skills/
    (output_dir / "environment" / "skills").mkdir(parents=True, exist_ok=True)
    copy_skill_to_env({"info": info}, output_dir)

    print(f"  ✓ {task_name}")


def main() -> None:
    assert_dependencies("claude")
    SMOKE_DIR.mkdir(parents=True, exist_ok=True)

    for skill_name in SKILLS_TO_TEST:
        scheme_file = SOURCE_DIR / skill_name / "utility_scheme.json"
        info_file   = SOURCE_DIR / skill_name / "info.json"

        if not scheme_file.exists():
            print(f"\n[{skill_name}] SKIP — no utility_scheme.json in {SOURCE_DIR}")
            continue

        schemes = json.loads(scheme_file.read_text(encoding="utf-8"))
        info    = json.loads(info_file.read_text(encoding="utf-8")) if info_file.exists() else {}

        print(f"\n[{skill_name}] generating {len(schemes)} scenarios ...")
        for scheme in schemes:
            _generate_task(_patch_instruction(scheme), info)

    print(f"\nDone. Tasks written to: {SMOKE_DIR}")


if __name__ == "__main__":
    main()
