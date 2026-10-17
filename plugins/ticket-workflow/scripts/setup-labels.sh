#!/usr/bin/env bash
# Create (or update) the ticket-workflow label set in a GitHub repo.
# Usage: scripts/setup-labels.sh [owner/repo]   (defaults to the current repo)
set -euo pipefail

GH="${GH:-$(command -v gh || echo /opt/homebrew/bin/gh)}"
REPO_ARGS=() # expanded with [@]+ below: empty arrays are unbound under set -u on macOS bash 3.2
[ $# -ge 1 ] && REPO_ARGS=(--repo "$1")

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

for entry in "${LABELS[@]}"; do
  IFS='|' read -r name color desc <<<"$entry"
  "$GH" label create "$name" --color "$color" --description "$desc" --force ${REPO_ARGS[@]+"${REPO_ARGS[@]}"}
done
