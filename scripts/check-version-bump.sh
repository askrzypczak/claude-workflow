#!/usr/bin/env bash
# Fail when HEAD changes the plugin without raising its version above the base ref's.
# Usage: scripts/check-version-bump.sh [base-ref]   (default origin/main)
# CI runs this on the PR merge ref, so a PR whose bump another PR already merged fails here
# even though git merges the identical version lines without a conflict.
set -uo pipefail

base=${1:-origin/main}
dir=${PLUGIN_DIR:-plugins/ticket-workflow}
manifest=$dir/.claude-plugin/plugin.json

version_at() { # ref
  git show "$1:$manifest" | node -p 'JSON.parse(require("fs").readFileSync(0, "utf8")).version'
}

if [ -z "$(git diff --name-only "$base" HEAD -- "$dir")" ]; then
  echo "ok: nothing under $dir changed against $base"
  exit 0
fi

old=$(version_at "$base") || { echo "FAIL: cannot read $manifest at $base" >&2; exit 1; }
new=$(version_at HEAD) || { echo "FAIL: cannot read $manifest at HEAD" >&2; exit 1; }

semver='^[0-9]+\.[0-9]+\.[0-9]+$'
for v in "$old" "$new"; do
  [[ $v =~ $semver ]] || { echo "FAIL: version '$v' is not x.y.z" >&2; exit 1; }
done

IFS=. read -r o1 o2 o3 <<<"$old"
IFS=. read -r n1 n2 n3 <<<"$new"
if (( n1 > o1 || (n1 == o1 && (n2 > o2 || (n2 == o2 && n3 > o3))) )); then
  echo "ok: $dir changed and version $old -> $new"
  exit 0
fi

echo "FAIL: $dir changed but its version is $new, not above $base's $old." >&2
echo "Bump \"version\" in $manifest. If another PR already merged with this version, raise it past $old again." >&2
exit 1
