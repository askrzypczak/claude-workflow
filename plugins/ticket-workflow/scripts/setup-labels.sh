#!/usr/bin/env bash
# Create the ticket-workflow label set in a GitHub repo and add the label-cleanup caller workflow to
# the checkout in the current directory. Existing labels and an existing workflow are left alone.
# Usage: scripts/setup-labels.sh [--update] [--no-workflow] [owner/repo]   (defaults to the current repo)
#   --update       also overwrite the colour and description of labels that already exist
#   --no-workflow  skip writing .github/workflows/ticket-labels.yml
# Without the caller workflow, closing a ticket leaves its state labels in place and never unblocks
# dependents. Run this from the repo's checkout, then commit and push the new workflow file.
set -euo pipefail

GH="${GH:-$(command -v gh || echo /opt/homebrew/bin/gh)}"
REPO_ARGS=() # expanded with [@]+ below: empty arrays are unbound under set -u on macOS bash 3.2
update=0
workflow=1
repo=""
for arg in "$@"; do
  case "$arg" in
    --update) update=1 ;;
    --no-workflow) workflow=0 ;;
    -*) echo "Usage: $0 [--update] [--no-workflow] [owner/repo]" >&2; exit 2 ;;
    *)
      [ -z "$repo" ] || { echo "Usage: $0 [--update] [--no-workflow] [owner/repo]" >&2; exit 2; }
      repo="$arg" ;;
  esac
done
[ -z "$repo" ] || REPO_ARGS=(--repo "$repo")

# name|color|description
LABELS=(
  "ready|0e8a16|Reviewed and approved by a human; only the maintainer adds it"
  "in-progress|fbca04|Claimed by a person or agent"
  "blocked|b60205|Waiting on another ticket or a decision"
  "needs-review|5319e7|PR open; awaiting human review"
  "agent-ok|1d76db|Safe for background agents to pick up unattended"
  "skip-plan|c5def5|Auto-launched agent skips the plan sign-off"
  "agent-failed|b60205|Background agent session failed; remove to retry"
  "bug|d73a4a|Something is broken"
  "feature|a2eeef|New capability"
  "chore|cfd3d7|Tooling, cleanup, docs"
)

existing="$("$GH" label list --limit 1000 --json name --jq '.[].name' ${REPO_ARGS[@]+"${REPO_ARGS[@]}"})"

for entry in "${LABELS[@]}"; do
  IFS='|' read -r name color desc <<<"$entry"
  force=()
  if printf '%s\n' "$existing" | grep -Fxqi -- "$name"; then
    if [ "$update" != 1 ]; then
      echo "$name: exists, skipped (use --update to overwrite)"
      continue
    fi
    force=(--force)
  fi
  "$GH" label create "$name" --color "$color" --description "$desc" ${force[@]+"${force[@]}"} ${REPO_ARGS[@]+"${REPO_ARGS[@]}"}
done

# Label-cleanup caller: copy the template unless a workflow here already calls the reusable one.
if [ "$workflow" = 1 ]; then
  template="$(dirname "$0")/../templates/ticket-labels.yml"
  target=".github/workflows/ticket-labels.yml"
  if ! git rev-parse --is-inside-work-tree >/dev/null 2>&1; then
    echo "workflow: not in a git checkout, skipped; copy $template to $target in the repo"
  elif [ -e "$target" ] || grep -qs 'claude-workflow/.github/workflows/ticket-labels.yml' .github/workflows/*.y*ml; then
    echo "workflow: ticket-labels caller exists, skipped"
  else
    mkdir -p .github/workflows
    cp "$template" "$target"
    echo "workflow: wrote $target; commit and push it so closed tickets lose their state labels"
  fi
fi
