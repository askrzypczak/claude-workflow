#!/usr/bin/env bash
# Keep open same-repo PRs on the base branch up to date with it; run by .github/workflows/update-prs.yml.
# For each PR (or only the one given): run update-pr-branch.sh on its branch in a scratch worktree, push
# the result, and after a version re-bump retitle "(OLD)" to "(NEW)" and comment. Then dispatch ci.yml on
# the branch, because pushes made with GITHUB_TOKEN start no pull_request run. Conflicting PRs are left
# as they are: the dispatch poller sends issue-N-* ones to resolve-conflicts.
# Usage: scripts/update-prs.sh [pr-number]   (gh needs contents, pull-requests and actions write)
set -uo pipefail

here=$(cd "$(dirname "$0")" && pwd)
base=${BASE_BRANCH:-main}
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"; git worktree prune' EXIT

git fetch -q origin "$base" || exit 1
if [ $# -gt 0 ]; then
  [[ $1 =~ ^[0-9]+$ ]] || { echo "not a PR number: $1" >&2; exit 1; }
  prs=$1
else
  prs=$(gh pr list --base "$base" --state open --limit 100 --json number --jq '.[].number') || exit 1
fi

fail=0
for pr in $prs; do
  read -r cross pr_base head < <(gh pr view "$pr" --json isCrossRepository,baseRefName,headRefName \
    --jq '"\(.isCrossRepository) \(.baseRefName) \(.headRefName)"')
  if [ -z "${head:-}" ]; then
    echo "::error::#$pr: cannot read the PR"
    fail=1
    continue
  fi
  if [ "$cross" != false ] || [ "$pr_base" != "$base" ]; then
    echo "#$pr: skipped (fork, or base is not $base)"
    continue
  fi
  git fetch -q origin "+refs/heads/$head:refs/remotes/origin/$head" &&
    git worktree add -q --detach "$tmp/$pr" "origin/$head" || { echo "::error::#$pr: cannot check out $head"; fail=1; continue; }

  out=$(cd "$tmp/$pr" && PR_BRANCH=$head "$here/update-pr-branch.sh" "origin/$base")
  case $? in
    0) ;;
    2) echo "#$pr: conflicts with $base; left for resolve-conflicts or the author"; continue ;;
    3) echo "::warning::#$pr: changes the plugin without a version bump to carry; CI will fail it" ;;
    *) echo "::error::#$pr: update failed"; fail=1; continue ;;
  esac
  if [ "$(git -C "$tmp/$pr" rev-parse HEAD)" = "$(git rev-parse "origin/$head")" ]; then
    echo "#$pr: up to date"
    continue
  fi

  if ! git -C "$tmp/$pr" push -q origin "HEAD:refs/heads/$head"; then
    # Expected when the branch moved meanwhile (its own pull_request run takes over) or when the merge
    # brings in workflow-file changes, which GITHUB_TOKEN may not push.
    if [ "$(git ls-remote origin "refs/heads/$head" | cut -f1)" != "$(git rev-parse "origin/$head")" ]; then
      echo "#$pr: $head moved while updating; its own run takes over"
    elif [ -n "$(git -C "$tmp/$pr" diff --name-only "origin/$head" HEAD -- .github/workflows)" ]; then
      echo "::warning::#$pr: $base changes workflow files, which this token may not push; use the Update branch button"
    else
      echo "::error::#$pr: push to $head rejected"
      fail=1
    fi
    continue
  fi
  echo "#$pr: updated $head"

  if [[ $out =~ ^version\ ([^ ]+)\ ([^ ]+)$ ]]; then
    old=${BASH_REMATCH[1]} new=${BASH_REMATCH[2]}
    title=$(gh pr view "$pr" --json title --jq .title)
    if [[ $title == *"($old)"* ]]; then
      gh pr edit "$pr" --title "${title%%"($old)"*}($new)${title#*"($old)"}" >/dev/null || fail=1
    fi
    gh pr comment "$pr" --body "Merged \`$base\` in and raised the plugin version $old -> $new: \`$base\` already reached $old, and this keeps the PR's bump level on top of it." >/dev/null || fail=1
  fi
  if [ "${DISPATCH_CI:-true}" = true ]; then
    gh workflow run ci.yml --ref "$head" || fail=1
  fi
done
exit $fail
