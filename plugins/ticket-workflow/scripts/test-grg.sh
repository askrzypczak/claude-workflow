#!/usr/bin/env bash
# Self-test for grg.sh using throwaway shell "tests" in a temp repo. Usage: scripts/test-grg.sh
set -uo pipefail

grg="$(cd "$(dirname "$0")" && pwd)/grg.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export TEST_CMD=bash TEST_GLOB='\.test\.sh$'
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t

fail=0
expect() { # name expected-exit
  if [ "$3" -ne "$2" ]; then echo "FAIL $1: expected exit $2, got $3"; fail=1; else echo "ok   $1"; fi
}

new_repo() { # dir
  git init -q -b main "$1" && cd "$1" || exit 1
  echo base >README && git add . && git commit -qm base && git switch -qc feat
  printf 'add() { echo $(( $1 + $2 )); }\n' >lib.sh
}

# 1. real test: passes with impl, fails without it
new_repo "$tmp/good"
printf '. ./lib.sh\n[ "$(add 1 2)" = 3 ] || exit 1\n' >good.test.sh
git add . && git commit -qm good
bash "$grg" main >/dev/null 2>&1; expect "real test passes grg" 0 $?

# 2. vacuous test: still green without the impl
new_repo "$tmp/vacuous"
printf '. ./lib.sh 2>/dev/null\ntrue\n' >vac.test.sh
git add . && git commit -qm vac
bash "$grg" main >/dev/null 2>&1; expect "vacuous test fails grg" 1 $?

# 3. no test files
new_repo "$tmp/none"
git add . && git commit -qm none
bash "$grg" main >/dev/null 2>&1; expect "no tests fails grg" 1 $?

# 4. temp worktree cleaned up
[ "$(git -C "$tmp/good" worktree list | wc -l)" -eq 1 ]; expect "no leftover worktrees" 0 $?

exit $fail
