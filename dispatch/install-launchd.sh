#!/usr/bin/env bash
# Install (or remove) the LaunchAgent that runs dispatch/agent-poller.sh every 3 minutes
# for every repo in the config. Run from the main clone, not a worktree. See dispatch/README.md.
# Usage: dispatch/install-launchd.sh [install|uninstall] [--legacy-label LABEL]... [--migrate-state DIR PREFIX]...
#   --legacy-label LABEL      also boot out and remove an older LaunchAgent (e.g. a single-repo poller)
#   --migrate-state DIR PREFIX  copy launched.json / conflicts.json from an older poller's state dir into
#                             <state>/repos/PREFIX/ (never overwrites), so in-flight tickets are not relaunched
# Test overrides: LAUNCHCTL, LAUNCH_AGENTS_DIR, LOG_DIR, STATE_DIR, CLAUDE_WORKFLOW_CONFIG.
set -euo pipefail

LABEL=com.askrzypczak.claude-workflow-poller
CLONE="$(cd "$(dirname "$0")/.." && pwd)"
LAUNCHCTL="${LAUNCHCTL:-launchctl}"
AGENTS_DIR="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
LOG_DIR="${LOG_DIR:-$HOME/Library/Logs}"
STATE_DIR="${STATE_DIR:-$HOME/.local/state/claude-workflow}"
CONFIG="${CLAUDE_WORKFLOW_CONFIG:-$HOME/.config/claude-workflow/repos.json}"
PLIST="$AGENTS_DIR/$LABEL.plist"
DOMAIN="gui/$(id -u)"

cmd="${1:-install}"
[ $# -eq 0 ] || shift
legacy=()
mig_dirs=()
mig_prefixes=()
while [ $# -gt 0 ]; do
  case "$1" in
    --legacy-label) [ $# -ge 2 ] || { echo "--legacy-label needs a value" >&2; exit 2; }; legacy+=("$2"); shift 2 ;;
    --migrate-state) [ $# -ge 3 ] || { echo "--migrate-state needs DIR PREFIX" >&2; exit 2; }; mig_dirs+=("$2"); mig_prefixes+=("$3"); shift 3 ;;
    *) echo "Usage: $0 [install|uninstall] [--legacy-label LABEL]... [--migrate-state DIR PREFIX]..." >&2; exit 2 ;;
  esac
done

remove_legacy() {
  local l
  for l in ${legacy[@]+"${legacy[@]}"}; do
    "$LAUNCHCTL" bootout "$DOMAIN/$l" 2>/dev/null || true
    rm -f "$AGENTS_DIR/$l.plist"
    echo "Removed legacy job $l."
  done
}

migrate_state() {
  local i src dst f
  for i in ${mig_dirs[@]+"${!mig_dirs[@]}"}; do
    src="${mig_dirs[$i]/#\~/$HOME}"
    dst="$STATE_DIR/repos/${mig_prefixes[$i]}"
    mkdir -p "$dst"
    for f in launched.json conflicts.json; do
      if [ -f "$src/$f" ] && [ ! -e "$dst/$f" ]; then
        cp "$src/$f" "$dst/$f"
        echo "Migrated $src/$f -> $dst/$f"
      fi
    done
  done
}

case "$cmd" in
  install)
    case "$CLONE" in
      */.claude/worktrees/*) echo "Run this from the main clone, not a worktree: $CLONE" >&2; exit 1 ;;
    esac
    if [ ! -f "$CONFIG" ]; then
      echo "No config at $CONFIG. Copy $CLONE/dispatch/repos.example.json there and edit it." >&2
      exit 1
    fi
    mkdir -p "$AGENTS_DIR" "$LOG_DIR"
    # Migrate state and drop the old job before the new one first runs, so nothing is relaunched.
    remove_legacy
    migrate_state
    sed -e "s|__CLONE__|$CLONE|g" -e "s|__HOME__|$HOME|g" "$CLONE/dispatch/launchd/$LABEL.plist" >"$PLIST"
    "$LAUNCHCTL" bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    "$LAUNCHCTL" bootstrap "$DOMAIN" "$PLIST"
    echo "Installed. Log: $LOG_DIR/claude-workflow-poller.log"
    ;;
  uninstall)
    "$LAUNCHCTL" bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    remove_legacy
    echo "Removed."
    ;;
  *) echo "Usage: $0 [install|uninstall] ..." >&2; exit 2 ;;
esac
