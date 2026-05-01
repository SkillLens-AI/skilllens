"""
LLM client wrapper.

Provides three invocation styles:
1. call_api()            — call via the anthropic SDK (task scheme generation)
2. call_claude_cli()     — call the claude CLI via subprocess + stdin (static scanning)
3. call_claude_cli_arg() — call the claude CLI via subprocess with a positional argument
                           (task generation: the message includes paths and claude must perform filesystem operations directly)

Dependency checks:
- assert_dependencies() — check that the claude CLI and optional external tools are available; raise FileNotFoundError if any are missing

Callers don't need to worry about the underlying differences or implement retries here — retries are the runner's responsibility.
"""

import shutil
import subprocess
from pathlib import Path

import anthropic


# ─────────────────────────────────────────────────────────────────────────────
# SDK invocation
# ─────────────────────────────────────────────────────────────────────────────

def call_api(
    user_message: str,
    system_message: str = "",
    *,
    model: str = "claude-sonnet-4-6",
    max_tokens: int = 16_000,
    api_key: str = "",
    api_base_url: str = "https://api.anthropic.com",
) -> str:
    """
    Issue a single-turn request via the anthropic SDK and return the model's plain-text reply.

    Parameters
    ----------
    user_message   : User message content
    system_message : System prompt; an empty string means none
    model          : Model name
    max_tokens     : Maximum output tokens
    api_key        : Anthropic API key; falls back to the ANTHROPIC_API_KEY environment variable when empty
    api_base_url   : API base URL

    Returns
    -------
    Text content of the model's reply; returns an empty string when the response is empty.

    Raises
    ------
    anthropic.APIError and subclasses (raised by the SDK); caught by the runner's retry logic.
    """
    client = anthropic.Anthropic(
        api_key=api_key or None,   # None -> SDK reads the environment variable automatically
        base_url=api_base_url,
    )

    kwargs: dict = dict(
        model=model,
        max_tokens=max_tokens,
        messages=[{"role": "user", "content": user_message}],
    )
    if system_message:
        kwargs["system"] = system_message

    resp = client.messages.create(**kwargs)
    return resp.content[0].text if resp.content else ""


# ─────────────────────────────────────────────────────────────────────────────
# CLI invocation
# ─────────────────────────────────────────────────────────────────────────────

def call_claude_cli(
    user_message: str,
    prompt_file: Path,
    *,
    log_file: Path | None = None,
) -> str:
    """
    Call the claude CLI via subprocess + stdin and return the stdout text.

    Suitable for scenarios like static scanning where the message is plain text and claude doesn't need filesystem access.

    Parameters
    ----------
    user_message : User message piped through stdin
    prompt_file  : File path for the --append-system-prompt-file argument
    log_file     : When provided, stdout + stderr are written to this file for debugging

    Returns
    -------
    The claude CLI's stdout text.

    Raises
    ------
    FileNotFoundError  Raised when the claude CLI is not on PATH.
    RuntimeError       Raised on a non-zero CLI exit code (includes stderr).
    """
    assert_dependencies("claude")

    cmd = [
        "claude", "-p",
        "--dangerously-skip-permissions",
        "--append-system-prompt-file", str(prompt_file),
    ]
    result = subprocess.run(
        cmd,
        input=user_message,
        capture_output=True,
        text=True,
    )

    if log_file is not None:
        log_file.parent.mkdir(parents=True, exist_ok=True)
        log_file.write_text(
            "=== STDOUT ===\n"
            + (result.stdout or "")
            + "\n=== STDERR ===\n"
            + (result.stderr or ""),
            encoding="utf-8",
        )

    if result.returncode != 0:
        raise RuntimeError(
            f"claude CLI exited with code {result.returncode}.\n"
            f"stderr: {(result.stderr or '').strip()[:500]}"
        )

    return result.stdout or ""


def call_claude_cli_arg(
    user_message: str,
    prompt_file: Path,
    *,
    log_file: Path | None = None,
) -> None:
    """
    Call the claude CLI via subprocess with a positional argument; stdout/stderr go to a log file.

    Suitable for scenarios like task generation where the message contains file paths and claude must directly
    create or modify files; no return value is needed (the result lives on disk).

    Parameters
    ----------
    user_message : Message passed to the claude CLI as a positional argument
    prompt_file  : File path for the --append-system-prompt-file argument
    log_file     : When provided, stdout + stderr are written to this file; output is discarded when None

    Raises
    ------
    FileNotFoundError  Raised when the claude CLI is not on PATH.
    RuntimeError       Raised on a non-zero CLI exit code (the message points to the log path).
    """
    assert_dependencies("claude")

    cmd = [
        "claude", "-p",
        "--dangerously-skip-permissions",
        "--append-system-prompt-file", str(prompt_file),
        user_message,
    ]

    if log_file is not None:
        log_file.parent.mkdir(parents=True, exist_ok=True)
        with open(log_file, "w", encoding="utf-8") as lf:
            result = subprocess.run(cmd, stdout=lf, stderr=lf)
    else:
        result = subprocess.run(cmd, capture_output=True)

    if result.returncode != 0:
        detail = f"See log: {log_file}" if log_file else f"exit code {result.returncode}"
        raise RuntimeError(f"claude CLI failed. {detail}")


# ─────────────────────────────────────────────────────────────────────────────
# Dependency checks
# ─────────────────────────────────────────────────────────────────────────────

def assert_dependencies(*tools: str) -> None:
    """
    Check that the named external tools exist on PATH; return silently when all are present.

    Parameters
    ----------
    *tools : Tool names, e.g. assert_dependencies("claude", "jq")

    Raises
    ------
    FileNotFoundError  Raised when any tool is missing; the message identifies which one.
    """
    for tool in tools:
        if not shutil.which(tool):
            raise FileNotFoundError(
                f"Required tool '{tool}' not found in PATH. "
                f"Please install it before proceeding."
            )