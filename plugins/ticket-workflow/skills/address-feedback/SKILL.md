---
name: address-feedback
description: Handle Tony's review of a PR - gather comments, summarise them, ask clarifying questions before acting, then fix. Use when asked to "address feedback on #N" or after review comments land on a PR.
---

# address-feedback

Argument: an issue number `N` (or PR number). Launched manually after CI is green and Tony has reviewed.

## 1. Gather (read-only)
- Find the PR: `gh pr list --search "N in:body" --json number,headRefName,url` (branch is `issue-N-*`).
- Check CI: `gh pr checks <pr>`. If it is red, say so; fixing CI comes first.
- Collect everything: `gh pr view <pr> --comments`, review threads (`gh api repos/{owner}/{repo}/pulls/<pr>/comments`), and review summaries (`gh pr view <pr> --json reviews`). Also read the issue comments.

## 2. Summarise and ask - gate 2
Do not change anything yet. Present Tony with:
- A numbered list of each distinct piece of feedback, grouped by theme, with `file:line` where relevant.
- For each: what you understand it to mean and what you would change.
- **Clarifying questions** for anything ambiguous, conflicting, out of scope for this ticket, or where several fixes are plausible. Prefer asking over guessing.
Wait for answers. Anything agreed as out of scope becomes a new issue (`gh issue create`), not part of this PR.

## 3. Act
Enter the existing worktree for the PR branch (or create one from the PR's head branch). Then run the same loop as `work-ticket`, with the agreed fix list as the plan:
- Launch the `ticket-workflow:implementer` (tier as agreed; default haiku xhigh) with the fix list.
- `npm run check`, then `${CLAUDE_PLUGIN_ROOT}/scripts/grg.sh` for any new or changed tests.
- `ticket-workflow:reviewer` for complex changes, self-check for simple ones.
Commit, push the same branch, and reply on the PR threads you resolved (`gh pr comment`), noting which items were done and which were deferred to new issues.

## 4. Hand off
Confirm CI passes on the new commits (`gh pr checks`), then tell Tony what changed and what remains. Re-add `needs-review` to the issue. Humans merge; do not merge the PR.

## Hard rules
Same as `work-ticket`: push only the PR's `issue-N-*` branch, never `main`, never force-push, never merge.
