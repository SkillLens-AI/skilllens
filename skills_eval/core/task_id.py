"""
Task unique-identifier generation utilities.

Provides stable, reproducible task-id generation, avoiding collisions caused by using only the first 4 chars of skill_name.

ID format:
    <prefix>_<scenario>_<8-char hash>

Examples:
    arti_U1_90d1ffeb    (article-writing, U1)
    boil_U1_a4c2154c    (boiler, U1)
    moto_F-002_5a51988f (motor, F-002)
"""

import hashlib


def make_task_id(skill_name: str, scenario_id: str, run_type: str = "utility") -> str:
    """
    Generate a unique task identifier.

    Parameters
    ----------
    skill_name  : Full skill name (e.g. "article-writing")
    scenario_id  : Scenario id (e.g. "U1", "F-001")
    run_type    : Run type; "utility" or "security"

    Returns
    -------
    str : Task identifier

    Examples
    --------
    >>> make_task_id("article-writing", "U1")
    'arti_U1_90d1ffeb'
    >>> make_task_id("article-writing", "U1")  # Stable: same input, same output
    'arti_U1_90d1ffeb'
    """
    prefix = _sanitize_prefix(skill_name)
    hash_suffix = _make_hash(skill_name, scenario_id, run_type)
    return f"{prefix}_{scenario_id}_{hash_suffix}"


def _sanitize_prefix(skill_name: str) -> str:
    """Convert skill_name to a safe directory-name prefix (first 4 chars, lowercased)."""
    prefix = skill_name[:4].lower()
    sanitized = "".join(c if c.isalnum() else "" for c in prefix)
    if len(sanitized) < 4:
        sanitized = sanitized + "x" * (4 - len(sanitized))
    return sanitized


def _make_hash(skill_name: str, scenario_id: str, run_type: str) -> str:
    """Generate an 8-character hash; identical inputs always yield the same output."""
    raw = f"{skill_name}:{scenario_id}:{run_type}"
    return hashlib.md5(raw.encode("utf-8")).hexdigest()[:8]


# Directory suffix constants
SUFFIX_UTILITY_WI = "_wi_skills"
SUFFIX_UTILITY_WO = "_wo_skills"
SUFFIX_SECURITY = "_run"


def make_run_dir_name(skill_name: str, scenario_id: str, run_type: str) -> str:
    """Generate the run directory name."""
    task_id = make_task_id(skill_name, scenario_id, run_type)
    if run_type == "utility":
        return f"{task_id}_wi_skills"
    else:
        return f"{task_id}_run"
