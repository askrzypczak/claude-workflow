#!/usr/bin/env bash
# Bring the checked-out PR branch up to date with the base ref, committing locally (update-prs.sh pushes).
# 1. Merge the base in. A conflict confined to the plugin manifest, where the PR changed nothing there
#    but the version, is resolved to the base's side; any other conflict aborts the merge.
# 2. If check-version-bump.sh then fails, carry the PR's own bump level (major, minor or patch, taken from
#    its latest first-parent commit whose version is above that commit's merge base with the base ref)
#    onto the base's version, so a PR whose bump another PR already merged passes again.
# Usage: scripts/update-pr-branch.sh [base-ref]   (default origin/main)
# Exit 0: done, printing "version OLD NEW" on stdout after a re-bump; 2: conflicts, merge aborted;
# 3: the version check fails and no commit on the branch raised the version, so there is nothing to carry.
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
base=${1:-origin/main}
dir=${PLUGIN_DIR:-plugins/ticket-workflow}
manifest=$dir/.claude-plugin/plugin.json
semver='^[0-9]+\.[0-9]+\.[0-9]+$'

version_at() { # ref
  git show "$1:$manifest" 2>/dev/null | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version'
}

rest_at() { # ref: the manifest without its version, to tell a version-only change from any other
  git show "$1:$manifest" 2>/dev/null |
    node -p 'const m = JSON.parse(require("fs").readFileSync(0, "utf8")); delete m.version; JSON.stringify(m)'
}

above() { # a b: whether x.y.z a is higher than b
  local a1 a2 a3 b1 b2 b3
  IFS=. read -r a1 a2 a3 <<<"$1"
  IFS=. read -r b1 b2 b3 <<<"$2"
  (( a1 > b1 || (a1 == b1 && (a2 > b2 || (a2 == b2 && a3 > b3))) ))
}

if ! git merge-base --is-ancestor "$base" HEAD; then
  if ! git merge --no-edit "$base" >&2; then
    conflicted=$(git diff --name-only --diff-filter=U)
    if [ "$conflicted" = "$manifest" ] && [ "$(rest_at "$(git merge-base "$base" HEAD)")" = "$(rest_at HEAD)" ]; then
      git checkout --theirs -- "$manifest" && git add -- "$manifest" && git commit -q --no-edit || exit 1
      echo "resolved the version-only conflict in $manifest to $base's side" >&2
    else
      echo "conflicts with $base:" $conflicted >&2
      git merge --abort
      exit 2
    fi
  fi
fi

"$here/check-version-bump.sh" "$base" >&2 && exit 0

level=
for c in $(git rev-list --first-parent HEAD --not "$base"); do
  pr_version=$(version_at "$c") || continue
  fork_version=$(version_at "$(git merge-base "$base" "$c")") || continue
  [[ $pr_version =~ $semver && $fork_version =~ $semver ]] || continue
  above "$pr_version" "$fork_version" || continue
  IFS=. read -r p1 p2 _ <<<"$pr_version"
  IFS=. read -r f1 f2 _ <<<"$fork_version"
  if (( p1 > f1 )); then level=major; elif (( p2 > f2 )); then level=minor; else level=patch; fi
  break
done
if [ -z "$level" ]; then
  echo "no commit on this branch raised the version above $base's, so there is no bump to carry" >&2
  exit 3
fi

base_version=$(version_at "$base")
[[ $base_version =~ $semver ]] || { echo "version '$base_version' at $base is not x.y.z" >&2; exit 1; }
IFS=. read -r b1 b2 b3 <<<"$base_version"
case $level in
  major) new="$((b1 + 1)).0.0" ;;
  minor) new="$b1.$((b2 + 1)).0" ;;
  patch) new="$b1.$b2.$((b3 + 1))" ;;
esac

node -e '
  const fs = require("fs");
  const [file, version] = process.argv.slice(1);
  const text = fs.readFileSync(file, "utf8");
  const next = text.replace(/("version"\s*:\s*")[^"]*"/, `$1${version}"`);
  if (next === text) process.exit(1);
  fs.writeFileSync(file, next);
' "$manifest" "$new" || { echo "cannot rewrite the version in $manifest" >&2; exit 1; }
git commit -q -m "Raise plugin version $pr_version -> $new ($level) past $base's $base_version" -- "$manifest" || exit 1
echo "version $pr_version $new"
