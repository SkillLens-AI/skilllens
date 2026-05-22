"""
JSON parsing utilities.

Consolidates the two parsing strategies that previously lived in three separate scripts:
- parse_json_tolerant (task scheme scripts; expects list root)
- extract_json (static scan scripts; expects dict root)

Exposes a single public function parse_response(); the root_type argument selects between the strategies.
"""

import json
import re
from typing import Any

try:
    import json5
    _HAS_JSON5 = True
except ImportError:
    _HAS_JSON5 = False


# ─────────────────────────────────────────────────────────────────────────────
# Internal helpers
# ─────────────────────────────────────────────────────────────────────────────

def _strip_fences(text: str) -> str:
    """Strip markdown code-block fences."""
    text = text.strip()
    text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.IGNORECASE)
    text = re.sub(r"\s*```\s*$", "", text)
    return text.strip()


def _fix_string_newlines(text: str) -> str:
    """
    Scan character-by-character and replace bare newlines/tabs inside JSON string values with their legal escape sequences.
    Whitespace in the JSON structure itself (between keys/values) is left untouched.
    """
    result = []
    in_string = False
    escape_next = False

    for ch in text:
        if escape_next:
            result.append(ch)
            escape_next = False
            continue

        if ch == "\\" and in_string:
            escape_next = True
            result.append(ch)
            continue

        if ch == '"':
            in_string = not in_string
            result.append(ch)
            continue

        if in_string:
            if ch == "\n":
                result.append("\\n")
            elif ch == "\r":
                pass  # Drop bare carriage returns
            elif ch == "\t":
                result.append("\\t")
            else:
                result.append(ch)
        else:
            result.append(ch)

    return "".join(result)


def _try_loads(text: str) -> Any:
    """
    Try json.loads then json5.loads in order; return on first success, raise ValueError if both fail.
    """
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass

    if _HAS_JSON5:
        try:
            return json5.loads(text)
        except Exception:
            pass

    raise ValueError("json / json5 both failed")


def _extract_outermost(text: str, open_ch: str, close_ch: str) -> str | None:
    """
    Use bracket counting to extract the first complete {...} or [...] block from text and return it.
    Returns None if no block is found.
    """
    depth = 0
    start = None
    for i, ch in enumerate(text):
        if ch == open_ch:
            if start is None:
                start = i
            depth += 1
        elif ch == close_ch:
            depth -= 1
            if depth == 0 and start is not None:
                return text[start: i + 1]
    return None


# ─────────────────────────────────────────────────────────────────────────────
# Public interface
# ─────────────────────────────────────────────────────────────────────────────

def parse_response(raw: str, root_type: str = "array") -> Any:
    """
    Parse the target JSON structure out of raw LLM-returned text.

    Parameters
    ----------
    raw       : Raw string returned by the LLM
    root_type : "array"  -> expect a list root  (task scheme generation)
                "object" -> expect a dict root  (static scan reports)

    Returns
    -------
    list or dict, depending on root_type.

    Raises
    ------
    ValueError  Raised when all parsing strategies fail.
    """
    if root_type not in ("array", "object"):
        raise ValueError(f"root_type must be 'array' or 'object'; got: {root_type!r}")

    open_ch  = "[" if root_type == "array" else "{"
    close_ch = "]" if root_type == "array" else "}"

    text = _strip_fences(raw)

    # Two attempts: first with newline-repaired text, then with the raw text
    for candidate in [_fix_string_newlines(text), text]:
        # Tier 1: parse directly
        try:
            result = _try_loads(candidate)
            _assert_root_type(result, root_type)
            return result
        except (ValueError, TypeError):
            pass

        # Tier 2: extract the outermost bracket block, then parse
        chunk = _extract_outermost(candidate, open_ch, close_ch)
        if chunk:
            try:
                result = _try_loads(chunk)
                _assert_root_type(result, root_type)
                return result
            except (ValueError, TypeError):
                pass

    raise ValueError(
        f"All JSON parsing strategies failed (expected {root_type}).\n"
        f"First 400 characters of raw content:\n{raw[:400]}"
    )


def _assert_root_type(value: Any, root_type: str) -> None:
    expected = list if root_type == "array" else dict
    if not isinstance(value, expected):
        raise TypeError(
            f"Expected root type {expected.__name__}, got {type(value).__name__}"
        )
