"""
Filesystem utilities.

Unified API for all file/directory operations:
- Reading SKILL.md
- Traversing skill directories (for utility tests)
- Traversing static scan reports (for security tests)
- Querying completed tasks
- Saving results
"""

import json
from pathlib import Path
from typing import Any

from .task_id import make_task_id, SUFFIX_UTILITY_WI, SUFFIX_UTILITY_WO


# ─────────────────────────────────────────────────────────────────────────────
# SKILL.md reading
# ─────────────────────────────────────────────────────────────────────────────

def read_skill_md(skill_path: str | Path) -> str:
    """
    Read the SKILL.md content from the given directory.

    Raises
    ------
    FileNotFoundError  Raised when SKILL.md does not exist.
    """
    path = Path(skill_path) / "SKILL.md"
    if not path.is_file():
        raise FileNotFoundError(f"SKILL.md not found in {skill_path}")
    return path.read_text(encoding="utf-8")


def find_skill_md(skill_name: str, base_dir: Path) -> str:
    """
    Look up the SKILL.md matching skill_name under base_dir.

    Matching rules:
    - First check whether base_dir itself directly contains SKILL.md
    - Otherwise, search subdirectories recursively for one whose name equals skill_name or has skill_name as a prefix
      (versioned suffixes are supported, e.g. "deep-research-pro-1.0.2" matches "deep-research-pro")

    Returns an empty string when no match is found (no exception; caller decides how to handle).
    """
    if not base_dir.is_dir():
        return ""

    # Directly contains SKILL.md
    direct = base_dir / "SKILL.md"
    if direct.is_file():
        return direct.read_text(encoding="utf-8")

    # Recursive search
    for candidate in sorted(base_dir.rglob("SKILL.md")):
        dir_name = candidate.parent.name
        if dir_name == skill_name or dir_name.startswith(skill_name):
            return candidate.read_text(encoding="utf-8")

    return ""


# ─────────────────────────────────────────────────────────────────────────────
# Task list construction
# ─────────────────────────────────────────────────────────────────────────────

def collect_skill_entries(base: Path) -> list[dict]:
    """
    Scan the skill directory tree and return the list of skills containing SKILL.md.

    Directory layout convention: base/<category>/<owner>/<skill_name>/SKILL.md

    Returns
    -------
    list of dict; each item contains:
        category, owner, skill_name, skill_path
    """
    entries = []
    if not base.is_dir():
        return entries

    for category in base.iterdir():
        if not category.is_dir():
            continue
        for owner in category.iterdir():
            if not owner.is_dir():
                continue
            for skill in owner.iterdir():
                if skill.is_dir() and (skill / "SKILL.md").is_file():
                    entries.append({
                        "category":   category.name,
                        "owner":      owner.name,
                        "skill_name": skill.name,
                        "skill_path": str(skill),
                    })
    return entries


def collect_skill_entries_by_infojson(input_dir: Path) -> list[dict]:
    """
    Scan input_dir and return the list of skills containing info.json.

    Directory layout convention: input_dir/<skill_name>/info.json
    info.json must contain the four fields: category, owner, skill_name, skill_path.

    Returns the same field format as collect_skill_entries to keep downstream processing compatible.

    Returns
    -------
    list of dict; each item contains:
        category, owner, skill_name, skill_path
    """
    entries = []
    seen: set[str] = set()
    if not input_dir.is_dir():
        return entries

    for skill_dir in input_dir.iterdir():
        if not skill_dir.is_dir():
            continue
        info_file = skill_dir / "info.json"
        if not info_file.is_file():
            continue
        try:
            info_data = json.loads(info_file.read_text(encoding="utf-8"))
        except Exception:
            continue

        entry = {
            "category":   info_data.get("category"),
            "owner":      info_data.get("owner"),
            "skill_name": info_data.get("skill_name"),
            "skill_path": info_data.get("skill_path"),
        }
        if all(entry.values()) and entry["skill_name"] not in seen:
            seen.add(entry["skill_name"])
            entries.append(entry)
    return entries

def collect_security_entries(
    scan_dir: Path,
    skill_base_dir: Path,
) -> list[dict]:
    """
    Scan the static scan report directory and return the list of reports containing dynamic_test_queue.

    Reports
    -------
    list of dict; each item contains:
        skill_name, report_path, static_report, skill_md
    """
    entries = []
    if not scan_dir.is_dir():
        return entries

    # Prefer *_latest.json, otherwise any *.json
    json_files = list(scan_dir.rglob("*_latest.json"))
    if not json_files:
        json_files = list(scan_dir.rglob("*.json"))

    for json_path in json_files:
        try:
            data = json.loads(json_path.read_text(encoding="utf-8"))
        except Exception as e:
            print(f"[WARN] Failed to load {json_path}: {e}")
            continue

        queue = data.get("dynamic_test_queue", [])
        if not queue:
            continue  # Skip reports that don't need dynamic verification

        skill_name = data.get("skill", {}).get("name") or json_path.stem
        skill_md   = find_skill_md(skill_name, skill_base_dir)
        if not skill_md:
            print(f"[WARN] SKILL.md not found for: {skill_name}")

        entries.append({
            "skill_name":    skill_name,
            "report_path":   str(json_path),
            "static_report": data,
            "skill_md":      skill_md,
        })

    return entries


# ─────────────────────────────────────────────────────────────────────────────
# Resume support
# ─────────────────────────────────────────────────────────────────────────────

def get_done_set(output_dir: Path, marker_filename: str) -> set[str]:
    """
    Return the set of skill_names whose tasks have completed.

    Determined by checking whether output_dir/<skill_name>/<marker_filename> exists.
    marker_filename is specified by the caller, e.g.:
        "utility_scheme.json"     (utility tests)
        "security_static_scan.json" (security tests)
        "security_scheme.json" (security tests)
    """
    if not output_dir.is_dir():
        return set()
    return {
        d.name
        for d in output_dir.iterdir()
        if d.is_dir() and (d / marker_filename).is_file()
    }


def _strip_task_suffix(task_name: str) -> str:
    """Strip the trailing _wi_skills or _wo_skills suffix from task_name."""
    if task_name.endswith(SUFFIX_UTILITY_WI):
        return task_name.removesuffix(SUFFIX_UTILITY_WI)
    if task_name.endswith(SUFFIX_UTILITY_WO):
        return task_name.removesuffix(SUFFIX_UTILITY_WO)
    return task_name


def get_done_task_set(outputs_dir: Path, marker_filename: str = "task.toml") -> set[str]:
    """
    Return the set of task_names whose tasks have completed.

    Directory layout: outputs_dir/<skill_name>/tasks/<task_name>/
    Verify whether marker_filename exists in each task directory.
    If present, add that task_name (with _wi_skills/_wo_skills suffix stripped) to the returned set.
    """
    if not outputs_dir.is_dir():
        return set()

    done_tasks: set[str] = set()
    for skill_dir in outputs_dir.iterdir():
        if not skill_dir.is_dir():
            continue
        tasks_dir = skill_dir / "tasks"
        if not tasks_dir.is_dir():
            continue
        for task_dir in tasks_dir.iterdir():
            if task_dir.is_dir() and (task_dir / marker_filename).is_file():
                done_tasks.add(_strip_task_suffix(task_dir.name))

    return done_tasks


# ─────────────────────────────────────────────────────────────────────────────
# Result saving
# ─────────────────────────────────────────────────────────────────────────────

def save_json(data: Any, path: Path, *, restore_newlines: bool = False) -> None:
    """
    Serialize data as JSON and write to path; parent directories are created automatically.

    Parameters
    ----------
    data             : Any JSON-serializable object
    path             : Output file path
    restore_newlines : If True, restore literal \\n in instruction fields to real newlines
                       (improves human readability; useful for task scheme generation output)
    """
    if restore_newlines:
        data = _restore_instruction_newlines(data)

    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(
        json.dumps(data, ensure_ascii=False, indent=4),
        encoding="utf-8",
    )


def _restore_instruction_newlines(data: Any) -> Any:
    """Recursively walk list/dict and restore literal \\n in instruction fields to real newlines."""
    if isinstance(data, list):
        return [_restore_instruction_newlines(item) for item in data]
    if isinstance(data, dict):
        return {
            k: (v.replace("\\n", "\n") if k == "instruction" and isinstance(v, str) else v)
            for k, v in data.items()
        }
    return data


def get_skill_name_from_meta(skill_path: Path) -> str:
    """
    Read the displayName or name field from _meta.json as the skill name.
    Falls back to the directory name on failure.
    """
    meta_file = skill_path / "_meta.json"
    if meta_file.exists():
        try:
            meta = json.loads(meta_file.read_text(encoding="utf-8"))
            return meta.get("displayName") or meta.get("name") or skill_path.name
        except Exception:
            pass
    return skill_path.name


# ─────────────────────────────────────────────────────────────────────────────
# utility_scheme.json loader (used for Harbor task generation)
# ─────────────────────────────────────────────────────────────────────────────

def collect_task_entries(dataset_dir: Path, marker: str = "utility_scheme.json") -> list[dict]:
    """
    Scan dataset_dir, collect all task_scheme.json files, and expand them into a list of task entries.

    Expected directory layout: dataset_dir/<skill_name>/task_scheme.json
    If a sibling info.json exists, its content is loaded into entry["info"].

    Each entry contains:
        skill_name   : str   runner unique identifier ("{task_name}_{level_safe}")
        task_name    : str   original skill name
        level        : str   task difficulty level
        level_safe   : str   level name (spaces replaced with underscores; used in directory/file naming)
        source_file  : str   path of task_scheme.json relative to dataset_dir (used for logging)
        scheme       : dict  full task scheme; can be serialized and passed directly to the claude CLI
        info         : dict  contents of the sibling info.json (empty dict if file is absent)

    Invalid or unparseable JSON files emit a WARNING and are skipped without interrupting the overall flow.

    Raises
    ------
    SystemExit  Exit when dataset_dir does not exist or no task_scheme.json is found.
    """
    import re
    import sys

    task_files = sorted(dataset_dir.glob(f"*/{marker}"))
    if not task_files:
        print(f"ERROR: No utility_scheme.json found under {dataset_dir}")
        print("Expected directory layout: <dataset>/<skill_name>/utility_scheme.json")
        sys.exit(1)

    entries = []
    for task_file in task_files:
        task_folder = task_file.parent
        folder_name = task_folder.name

        # Read sibling info.json (optional)
        info_data: dict = {}
        info_file = task_folder / "info.json"
        if info_file.exists():
            try:
                info_data = json.loads(info_file.read_text(encoding="utf-8"))
            except Exception as e:
                print(f"WARNING: Error reading {info_file}: {e}")

        # Parse utility_scheme.json
        try:
            schemes = json.loads(task_file.read_text(encoding="utf-8"))
            if not isinstance(schemes, list):
                schemes = [schemes]
        except Exception as e:
            print(f"WARNING: Skipping invalid JSON file {task_file}: {e}")
            continue

        for scheme in schemes:
            if "skill_name" not in scheme:
                scheme["skill_name"] = folder_name

            skill_name   = scheme["skill_name"]
            scenario_id  = scheme["scenario_id"]
            level        = scheme.get("level", "default")
            level_safe   = re.sub(r" ", "_", level)

            # Determine run_type based on the marker
            run_type = "security" if marker == "security_scheme.json" else "utility"
            task_name = make_task_id(skill_name, scenario_id, run_type)

            entries.append({
                "skill_name":  folder_name,
                "task_name":   task_name,
                "level":       level,
                "level_safe":  level_safe,
                "source_file": str(task_file.relative_to(dataset_dir)),
                "scheme":      scheme,
                "skill_path":  info_data.get("skill_path"),
                "info":        info_data,
                "run_type":    run_type,
            })

    return entries


# ─────────────────────────────────────────────────────────────────────────────
# Skill directory copy (used for Harbor task generation)
# ─────────────────────────────────────────────────────────────────────────────

def copy_skill_to_env(
    entry: dict,
    output_dir: Path,
) -> None:
    """
    Copy the skill directory specified by entry["info"]["skill_path"] to
    output_dir/environment/skills/<skill_name>.

    Raises RuntimeError when skill_path does not exist (the runner handles retry/logging).

    Parameters
    ----------
    entry      : Task entry dict produced by collect_task_entries()
    output_dir : Output directory for the current task (i.e. outputs/<skill_name>/tasks/<task_name>/)
    """
    import shutil

    info_data = entry.get("info", {})
    skill_path_str = info_data.get("skill_path")
    if not skill_path_str:
        return  # Optional field; skip

    skill_path = Path(skill_path_str)
    if not skill_path.is_dir():
        raise RuntimeError(f"skill_path does not exist: {skill_path}")

    info_skill_name = info_data.get("skill_name")
    skills_dest = output_dir / "environment" / "skills" / info_skill_name
    skills_dest.parent.mkdir(parents=True, exist_ok=True)
    shutil.copytree(skill_path, skills_dest, dirs_exist_ok=True)