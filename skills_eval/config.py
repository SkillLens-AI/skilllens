"""
Global configuration.
Each subtask only needs to override the paths it cares about; the rest inherit from BaseConfig.
"""

import os
from pathlib import Path

ROOT_DIR    = Path(os.environ.get("SKILLLENS_ROOT", str(Path(__file__).resolve().parent.parent)))
# Directory layout convention: SKILLS_DIR/<category>/<owner>/<skill_name>/SKILL.md
# SKILLS_DIR  = ROOT_DIR / "dataset" / "alternative_skills"      
# OUTPUT_DIR  = ROOT_DIR / "alternative_output"
# JOB_DIR     = ROOT_DIR / "jobs" / "utiity_cc_claude46_alternative_output"

# SKILLS_DIR  = ROOT_DIR / "dataset" / "injected_security_skills"      
# OUTPUT_DIR  = ROOT_DIR / "test_security_output_latest"
# JOB_DIR     = ROOT_DIR / "jobs" / "small_batch"

SKILLS_DIR  = ROOT_DIR / "dataset" / "supplement"
INPUT_DIR   = ROOT_DIR / "merge_output/selected_output_cc_claude"
OUTPUT_DIR  = ROOT_DIR / "merge_output/selected_output_cc_claude"
JOB_DIR     = ROOT_DIR / "merge_output" / "jobs_cc/cc_claude4"


class BaseConfig:
    # ── LLM ──────────────────────────────────────────────────────────────
    API_KEY      = os.environ.get("ANTHROPIC_API_KEY", "")
    API_BASE_URL = "https://api.anthropic.com"
    MODEL        = "claude-sonnet-4-6"
    MAX_TOKENS   = 16_000

    # ── Concurrency ──────────────────────────────────────────────────────
    MAX_WORKERS  = 8
    MAX_RETRIES  = 3


class TaskSchemeConfig(BaseConfig):
    INPUT_DIR   = SKILLS_DIR
    OUTPUT_DIR  = OUTPUT_DIR


class SecuritySchemeConfig(BaseConfig):
    STATIC_SCAN_DIR = ROOT_DIR / "security_reports"
    SKILL_BASE_DIR  = ROOT_DIR / "examples" / "tasks"
    OUTPUT_DIR      = ROOT_DIR / "dataset" / "security_schemes"


class StaticScanConfig(BaseConfig):
    OUTPUT_DIR  = OUTPUT_DIR
    LOGS_DIR    = OUTPUT_DIR
    PROMPT_FILE = Path(__file__).resolve().parent \
                  / "task_scheme" \
                  / "system_prompt_skill_security_static_scanner.md"

class JudgeConfig(BaseConfig):
    OUTPUT_DIR = OUTPUT_DIR
    JOB_DIR    = JOB_DIR
    RESULT_DIR = OUTPUT_DIR

class TaskExecutionConfig(BaseConfig):
    TASK_DIR                 = ROOT_DIR / "merge_output/jobs_cc"
    RETRY_TIMEOUT_SEC        = 3600.0
    NETWORK_RETRY_CONCURRENCY = 1