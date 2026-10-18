#!/usr/bin/env bash
# Poll GitHub for agent-ready tickets in every configured repo and start background
# Claude Code sessions (visible in `claude agents`). Run from launchd. See dispatch/README.md.
# Usage: dispatch/agent-poller.sh [--dry-run]
#
# This is a thin entrypoint: it sets PATH (launchd gives the job a minimal one) and runs
# the TypeScript poller in dispatch/poller/ with Node 24 (type stripping, no build step).
# `exec` keeps this process's pid, which the poller writes into its lock.
set -euo pipefail

# The fnm default bin dir puts node/npm on PATH; launchd does not read ~/.zshenv. Harmless if absent.
export PATH="${EXTRA_PATH:+$EXTRA_PATH:}$HOME/.local/share/fnm/aliases/default/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

if ! command -v node >/dev/null 2>&1; then
  printf '%s %s\n' "$(date '+%F %T')" "node not found on PATH ($PATH); the poller needs Node 24; aborting"
  exit 1
fi
exec node "$(dirname "$0")/poller/main.ts" "$@"
