#!/usr/bin/env bash
# Poll GitHub for agent-ready tickets in every configured repo and start background
# Claude Code sessions (visible in `claude agents`). Run from launchd. See dispatch/README.md.
# Usage: dispatch/agent-poller.sh [--dry-run]
#
# Repos come from a JSON config (${CLAUDE_WORKFLOW_CONFIG:-~/.config/claude-workflow/repos.json}):
#   [{"repo": "owner/name", "dir": "~/Projects/name", "sessionPrefix": "name", "owner": "login", "bgFlags": "...", "maxSessions": 3}]
#
# Safety: bypass flags (--dangerously-skip-permissions, --permission-mode bypassPermissions, ...) in the
# combined flags make the poller skip that repo unless CLAUDE_ALLOW_BYPASS_PERMISSIONS=1. At most
# CLAUDE_MAX_SESSIONS (default 10) sessions are live across all repos, and at most a repo's optional
# `maxSessions` in that repo; launches over the cap are deferred to a later poll.
#
# A ticket is picked up when it is open, authored by the repo's `owner`, and labelled
# `agent-ok` + `ready` (and not in-progress, blocked or agent-failed). The session
# is interactive: it shows as `blocked` in `claude agents` when it needs you
# (plan sign-off, questions, permissions) and waits. Tickets labelled `skip-plan`
# are launched with `auto`, which skips the plan sign-off. The work-ticket skill
# does the claiming itself.
#
# A third phase finds open, same-repo `issue-N-*` PRs by `owner` that conflict with main
# and launches `<prefix>-N-conflict` (`resolve-conflicts N`), at most once per main SHA.
# Fork PRs and PRs by anyone else are skipped: a fork can use any branch name.
#
# Each repo is polled in its own subshell: a failure in one is logged and the others still run.
set -euo pipefail

# The fnm default bin dir puts node/npm on PATH; launchd does not read ~/.zshenv. Harmless if absent.
export PATH="${EXTRA_PATH:+$EXTRA_PATH:}$HOME/.local/share/fnm/aliases/default/bin:$HOME/.local/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:${PATH:-}"

CONFIG="${CLAUDE_WORKFLOW_CONFIG:-$HOME/.config/claude-workflow/repos.json}"
STATE_DIR="${STATE_DIR:-$HOME/.local/state/claude-workflow}"
# Default extra flags for `claude --bg` (e.g. "--permission-mode acceptEdits"); word-split.
# A repo's `bgFlags` is appended after these.
# Sessions start on sonnet at xhigh effort; a later --model / --effort in either place overrides.
GLOBAL_BG_FLAGS=()
read -r -a GLOBAL_BG_FLAGS <<<"--model sonnet --effort xhigh ${CLAUDE_BG_FLAGS:-}"

MAX_SESSIONS="${CLAUDE_MAX_SESSIONS:-10}"

DRY=0
[ "${1:-}" = "--dry-run" ] && DRY=1

LOGP="" # per-repo log prefix, set while polling a repo
log() { printf '%s %s%s\n' "$(date '+%F %T')" "$LOGP" "$*"; }
run() {
  if [ "$DRY" = 1 ]; then log "[dry-run] $*"; else "$@"; fi
}

# --- Config ------------------------------------------------------------------
case "$MAX_SESSIONS" in
  "" | *[!0-9]* | 0 | 0[0-9]*) log "CLAUDE_MAX_SESSIONS='$MAX_SESSIONS' is not a positive integer; aborting"; exit 1 ;;
esac
[ -r "$CONFIG" ] || { log "config $CONFIG missing or unreadable; aborting"; exit 1; }
jq -e 'type == "array"' "$CONFIG" >/dev/null 2>&1 || { log "config $CONFIG is not a JSON array; aborting"; exit 1; }
bad=$(jq -r 'to_entries[] | select(
    (.value | type) != "object"
    or ([.value.repo, .value.dir, .value.sessionPrefix, .value.owner] | any((type != "string") or (length == 0)))
    or ((.value.sessionPrefix | type) == "string" and (.value.sessionPrefix | test("^[A-Za-z0-9_-]+$") | not))
    or ((.value.bgFlags // "") | type) != "string"
    or ((.value | has("maxSessions")) and (
      (.value.maxSessions | type) != "number" or .value.maxSessions < 1 or .value.maxSessions != (.value.maxSessions | floor)
    ))
  ) | .key' "$CONFIG" 2>/dev/null | head -n1) || bad=invalid
if [ -n "$bad" ]; then
  log "config $CONFIG: entry $bad needs string repo, dir, sessionPrefix ([A-Za-z0-9_-]+), owner (and optional string bgFlags, positive integer maxSessions); aborting"
  exit 1
fi
dup=$(jq -r '[.[].sessionPrefix | ascii_downcase] | group_by(.) | map(select(length > 1) | .[0]) | first // empty' "$CONFIG")
if [ -n "$dup" ]; then
  log "config $CONFIG: duplicate sessionPrefix '$dup' (compared case-insensitively); aborting"
  exit 1
fi
while IFS=$'\t' read -r r d; do
  if ! printf '%s' "$r" | grep -Eq '^[A-Za-z0-9._-]+/[A-Za-z0-9._-]+$'; then
    log "config $CONFIG: repo '$r' is not of the form owner/name; aborting"
    exit 1
  fi
  case "$d" in "~/"*) d="$HOME/${d#"~/"}" ;; "~") d=$HOME ;; esac
  if [ ! -d "$d" ]; then
    log "config $CONFIG: dir '$d' (repo $r) does not exist; aborting"
    exit 1
  fi
done < <(jq -r '.[] | [.repo, .dir] | @tsv' "$CONFIG")
[ "$(jq 'length' "$CONFIG")" -gt 0 ] || { log "config $CONFIG has no repos; nothing to do"; exit 0; }

# --- Lock ----------------------------------------------------------------------
mkdir -p "$STATE_DIR"
LOCK="$STATE_DIR/lock"
if ! mkdir "$LOCK" 2>/dev/null; then
  pid=$(cat "$LOCK/pid" 2>/dev/null || true)
  if [ -n "$pid" ] && kill -0 "$pid" 2>/dev/null; then
    log "another run is active (pid $pid); exiting"
    exit 0
  fi
  rm -rf "$LOCK"
  mkdir "$LOCK"
fi
echo $$ >"$LOCK/pid"
LAUNCHES=$(mktemp "${TMPDIR:-/tmp}/poller-launches.XXXXXX")
trap 'rm -rf "$LOCK" "$LAUNCHES"' EXIT

# Abort (rather than guess) if we cannot read the session list: a wrong empty
# answer would relaunch everything. Fetched once and shared by all repos.
SESSIONS=$(claude agents --json --all) || { log "claude agents --json failed; aborting"; exit 1; }
echo "$SESSIONS" | jq -e 'type == "array"' >/dev/null || { log "unexpected agents output; aborting"; exit 1; }

session_state() { # name -> state of the newest session with that name, or empty
  echo "$SESSIONS" | jq -r --arg n "$1" '[.[] | select(.name == $n)] | sort_by(.startedAt) | last | .state // empty'
}

# Sessions in a repo's launched.json that are not done/failed/stopped (alive, or just launched and not listed yet).
# An unlisted entry older than 10 minutes is dead (reconcile fails it), so it does not count.
live_in_state() { # state-file
  local name at st c=0 now
  [ -f "$1" ] || { echo 0; return 0; }
  now=$(date +%s)
  while IFS=$'\t' read -r name at; do
    [ -n "$name" ] || continue
    st=$(session_state "$name")
    case "$st" in
      done | failed | stopped) ;;
      "") if [ "$((now - at))" -lt 600 ]; then c=$((c + 1)); fi ;;
      *) c=$((c + 1)) ;;
    esac
  done < <(jq -r '.[] | [.name, (.at // 0)] | @tsv' "$1")
  echo "$c"
}
# Live counts are read once (GLOBAL_LIVE before the repo loop, REPO_LIVE per repo) and then bumped by
# launches made during this run, recorded one prefix per line in a scratch file because poll_repo
# runs in a subshell.
launches_made() { # [prefix] -> launches so far this run
  if [ -n "${1:-}" ]; then grep -cxF -- "$1" "$LAUNCHES" || true; else wc -l <"$LAUNCHES" | tr -d ' '; fi
}
at_cap() { # -> 0 when starting another session would exceed the repo or global cap
  if [ -n "$REPO_MAX" ] && [ "$((REPO_LIVE + $(launches_made "$PREFIX")))" -ge "$REPO_MAX" ]; then
    return 0
  fi
  [ "$((GLOBAL_LIVE + $(launches_made)))" -ge "$MAX_SESSIONS" ]
}
note_launch() { echo "$PREFIX" >>"$LAUNCHES"; }

has_bypass_flag() { # flags... -> 0 if any grants bypassPermissions
  local prev="" f
  for f in "$@"; do
    case "$f" in
      --dangerously-skip-permissions | --allow-dangerously-skip-permissions | --permission-mode=bypassPermissions) return 0 ;;
      bypassPermissions) [ "$prev" = "--permission-mode" ] && return 0 ;;
    esac
    prev=$f
  done
  return 1
}

state_set() { # key name [pr mainSha]
  [ "$DRY" = 1 ] && return 0
  jq --arg k "$1" --arg n "$2" --arg pr "${3:-}" --arg sha "${4:-}" --argjson at "$(date +%s)" \
    '.[$k] = ({name: $n, at: $at} + (if $pr != "" then {pr: $pr, mainSha: $sha} else {} end))' "$STATE" >"$STATE.tmp" && mv "$STATE.tmp" "$STATE"
}
attempt_set() { # number pr mainSha
  [ "$DRY" = 1 ] && return 0
  jq --arg k "$1" --arg pr "$2" --arg sha "$3" '.[$k] = {pr: $pr, mainSha: $sha}' "$ATTEMPTS" >"$ATTEMPTS.tmp" && mv "$ATTEMPTS.tmp" "$ATTEMPTS"
}
state_del() { # key
  [ "$DRY" = 1 ] && return 0
  jq --arg k "$1" 'del(.[$k])' "$STATE" >"$STATE.tmp" && mv "$STATE.tmp" "$STATE"
}

fail_issue() { # number name reason
  log "#$1: $3 -> agent-failed"
  run gh issue edit "$1" --repo "$GH_REPO" --add-label agent-failed --remove-label in-progress || true
  run gh issue comment "$1" --repo "$GH_REPO" --body "Background session \`$2\` ended without finishing: $3. See \`claude logs $2\` or \`claude agents\`. To retry, remove \`agent-failed\` and add \`ready\`."
}

fail_conflict() { # number name pr reason
  log "#$1: $4 (PR #$3) -> agent-failed"
  local body="Conflict-resolution session \`$2\` ended without resolving the conflict on PR #$3: $4. See \`claude logs $2\`. It will not be retried against the same main; remove \`agent-failed\` to allow a retry once main moves."
  run gh issue edit "$1" --repo "$GH_REPO" --add-label agent-failed || true
  run gh pr comment "$3" --repo "$GH_REPO" --body "$body" || true
  run gh issue comment "$1" --repo "$GH_REPO" --body "$body"
}

# Uses GH_REPO, REPO_DIR, OWNER, PREFIX, STATE, ATTEMPTS, BG_FLAGS (set by the caller).
# Must run with `set -e` active (see the call site): a failing command aborts this repo only.
poll_repo() {
  local now key n conflict pr name age st prinfo issue labels ok issues prs row author pr_author arg cname main_sha

  # --- Reconcile sessions we launched ---------------------------------------
  now=$(date +%s)
  for key in $(jq -r 'keys[]' "$STATE"); do
    n=$key
    conflict=0
    pr=""
    case "$key" in
      conflict-*)
        conflict=1
        n=${key#conflict-}
        pr=$(jq -r --arg k "$key" '.[$k].pr' "$STATE")
        ;;
    esac
    fail() { # reason
      if [ "$conflict" = 1 ]; then fail_conflict "$n" "$name" "$pr" "$1"; else fail_issue "$n" "$name" "$1"; fi
    }
    name=$(jq -r --arg k "$key" '.[$k].name' "$STATE")
    age=$((now - $(jq -r --arg k "$key" '.[$k].at' "$STATE")))
    st=$(session_state "$name")
    log "#$n: $name state=${st:-<none>}"
    case "$st" in
      "")
        [ "$age" -lt 600 ] && continue # just launched; may not be listed yet
        fail "no session found"
        state_del "$key"
        ;;
      failed | stopped)
        fail "session $st"
        state_del "$key"
        ;;
      done) # check the ticket was handed off
        if [ "$conflict" = 1 ]; then
          prinfo=$(gh pr view "$pr" --repo "$GH_REPO" --json state,mergeable)
          if [ "$(echo "$prinfo" | jq -r '.state')" = OPEN ] && [ "$(echo "$prinfo" | jq -r '.mergeable')" = CONFLICTING ]; then
            fail "session finished but the conflict remains"
          fi
          state_del "$key"
          continue
        fi
        issue=$(gh issue view "$n" --repo "$GH_REPO" --json state,labels)
        labels=",$(echo "$issue" | jq -r '[.labels[].name] | join(",")'),"
        ok=0
        [ "$(echo "$issue" | jq -r '.state')" = CLOSED ] && ok=1
        case "$labels" in *,needs-review,* | *,blocked,* | *,agent-failed,*) ok=1 ;; esac
        [ "$ok" = 0 ] && fail "session finished but the ticket was not handed off"
        state_del "$key"
        ;;
      *) continue ;; # working, blocked, waiting, idle or unknown: still alive; leave it
    esac
  done

  # --- Launch new sessions ---------------------------------------------------
  issues=$(gh issue list --repo "$GH_REPO" --state open --label agent-ok --limit 50 --json number,author,labels)

  while read -r row; do
    [ -n "$row" ] || continue
    n=$(echo "$row" | jq -r '.number')
    author=$(echo "$row" | jq -r '.author.login')
    labels=",$(echo "$row" | jq -r '[.labels[].name] | join(",")'),"
    has() { case "$labels" in *",$1,"*) return 0 ;; esac; return 1; }

    has in-progress && continue
    has blocked && continue
    has agent-failed && continue
    has ready || continue

    if [ "$author" != "$OWNER" ]; then
      log "#$n: author $author is not $OWNER; skipping"
      continue
    fi
    [ "$(jq -r --arg k "$n" 'has($k)' "$STATE")" = true ] && continue

    if at_cap; then
      log "deferred #$n: at session cap"
      continue
    fi
    name="$PREFIX-$n"
    arg="$n"
    has skip-plan && arg="$n auto"
    log "#$n: launching $name (flags: ${BG_FLAGS[*]:-<none>})"
    # BG_FLAGS may be empty; the [@]+ form keeps macOS bash 3.2 happy under set -u.
    if [ "$DRY" = 1 ]; then
      log "[dry-run] (cd $REPO_DIR && claude --bg --name $name ${BG_FLAGS[*]:-} \"/ticket-workflow:work-ticket $arg\")"
    else
      (cd "$REPO_DIR" && claude --bg --name "$name" ${BG_FLAGS[@]+"${BG_FLAGS[@]}"} "/ticket-workflow:work-ticket $arg")
    fi
    state_set "$n" "$name"
    note_launch
  done < <(echo "$issues" | jq -c '.[]')

  # --- Resolve conflicts on agent PRs ----------------------------------------
  # Detection is plain gh/jq (no model tokens). UNKNOWN means GitHub has not computed
  # mergeability yet: retry next poll. BEHIND without conflicts is ignored.
  prs=$(gh pr list --repo "$GH_REPO" --state open --limit 100 --json number,headRefName,mergeable,mergeStateStatus,isCrossRepository,author)
  main_sha=""

  while read -r row; do
    [ -n "$row" ] || continue
    pr=$(echo "$row" | jq -r '.number')
    n=$(echo "$row" | jq -r '.headRefName | capture("^issue-(?<n>[0-9]+)-").n // empty')
    [ -n "$n" ] || continue
    # Anyone can open a PR from a fork and name its branch issue-N-*: only same-repo PRs
    # by the owner are resolved. A missing isCrossRepository counts as a fork.
    if [ "$(echo "$row" | jq -r '.isCrossRepository')" != false ]; then
      log "#$n: PR #$pr is from a fork; skipping"
      continue
    fi
    pr_author=$(echo "$row" | jq -r '.author.login')
    if [ "$pr_author" != "$OWNER" ]; then
      log "#$n: PR #$pr author $pr_author is not $OWNER; skipping"
      continue
    fi
    case "$(echo "$row" | jq -r '.mergeable')" in
      CONFLICTING) ;;
      UNKNOWN)
        log "#$n: PR #$pr mergeability unknown; retry next poll"
        continue
        ;;
      *) continue ;;
    esac

    # The ticket session owns the branch while it is active.
    case "$(session_state "$PREFIX-$n")" in
      working | blocked)
        log "#$n: PR #$pr conflicts but $PREFIX-$n is active; skipping"
        continue
        ;;
    esac
    cname="$PREFIX-$n-conflict"
    case "$(session_state "$cname")" in
      "" | done | failed | stopped) ;;
      *) continue ;; # a conflict session is still alive
    esac
    [ "$(jq -r --arg k "conflict-$n" 'has($k)' "$STATE")" = true ] && continue

    issue=$(gh issue view "$n" --repo "$GH_REPO" --json author,labels,state) || {
      log "#$n: cannot read issue; skipping"
      continue
    }
    if [ "$(echo "$issue" | jq -r '.state')" != OPEN ]; then
      log "#$n: issue is not open; skipping conflict resolution"
      continue
    fi
    labels=",$(echo "$issue" | jq -r '[.labels[].name] | join(",")'),"
    case "$labels" in *,agent-ok,*) ;; *) continue ;; esac
    case "$labels" in *,agent-failed,*) continue ;; esac
    if [ "$(echo "$issue" | jq -r '.author.login')" != "$OWNER" ]; then
      log "#$n: author is not $OWNER; skipping conflict resolution"
      continue
    fi

    if [ -z "$main_sha" ]; then
      main_sha=$(gh api "repos/$GH_REPO/commits/main" | jq -er '.sha') || {
        log "cannot read main SHA; skipping conflict phase"
        break
      }
    fi
    if [ "$(jq -r --arg k "$n" --arg pr "$pr" --arg sha "$main_sha" '.[$k] | (.pr == $pr and .mainSha == $sha)' "$ATTEMPTS")" = true ]; then
      log "#$n: PR #$pr already attempted against main ${main_sha:0:7}; skipping"
      continue
    fi

    if at_cap; then
      log "deferred #$n: at session cap (conflict resolution for PR #$pr)"
      continue
    fi
    log "#$n: PR #$pr conflicts with main; launching $cname (flags: ${BG_FLAGS[*]:-<none>})"
    if [ "$DRY" = 1 ]; then
      log "[dry-run] (cd $REPO_DIR && claude --bg --name $cname ${BG_FLAGS[*]:-} \"/ticket-workflow:resolve-conflicts $n\")"
    else
      (cd "$REPO_DIR" && claude --bg --name "$cname" ${BG_FLAGS[@]+"${BG_FLAGS[@]}"} "/ticket-workflow:resolve-conflicts $n")
    fi
    state_set "conflict-$n" "$cname" "$pr" "$main_sha"
    attempt_set "$n" "$pr" "$main_sha"
    note_launch
  done < <(echo "$prs" | jq -c '.[]')
}

# --- Poll each repo ----------------------------------------------------------
entries=()
while IFS= read -r e; do entries+=("$e"); done < <(jq -c '.[]' "$CONFIG")

ALL_PREFIXES=()
while IFS= read -r e; do ALL_PREFIXES+=("$e"); done < <(jq -r '.[].sessionPrefix' "$CONFIG")

GLOBAL_LIVE=0
for p in "${ALL_PREFIXES[@]}"; do
  GLOBAL_LIVE=$((GLOBAL_LIVE + $(live_in_state "$STATE_DIR/repos/$p/launched.json")))
done

failures=0
for entry in "${entries[@]}"; do
  GH_REPO=$(echo "$entry" | jq -r '.repo')
  REPO_DIR=$(echo "$entry" | jq -r '.dir')
  PREFIX=$(echo "$entry" | jq -r '.sessionPrefix')
  OWNER=$(echo "$entry" | jq -r '.owner')
  repo_flags=()
  read -r -a repo_flags <<<"$(echo "$entry" | jq -r '.bgFlags // ""')"
  REPO_MAX=$(echo "$entry" | jq -r '.maxSessions // empty | floor')
  BG_FLAGS=(${GLOBAL_BG_FLAGS[@]+"${GLOBAL_BG_FLAGS[@]}"} ${repo_flags[@]+"${repo_flags[@]}"})
  case "$REPO_DIR" in "~/"*) REPO_DIR="$HOME/${REPO_DIR#"~/"}" ;; "~") REPO_DIR=$HOME ;; esac

  LOGP="[$PREFIX] "
  if [ "${CLAUDE_ALLOW_BYPASS_PERMISSIONS:-}" != 1 ] && has_bypass_flag ${BG_FLAGS[@]+"${BG_FLAGS[@]}"}; then
    log "refusing bypass flags (${BG_FLAGS[*]}); set CLAUDE_ALLOW_BYPASS_PERMISSIONS=1 to allow; skipping this repo"
    failures=$((failures + 1))
    continue
  fi
  RSTATE="$STATE_DIR/repos/$PREFIX"
  # {"<N>": {"name": "...", "at": <epoch>}, "conflict-<N>": {"name", "at", "pr", "mainSha"}}
  STATE="$RSTATE/launched.json"
  # {"<N>": {"pr": "<pr>", "mainSha": "<sha>"}}: last conflict attempt per ticket. Kept after
  # the session ends so a failed attempt is not repeated against the same main.
  ATTEMPTS="$RSTATE/conflicts.json"
  mkdir -p "$RSTATE"
  [ -f "$STATE" ] || echo '{}' >"$STATE"
  [ -f "$ATTEMPTS" ] || echo '{}' >"$ATTEMPTS"
  REPO_LIVE=$(live_in_state "$STATE")

  # `set -e` is ignored inside anything run as `cmd || ...` or `if cmd`, so the subshell is
  # run as a plain command with errexit off in the parent, and turns it on for itself.
  set +e
  (
    set -e
    poll_repo
  )
  rc=$?
  set -e
  if [ "$rc" -ne 0 ]; then
    log "poll failed (exit $rc); continuing with the next repo"
    failures=$((failures + 1))
  fi
done

LOGP=""
log "done"
[ "$failures" -eq 0 ] || exit 1
