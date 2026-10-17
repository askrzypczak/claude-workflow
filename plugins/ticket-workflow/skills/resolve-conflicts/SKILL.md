---
name: resolve-conflicts
description: Bring a PR branch that conflicts with main back to mergeable by merging origin/main into it, resolving conflicts, running the checks and publishing the branch. Use when asked to "resolve conflicts on #N" or when a launcher reports a conflicting issue-N-* PR.
---

# resolve-conflicts

Argument: a PR number or an issue number `N`. Always launched with an explicit number, usually by a poller in a fresh session (not by resuming the original ticket session); never auto-pick. The job is narrow: make the branch mergeable, nothing else.

## 1. Find the branch
- Resolve the PR: `gh pr view <N> --json number,headRefName,mergeable,state,url` for a PR number, or `gh pr list --search "N in:body" --json number,headRefName,mergeable,state,url` for an issue number (branch is `issue-N-*`).
- Stop and report if the PR is closed or merged, or if `mergeable` is `MERGEABLE` (nothing to do). `UNKNOWN` means GitHub has not computed it yet; retry once after a few seconds.
- Run `git fetch origin --quiet`, then enter a worktree on the existing branch (`git worktree add` from `origin/<headRefName>`, or EnterWorktree) so that it tracks the PR branch.

## 2. Merge main in
`git merge origin/main`. **Never rebase, never force-push** (the git guard forbids force-push, and rebasing would rewrite the PR's history).
- Clean merge: go to step 4.
- Conflicts: list them with `git diff --name-only --diff-filter=U`.

## 3. Resolve
For each conflicted file, read both sides (the commits on each side since the merge base, `git log origin/main..HEAD` and `git log HEAD..origin/main`, and their diffs) before choosing a resolution. Record file and resolution for the PR comment.
- Lockfiles (`package-lock.json`): do not hand-merge. Take main's version (`git checkout --theirs package-lock.json` in a merge of main into the branch means main's side), reconcile `package.json` first, then run `npm install` to regenerate and `git add` the result.
- Independent edits (imports, adjacent lines, list additions, docs): keep both sides.
- Never resolve by dropping one side's tests, or by deleting a side's behaviour to make the merge go away.

**Stop conditions.** Abort with `git merge --abort`, publish nothing, and end with `needs input:` (plus a PR comment saying the same) when any of these hold:
- Both sides change the same logic differently, and the correct combination is not obvious from the diffs and the ticket.
- Tests disagree: the merged result only passes if one side's expectations are changed.
- A conflict touches security or data handling, or you cannot explain in one sentence why your resolution is right.
- The check keeps failing after one fix attempt for a reason unrelated to conflict markers.
State exactly which files and hunks conflict, what each side intends, and the options you see.

## 4. Verify and publish
- `npm run check` (the project's definition of done) must be green. If it fails because of the merge, fix the merge; if it fails identically on `origin/main`, say so rather than papering over it.
- Commit the merge. Keep git's default merge message; when conflicts were resolved, list the files in the body.
- Send the same branch to origin with a plain `git push` (no force flags).
- Confirm GitHub now reports the PR as mergeable (`gh pr view <pr> --json mergeable`) and wait for CI (`gh pr checks <pr>`).

## 5. Report
Comment on the PR (`gh pr comment`): which files conflicted, how each was resolved, the `npm run check` result, and the new head commit. End the session with `result:` naming the PR and its state.

## Hard rules
Only ever update the PR's own `issue-N-*` branch, with a plain push; never `main`, never force-push, never rebase, never `gh pr merge`. Do not change issue or PR labels, and do not touch anything beyond what the merge requires. Same guardrails as `work-ticket`.
