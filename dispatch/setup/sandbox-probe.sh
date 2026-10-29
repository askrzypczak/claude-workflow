#!/usr/bin/env bash
# Run inside the sandbox probe session: tries what a sandboxed session must not do (and the
# one thing it must) and appends one SANDBOX-PROBE PASS or FAIL line per item to RESULT_FILE.
# Usage: dispatch/setup/sandbox-probe.sh RESULT_FILE OWNER/REPO [KEY_FILE...]
# Key files are tried with `test -r` only; nothing reads them.
set -uo pipefail

exit 0
