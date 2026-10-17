---
name: work-ticket
description: Work a GitHub issue end to end - plan with a human sign-off gate, delegate to an implementer subagent, prove the tests, review, and open a PR. Use when asked to "work ticket #N" or pick up an issue.
---

# work-ticket

Argument: an issue number `N`, optionally followed by `auto` (see Auto mode). Always launched with an explicit number (manually, or by a launcher script); never auto-pick.

You are the **orchestrator**. Keep your own context small: delegate the heavy reading and writing to subagents and work from their short reports. The ticket is a conversation with Tony, so expect to ask questions (a background session just waits for him).

## Auto mode
If the argument is `N auto` (a launcher passes it for tickets labelled `skip-plan`), plan as in step 2 but skip the human sign-off: do not enter plan mode or wait for approval, and go straight to step 3 with your own plan. Still ask Tony if the ticket is ambiguous or the change turns out to be wide or risky (touching security, data handling or shared code); that is what the gate is for. Everything else is unchanged.

## 1. Read (read-only)
Run `git fetch origin --quiet` first: the local checkout can be stale, and everything below assumes a current `origin/main`. Then `gh issue view N --comments --json number,title,body,labels,assignees,state`.
- Stop and report if the issue is closed, has `blocked`, or its body has an open `Blocked by #M` (check `gh issue view M --json state`).
- Stop if it already has `in-progress`.

## 2. Plan - gate 1 (human sign-off)
(Auto mode: plan privately, with no plan mode and no sign-off.) Otherwise enter plan mode and explore just enough to plan. Read from `origin/main` (`git show origin/main:<path>`, `git ls-tree -r origin/main`), not the working tree, which may be behind. The plan must include:
- Approach, and the files likely touched.
- Acceptance criteria (from the ticket; add any that are implied).
- Test list: each behaviour to be covered.
- **Complexity** rating: `complex` (branching logic, new abstractions, shared code, security/data handling) or `simple` (docs, config, chores, trivial one-file changes). This decides step 6.
- **Implementer tier**: default `sonnet` medium. Propose `haiku` with `xhigh` effort only for mechanical, well-specified work; use `opus` for subtle logic. Say why.
Ask clarifying questions first if the ticket is ambiguous. Exit plan mode only with Tony's explicit approval. If he declines or abandons, stop; nothing has been claimed.

## 3. Claim and branch
- Re-check the issue has no `in-progress`, then `gh issue edit N --add-assignee @me --add-label in-progress --remove-label ready` and comment "Claimed; working in branch `issue-N-<slug>`."
- Run `git fetch origin --quiet` again (sign-off may have taken a while), enter a worktree, and create branch `issue-N-<short-slug>` from `origin/main`.

## 4. Implement
Launch the `ticket-workflow:implementer` subagent (override `model`/`effort` per the approved tier). If the Agent tool rejects `ticket-workflow:implementer`, list the available agent types and use the one that ends in `:implementer`; do the same for the reviewer. Prompt it with: the approved plan, acceptance criteria, test list, and the instruction to follow its agent definition. Do not do the implementation yourself.

## 5. Verify the tests (green/red/green)
Run `npm run check`, then `${CLAUDE_PLUGIN_ROOT}/scripts/grg.sh`. Failures, or a tests-pass-without-implementation result, go back to the implementer (SendMessage to continue it, with the exact output). Maximum 2 rounds, then stop and tell Tony what is stuck. Do not accept "PASS (weak)" without the implementer's targeted-break evidence in its report.

## 6. Review
- `complex`: launch the `ticket-workflow:reviewer` subagent with the issue number, acceptance criteria, base ref `origin/main`, and the implementer's report. Send blockers back to the implementer, then re-run step 5. Maximum 2 rounds, then escalate to Tony.
- `simple`: check `git diff origin/main...HEAD` against the acceptance criteria yourself.
File a new issue (`gh issue create`) for anything adjacent instead of expanding scope.

## 7. PR
Commit (follow the repo's commit conventions), push the branch, then `gh pr create` (active, not draft: there is one human reviewer, and `needs-review` carries the signal) with `Closes #N`, a short summary, and a **Test proof** section holding the GRG evidence (`grg.sh` result and the behaviours the implementer broke). Then `gh issue edit N --add-label needs-review --remove-label in-progress` and comment the PR link on the issue.
CI must pass before Tony reviews. Check with `gh pr checks`; if it fails, fix via steps 4-5 and push again.

## 8. Hand off
Tell Tony the PR is ready for review. His feedback is handled in a separate session with the `address-feedback` skill. If you cannot finish, comment what was done on the issue, remove `in-progress`, and add `blocked` with the reason.

## Hard rules
- Push only your own `issue-N-*` branch. Never push to `main`/`master`, force-push, or merge: the project's PreToolUse git guard hook enforces this (see this plugin's README), and a denial means stop, not work around.
- Humans merge.
