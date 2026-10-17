#!/usr/bin/env bash
# PreToolUse hook (matcher: Bash). Blocks Bash commands that read issue/PR comment text (comments,
# reviews, review threads) without piping it through scripts/trusted-comments.ts, which drops
# comments by untrusted authors. Text matching only, so it is a guardrail, not a security boundary.
# Input: hook JSON on stdin. Deny = exit 2 with the reason on stderr; allow = exit 0.
set -uo pipefail

input=$(cat)
cmd=$(jq -r '.tool_input.command // empty' <<<"$input")
[ -z "$cmd" ] && exit 0

deny() {
  echo "guard-comments: $1 Pipe the output through \`node \${CLAUDE_PLUGIN_ROOT}/scripts/trusted-comments.ts\` (e.g. \`gh pr view N --json comments,reviews | node .../trusted-comments.ts\`). If the filter fails, stop and tell the human; do not read comments another way." >&2
  exit 2
}

# Split into command lists on newline, ;, && and ||. A single | stays, so a pipeline is one segment.
segments=$(printf '%s' "$cmd" | tr '\n' ';' | sed -E 's/&&|\|\||;/\n/g')

while IFS= read -r seg; do
  case "$seg" in *gh*) ;; *) continue ;; esac
  # Exempt when the output is piped into the filter.
  if printf '%s' "$seg" | grep -Eq '\|[^|]*trusted-comments\.ts'; then continue; fi

  # gh issue|pr view ... --comments / -c
  if printf '%s' "$seg" | grep -Eq 'gh +(issue|pr) +view( .*)? (--comments|-c)([ "'"'"')]|$)'; then
    deny "reading comments with --comments is blocked."
  fi

  # gh issue|pr view|list ... --json <fields containing comments or reviews (incl. latestReviews)>
  if printf '%s' "$seg" | grep -Eiq 'gh +(issue|pr) +(view|list)( .*)? --json[ =]+[^ ]*(comments|reviews)'; then
    deny "requesting comments or reviews via --json is blocked."
  fi

  # gh api to comment/review endpoints or graphql queries that mention them (writes are fine)
  if printf '%s' "$seg" | grep -Eq 'gh +api '; then
    if printf '%s' "$seg" | grep -Eiq '(-X|--method)[ =]*(POST|PATCH|PUT|DELETE)'; then continue; fi
    if printf '%s' "$seg" | grep -Eiq '/(comments|reviews)([/ ?"'"'"']|$)'; then
      deny "reading comment or review endpoints via gh api is blocked."
    fi
    if printf '%s' "$seg" | grep -Eiq 'graphql' && printf '%s' "$seg" | grep -Eiq 'comments|reviews|reviewThreads'; then
      deny "reading comments or reviews via graphql is blocked."
    fi
  fi
done <<<"$segments"

exit 0
