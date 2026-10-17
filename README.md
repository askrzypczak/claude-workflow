# claude-workflow

Private Claude Code plugin marketplace for Tony's agent workflow.

## What's in it

Plugin `ticket-workflow`:

- Skills: `work-ticket` (works a GitHub issue end to end), `address-feedback` (handles review feedback on the PR) and `resolve-conflicts` (merges `origin/main` into a conflicting `issue-N-*` PR branch, resolves, runs `npm run check`, publishes the branch; stops with `needs input` on semantic conflicts; never rebases or force-pushes).
- Subagents: `implementer` (haiku, xhigh; sonnet or opus per the approved plan) builds code and tests; `reviewer` (opus, medium, read-only) reviews complex diffs.
- `scripts/grg.sh`: mechanical green/red/green test check. Self-test: `scripts/test-grg.sh`.

## Install

In Claude Code:

    /plugin marketplace add askrzypczak/claude-workflow
    /plugin install ticket-workflow@askrzypczak-plugins

From a shell:

    claude plugin marketplace add askrzypczak/claude-workflow
    claude plugin install ticket-workflow@askrzypczak-plugins --scope project

Local development:

    claude plugin marketplace add /Users/tony/Projects/claude-workflow
    claude plugin update ticket-workflow@askrzypczak-plugins
    /reload-plugins
    claude plugin validate .

## Shared label tooling

Create the ticket labels in any repo (run once, from your machine; idempotent):

    plugins/ticket-workflow/scripts/setup-labels.sh owner/repo

Close-time cleanup (strips `ready`/`in-progress`/`needs-review`/`blocked` from the closed issue and removes `blocked` from dependents whose blockers are all closed) is a reusable workflow. A consuming repo adds `.github/workflows/ticket-labels.yml`:

    name: ticket-labels
    on:
      issues:
        types: [closed]
    permissions:
      contents: read
      issues: write
    jobs:
      cleanup:
        uses: askrzypczak/claude-workflow/.github/workflows/ticket-labels.yml@main

Setup notes:

- This repo is private, so **Settings > Actions > General > Access** must be "Accessible from repositories owned by the user" (API: `actions/permissions/access` with `access_level=user`). Only the workflow file is fetched, not the repo, so callers cannot check out `ticket-labels.ts`; the workflow therefore **embeds a copy** of `plugins/ticket-workflow/scripts/ticket-labels.ts`. Edit both together: the `ticket-labels-workflow` test fails if they drift.
- The workflow sets up Node 24 itself (the script runs TypeScript directly).
- Tests: `npm test`.

## What a project must provide

- An `npm run check` command that runs lint, typecheck, and tests.
- GitHub issue labels: `ready`, `in-progress`, `blocked`, `needs-review`.
- `gh` authenticated.
- A project-level PreToolUse git guard hook that blocks pushes to `main`/`master`, force pushes and `gh pr merge`. This plugin deliberately does not ship the guardrails; they stay in each project, e.g. ttrpg-agents `.claude/hooks/guard-git.sh`.

## Workflow

1. Read and claim the ticket (planning counts as work).
2. Plan, with human sign-off.
3. Branch in a worktree.
4. Implementer builds the code and tests.
5. Green/red/green proof.
6. Reviewer on complex changes; the orchestrator triages its findings (blockers and cheap fixes to the implementer, the rest deferred).
7. Open an active (non-draft) PR with CI green.
8. Human review, then address-feedback.
9. Human merges.
