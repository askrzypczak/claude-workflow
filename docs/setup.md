# Setup

What to install and configure to use the plugin and the poller. The maintainer-side security setup is in [Agent credentials](agent-credentials.md) and [Agent container](containers.md); [Setting up the machine](#setting-up-the-machine) gives the order.

## Install

In Claude Code:

    /plugin marketplace add askrzypczak/claude-workflow
    /plugin install ticket-workflow@askrzypczak-plugins

From a shell:

    claude plugin marketplace add askrzypczak/claude-workflow
    claude plugin install ticket-workflow@askrzypczak-plugins --scope user

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
- `gh` and `jq` on PATH, and an SSH remote. `gh` starts with an admin login (`gh auth login`): the `credentials` phase of `dispatch/setup-agents.sh` uses it for the rulesets, then replaces it with a fine-grained token that cannot merge ([Agent credentials](agent-credentials.md)). After that, change the token by rerunning `dispatch/setup-agents.sh credentials`, never with plain `gh auth login`, which would store a token that can merge.
- For dispatch: Node 24, Colima and Docker (`brew install colima docker`).
- The plugin installed at user scope ([Install](#install)), once per machine; in the agent container the `container` phase installs it. The project's `.claude/settings.json` does not enable it: the poll and the `container` phase update only the user-scope install, so a project-scope one would go stale (#187). The trade-off: a fresh clone no longer prompts to install the plugin.
- Deny rules in `.claude/settings.json`. The agents' tokens enforce "humans merge": they cannot merge ([Agent credentials](agent-credentials.md)). The deny rules are the backstop for pushes to `main`/`master` and for force, delete and mirror pushes. The plugin ships the comment guard (`hooks/hooks.json`), which enforces the [trust rule](../README.md#trust-rule-for-public-repos). The project adds the deny rules:

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

  A `*` can sit anywhere in a rule, and deny rules apply "when any subcommand matches them" (Claude Code docs, *Configure permissions*), so they hold inside chained and piped commands too. They match the command as written, so a push spelled another way gets past them: `git -C . push`, a quoted or `refs/heads/` refspec, arguments after a `main` or `master` refspec, an abbreviated option such as `--del`, combined short flags such as `-ud`, a force or prune flag written in a form these strings miss, such as `-uf`, or a bare `git push` with `main` checked out. A delete by `:<branch>` refspec is caught only for `issue-*` and `epic-*` branches and for `main`/`master`: a rule ending in `:*` cannot express it, since "The `:*` suffix is an equivalent way to write a trailing wildcard" (same page). On the host, these project rules sit beside the user-settings deny list the `host` phase writes ([Sessions on the host](containers.md#sessions-on-the-host)), and both apply: "deny rules from any scope are evaluated before allow rules" (same page). In the agent container only the project's rules apply. The strings are derived from *Configure permissions* and were not exercised by an agent. To check them, ask a Claude Code session in the project to run `git push --dry-run origin main`: the rules must deny it before it runs (`--dry-run` pushes nothing if a rule fails to match, and `protect-main`, where GitHub enforces it, refuses the real push anyway).
- Optional, for [dispatch](../dispatch/README.md): an entry in the poller config whose `dir` is `/home/node/<name>`, the repo's clone in the agent container; the `container` phase clones it there and trusts it.
- Optional: an unused-export / dead-file check inside `npm run check` (for example knip in production mode, excluding test suites; default knip treats test files as entry points).
- Optional, for [label cleanup](#label-cleanup-on-close): a caller workflow.
- Every GitHub API token a session holds, the host's and the agent container's, is a fine-grained token that cannot merge, and the maintainer merges in the browser. The maintainer sets up the tokens, the host's settings and the agent container with the full `dispatch/setup-agents.sh` (phases `credentials`, `host`, `container`, `check`; [Setting up the machine](#setting-up-the-machine)), run in a terminal, never by an agent. See [Agent credentials](agent-credentials.md).
- Unattended sessions run in the agent container, behind its egress firewall, and push with per-repo deploy keys made there. Interactive sessions stay on the host, with no sandbox. See [Agent container](containers.md).

## Setting up the machine

The maintainer runs these in a terminal in the main clone, never from an agent session. [Onboarding a repo](../dispatch/README.md#onboarding-a-repo) has the detail of each phase.

1. Before starting: Node 24 and `npm ci` in the clone. Colima started with `colima start --cpu 4 --memory 4 --disk 40 --mount none`; `docker context show` prints `colima`, and `colima ssh -- mount` shows no `virtiofs`, `9p` or `sshfs` mount. An admin `gh` login. The dispatch config, with `/home/node/<name>` dirs. In a served repo, an open PR with a `test` check run, an open issue and a completed workflow run for the pre-swap test ([Verify](agent-credentials.md#verify)).
2. `dispatch/setup-agents.sh --dry-run`: every step it would take, changing nothing.
3. With every Claude Code session closed, on the host and in the agent container: `dispatch/setup-agents.sh`, the full run of `credentials`, `host`, `container` and `check`. It stops at the first step that needs the maintainer: do what it prints and rerun.
4. `dispatch/install-launchd.sh install`, which starts polling.

When a session on the host must stay open, run `dispatch/setup-agents.sh host`, `container` and `check` one at a time, then `credentials` once every session is closed, then install. A single phase never resumes dispatch, and `credentials` refuses while any session is live, idle ones included.

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

