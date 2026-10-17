---
name: address-feedback
description: Handle the human reviewer's review of a PR - collect feedback from live discussion, merge in GitHub PR comments, confirm the list, then fix. Use when asked to "address feedback on #N", when the human says they are done reviewing, or after review comments land on a PR.
---

# address-feedback

Argument: an issue number `N` (or PR number). The human reviews by discussing the PR live with you and may also leave GitHub comments. Launched manually after CI is green, or started by the conversation itself.

## 1. Collect (live conversation)
Feedback comes from what the human says. Keep a running numbered list (with `file:line` where relevant) as they talk, and show it when asked.
- No code changes in this phase. Discuss, record, ask questions.
- Find the PR early (`gh pr list --search "N in:body" --json number,headRefName,url`; branch is `issue-N-*`) so you can read the diff while discussing.
- The phase ends only when the human says they are done reviewing, or types `address-feedback N` themselves as a command. Starting this skill yourself because they opened a review (for example "PR feedback: ...") begins this phase; it does not end it. Neither does answering your clarifying questions, or a pause: they often read, think and come back with more. Acknowledge each new point, keep the numbered list, and wait. Do not move on before that.

## 2. Gather (read-only)
At the trigger, also pull GitHub feedback and merge it into the list:
- Check CI: `gh pr checks <pr>`. If it is red, say so; fixing CI comes first.
- `gh pr view <pr> --comments`, review threads (`gh api repos/{owner}/{repo}/pulls/<pr>/comments`), review summaries (`gh pr view <pr> --json reviews`), and issue comments.
- Deduplicate against the conversation list. Flag any item where a GitHub comment conflicts with what was said live.

## Gate 2: confirm the list
Do not change anything yet. Present the merged numbered list, grouped by theme, with `file:line` where relevant. For each item: what you understand it to mean, which source it came from (conversation or GitHub), and the fix you propose.
- Ask only what is still open: ambiguity, conflicts, out-of-scope items, or several plausible fixes. Prefer asking over guessing.
- If everything was agreed in conversation, this is a quick "confirm this list".
Wait for confirmation. Anything agreed as out of scope becomes a new issue (`gh issue create`), not part of this PR. If new feedback arrives while you wait for confirmation, add it to the list and present the updated list; act only on a confirmation that follows the final list.

## 3. Act
Enter the existing worktree for the PR branch (or create one from the PR's head branch). Then run the same loop as `work-ticket`, with the agreed fix list as the plan:
- Launch the `ticket-workflow:implementer` (tier as agreed; default haiku xhigh) with the fix list.
- `npm run check`, then `${CLAUDE_PLUGIN_ROOT}/scripts/grg.sh` for any new or changed tests.
- `ticket-workflow:reviewer` for complex changes, self-check for simple ones.
Commit, push the same branch, and reply on the PR threads you resolved (`gh pr comment`), noting which items were done and which were deferred to new issues.

## 4. Hand off
Confirm CI passes on the new commits (`gh pr checks`), then tell the human what changed and what remains. Re-add `needs-review` to the issue. Humans merge; do not merge the PR.

## Hard rules
Same as `work-ticket`: push only the PR's `issue-N-*` branch, never `main`, never force-push, never merge.
