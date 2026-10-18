#!/usr/bin/env bash
# Table-driven test for guard-comments.sh. Usage: plugins/ticket-workflow/hooks/test-guard-comments.sh
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
guard="$here/guard-comments.sh"

fail=0
check() { # expected(allow|deny) command
  local want=$1 cmd=$2 got
  jq -n --arg c "$cmd" '{tool_input:{command:$c}}' | "$guard" >/dev/null 2>&1
  [ $? -eq 2 ] && got=deny || got=allow
  if [ "$got" != "$want" ]; then echo "FAIL ($want expected, got $got): $cmd"; fail=1; fi
}

T='node ${CLAUDE_PLUGIN_ROOT}/scripts/trusted-comments.ts'

# allowed: unrelated or writing commands
check allow 'gh pr checks 7'
check allow 'gh pr view 7 --json number,title'
check allow 'gh pr view 7 --json number,title,body,reviewRequests,reviewDecision'
check allow 'gh pr create --title x --body "Closes #7"'
check allow 'gh issue comment 7 --body "Claimed; planning."'
check allow 'gh pr comment 7 --body "see --comments docs"'
check allow 'gh issue list --json number,title,labels'
check allow 'gh api repos/o/r/issues/7 --jq .author_association'
check allow 'gh api repos/o/r/pulls/7 --jq .author_association'
check allow 'gh api -X POST repos/o/r/issues/7/comments -f body=hi'
check allow 'git status && npm test'
check allow ''
# allowed: piped through the filter
check allow "gh issue view 7 --json number,title,body,comments | $T"
check allow "gh pr view 7 --json comments,reviews | $T"
check allow "gh api --paginate --slurp repos/o/r/pulls/7/comments | $T"
check allow "gh api --paginate --slurp repos/o/r/issues/7/comments | $T"
check allow "gh api repos/o/r/pulls/7/reviews | $T"

# denied
check deny 'gh issue view 7 --comments'
check deny 'gh pr view 7 --comments'
check deny 'gh pr view 7 -c'
check deny 'gh issue view 7 --json number,comments'
check deny 'gh pr view 7 --json reviews'
check deny 'gh pr view 7 --json latestReviews'
check deny 'gh pr view 7 --json=comments'
check deny 'gh pr list --json number,comments'
check deny 'gh api repos/o/r/pulls/7/comments'
check deny 'gh api repos/o/r/issues/7/comments'
check deny 'gh api repos/o/r/pulls/7/reviews'
check deny 'gh api repos/o/r/issues/comments'
check deny 'gh api graphql -f query="{ repository { pullRequest(number:7) { reviewThreads(first:5) { nodes { id } } } } }"'
check deny 'gh api graphql -f query="{ repository { issue(number:7) { comments(first:5) { nodes { body } } } } }"'
check deny "sh -c 'gh pr view 7 --comments'"
check deny 'echo hi && gh pr view 7 --comments'
check deny "gh pr view 7 --comments; $T"
check deny "gh pr view 7 --comments | cat"
check deny "$T < /dev/null; gh pr view 7 --json comments | cat"

[ $fail -eq 0 ] && echo "guard-comments: all cases pass"
exit $fail
