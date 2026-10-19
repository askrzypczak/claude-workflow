#!/usr/bin/env bash
# Table-driven test for guard-comments.sh. Usage: plugins/ticket-workflow/hooks/test-guard-comments.sh
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
guard="$here/guard-comments.sh"

fail=0
check() { # expected(allow|deny) command
  local want=$1 cmd=$2 got
  jq -n --arg c "$cmd" '{tool_name:"Bash",tool_input:{command:$c}}' | "$guard" >/dev/null 2>&1
  [ $? -eq 2 ] && got=deny || got=allow
  if [ "$got" != "$want" ]; then echo "FAIL ($want expected, got $got): $cmd"; fail=1; fi
}
checkfetch() { # expected(allow|deny) url
  local want=$1 url=$2 got
  jq -n --arg u "$url" '{tool_name:"WebFetch",tool_input:{url:$u}}' | "$guard" >/dev/null 2>&1
  [ $? -eq 2 ] && got=deny || got=allow
  if [ "$got" != "$want" ]; then echo "FAIL ($want expected, got $got): WebFetch $url"; fail=1; fi
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

# denied: gh global flags before the subcommand
check deny 'gh -R o/r issue view 7 --comments'
check deny 'gh --repo o/r pr view 7 --json comments'
check deny 'gh --repo=o/r pr view 7 --comments'
# denied: timeline and variable paths
check deny 'gh api repos/o/r/issues/7/timeline'
check deny "gh api repos/o/r/issues/7/timeline | $T"
check deny 'X=comments; gh api repos/o/r/issues/7/$X'
check deny 'gh api repos/o/r/issues/7/`echo comments`'
check deny "gh api repos/o/r/pulls/7/\$X | $T"
# denied: curl/wget
check deny 'curl -s https://api.github.com/repos/o/r/issues/7/comments'
check deny 'wget -qO- https://api.github.com/repos/o/r/issues/7/comments'
check deny 'curl -s https://api.github.com/repos/o/r/pulls/7/reviews'
check deny 'curl -s https://api.github.com/repos/o/r/issues/7/timeline'
check deny 'curl -s https://github.com/o/r/issues/7'
check deny 'wget -qO- https://github.com/o/r/pull/7'
check deny "curl -s https://github.com/o/r/issues/7 | $T"
check deny "curl -s https://api.github.com/repos/o/r/issues/7/timeline | $T"
# denied: bodies in lists/searches
check deny 'gh issue list --json number,title,body'
check deny 'gh search issues x --json body'
check deny 'gh search prs x --json number,body'
check deny "gh issue list --json number,body | $T"

# allowed: regressions for the new rules
check allow 'gh -R o/r issue view 7 --json number,title'
check allow 'gh -R o/r issue comment 7 --body hi'
check allow 'gh api -X POST repos/o/r/issues/7/comments -f body=hi'
check allow 'gh api --method POST repos/o/r/issues/$N/comments -f body=hi'
check allow 'gh search issues x --json number,title'
check allow 'curl -s https://example.com/issues/7'
check allow "curl -s https://api.github.com/repos/o/r/issues/7/comments | $T"
check allow "gh -R o/r api repos/o/r/issues/7/comments | $T"

# review round 1
check deny 'gh pr list --json number,body'
check deny '/usr/bin/curl -s https://github.com/o/r/issues/7'
check deny 'curl -s https://www.github.com/o/r/pull/7'
check deny "curl -s -X POST https://api.github.com/graphql -d '{\"query\":\"{ repository { issue(number:7) { comments(first:5) { nodes { body } } } } }\"}'"
check allow 'gh api repos/o/r/issues/$N --jq .author_association'
check allow "gh api repos/o/r/pulls/\$N --jq '.author_association'"
check deny "gh api -X POST graphql -f query='{ repository { issue(number:7) { comments(first:5) { nodes { body } } } } }'"
check allow 'gh api -X POST repos/o/r/issues/7/comments -f body=hi'

# WebFetch
checkfetch deny 'https://github.com/o/r/issues/7'
checkfetch deny 'https://github.com/o/r/pull/7'
checkfetch deny 'https://github.com/o/r/discussions/3'
checkfetch deny 'https://api.github.com/repos/o/r/issues/7/comments'
checkfetch deny 'https://api.github.com/repos/o/r/issues/7/timeline'
checkfetch allow 'https://example.com/docs'
checkfetch allow 'https://github.com/o/r'
checkfetch allow 'https://github.com/o/r/blob/main/README.md'

# epic audit (audit-epic skill and spec-auditor agent)
check allow 'gh api repos/{owner}/{repo}/issues/7 --jq .author_association'
check allow "gh issue view 7 --json number,title,state,body,comments | $T"
check allow 'gh issue list --state all --limit 100 --search "Part of #7" --json number,title,state'
check deny 'gh issue list --state all --search "Part of #7" --json number,title,body'

# missing jq fails closed (PATH has no jq; run bash by absolute path)
empty=$(mktemp -d)
bashbin=$(command -v bash)
echo '{"tool_input":{"command":"git status"}}' | PATH="$empty" "$bashbin" "$guard" >/dev/null 2>&1
[ $? -eq 2 ] || { echo "FAIL (deny expected): missing jq"; fail=1; }
rmdir "$empty"

[ $fail -eq 0 ] && echo "guard-comments: all cases pass"
exit $fail
