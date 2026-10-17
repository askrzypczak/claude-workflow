# claude-workflow

Private Claude Code plugin marketplace for Tony's agent workflow.

## What's in it

Plugin `ticket-workflow`:

- Skills: `work-ticket` (works a GitHub issue end to end) and `address-feedback` (handles review feedback on the PR).
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
