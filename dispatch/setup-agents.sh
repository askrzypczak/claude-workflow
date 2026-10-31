#!/usr/bin/env bash
# Set this machine up for agent sessions: the agents' GitHub token and the repo settings it
# relies on (credentials), then this host's own Claude Code settings (host), then the agent
# container with a deploy key, clone and SSH host alias per served repo, its own gh login, the
# Claude token and the plugin (container), then checks in the container and a probe session
# started in it (check).
# See docs/agent-credentials.md and dispatch/container/README.md.
# Usage: dispatch/setup-agents.sh [credentials|host|container|check] [--dry-run] [--rebuild]
#   With no phase, runs every phase in order and stops at the first step that needs the maintainer.
#   --dry-run  run the reads and print what each step would do; change nothing.
#   --rebuild  container: rebuild the image with --pull --no-cache and replace the container,
#              keeping its home volume; it refuses while a session is live.
# The maintainer runs this in a terminal, never an agent: it reads the tokens and sets up the
# container that confines agent sessions.
#
# This is a thin entrypoint: it sets PATH as dispatch/agent-poller.sh does and runs the
# TypeScript in dispatch/setup/ with Node 24 (type stripping, no build step).
set -euo pipefail

# The poller's PATH, so setup checks with the node and gh the poller uses. Harmless if absent.
export PATH="${EXTRA_PATH:+$EXTRA_PATH:}$HOME/.local/share/fnm/aliases/default/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

clone="$(cd "$(dirname "$0")/.." && pwd)"

if ! command -v node >/dev/null 2>&1; then
  echo "node not found on PATH ($PATH); setup needs Node 24" >&2
  exit 1
fi
major=$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || true)
case "$major" in "" | *[!0-9]*) major=0 ;; esac
if [ "$major" -lt 24 ]; then
  echo "node $(node --version 2>/dev/null || echo '(unknown version)') at $(command -v node) is too old; setup needs Node 24 or later" >&2
  exit 1
fi
if [ ! -d "$clone/node_modules" ]; then
  echo "dependencies are not installed in $clone; run npm ci there, then rerun" >&2
  exit 1
fi
exec node "$clone/dispatch/setup/main.ts" "$@"
