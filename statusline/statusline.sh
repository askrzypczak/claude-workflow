#!/bin/bash
# Claude Code status line: model · effort · context bar + tokens [· 5h/7d plan usage]
# Reads session JSON on stdin; see https://code.claude.com/docs/en/statusline

input=$(cat)

# One jq call, "|"-separated (a non-whitespace IFS keeps empty fields in place).
# Missing fields become empty strings.
IFS='|' read -r MODEL EFFORT CTX TOK SIZE FIVE WEEK < <(
  echo "$input" | jq -r '
    def human: if . >= 1000000 then "\((. / 100000 | floor) / 10)M"
               elif . >= 10000 then "\(. / 1000 | floor)k"
               elif . >= 1000 then "\((. / 100 | floor) / 10)k"
               else tostring end;
    [
      (.model.display_name // "?"),
      (.effort.level // ""),
      ((.context_window.used_percentage // 0) | floor | tostring),
      ((.context_window.total_input_tokens // 0) | human),
      ((.context_window.context_window_size // 0) | human),
      ((.rate_limits.five_hour.used_percentage // "") | if . == "" then "" else (floor | tostring) end),
      ((.rate_limits.seven_day.used_percentage // "") | if . == "" then "" else (floor | tostring) end)
    ] | join("|")'
)

# Context bar: 10 cells, color shifts as the window fills.
if   [ "$CTX" -ge 90 ]; then COLOR=$'\033[31m'  # red
elif [ "$CTX" -ge 70 ]; then COLOR=$'\033[33m'  # yellow
else                         COLOR=$'\033[32m'  # green
fi
DIM=$'\033[2m'; RESET=$'\033[0m'

FILLED=$((CTX / 10)); [ "$FILLED" -gt 10 ] && FILLED=10
EMPTY=$((10 - FILLED))
BAR=""
[ "$FILLED" -gt 0 ] && printf -v F "%${FILLED}s" "" && BAR="${F// /▓}"
[ "$EMPTY" -gt 0 ]  && printf -v E "%${EMPTY}s" ""  && BAR="${BAR}${E// /░}"

OUT="[$MODEL]"
[ -n "$EFFORT" ] && OUT="$OUT ${DIM}effort:${RESET}$EFFORT"
OUT="$OUT ${COLOR}${BAR}${RESET} ${CTX}% ${DIM}(${TOK}/${SIZE})${RESET}"
[ -n "$FIVE" ] && OUT="$OUT ${DIM}· 5h:${RESET}${FIVE}%"
[ -n "$WEEK" ] && OUT="$OUT ${DIM}· 7d:${RESET}${WEEK}%"

echo "$OUT"
