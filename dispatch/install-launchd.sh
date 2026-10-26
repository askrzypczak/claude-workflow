#!/usr/bin/env bash
# Install, remove, pause or resume the LaunchAgent that runs dispatch/agent-poller.sh every 3 minutes
# for every repo in the config. Run from the main clone, not a worktree. See dispatch/README.md.
# Usage: dispatch/install-launchd.sh [install|uninstall|pause|resume|status] [--yes] [--purge] [--legacy-label LABEL]... [--migrate-state DIR PREFIX]...
#   pause                     stop polling until resume: disable and boot out the poller (also across logins and reboots).
#                             The plist stays. Sessions already running are not stopped; they are listed with claude stop.
#   resume                    enable and bootstrap the installed plist, so the poller runs now. No npm ci or dry run.
#   status                    print whether the plist is installed and whether the job is loaded and disabled. Exits 0.
#   --yes                     install without the confirmation prompt (the dry run is still shown, and a
#                             failing dry run still aborts). Without it, install runs the poller with
#                             --dry-run, prints what it would launch and asks "Install and start polling? [y/N]".
#   --purge                   uninstall only: also delete the state dir, the config file and the log file
#                             (never live sessions or the plugin; those are listed with the commands to remove them)
#   --legacy-label LABEL      also boot out and remove an older LaunchAgent (e.g. a single-repo poller);
#                             letters, digits, . _ - only
#   --migrate-state DIR PREFIX  copy launched.json / conflicts.json from an older poller's state dir into
#                             <state>/repos/PREFIX/ (never overwrites), so in-flight tickets are not relaunched;
#                             PREFIX is letters, digits, _ - only
# Before the dry run, install runs `npm ci` in the clone: the poller needs its runtime dependencies.
# Test overrides: NPM, POLLER, LAUNCHCTL, LAUNCH_AGENTS_DIR, LOG_DIR, STATE_DIR, CLAUDE_WORKFLOW_CONFIG.
set -euo pipefail

LABEL=com.askrzypczak.claude-workflow-poller
CLONE="$(cd "$(dirname "$0")/.." && pwd)"
LAUNCHCTL="${LAUNCHCTL:-launchctl}"
AGENTS_DIR="${LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}"
LOG_DIR="${LOG_DIR:-$HOME/Library/Logs}"
STATE_DIR="${STATE_DIR:-$HOME/.local/state/claude-workflow}"
CONFIG="${CLAUDE_WORKFLOW_CONFIG:-$HOME/.config/claude-workflow/repos.json}"
POLLER="${POLLER:-$CLONE/dispatch/agent-poller.sh}"
NPM="${NPM:-npm}"
PLIST="$AGENTS_DIR/$LABEL.plist"
DOMAIN="gui/$(id -u)"

cmd="${1:-install}"
[ $# -eq 0 ] || shift
assume_yes=0
purge=0
legacy=()
mig_dirs=()
mig_prefixes=()
while [ $# -gt 0 ]; do
  case "$1" in
    --yes | -y) assume_yes=1; shift ;;
    --purge) purge=1; shift ;;
    --legacy-label)
      [ $# -ge 2 ] || { echo "--legacy-label needs a value" >&2; exit 2; }
      # The label becomes a path ($AGENTS_DIR/LABEL.plist) that is deleted: no separators, not just dots.
      if [[ ! "$2" =~ ^[A-Za-z0-9._-]+$ ]] || [[ "$2" != *[!.]* ]]; then
        echo "Invalid --legacy-label '$2': use letters, digits, '.', '_' and '-' only." >&2; exit 2
      fi
      legacy+=("$2"); shift 2 ;;
    --migrate-state)
      [ $# -ge 3 ] || { echo "--migrate-state needs DIR PREFIX" >&2; exit 2; }
      if [[ ! "$3" =~ ^[A-Za-z0-9_-]+$ ]]; then
        echo "Invalid --migrate-state PREFIX '$3': use letters, digits, '_' and '-' only (a sessionPrefix)." >&2; exit 2
      fi
      mig_dirs+=("$2"); mig_prefixes+=("$3"); shift 3 ;;
    *) echo "Usage: $0 [install|uninstall|pause|resume|status] [--yes] [--purge] [--legacy-label LABEL]... [--migrate-state DIR PREFIX]..." >&2; exit 2 ;;
  esac
done
if [ "$purge" = 1 ] && [ "$cmd" != uninstall ]; then
  echo "--purge only applies to uninstall." >&2; exit 2
fi
case "$cmd" in
  pause | resume | status)
    [ ${#legacy[@]} -eq 0 ] || { echo "--legacy-label does not apply to $cmd." >&2; exit 2; }
    [ ${#mig_dirs[@]} -eq 0 ] || { echo "--migrate-state does not apply to $cmd." >&2; exit 2; }
    ;;
esac

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

# replace_all STRING PATTERN REPLACEMENT -> $REPLY, all literal. Not ${s//p/r}: a '&' in the
# replacement means "the match" in bash 5.2 and a quoted one keeps its quotes in bash 3.2 (macOS).
replace_all() {
  local s="$1" pat="$2" out=""
  while [[ "$s" == *"$pat"* ]]; do
    out="$out${s%%"$pat"*}$3"
    s="${s#*"$pat"}"
  done
  REPLY="$out$s"
}

# Escape a value for an XML text node ('&' first so the others are not double-escaped) -> $REPLY.
xml_escape() {
  replace_all "$1" '&' '&amp;'
  replace_all "$REPLY" '<' '&lt;'
  replace_all "$REPLY" '>' '&gt;'
}

# Fill the plist template into $PLIST via a temp file, replacing it only if the result is valid.
write_plist() {
  local tpl="$CLONE/dispatch/launchd/$LABEL.plist" tmp="$PLIST.tmp.$$" content clone home
  [ -f "$tpl" ] || { echo "Missing plist template $tpl" >&2; return 1; }
  content="$(cat "$tpl"; printf x)"
  content="${content%x}"
  xml_escape "$CLONE"; clone="$REPLY"
  xml_escape "$HOME"; home="$REPLY"
  replace_all "$content" __CLONE__ "$clone"
  replace_all "$REPLY" __HOME__ "$home"
  content="$REPLY"
  if ! printf '%s' "$content" >"$tmp"; then
    rm -f "$tmp"; echo "Could not write $tmp" >&2; return 1
  fi
  if command -v plutil >/dev/null 2>&1 && ! plutil -lint "$tmp" >&2; then
    rm -f "$tmp"; echo "Generated plist is invalid; nothing was installed." >&2; return 1
  fi
  mv -f "$tmp" "$PLIST" || { rm -f "$tmp"; return 1; }
}

# Print the sessions recorded in each repo's launched.json, each with its stop command.
list_sessions() {
  local f names="" n found=0 nojq=0
  for f in "$STATE_DIR"/repos/*/launched.json; do
    [ -f "$f" ] || continue
    if command -v jq >/dev/null 2>&1; then
      names="$names$(jq -r '.[]? | .name? // empty' "$f" 2>/dev/null || true)"$'\n'
    else
      nojq=1
    fi
  done
  while IFS= read -r n; do
    [ -n "$n" ] || continue
    if [ "$found" = 0 ]; then echo "  Sessions possibly still running (stop each if you want it gone):"; found=1; fi
    echo "    claude stop $n"
  done <<<"$names"
  if [ "$nojq" = 1 ]; then
    echo "  (jq not found; check $STATE_DIR/repos/*/launched.json for live sessions)"
  fi
}

# Print what uninstall does not remove (and, with --purge, remove the files it owns).
report_leftovers() {
  local log="$LOG_DIR/claude-workflow-poller.log" sessions
  # Sessions are read before a purge deletes the state dir.
  sessions="$(list_sessions)"
  if [ "$purge" = 1 ]; then
    rm -rf "${STATE_DIR:?}"
    rm -f "$CONFIG" "$log"
    echo "Purged: state dir $STATE_DIR, config $CONFIG, log $log"
    echo "Still to clean up by hand:"
  else
    echo "Not removed by the LaunchAgent uninstall:"
    echo "  State dir: $STATE_DIR"
    echo "  Config:    $CONFIG"
    echo "  Log:       $log"
    echo "  (rerun with --purge to delete these three)"
  fi
  if [ -n "$sessions" ]; then printf '%s\n' "$sessions"; fi
  echo "  Plugin (remove if you no longer want it):"
  echo "    claude plugin uninstall ticket-workflow"
  echo "    claude plugin marketplace remove askrzypczak-plugins"
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
    echo "Installing dependencies (npm ci in $CLONE):"
    if ! (cd "$CLONE" && "$NPM" ci); then
      echo "npm ci failed in $CLONE; fix it and retry. Nothing was installed." >&2
      exit 1
    fi
    # Show what the poller would launch right now, and ask, before anything is written or started:
    # the LaunchAgent runs at load, so a real launch could otherwise precede the first look.
    # launchd gives the job only HOME and PATH, so the dry run drops the poller's settings from this shell.
    echo "Dry run (nothing is launched; run the way launchd will, without CLAUDE_MAX_SESSIONS from this shell):"
    dry_rc=0
    dry_out=$(env -u CLAUDE_MAX_SESSIONS "$POLLER" --dry-run 2>&1) || dry_rc=$?
    printf '%s\n' "$dry_out"
    if [ "$dry_rc" -ne 0 ]; then
      echo "The dry run failed; fix the config or environment and retry. Nothing was installed." >&2
      exit 1
    fi
    case "$dry_out" in
      *"another run is active"*)
        echo "A poll is running right now, so the dry run above did not check anything. Wait for it to finish and retry. Nothing was installed." >&2
        exit 1
        ;;
    esac
    if [ ${#mig_dirs[@]} -gt 0 ] || [ ${#legacy[@]} -gt 0 ]; then
      echo "Note: --migrate-state / --legacy-label have not been applied yet, so tickets still tracked only by the old poller may show above as launching; they are migrated after you confirm."
    fi
    if [ "$assume_yes" != 1 ]; then
      printf 'Install and start polling? [y/N] '
      answer=""
      read -r answer || answer=""
      case "$answer" in
        y | Y | yes | YES | Yes) ;;
        *) echo "Aborted; nothing was installed." >&2; exit 1 ;;
      esac
    fi
    mkdir -p "$AGENTS_DIR" "$LOG_DIR"
    # Migrate state and drop the old job before the new one first runs, so nothing is relaunched.
    remove_legacy
    migrate_state
    write_plist || exit 1
    "$LAUNCHCTL" bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    # A label that pause disabled refuses bootstrap, so enable it first.
    "$LAUNCHCTL" enable "$DOMAIN/$LABEL"
    "$LAUNCHCTL" bootstrap "$DOMAIN" "$PLIST"
    echo "Installed. Log: $LOG_DIR/claude-workflow-poller.log"
    ;;
  uninstall)
    "$LAUNCHCTL" bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    rm -f "$PLIST"
    remove_legacy
    echo "Removed."
    report_leftovers
    ;;
  pause)
    "$LAUNCHCTL" disable "$DOMAIN/$LABEL"
    "$LAUNCHCTL" bootout "$DOMAIN/$LABEL" 2>/dev/null || true
    echo "Polling is paused: the poller is stopped and disabled, also across logins and reboots."
    echo "Sessions already running are not stopped."
    list_sessions
    echo "Resume with: dispatch/install-launchd.sh resume"
    ;;
  resume)
    if [ ! -f "$PLIST" ]; then
      echo "No LaunchAgent at $PLIST; run dispatch/install-launchd.sh install." >&2
      exit 1
    fi
    "$LAUNCHCTL" enable "$DOMAIN/$LABEL"
    if ! boot_err="$("$LAUNCHCTL" bootstrap "$DOMAIN" "$PLIST" 2>&1)"; then
      # Bootstrap also fails when the job is already loaded, which is not a failure here.
      if "$LAUNCHCTL" print "$DOMAIN/$LABEL" >/dev/null 2>&1; then
        echo "Already loaded: the poller was not restarted; it runs every 3 minutes."
        exit 0
      fi
      printf '%s\n' "$boot_err" >&2
      exit 1
    fi
    echo "Resumed: the poller runs now and every 3 minutes. Log: $LOG_DIR/claude-workflow-poller.log"
    ;;
  status)
    if [ -f "$PLIST" ]; then echo "Installed: yes ($PLIST)"; else echo "Installed: no"; fi
    loaded=no
    if "$LAUNCHCTL" print "$DOMAIN/$LABEL" >/dev/null 2>&1; then loaded=yes; fi
    # A failing print-disabled reads as "not disabled".
    disabled_list="$("$LAUNCHCTL" print-disabled "$DOMAIN" 2>/dev/null || true)"
    needle="\"$LABEL\" => disabled"
    disabled=no
    case "$disabled_list" in
      *"$needle"*) disabled=yes ;;
    esac
    echo "Loaded:    $loaded"
    echo "Disabled:  $disabled"
    ;;
  *) echo "Usage: $0 [install|uninstall|pause|resume|status] [--yes] [--purge] ..." >&2; exit 2 ;;
esac
