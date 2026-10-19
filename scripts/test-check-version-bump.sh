#!/usr/bin/env bash
# Self-test for check-version-bump.sh using throwaway repos. Usage: scripts/test-check-version-bump.sh
set -uo pipefail

check="$(cd "$(dirname "$0")" && pwd)/check-version-bump.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export PLUGIN_DIR=plugins/p

fail=0
expect() { # name expected-exit actual-exit
  if [ "$3" -ne "$2" ]; then echo "FAIL $1: expected exit $2, got $3"; fail=1; else echo "ok   $1"; fi
}

set_version() { # version
  mkdir -p "$PLUGIN_DIR/.claude-plugin"
  printf '{ "name": "p", "version": "%s" }\n' "$1" >"$PLUGIN_DIR/.claude-plugin/plugin.json"
}

new_repo() { # dir base-version
  git init -q -b main "$1" && cd "$1" || exit 1
  echo base >README
  set_version "$2"
  echo v1 >"$PLUGIN_DIR/skill.md"
  git add . && git commit -qm base && git switch -qc feat
}

run() { bash "$check" main >/dev/null 2>&1; }

# 1. nothing under the plugin changed: no bump needed
new_repo "$tmp/untouched" 0.14.0
echo more >>README && git commit -qam readme
run; expect "no plugin change passes" 0 $?

# 2. plugin changed without a bump
new_repo "$tmp/nobump" 0.14.0
echo v2 >"$PLUGIN_DIR/skill.md" && git commit -qam change
run; expect "plugin change without bump fails" 1 $?

# 3. plugin changed with a bump
new_repo "$tmp/bumped" 0.14.0
echo v2 >"$PLUGIN_DIR/skill.md" && set_version 0.14.1 && git commit -qam change
run; expect "plugin change with bump passes" 0 $?

# 4. two PRs bump to the same version: A merges, B merges main in cleanly, check must fail
new_repo "$tmp/collision" 0.14.0
echo v2 >"$PLUGIN_DIR/skill.md" && set_version 0.15.0 && git commit -qam "pr b"
git switch -q main && echo other >"$PLUGIN_DIR/other.md" && set_version 0.15.0 && git add . && git commit -qm "pr a merged"
git switch -q feat && git merge -q main -m "update from main" 2>/dev/null
[ -z "$(git ls-files -u)" ]; expect "collision setup merges cleanly" 0 $?
run; expect "same version as already-merged PR fails" 1 $?

# 5. downgrade
new_repo "$tmp/downgrade" 0.14.0
echo v2 >"$PLUGIN_DIR/skill.md" && set_version 0.13.9 && git commit -qam change
run; expect "lower version fails" 1 $?

# 6. numeric, not lexical, comparison
new_repo "$tmp/numeric" 0.9.0
echo v2 >"$PLUGIN_DIR/skill.md" && set_version 0.10.0 && git commit -qam change
run; expect "0.9.0 -> 0.10.0 passes" 0 $?

# 7. not x.y.z
new_repo "$tmp/malformed" 0.14.0
echo v2 >"$PLUGIN_DIR/skill.md" && set_version 0.15 && git commit -qam change
run; expect "non x.y.z version fails" 1 $?

# 8. only the version line changed still counts as a plugin change and passes with a bump
new_repo "$tmp/versiononly" 0.14.0
set_version 0.14.1 && git commit -qam bump
run; expect "version-only bump passes" 0 $?

exit $fail
