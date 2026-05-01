"""
Generic concurrent batch processing framework.

Callers only need to supply:
    process_fn(entry: dict) -> None   # Pure business logic; no retries, no progress reporting

The runner handles:
    - Concurrent scheduling (ThreadPoolExecutor)
    - Retries (exponential backoff)
    - Progress display (with ETA)
    - Success / failure statistics
    - Final summary output

Usage example:
    from core.runner import run

    def process_one(entry):
        skill_md = fs_utils.read_skill_md(entry["skill_path"])
        raw = llm_client.call_api(PROMPT.format(skill_md=skill_md), SYSTEM)
        result = json_utils.parse_response(raw)
        fs_utils.save_json(result, OUTPUT / entry["skill_name"] / "task_scheme.json")

    succeeded, failed = run(process_one, tasks, max_workers=10)
"""

import time
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from typing import Any, Callable


# ─────────────────────────────────────────────────────────────────────────────
# Public entry point
# ─────────────────────────────────────────────────────────────────────────────

def run(
    process_fn: Callable[[dict], None],
    tasks: list[dict],
    *,
    max_workers: int = 10,
    max_retries: int = 3,
    id_key: str = "skill_name",
    label: str = "tasks",
) -> tuple[list[str], list[str]]:
    """
    Execute tasks concurrently, calling process_fn for each, and return the lists of succeeded and failed ids.

    Parameters
    ----------
    process_fn  : Function that processes a single task; signature (entry: dict) -> None.
                  Any raised exception is treated as a failure; the runner handles retry.
    tasks       : Task list; each item is a dict that must contain the id_key field.
    max_workers : Maximum concurrent thread count.
    max_retries : Maximum attempts per task (counting the first try, not just retries).
    id_key      : Field name in entry used as the unique task id; defaults to "skill_name".
    label       : Label used in logs to describe the task type; defaults to "tasks".

    Returns
    -------
    (succeeded, failed) — two lists of ids.
    """
    if not tasks:
        print(f"[runner] No {label} to process.")
        return [], []

    total = len(tasks)
    state = _RunState(total=total)

    _print_header(total=total, max_workers=max_workers, label=label)

    succeeded: list[str] = []
    failed: list[str] = []

    with ThreadPoolExecutor(max_workers=max_workers) as executor:
        futures = {
            executor.submit(
                _execute_with_retry,
                process_fn, entry, state,
                max_retries=max_retries,
                id_key=id_key,
            ): entry
            for entry in tasks
        }
        for future in as_completed(futures):
            entry_id, ok = future.result()
            (succeeded if ok else failed).append(entry_id)

    _print_footer(
        succeeded=succeeded,
        failed=failed,
        start_time=state.start_time,
        label=label,
    )
    return succeeded, failed


# ─────────────────────────────────────────────────────────────────────────────
# Internal state
# ─────────────────────────────────────────────────────────────────────────────

class _RunState:
    """Thread-safe progress and timing state."""

    def __init__(self, total: int) -> None:
        self.total      = total
        self.start_time = time.time()
        self._lock      = threading.Lock()
        self._current   = 0
        self._durations: dict[str, float] = {}  # id -> elapsed seconds

    def increment(self) -> int:
        """Atomically increment the counter and return the new value."""
        with self._lock:
            self._current += 1
            return self._current

    def record_duration(self, entry_id: str, duration: float) -> None:
        with self._lock:
            self._durations[entry_id] = duration

    def eta(self, current: int) -> float:
        """Estimate remaining time (seconds) from the mean duration of completed tasks."""
        with self._lock:
            durations = list(self._durations.values())
        if not durations:
            return 0.0
        avg = sum(durations) / len(durations)
        return max(0.0, (self.total - current) * avg)


# ─────────────────────────────────────────────────────────────────────────────
# Single-task execution (with retry)
# ─────────────────────────────────────────────────────────────────────────────

def _execute_with_retry(
    process_fn: Callable[[dict], None],
    entry: dict,
    state: _RunState,
    *,
    max_retries: int,
    id_key: str,
) -> tuple[str, bool]:
    """
    Run process_fn on a single task; retry with exponential backoff on failure.

    Returns (entry_id, success).
    """
    entry_id = entry.get(id_key, str(entry))
    t0 = time.time()

    for attempt in range(1, max_retries + 1):
        try:
            current = state.increment()
            elapsed = time.time() - state.start_time
            eta     = state.eta(current)

            print(
                f"[{current}/{state.total}] {entry_id}  "
                f"attempt={attempt}  "
                f"elapsed={elapsed:.0f}s  "
                f"eta={eta:.0f}s"
            )

            process_fn(entry)

            duration = time.time() - t0
            state.record_duration(entry_id, duration)
            print(f"[✓] {entry_id}  ({duration:.1f}s)")
            return entry_id, True

        except Exception as exc:
            print(f"[!] {entry_id}  attempt {attempt}/{max_retries}: {exc}")
            if attempt == max_retries:
                duration = time.time() - t0
                state.record_duration(entry_id, duration)
                print(f"[✗] {entry_id}: max retries reached, skipping.")
                return entry_id, False
            time.sleep(2 ** (attempt - 1))   # 1s, 2s, 4s ...

    return entry_id, False  # Unreachable, but keeps the type checker happy


# ─────────────────────────────────────────────────────────────────────────────
# Logging
# ─────────────────────────────────────────────────────────────────────────────

def _print_header(*, total: int, max_workers: int, label: str) -> None:
    print("=" * 72)
    print(f"  {label}")
    print(f"  total={total}  workers={max_workers}")
    print(f"  start={datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
    print("=" * 72)


def _print_footer(
    *,
    succeeded: list[str],
    failed: list[str],
    start_time: float,
    label: str,
) -> None:
    total_time = time.time() - start_time
    total      = len(succeeded) + len(failed)
    avg_time   = total_time / total if total else 0

    print("=" * 72)
    print(f"  {label} done.")
    print(f"  success={len(succeeded)}  failed={len(failed)}")
    print(f"  total={total_time:.1f}s ({total_time / 60:.1f} min)  avg={avg_time:.1f}s/task")
    if failed:
        print(f"\n  Still failed: {failed}")
    print("=" * 72)
