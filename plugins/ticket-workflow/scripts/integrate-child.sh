#!/usr/bin/env bash
# Integrate a child branch into its epic branch: fetch, --no-ff merge, plain push, close the issue.
# Usage: scripts/integrate-child.sh <epic> <issue> <slug> <pr>   (run in the epic-<epic> worktree)
#   exit 0 merged, pushed and closed; 1 merge conflict (aborted, nothing pushed); 2 usage or precondition error
set -euo pipefail

echo "not implemented" >&2
exit 99
