#!/usr/bin/env bash
# The LaunchAgent's program: runs dispatch/launchd/job.ts with Node 24. See dispatch/README.md.
# Usage: dispatch/launchd/job.sh [--dry-run] | deps | halt
#
# This is a thin entrypoint: it sets PATH (launchd gives the job a minimal one) and runs the
# TypeScript job, which reaches the agent container with docker and starts Colima when it is down.
set -euo pipefail

# The fnm default bin dir puts node on PATH, and Homebrew docker and colima; launchd does not read
# ~/.zshenv. Harmless if absent.
export PATH="${EXTRA_PATH:+$EXTRA_PATH:}$HOME/.local/share/fnm/aliases/default/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

clone="$(cd "$(dirname "$0")/../.." && pwd)"
log() { printf '%s %s\n' "$(date '+%F %T')" "$*"; }

if ! command -v node >/dev/null 2>&1; then
  log "node not found on PATH ($PATH); the job needs Node 24; aborting"
  exit 1
fi
major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)
case "$major" in "" | *[!0-9]*) major=0 ;; esac
if [ "$major" -lt 24 ]; then
  log "node $(node --version 2>/dev/null || echo '(unknown version)') at $(command -v node) is too old; the job needs Node 24 or later; aborting"
  exit 1
fi
if [ ! -d "$clone/node_modules" ]; then
  log "dependencies are not installed in $clone (run npm ci there, or rerun dispatch/install-launchd.sh); aborting"
  exit 1
fi
exec node "$clone/dispatch/launchd/job.ts" "$@"
