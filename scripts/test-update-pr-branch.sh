#!/usr/bin/env bash
# Self-test for update-pr-branch.sh using throwaway repos. Usage: scripts/test-update-pr-branch.sh
set -uo pipefail

update="$(cd "$(dirname "$0")" && pwd)/update-pr-branch.sh"
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
export GIT_AUTHOR_NAME=t GIT_AUTHOR_EMAIL=t@t GIT_COMMITTER_NAME=t GIT_COMMITTER_EMAIL=t@t
export PLUGIN_DIR=plugins/p
manifest=$PLUGIN_DIR/.claude-plugin/plugin.json

fail=0
expect() { # name expected actual
  if [ "$3" != "$2" ]; then echo "FAIL $1: expected '$2', got '$3'"; fail=1; else echo "ok   $1"; fi
}

set_version() { # version [description]
  mkdir -p "$PLUGIN_DIR/.claude-plugin"
  printf '{\n  "name": "p",\n  "version": "%s",\n  "description": "%s"\n}\n' "$1" "${2:-d}" >"$manifest"
}

version() { node -p "require('./$manifest').version"; }

new_repo() { # dir base-version
  git init -q -b main "$1" && cd "$1" || exit 1
  echo base >README
  set_version "$2"
  echo v1 >"$PLUGIN_DIR/skill.md"
  echo v1 >shared.txt
  git add . && git commit -qm base && git switch -qc feat
}

on_main() { # command...: run it on main and commit the result
  git switch -q main && "$@" && git add . && git commit -qm "main" && git switch -q feat
}

run() { out=$(bash "$update" main 2>/dev/null); rc=$?; }

# 1. already up to date with a good bump: nothing changes
new_repo "$tmp/current" 0.14.0
echo v2 >"$PLUGIN_DIR/skill.md" && set_version 0.14.1 && git commit -qam change
head=$(git rev-parse HEAD)
run; expect "up to date exits 0" 0 $rc; expect "up to date leaves HEAD" "$head" "$(git rev-parse HEAD)"; expect "up to date prints nothing" "" "$out"

# 2. behind, clean merge, versions fine
new_repo "$tmp/behind" 0.14.0
echo v2 >"$PLUGIN_DIR/skill.md" && set_version 0.14.1 && git commit -qam change
on_main sh -c 'echo more >>README'
run; expect "behind exits 0" 0 $rc; expect "behind merges main" 0 "$(git merge-base --is-ancestor main HEAD; echo $?)"
expect "behind keeps version" 0.14.1 "$(version)"; expect "behind prints nothing" "" "$out"

# 3. both PRs raised to the same minor: merges cleanly, PR re-bumped one minor past main
new_repo "$tmp/samebump" 0.14.0
echo v2 >"$PLUGIN_DIR/skill.md" && set_version 0.15.0 && git commit -qam change
on_main set_version 0.15.0
run; expect "same bump exits 0" 0 $rc; expect "same bump re-bumps minor" 0.16.0 "$(version)"
expect "same bump reports" "version 0.15.0 0.16.0" "$out"; expect "same bump leaves a clean tree" "" "$(git status --porcelain)"

# 4. PR patch vs main minor: version-only conflict resolved, patch carried onto main's version
new_repo "$tmp/versionconflict" 0.14.0
echo v2 >"$PLUGIN_DIR/skill.md" && set_version 0.14.1 && git commit -qam change
on_main set_version 0.15.0
run; expect "version conflict exits 0" 0 $rc; expect "version conflict carries patch" 0.15.1 "$(version)"
expect "version conflict reports" "version 0.14.1 0.15.1" "$out"

# 5. PR changed the manifest beyond its version and it conflicts: aborted, left for a human or agent
new_repo "$tmp/manifestconflict" 0.14.0
set_version 0.14.1 "pr text" && git commit -qam change
head=$(git rev-parse HEAD)
on_main set_version 0.15.0 "main text"
run; expect "manifest conflict exits 2" 2 $rc; expect "manifest conflict aborts" "$head" "$(git rev-parse HEAD)"
expect "manifest conflict leaves a clean tree" "" "$(git status --porcelain)"

# 6. conflict outside the manifest: aborted
new_repo "$tmp/fileconflict" 0.14.0
echo pr >shared.txt && git commit -qam change
on_main sh -c 'echo main >shared.txt'
run; expect "file conflict exits 2" 2 $rc; expect "file conflict leaves no merge in progress" 1 "$(git rev-parse -q --verify MERGE_HEAD >/dev/null; echo $?)"

# 7. plugin changed without any bump: nothing to carry
new_repo "$tmp/nobump" 0.14.0
echo v2 >"$PLUGIN_DIR/skill.md" && git commit -qam change
on_main sh -c 'echo more >>README'
run; expect "no bump exits 3" 3 $rc; expect "no bump still merges main" 0 "$(git merge-base --is-ancestor main HEAD; echo $?)"

# 8. main was already merged in (by resolve-conflicts) with a colliding version: bump level found past the merge
new_repo "$tmp/premerged" 0.14.0
echo v2 >"$PLUGIN_DIR/skill.md" && set_version 0.15.0 && git commit -qam change
on_main set_version 0.15.0
git merge -q --no-edit main
run; expect "premerged exits 0" 0 $rc; expect "premerged re-bumps minor" 0.16.0 "$(version)"

# 9. major carried as major
new_repo "$tmp/major" 0.14.0
echo v2 >"$PLUGIN_DIR/skill.md" && set_version 1.0.0 && git commit -qam change
on_main set_version 1.0.0
run; expect "major re-bumps major" 2.0.0 "$(version)"

exit $fail
