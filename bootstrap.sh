#!/usr/bin/env bash
#
# bootstrap.sh — set up a SkillLens evaluation environment from a clean clone.
#
# What it does:
#   1. Verifies Python >= 3.12 and the `uv` package manager are available.
#   2. Creates a virtualenv via `uv venv`.
#   3. Installs the project (and the pinned Harbor fork) in
#      editable mode.
#   4. Copies .env.example -> .env if .env does not already exist.
#   5. Reminds the user which environment variables still need real values.
#
# Usage:
#   ./bootstrap.sh
#
# Override the Harbor commit at install time (otherwise the placeholder in
# pyproject.toml must be filled in manually):
#   HARBOR_SHA=<commit-sha> ./bootstrap.sh

set -euo pipefail

repo_root="$(cd "$(dirname "$0")" && pwd)"
cd "$repo_root"

log() { printf '[bootstrap] %s\n' "$*"; }
die() { printf '[bootstrap][error] %s\n' "$*" >&2; exit 1; }

# ──────────────────────────────────────────────────────────────────────
# 1. Check Python.
# ──────────────────────────────────────────────────────────────────────
if ! command -v python3 >/dev/null 2>&1; then
    die "python3 not found on PATH. Install Python 3.12+ first."
fi

py_version="$(python3 -c 'import sys; print("%d.%d" % sys.version_info[:2])')"
py_major="${py_version%.*}"
py_minor="${py_version#*.}"
if [ "$py_major" -lt 3 ] || { [ "$py_major" -eq 3 ] && [ "$py_minor" -lt 12 ]; }; then
    die "Python $py_version detected; SkillLens requires >= 3.12."
fi
log "python3 = $py_version OK"

# ──────────────────────────────────────────────────────────────────────
# 2. Check / install uv.
# ──────────────────────────────────────────────────────────────────────
if ! command -v uv >/dev/null 2>&1; then
    log "uv not found; install it via 'pip install uv' or"
    log "  curl -LsSf https://astral.sh/uv/install.sh | sh"
    die "uv missing"
fi
log "uv = $(uv --version) OK"

# ──────────────────────────────────────────────────────────────────────
# 3. Optional: substitute HARBOR_SHA placeholder in pyproject.toml.
# ──────────────────────────────────────────────────────────────────────
if [ -n "${HARBOR_SHA:-}" ]; then
    log "substituting HARBOR_SHA=$HARBOR_SHA into pyproject.toml"
    if grep -q "<HARBOR_SHA>" pyproject.toml; then
        # Portable inline edit via temp file (works on macOS + Linux).
        tmp_pyproject="$(mktemp)"
        sed "s/<HARBOR_SHA>/${HARBOR_SHA}/g" pyproject.toml > "$tmp_pyproject"
        mv "$tmp_pyproject" pyproject.toml
    else
        log "no <HARBOR_SHA> placeholder found in pyproject.toml — skipping"
    fi
fi

if grep -q "<HARBOR_SHA>" pyproject.toml; then
    log "warning: pyproject.toml still contains the <HARBOR_SHA> placeholder."
    log "         pip install will fail until you replace it with a real commit SHA."
    log "         Either rerun with HARBOR_SHA=<sha> ./bootstrap.sh, or edit"
    log "         pyproject.toml manually."
fi

# ──────────────────────────────────────────────────────────────────────
# 4. Create venv and install.
# ──────────────────────────────────────────────────────────────────────
if [ ! -d ".venv" ]; then
    log "creating virtualenv at .venv via uv"
    uv venv
fi

log "installing project in editable mode (this will fetch the Harbor fork)"
uv pip install -e .

# ──────────────────────────────────────────────────────────────────────
# 5. Seed .env from template.
# ──────────────────────────────────────────────────────────────────────
if [ ! -f ".env" ]; then
    if [ -f ".env.example" ]; then
        cp .env.example .env
        log "wrote .env from .env.example — fill in real values before running"
    else
        log "warning: .env.example not found; skipping .env seed"
    fi
else
    log ".env already exists; not overwriting"
fi

# ──────────────────────────────────────────────────────────────────────
# 6. Final reminder.
# ──────────────────────────────────────────────────────────────────────
cat <<'EOF'

────────────────────────────────────────────────────────────────────
Bootstrap complete.

Activate the venv with:
    source .venv/bin/activate           # bash / zsh
    .venv\Scripts\activate               # PowerShell on Windows

Required env vars (see .env.example for full list):
    ANTHROPIC_API_KEY     — judge + scheme generation
    OPENAI_API_KEY        — Codex agent runs
    HARBOR_HOME           — local Harbor checkout
    CODEX_HOME            — Codex skill registration root

Sanity check:
    python -m skills_eval.task_judge.run_utility_judge --help

For a small smoke run:
    python -m skills_eval.smoke_codex_generate
    python -m skills_eval.smoke_codex_run
────────────────────────────────────────────────────────────────────
EOF
