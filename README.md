# claude-workflow

> [!CAUTION]
> This is a personal experiment, not a supported product. It runs autonomous agents with your credentials and can start unattended sessions on your machine. Use it at your own risk, and read [What this can do on your machine](#what-this-can-do-on-your-machine) before enabling dispatch.

Claude Code plugin marketplace (`askrzypczak-plugins`) for an orchestrated, ticket-driven agent workflow.

## Contents

Plugin `ticket-workflow`:

- Skills:
  - `work-ticket`: works a GitHub issue end to end.
  - `address-feedback`: handles review feedback on the PR.
  - `resolve-conflicts`: merges `origin/main` into a conflicting `issue-N-*` PR branch, runs `npm run check`, publishes. Stops with `needs input` on semantic conflicts; never rebases or force-pushes.
  - `audit-epic`: read-only necessity audit of an epic and its child tickets; prints a report and changes nothing on GitHub.
- Subagents: `implementer` (haiku, xhigh; sonnet or opus per the approved plan) builds code and tests; `reviewer` (opus, medium, read-only) reviews complex diffs; `spec-auditor` (opus, high, read-only) audits epics for necessity.
- `scripts/grg.sh`: mechanical green/red/green test check. Self-test: `scripts/test-grg.sh`.
- Hooks: a git guard and a comment guard (see [Requirements](#requirements) and [Trust rule](#trust-rule-for-public-repos)).

Outside the plugin, `dispatch/` holds `agent-poller.sh`, a multi-repo poller that starts background sessions for `ready` + `agent-ok` tickets. It runs from this clone. See [Dispatch](#dispatch-automatic-ticket-pickup) and `dispatch/README.md`.

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
- Ticket labels, created with `plugins/ticket-workflow/scripts/setup-labels.sh [owner/repo]` (idempotent: existing labels are left untouched; `--update` overwrites their colour and description). See [Ticket conventions](#ticket-conventions).
- `gh` authenticated (SSH remote, `gh auth login`) and `jq` on PATH.
- The plugin enabled in `.claude/settings.json`: `enabledPlugins` with `ticket-workflow@askrzypczak-plugins`, plus an `extraKnownMarketplaces` entry for `askrzypczak/claude-workflow`.
- Deny rules in `.claude/settings.json`. The guards ship with the plugin (`hooks/hooks.json`): the git guard blocks pushes to `main`/`master`, force pushes and `gh pr merge`; the comment guard enforces the [trust rule](#trust-rule-for-public-repos). The project only adds the deny rules:

        "permissions": {
          "deny": [
            "Bash(gh pr merge *)",
            "Bash(git push --force*)",
            "Bash(git push -f*)"
          ]
        }
- Optional, for [dispatch](#dispatch-automatic-ticket-pickup): an entry in the poller config and a directory trusted by Claude Code.
- Optional, for [label cleanup](#label-cleanup-on-close): a caller workflow.

## Ticket conventions

GitHub Issues is the source of truth; agents use `gh`.

### Labels

- State: `ready` -> `in-progress` -> `needs-review`; `blocked` while waiting on something.
- Type: `bug`, `feature`, `chore`.
- Dispatch: `agent-ok` (safe for unattended agents), `skip-plan` (launch with `work-ticket N auto`, no plan sign-off), `agent-failed` (set by the poller when a session failed).

`ready` means a human reviewed the ticket and approved its premise for work. It does not approve every acceptance criterion (AC): AC are proposals until the plan gate, where the human approves them as a diff against the ticket. **Only the maintainer adds `ready`.** Agents that file tickets never set `ready` or `skip-plan`. They may set type labels, `agent-ok` and `blocked` (with `Blocked by #M`); the maintainer removes `agent-ok` during review if needed.

### One ticket, one worktree

One ticket = one worktree = one branch (`issue-N-slug`) = one PR containing `Closes #N`. Agents may push their own `issue-N-*` branch; humans merge. Nobody pushes to `main`, force-pushes, or merges PRs from an agent session.

### Dependencies

Write `Blocked by #M` in the issue body (also `#3, #5` or `#3 and #5`; several lines allowed) and add `blocked`. [Label cleanup](#label-cleanup-on-close) removes it.

### Epics

Write `Part of #N` in a child ticket's body to link it to its epic; the epic body lists its children. `audit-epic N` reads the epic and its children together. Unlike `Blocked by`, it carries no state (label cleanup ignores it).

### Trust rule for public repos

Comments on a public repo can come from anyone, so an agent reading them is open to prompt injection. The skills pipe `gh` output through `scripts/trusted-comments.ts`, which keeps only comments, reviews and review comments whose author association is `OWNER`, `MEMBER` or `COLLABORATOR`. Everything else (or a missing association) is dropped; the script reports the count and authors' logins, never bodies, and agents report the count. The filter fails closed: it exits non-zero on comment-like fields it cannot filter (e.g. `latestReviews`), and the agent then stops and tells the human.

Issue and PR bodies are not filtered, so the skills also check the author's association and stop if it is not one of the three. The poller launches only owner-authored tickets, but manual launches can name any issue. `resolve-conflicts` acts only on same-repo PRs by trusted authors and never checks out a fork's code.

The plugin's PreToolUse hook (`hooks/guard-comments.sh`, tested by `hooks/test-guard-comments.sh`) denies Bash commands that read comments or reviews unless piped into `trusted-comments.ts`. That covers `--comments`, `--json` with comment/review fields, `gh api` comment/review endpoints, graphql, and `curl`/`wget` of API comment endpoints. It denies regardless of piping: timelines, GitHub issue/PR/discussion page URLs (also via `WebFetch`), `gh api` issue/PR paths built from shell variables, and `--json` listings that include `body`. It fails closed if `jq` is missing. It is a text-matching guardrail, not a security boundary.

Limits:

- `MEMBER` means anyone in the owning organisation, even without access to this repo; `COLLABORATOR` includes read-only collaborators.
- The filter checks authors, not content: a trusted user who quotes untrusted text passes it through.

Stopgap: GitHub's temporary interaction limits (repo Settings, Moderation options) restrict commenting to collaborators for a period.

### Working a ticket

Agents follow the `work-ticket` skill with an explicit issue number, run manually (`/ticket-workflow:work-ticket N`) or launched by the poller. Agents never pick tickets themselves. See [Workflow](#workflow).

## Dispatch (automatic ticket pickup)

A poller runs every 3 minutes from a macOS LaunchAgent and starts one interactive background Claude Code session per eligible ticket, across all configured repos. Sessions show up in `claude agents`.

A ticket is picked up when it is open, authored by the repo's configured `owner`, and labelled `agent-ok` + `ready` (and not `in-progress`, `blocked` or `agent-failed`). The session is named `<sessionPrefix>-<issue>` (e.g. `app-12`) and runs `work-ticket`.

The poller, installer and config run from the local clone of this repo, not the plugin cache: a LaunchAgent needs a stable path.

The poller is TypeScript run by Node 24. It needs `node` on the launchd `PATH`, which is minimal (the entrypoint adds fnm's default bin, `~/.local/bin` and Homebrew to it), and the clone's npm dependencies: the installer runs `npm ci` in the clone; rerun it (or the installer) after pulling a change to `package-lock.json`. It also needs `gh` and `claude`.

### What this can do on your machine

Labels on GitHub start unattended agent sessions locally:

- Sessions run as you, with your `gh` token. They can read and write every repo that token reaches, not only the configured one.
- They work in `dir` on your files, with your credentials and tools, under the permission mode you configure. With no flags that is Claude Code's default mode, so sessions stop and show as `blocked` in `claude agents` at permission prompts. `--permission-mode acceptEdits` and similar flags widen what they do without asking.
- Every session uses your Claude usage limits and costs money if you pay per token. Several `ready` tickets start several sessions at once.
- Bypass flags (`--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions`, `--permission-mode bypassPermissions`) are refused: a repo whose combined `CLAUDE_BG_FLAGS` + `bgFlags` contain one is skipped, logged and the run exits non-zero. Set `CLAUDE_ALLOW_BYPASS_PERMISSIONS=1` to accept the risk.
- At most 10 sessions are live at once across all repos (`CLAUDE_MAX_SESSIONS`; per-repo `maxSessions`). Extra tickets log `deferred #N: at session cap` and start on a later poll.
- Effective flags are logged on every launch. Anyone who can get `owner` to label an issue `ready` can start a session, so keep labelling rights tight.

### Onboarding a repo

1. Meet the [requirements](#requirements) (`npm run check`, deny rules, plugin enabled).
2. Create the labels: `setup-labels.sh owner/repo`.
3. Optionally add the [label-cleanup caller](#label-cleanup-on-close).
4. Add the repo to `~/.config/claude-workflow/repos.json` (`dispatch/repos.example.json` is a starting point; the installer refuses to run without the file):

        [
          {
            "repo": "example-owner/example-app",
            "dir": "~/Projects/example-app",
            "sessionPrefix": "app",
            "owner": "example-owner"
          }
        ]

   - `repo`: `owner/name`.
   - `dir`: the main checkout sessions start in (not a worktree).
   - `sessionPrefix`: names sessions; unique per repo.
   - `owner`: the only ticket author whose tickets are launched.
   - `bgFlags` (optional): extra `claude --bg` flags for this repo, e.g. `--permission-mode acceptEdits`.
   - `maxSessions` (optional, positive integer): cap on live sessions for this repo.
5. Trust the directory: run `claude` once in `dir`, accept the prompt, exit. `claude --bg` fails in an untrusted workspace.
6. Dry run: `npm ci` in the clone once, then `dispatch/agent-poller.sh --dry-run` logs which tickets would launch and with which flags, and launches nothing.
7. Install the LaunchAgent once, from the main clone (not a worktree): `dispatch/install-launchd.sh`.
   - The installer first runs `npm ci` in the clone (a failure aborts with nothing installed).
   - The agent polls as soon as it loads, so the installer repeats the dry run, shows its output and asks `Install and start polling? [y/N]` before writing or starting anything. Anything but `y`, no input, a failing dry run, or a poll already running aborts. `--yes` skips the question for scripted reinstalls.
   - launchd only gives the job `HOME` and `PATH`, so the dry run drops `CLAUDE_BG_FLAGS`, `CLAUDE_ALLOW_BYPASS_PERMISSIONS` and `CLAUDE_MAX_SESSIONS` from your shell. Set them in the plist's `EnvironmentVariables` for the real poller.
   - Remove with `dispatch/install-launchd.sh uninstall`. Adding repos later only needs a config edit.

Migrating from an older single-repo poller: pass `--legacy-label <its launchd label>` (booted out, plist removed) and `--migrate-state <its state dir> <sessionPrefix>` (copies `launched.json` / `conflicts.json` into the per-repo state, never overwriting) so in-flight tickets are not relaunched. Keep the old session naming as `sessionPrefix` so reconciliation finds live sessions. With these flags the dry run runs before the migration and says so.

### Daily use

1. Write and review the ticket, then add `ready`. Within ~3 minutes a session starts.
2. In `claude agents`, a `blocked` session is waiting for you: usually plan sign-off, also questions and permission prompts. Use `claude attach <prefix>-<issue>`, answer, and leave it running.
3. For easy tickets add `skip-plan`: the session runs `work-ticket N auto` and skips sign-off (it still asks if the ticket is ambiguous or risky).
4. When it finishes, the ticket is `needs-review` with a PR. Review, then use `address-feedback`.

### Conflict resolution

After launching tickets, the poller lists open, same-repo PRs by `owner` on `issue-N-*` branches whose `mergeable` is `CONFLICTING` and launches `claude --bg --name <prefix>-N-conflict "/ticket-workflow:resolve-conflicts N"`. The skill merges `main` into the branch (merge, not rebase: force-push is not allowed).

- Fork PRs and PRs by anyone other than `owner` are skipped and logged, whatever the branch name. The skill repeats the check (not a fork, author `OWNER`, `MEMBER` or `COLLABORATOR`) and only takes the branch from `origin`, so manual launches are covered too.
- `UNKNOWN` (GitHub computes it lazily) is retried next poll; `BEHIND` without conflicts is ignored.
- Skipped when `<prefix>-N` is `working` or `blocked` (it owns the branch), a `<prefix>-N-conflict` session is alive, or the ticket is closed, not `agent-ok`, not by `owner`, or has `agent-failed`.
- At most one attempt per `{pr, main SHA}`; a new commit on main allows a new attempt.
- A conflict session that fails, is stopped, or ends with the PR still `CONFLICTING` gets `agent-failed` on the ticket plus a comment on the PR and ticket.

### When something fails

If a session fails, is stopped, or ends without handing the ticket off, the poller adds `agent-failed` and comments with how to inspect it (`claude logs <prefix>-<issue>`). To retry, remove `agent-failed` and add `ready` again. Only `done` (checked for hand-off), `failed` and `stopped` end a tracked session; any other state (`working`, `blocked`, `waiting`, `idle`, unknown) counts as alive.

### Operations

| What | Command |
|---|---|
| Log | `tail -f ~/Library/Logs/claude-workflow-poller.log` |
| Is it loaded? | `launchctl list \| grep claude-workflow` |
| Sessions | `claude agents` (or `claude agents --json --all`) |
| One session's output | `claude logs <prefix>-<issue>` |
| Stop a session | `claude stop <prefix>-<issue>` |
| What would launch now | `dispatch/agent-poller.sh --dry-run` |
| Pause everything | `dispatch/install-launchd.sh uninstall` |

### Options

Per repo options are in `repos.json` (above). Global options are environment variables: set them in `EnvironmentVariables` of the plist template and rerun the installer (it regenerates the installed copy, so edits made only under `~/Library/LaunchAgents/` are overwritten), or prefix a one-off run, e.g. `CLAUDE_BG_FLAGS="--permission-mode acceptEdits" dispatch/agent-poller.sh --dry-run`.

| Variable | Default | Meaning |
|---|---|---|
| `CLAUDE_BG_FLAGS` | empty | Extra flags for `claude --bg`, applied to every repo (per-repo `bgFlags` adds to it). Sessions always start with `--model sonnet --effort high` first; add your own `--model` or `--effort` here or in `bgFlags` to override. |
| `CLAUDE_MAX_SESSIONS` | `10` | Most sessions live at once across all repos (positive integer; invalid values abort the run). A guard against a runaway label batch; raise it deliberately. |
| `CLAUDE_ALLOW_BYPASS_PERMISSIONS` | unset | `1` allows bypass flags in `CLAUDE_BG_FLAGS` / `bgFlags`; otherwise such repos are refused. |
| `EXTRA_PATH` | empty | Directories prepended to the poller's PATH (inherited by sessions). fnm's default bin dir (`~/.local/share/fnm/aliases/default/bin`) is always included so sessions find `node`/`npm`. |
| `STATE_DIR` | `~/.local/state/claude-workflow` | Lock file and per-repo `launched.json` / `conflicts.json`. |

### Notes

- The poller never claims a ticket; the session does (`in-progress`) as part of `work-ticket`.
- A ticket is launched once. Delete its entry from `launched.json` to relaunch a ticket that still has `ready`.
- A live session is a tracked launch that is not `done`, `failed` or `stopped`. Tickets over the cap are deferred, not dropped.
- The Mac must be awake and logged in. Nothing runs while it sleeps; the next run after wake picks up anything missed.

## Label cleanup on close

A reusable workflow (`workflow_call`, ticket #15) that runs when an issue is closed (e.g. by merging a PR with `Closes #N`):

- removes `ready`, `in-progress`, `needs-review`, `blocked` from the closed issue (only those it has);
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

## Workflow

1. Check the ticket author is trusted (owner, member, collaborator) before reading anything else, then read and claim the ticket (planning counts as work), reading only trusted comments.
2. Plan, with human sign-off: the AC as a diff against the ticket (additions struck unless approved), Interfaces, Test titles and Carrying costs.
3. Branch in a worktree; the approved plan is posted on the issue.
4. Implementer builds the code and tests.
5. Green/red/green proof.
6. Reviewer on complex changes; the orchestrator triages its findings (blockers and cheap fixes to the implementer, the rest deferred).
7. Open an active (non-draft) PR with CI green; its body repeats the approved plan.
8. Human review, then address-feedback.
9. Human merges.

## License

MIT, see [LICENSE](LICENSE).
