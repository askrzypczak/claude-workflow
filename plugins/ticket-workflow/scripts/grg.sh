#!/usr/bin/env bash
# Mechanical green/red/green check: do the new/changed tests actually depend on the implementation?
#
#   1. green: run the tests in the current worktree (must pass)
#   2. red:   run the same test files against the base commit with the implementation changes absent
#             (must fail, and not merely because of a missing import/module)
#   3. green: confirm the current worktree is untouched and passes again
#
# Usage: scripts/grg.sh [base-ref]     (default: origin/main)
# Env:   TEST_CMD   command that runs tests, given test file paths as args (default: npx vitest run)
#        TEST_GLOB  regex of test file paths (default: \.(test|spec)\.[jt]sx?$)
#
# Uses a throwaway worktree for the red step, so it never touches the shared stash or your working tree.
set -euo pipefail

BASE="${1:-origin/main}"
TEST_CMD="${TEST_CMD:-npx vitest run}"
TEST_GLOB="${TEST_GLOB:-\.(test|spec)\.[jt]sx?\$}"

root=$(git rev-parse --show-toplevel)
cd "$root"

tests=()
while IFS= read -r f; do
  [ -f "$f" ] && tests+=("$f")
done < <({ git diff --name-only "$BASE"...HEAD; git diff --name-only; git ls-files --others --exclude-standard; } |
  sort -u | grep -E "$TEST_GLOB" || true)

if [ ${#tests[@]} -eq 0 ]; then
  echo "grg: no new or changed test files found vs $BASE" >&2
  exit 1
fi
echo "grg: test files: ${tests[*]}"

echo "grg: [1/3] green with implementation"
# shellcheck disable=SC2086
$TEST_CMD "${tests[@]}" || { echo "grg: FAIL - tests are not green to begin with" >&2; exit 1; }

tmp=$(mktemp -d)
trap 'git worktree remove --force "$tmp/wt" >/dev/null 2>&1 || true; rm -rf "$tmp"' EXIT
git worktree add --detach -q "$tmp/wt" "$(git merge-base "$BASE" HEAD)"
[ -d node_modules ] && ln -s "$root/node_modules" "$tmp/wt/node_modules"
for f in "${tests[@]}"; do mkdir -p "$tmp/wt/$(dirname "$f")"; cp "$f" "$tmp/wt/$f"; done

echo "grg: [2/3] red without implementation"
set +e
out=$(cd "$tmp/wt" && $TEST_CMD "${tests[@]}" 2>&1)
status=$?
set -e
if [ $status -eq 0 ]; then
  echo "$out" | tail -20
  echo "grg: FAIL - tests pass without the implementation; they assert nothing about the change" >&2
  exit 1
fi
if echo "$out" | grep -Eiq "cannot find (module|package)|failed to (resolve|load) (import|url)|SyntaxError|TS2307|ERR_MODULE_NOT_FOUND"; then
  echo "grg: WARN - red for the wrong reason (missing module/compile error), not a failed assertion:" >&2
  echo "$out" | grep -Ei "cannot find|failed to (resolve|load)|SyntaxError|TS2307|ERR_MODULE_NOT_FOUND" | head -5 >&2
  echo "grg: only weak evidence. Add a targeted mutation check (step 4b)." >&2
  weak=1
fi

echo "grg: [3/3] green again with implementation"
# shellcheck disable=SC2086
$TEST_CMD "${tests[@]}" >/dev/null || { echo "grg: FAIL - tests no longer green" >&2; exit 1; }

if [ "${weak:-0}" = 1 ]; then
  echo "grg: PASS (weak): red only via missing module"
  exit 0
fi
echo "grg: PASS: green -> red -> green"
