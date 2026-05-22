#!/bin/bash
# Validates a Harbor task folder structure.
# Usage: validate.sh <task_directory>
# Exit code = number of errors (0 = pass)

set -uo pipefail

TASK_DIR="${1:?Usage: validate.sh <task_directory>}"
ERRORS=0

check() {
    local desc="$1"
    shift
    if ! "$@" 2>/dev/null; then
        echo "FAIL: $desc"
        ERRORS=$((ERRORS + 1))
    fi
}

# Required files
check "task.toml exists"           test -f "$TASK_DIR/task.toml"
check "instruction.md exists"      test -f "$TASK_DIR/instruction.md"
check "Dockerfile exists"          test -f "$TASK_DIR/environment/Dockerfile"
check "test.sh exists"             test -f "$TASK_DIR/tests/test.sh"

# task.toml content checks
if [ -f "$TASK_DIR/task.toml" ]; then
    check "task.toml contains version" grep -q 'version' "$TASK_DIR/task.toml"
fi

# test.sh content checks
if [ -f "$TASK_DIR/tests/test.sh" ]; then
    check "test.sh references reward file" grep -qE 'reward\.(txt|json)' "$TASK_DIR/tests/test.sh"
fi

# Dockerfile content checks
if [ -f "$TASK_DIR/environment/Dockerfile" ]; then
    check "Dockerfile starts with FROM" head -1 "$TASK_DIR/environment/Dockerfile" | grep -q '^FROM'
fi

# instruction.md is non-empty
if [ -f "$TASK_DIR/instruction.md" ]; then
    check "instruction.md is non-empty" test -s "$TASK_DIR/instruction.md"
fi

# Report NEEDS_HUMAN status (informational, not an error)
if [ -f "$TASK_DIR/NEEDS_HUMAN.md" ]; then
    MARKER_COUNT=$(grep -r "NEEDS_HUMAN:" "$TASK_DIR" --include="*.sh" --include="*.py" --include="*.toml" --include="Dockerfile*" 2>/dev/null | wc -l | tr -d ' ')
    echo "INFO: Has NEEDS_HUMAN.md ($MARKER_COUNT inline markers) — requires human review before running"
fi

if [ $ERRORS -eq 0 ]; then
    echo "OK: All structural checks passed for $(basename "$TASK_DIR")"
fi

exit $ERRORS
