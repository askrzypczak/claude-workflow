#!/usr/bin/env bash
# Integrate a child branch into its epic branch: fetch, --no-ff merge, plain push, close the issue.
# Usage: scripts/integrate-child.sh <epic> <issue> <slug> <pr>   (run in the epic-<epic> worktree)
#   exit 0 merged, pushed and closed; 1 merge conflict (aborted, nothing pushed); 2 usage or precondition error;
#   3 merged, but the push or the close failed (stderr says which); rerunning after fixing the cause is safe:
#   the merge is then "Already up to date" and the push and close are retried
# The git guard hook never sees the push below, so the argument and HEAD checks are this script's guard.
set -euo pipefail

usage() { echo "Usage: $0 <epic> <issue> <slug> <pr>" >&2; exit 2; }
[ "$#" -eq 4 ] || usage
epic="$1" issue="$2" slug="$3" pr="$4"
for n in "$epic" "$issue" "$pr"; do
  [[ "$n" =~ ^[1-9][0-9]*$ ]] || usage
done
[[ "$slug" =~ ^[a-z0-9][a-z0-9-]*$ ]] || usage

epic_branch="epic-$epic"
child_branch="issue-$issue-$slug"
head="$(git rev-parse --abbrev-ref HEAD)"
[ "$head" = "$epic_branch" ] || { echo "HEAD is $head, not $epic_branch" >&2; exit 2; }

git fetch origin --quiet
git rev-parse -q --verify "refs/remotes/origin/$child_branch" >/dev/null \
  || { echo "origin/$child_branch not found" >&2; exit 2; }

if ! git merge --no-ff -m "Merge PR #$pr ($child_branch) into $epic_branch" "origin/$child_branch"; then
  if git rev-parse -q --verify MERGE_HEAD >/dev/null; then
    echo "Merge conflict in:" >&2
    git diff --name-only --diff-filter=U >&2
    git merge --abort
    exit 1
  fi
  echo "merge of origin/$child_branch failed" >&2
  exit 2
fi

merge="$(git rev-parse --short HEAD)"
git push origin "$epic_branch" \
  || { echo "push of $epic_branch failed; merge $merge is local only" >&2; exit 3; }
gh issue close "$issue" --comment "Integrated into \`$epic_branch\` by PR #$pr (merge $merge)." \
  || { echo "merged and pushed; closing #$issue failed" >&2; exit 3; }
