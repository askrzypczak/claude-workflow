#!/usr/bin/env bash
# Integrate a child branch into its epic branch, in two subcommands around orchestrate-epic step 7's own
# plain fetch (before merge) and push of epic-<epic> (between merge and close), which the sandbox's git
# exclusions match. This script runs no git network command.
# Usage: scripts/integrate-child.sh merge|close <epic> <issue> <slug> <pr>   (run in the epic-<epic> worktree)
#   merge: --no-ff merge of origin/issue-<issue>-<slug> into epic-<epic>, as last fetched.
#     exit 0 merged (a rerun after a merge is "Already up to date", also 0); 1 merge conflict (aborted,
#     epic-<epic> and the working tree as before); 2 usage or precondition error, or any other merge failure
#   close: closes issue <issue> once its merge commit is on origin/epic-<epic>.
#     exit 0 closed; 2 usage or precondition error, or the merge not on origin/epic-<epic> yet (push it first);
#     3 closing the issue failed (stderr says why)
set -euo pipefail

usage() { echo "Usage: $0 merge|close <epic> <issue> <slug> <pr>" >&2; exit 2; }
[ "$#" -eq 5 ] || usage
cmd="$1" epic="$2" issue="$3" slug="$4" pr="$5"
case "$cmd" in
  merge | close) ;;
  *) usage ;;
esac
for n in "$epic" "$issue" "$pr"; do
  [[ "$n" =~ ^[1-9][0-9]*$ ]] || usage
done
[[ "$slug" =~ ^[a-z0-9][a-z0-9-]*$ ]] || usage

epic_branch="epic-$epic"
child_branch="issue-$issue-$slug"
subject="Merge $child_branch into $epic_branch (#$issue, PR #$pr)"
head="$(git rev-parse --abbrev-ref HEAD)" || { echo "not in a git worktree" >&2; exit 2; }
[ "$head" = "$epic_branch" ] || { echo "HEAD is $head, not $epic_branch" >&2; exit 2; }

merge_child() {
  git rev-parse -q --verify "refs/remotes/origin/$child_branch" >/dev/null \
    || { echo "origin/$child_branch not found; fetch origin first" >&2; exit 2; }

  if ! git merge --no-ff -m "$subject" "origin/$child_branch"; then
    if git rev-parse -q --verify MERGE_HEAD >/dev/null; then
      echo "Merge conflict in:" >&2
      git diff --name-only --diff-filter=U >&2
      git merge --abort
      exit 1
    fi
    echo "merge of origin/$child_branch failed" >&2
    exit 2
  fi
}

close_child() {
  local log="" sha subj merge=""
  if git rev-parse -q --verify "refs/remotes/origin/$epic_branch" >/dev/null; then
    log="$(git log --merges --format='%h %s' "refs/remotes/origin/$epic_branch" --)" || log=""
  fi
  while IFS=' ' read -r sha subj; do
    if [ "$subj" = "$subject" ]; then
      merge="$sha"
      break
    fi
  done <<<"$log"
  [ -n "$merge" ] || {
    echo "no merge commit \"$subject\" on origin/$epic_branch; push $epic_branch first" >&2
    exit 2
  }

  gh issue close "$issue" --comment "Integrated into \`$epic_branch\` by PR #$pr (merge $merge)." \
    || { echo "merge $merge is on origin/$epic_branch; closing #$issue failed" >&2; exit 3; }
}

case "$cmd" in
  merge) merge_child ;;
  close) close_child ;;
esac
