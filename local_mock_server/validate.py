"""Validate adapter output (and overrides.json entries) against schema.json.

Usage::

    python validate.py                          # validate adapter index for Example/
    python validate.py path/to/payload.json     # validate a single payload
    python validate.py --all                    # also validate overrides.json

Exits with code 0 on success, 1 on validation failure. Uses ``jsonschema`` if
installed for full Draft 2020-12 validation; otherwise falls back to a
lightweight structural check covering required fields and primitive types.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path
from typing import Any, Iterable, List, Optional, Tuple


HERE = Path(__file__).resolve().parent
SCHEMA_PATH = HERE / "schema.json"


# ─────────────────────────────────────────────────────────────────────────────
# Validation backends
# ─────────────────────────────────────────────────────────────────────────────


def _validate_with_jsonschema(payload: dict, schema: dict) -> List[str]:
    try:
        import jsonschema  # type: ignore
    except ImportError:
        return _validate_structural(payload, schema)

    validator = jsonschema.Draft202012Validator(schema)
    errors = sorted(validator.iter_errors(payload), key=lambda e: list(e.absolute_path))
    return [f"{'/'.join(str(p) for p in err.absolute_path) or '<root>'}: {err.message}" for err in errors]


_PY_TYPES = {
    "string": str,
    "integer": int,
    "number": (int, float),
    "boolean": bool,
    "array": list,
    "object": dict,
    "null": type(None),
}


def _types_for(spec: Any) -> tuple:
    if isinstance(spec, list):
        flat: list = []
        for entry in spec:
            t = _PY_TYPES.get(entry)
            if isinstance(t, tuple):
                flat.extend(t)
            elif t is not None:
                flat.append(t)
        return tuple(flat)
    t = _PY_TYPES.get(spec)
    if t is None:
        return ()
    return t if isinstance(t, tuple) else (t,)


def _walk(payload: Any, schema: Any, path: str, errors: List[str]) -> None:
    if not isinstance(schema, dict):
        return

    expected_types = schema.get("type")
    if expected_types is not None:
        py_types = _types_for(expected_types)
        if py_types and not isinstance(payload, py_types):
            errors.append(f"{path or '<root>'}: expected {expected_types}, got {type(payload).__name__}")
            return

    if isinstance(payload, dict) and isinstance(schema.get("properties"), dict):
        for key in schema.get("required", []) or []:
            if key not in payload:
                errors.append(f"{path or '<root>'}: missing required field '{key}'")
        for key, sub_schema in schema["properties"].items():
            if key in payload:
                _walk(payload[key], sub_schema, f"{path}/{key}" if path else key, errors)

    if isinstance(payload, list) and isinstance(schema.get("items"), dict):
        for idx, item in enumerate(payload):
            _walk(item, schema["items"], f"{path}/{idx}" if path else str(idx), errors)

    enum = schema.get("enum")
    if enum is not None and payload not in enum:
        errors.append(f"{path or '<root>'}: value {payload!r} not in enum {enum}")


def _validate_structural(payload: dict, schema: dict) -> List[str]:
    errors: List[str] = []
    _walk(payload, schema, "", errors)
    return errors


# ─────────────────────────────────────────────────────────────────────────────
# Entry-point helpers
# ─────────────────────────────────────────────────────────────────────────────


def load_schema() -> dict:
    return json.loads(SCHEMA_PATH.read_text(encoding="utf-8"))


def validate_payload(payload: dict, schema: dict) -> List[str]:
    return _validate_with_jsonschema(payload, schema)


def collect_payloads(args: argparse.Namespace) -> Iterable[Tuple[str, dict]]:
    if args.payload:
        path = Path(args.payload).resolve()
        data = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(data, dict) and "utility" in data:
            yield (str(path), data)
        elif isinstance(data, dict):
            for key, value in data.items():
                if isinstance(value, dict):
                    yield (f"{path}::{key}", value)
        return

    # Default: build adapter index from Example/ and validate each entry.
    sys.path.insert(0, str(HERE))
    from adapter import build_index  # noqa: WPS433 (intentional local import)

    examples_dir = Path(args.examples_dir).resolve()
    manifest_path = Path(args.manifest).resolve()
    pricing_path = Path(args.pricing).resolve()
    index = build_index(examples_dir, manifest_path, pricing_path)
    for key, payload in index.items():
        yield (f"adapter::{key}", payload)

    if args.include_overrides:
        overrides_path = Path(args.overrides).resolve()
        if overrides_path.exists():
            data = json.loads(overrides_path.read_text(encoding="utf-8")) or {}
            for key, payload in data.items():
                if isinstance(payload, dict):
                    yield (f"override::{key}", payload)


def main(argv: Optional[Iterable[str]] = None) -> int:
    parser = argparse.ArgumentParser(description="Validate /lookup payloads against schema.json.")
    parser.add_argument("payload", nargs="?", default="", help="Optional path to a JSON file to validate.")
    parser.add_argument("--examples-dir", default=str(HERE.parent / "Example"))
    parser.add_argument("--manifest", default=str(HERE / "skill_manifest.json"))
    parser.add_argument("--pricing", default=str(HERE / "model_pricing.json"))
    parser.add_argument("--overrides", default=str(HERE / "overrides.json"))
    parser.add_argument(
        "--all",
        dest="include_overrides",
        action="store_true",
        help="Also validate overrides.json entries.",
    )
    args = parser.parse_args(list(argv) if argv is not None else None)

    schema = load_schema()
    backend = "jsonschema" if _has_jsonschema() else "structural-fallback"
    print(f"[validate] backend: {backend}")

    total = 0
    failed = 0
    for label, payload in collect_payloads(args):
        total += 1
        errors = validate_payload(payload, schema)
        if errors:
            failed += 1
            print(f"[FAIL] {label}")
            for err in errors:
                print(f"   - {err}")
        else:
            print(f"[ OK ] {label}")

    print(f"\n[validate] {total - failed}/{total} passed")
    return 0 if failed == 0 else 1


def _has_jsonschema() -> bool:
    try:
        import jsonschema  # noqa: F401
        return True
    except ImportError:
        return False


if __name__ == "__main__":
    raise SystemExit(main())
