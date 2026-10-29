# Setup

What to install and configure to use the plugin and the poller. The maintainer-side security setup is in [Agent credentials](agent-credentials.md) and [Sandboxing agent sessions](sandboxing.md).

## Install

In Claude Code:

    /plugin marketplace add askrzypczak/claude-workflow
    /plugin install ticket-workflow@askrzypczak-plugins

From a shell:

    claude plugin marketplace add askrzypczak/claude-workflow
    claude plugin install ticket-workflow@askrzypczak-plugins --scope project

Local development:

    claude plugin marketplace add /path/to/claude-workflow
    claude plugin update ticket-workflow@askrzypczak-plugins
    /reload-plugins
    claude plugin validate .
    npm run typecheck

## Requirements

A consuming project needs:

- `npm run check`: build, lint, typecheck and tests. It is the definition of done and what CI runs.
- Ticket labels, created with `plugins/ticket-workflow/scripts/setup-labels.sh [owner/repo]` (idempotent: existing labels are left untouched; `--update` overwrites their colour and description). See [Ticket conventions](../README.md#ticket-conventions).
- `gh` authenticated (SSH remote, `gh auth login`) and `jq` on PATH.
- The plugin enabled in `.claude/settings.json`: `enabledPlugins` with `ticket-workflow@askrzypczak-plugins`, plus an `extraKnownMarketplaces` entry for `askrzypczak/claude-workflow`.
- Deny rules in `.claude/settings.json`. The agents' token enforces "humans merge": it cannot merge ([Agent credentials](agent-credentials.md)). The deny rules are the backstop for pushes to `main`/`master` and for force, delete and mirror pushes. The plugin ships the comment guard (`hooks/hooks.json`), which enforces the [trust rule](../README.md#trust-rule-for-public-repos). The project adds the deny rules:

        "permissions": {
          "deny": [
            "Bash(gh pr merge *)",
            "Bash(git push --force*)",
            "Bash(git push -f*)",
            "Bash(git push * --force*)",
            "Bash(git push * -f*)",
            "Bash(git push * +*)",
            "Bash(git push * main)",
            "Bash(git push *:main)",
            "Bash(git push * master)",
            "Bash(git push *:master)",
            "Bash(git push --delete*)",
            "Bash(git push * --delete*)",
            "Bash(git push -d *)",
            "Bash(git push * -d *)",
            "Bash(git push * :issue-*)",
            "Bash(git push * :epic-*)",
            "Bash(git push --mirror*)",
            "Bash(git push * --mirror*)",
            "Bash(git push --prune*)",
            "Bash(git push * --prune*)"
          ]
        }

  A `*` can sit anywhere in a rule, and deny rules apply "when any subcommand matches them" (Claude Code docs, *Configure permissions*), so they hold inside chained and piped commands too. They match the command as written, so a push spelled another way gets past them: `git -C . push`, a quoted or `refs/heads/` refspec, arguments after a `main` or `master` refspec, an abbreviated option such as `--del`, combined short flags such as `-ud`, a force or prune flag written in a form these strings miss, such as `-uf`, or a bare `git push` with `main` checked out. A delete by `:<branch>` refspec is caught only for `issue-*` and `epic-*` branches and for `main`/`master`: a rule ending in `:*` cannot express it, since "The `:*` suffix is an equivalent way to write a trailing wildcard" (same page). These project rules sit beside the user-settings deny list in [Settings](sandboxing.md#settings), and both apply: "deny rules from any scope are evaluated before allow rules" (same page). The strings are derived from *Configure permissions* and were not exercised by an agent. To check them, ask a Claude Code session in the project to run `git push --dry-run origin main`: the rules must deny it before it runs (`--dry-run` pushes nothing if a rule fails to match, and `protect-main`, where GitHub enforces it, refuses the real push anyway).
- Optional, for [dispatch](../dispatch/README.md): an entry in the poller config and a directory trusted by Claude Code.
- Optional: an unused-export / dead-file check inside `npm run check` (for example knip in production mode, excluding test suites; default knip treats test files as entry points).
- Optional, for [label cleanup](#label-cleanup-on-close): a caller workflow.
- The machine's only GitHub API credential is a fine-grained token that cannot merge, and the maintainer merges in the browser. The maintainer sets up the token, the deploy keys and the sandbox settings with the full `dispatch/setup-agents.sh` (phases `credentials`, `ssh`, `sandbox`, `check`; [Onboarding a repo](../dispatch/README.md#onboarding-a-repo)), run in a terminal, never by an agent. See [Agent credentials](agent-credentials.md).
- Agent sessions run Bash in Claude Code's sandbox, set in user settings, and push with per-repo deploy keys. See [Sandboxing agent sessions](sandboxing.md).


## Label cleanup on close

A reusable workflow (`workflow_call`, ticket #15) that runs when an issue is closed (e.g. by merging a PR with `Closes #N`):

- removes `ready`, `in-progress`, `needs-review`, `blocked` and `orchestrate-epic-run` from the closed issue (only those it has);
- for each open `blocked` issue whose body has `Blocked by #N`, removes `blocked` once every referenced blocker is closed (closed as not planned counts);
- never adds `ready`.

A consuming repo adds `.github/workflows/ticket-labels.yml`:

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

The workflow checks out this public repo, sets up Node 24 itself and runs `plugins/ticket-workflow/scripts/ticket-labels.ts`, so callers need no secrets or Actions settings. Tests: `npm test`; type-check: `npm run typecheck`.

