#!/bin/bash
# Claude Code status line: repo branch [model] · effort · context bar + tokens [· 5h/7d plan usage]
# Reads session JSON on stdin; see https://code.claude.com/docs/en/statusline

input=$(cat)

# One jq call, fields split on the ASCII unit separator (\x1f): unlike "|", it
# can't appear in a branch name, and a non-whitespace IFS keeps empty fields in
# place. Missing fields become empty strings.
IFS=$'\x1f' read -r REPO MODEL EFFORT CTX TOK SIZE FIVE WEEK WT_BRANCH CWD < <(
  echo "$input" | jq -r '
    def human: if . >= 1000000 then "\((. / 100000 | floor) / 10)M"
               elif . >= 10000 then "\(. / 1000 | floor)k"
               elif . >= 1000 then "\((. / 100 | floor) / 10)k"
               else tostring end;
    [
      (.workspace.repo.name // ""),
      (.model.display_name // "?"),
      (.effort.level // ""),
      ((.context_window.used_percentage // 0) | floor | tostring),
      ((.context_window.total_input_tokens // 0) | human),
      ((.context_window.context_window_size // 0) | human),
      ((.rate_limits.five_hour.used_percentage // "") | if . == "" then "" else (floor | tostring) end),
      ((.rate_limits.seven_day.used_percentage // "") | if . == "" then "" else (floor | tostring) end),
      (.worktree.branch // ""),
      (.cwd // "")
    ] | join("\u001f")'
)

# Context bar: 10 cells, color shifts as the window fills.
if   [ "$CTX" -ge 90 ]; then COLOR=$'\033[31m'  # red
elif [ "$CTX" -ge 70 ]; then COLOR=$'\033[33m'  # yellow
else                         COLOR=$'\033[32m'  # green
fi
REPOCOLOR=$'\033[1;30;44m'; BRANCHCOLOR=$'\033[4;36m'; DIM=$'\033[2m'; RESET=$'\033[0m'
# Prefer the worktree branch Claude Code reports (only in worktree sessions, and
# absent for hook-based worktrees); otherwise ask git in the session's cwd.
# git prints nothing on a detached HEAD and fails outside a repo.
if [ -n "$WT_BRANCH" ]; then
  BRANCH=$WT_BRANCH
elif BRANCH=$(git -C "${CWD:-.}" branch --show-current 2>/dev/null); then
  BRANCH=${BRANCH:-"<detached>"}
else
  BRANCH="?"
fi

# Claude Code leaves the repo name empty when it can't resolve the remote (for
# example an SSH host alias such as github.com-name:owner/repo.git), so fall back
# to the last path segment of origin's URL, without a trailing .git.
if [ -z "$REPO" ]; then
  REPO=$(git -C "${CWD:-.}" remote get-url origin 2>/dev/null)
  REPO=${REPO%/}; REPO=${REPO%.git}; REPO=${REPO##*[/:]}
  REPO=${REPO:-"?"}
fi

FILLED=$((CTX / 10)); [ "$FILLED" -gt 10 ] && FILLED=10
EMPTY=$((10 - FILLED))
BAR=""
[ "$FILLED" -gt 0 ] && printf -v F "%${FILLED}s" "" && BAR="${F// /▓}"
[ "$EMPTY" -gt 0 ]  && printf -v E "%${EMPTY}s" ""  && BAR="${BAR}${E// /░}"

OUT="${REPOCOLOR}$REPO${RESET} ${BRANCHCOLOR}$BRANCH${RESET} [$MODEL]"
[ -n "$EFFORT" ] && OUT="$OUT ${DIM}effort:${RESET}$EFFORT"
OUT="$OUT ${COLOR}${BAR}${RESET} ${CTX}% ${DIM}(${TOK}/${SIZE})${RESET}"
[ -n "$FIVE" ] && OUT="$OUT ${DIM}· 5h:${RESET}${FIVE}%"
[ -n "$WEEK" ] && OUT="$OUT ${DIM}· 7d:${RESET}${WEEK}%"

echo "$OUT"
