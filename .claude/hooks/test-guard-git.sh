#!/usr/bin/env bash
# Table-driven test for guard-git.sh. Usage: .claude/hooks/test-guard-git.sh
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
guard="$here/guard-git.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

git init -q -b main "$tmp/onmain"
git -C "$tmp/onmain" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init
git init -q -b issue-7-feature "$tmp/onfeature"
git -C "$tmp/onfeature" -c user.name=t -c user.email=t@t commit -q --allow-empty -m init

fail=0
check() { # expected(allow|deny) cwd command
  local want=$1 dir=$2 cmd=$3 got
  jq -n --arg c "$cmd" --arg d "$dir" '{tool_input:{command:$c},cwd:$d}' | "$guard" >/dev/null 2>&1
  [ $? -eq 2 ] && got=deny || got=allow
  if [ "$got" != "$want" ]; then echo "FAIL ($want expected, got $got): [$dir] $cmd"; fail=1; fi
}

F="$tmp/onfeature"
M="$tmp/onmain"

# allowed
check allow "$F" 'git push'
check allow "$F" 'git push -u origin issue-7-feature'
check allow "$F" 'git push origin HEAD'
check allow "$F" 'git status && git push origin issue-7-feature'
check allow "$F" 'gh pr create --draft --title x --body "Closes #7"'
check allow "$F" 'gh pr view 7 --comments'
check allow "$F" 'git commit -m "fix push to main handling"'

# denied
check deny "$M" 'git push'
check deny "$M" 'git push origin HEAD'
check deny "$F" 'git push origin main'
check deny "$F" 'git push origin master'
check deny "$F" 'git push origin HEAD:main'
check deny "$F" 'git push origin issue-7-feature:refs/heads/main'
check deny "$F" 'git push --force origin issue-7-feature'
check deny "$F" 'git push -f'
check deny "$F" 'git push --force-with-lease'
check deny "$F" 'git push origin +issue-7-feature'
check deny "$F" 'git push origin :issue-7-feature'
check deny "$F" 'git push origin --delete issue-7-feature'
check deny "$F" 'git -C . push origin main'
check deny "$F" "sh -c 'git push origin main'"
check deny "$F" 'echo $(git push origin main)'
check deny "$F" 'git add . && git push origin main'
check deny "$F" 'gh pr merge 7 --squash'
check deny "$F" 'gh api -X PUT repos/o/r/pulls/7/merge'

[ $fail -eq 0 ] && echo "guard-git: all cases pass"
exit $fail
