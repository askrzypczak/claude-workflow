# claude-workflow

Claude Code plugin marketplace for an orchestrated, ticket-driven agent workflow.

## What's in it

Plugin `ticket-workflow`:

- Skills: `work-ticket` (works a GitHub issue end to end), `address-feedback` (handles review feedback on the PR) and `resolve-conflicts` (merges `origin/main` into a conflicting `issue-N-*` PR branch, resolves, runs `npm run check`, publishes the branch; stops with `needs input` on semantic conflicts; never rebases or force-pushes).
- Subagents: `implementer` (haiku, xhigh; sonnet or opus per the approved plan) builds code and tests; `reviewer` (opus, medium, read-only) reviews complex diffs.
- `scripts/grg.sh`: mechanical green/red/green test check. Self-test: `scripts/test-grg.sh`.

## Dispatch

`dispatch/` holds `agent-poller.sh`, a multi-repo poller that starts background sessions for `ready` + `agent-ok` tickets. It runs from this clone, not from the plugin. See `dispatch/README.md`.

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

- The workflow checks out this (public) repo and runs `plugins/ticket-workflow/scripts/ticket-labels.ts`; callers need no secrets or special Actions settings.
- The workflow sets up Node 24 itself (the script runs TypeScript directly).
- Tests: `npm test`.

## What a project must provide

- An `npm run check` command that runs build, lint, typecheck, and tests. It is the definition of done and what CI runs.
- The ticket labels (see [Ticket conventions](#ticket-conventions)), created with `setup-labels.sh [owner/repo]` from this repo.
- `gh` authenticated (SSH remote, `gh auth login`).
- A project-level PreToolUse git guard hook that blocks pushes to `main`/`master`, force pushes and PR merges via `gh`, plus matching deny rules in `.claude/settings.json`. The repo-guard (pushes, merges) deliberately stays in each project, e.g. `.claude/hooks/guard-git.sh`. The comment guard (see [Trust rule](#trust-rule-for-public-repos)) is different: it ships with the plugin (`hooks/hooks.json`), so no project setup is needed. It needs `jq` on PATH.
- The plugin enabled in the project's `.claude/settings.json` (`enabledPlugins` with `ticket-workflow@askrzypczak-plugins`, plus the `extraKnownMarketplaces` entry for `askrzypczak/claude-workflow`).
- For automatic dispatch: an entry for the repo in the poller config, and the directory trusted by Claude Code (see [Dispatch](#dispatch-automatic-ticket-pickup)).
- For label cleanup on close: a caller workflow for the shared ticket-labels workflow (see [Label cleanup](#label-cleanup-on-close)).

## Ticket conventions

GitHub Issues is the source of truth; agents use `gh` (at `/opt/homebrew/bin/gh` if not on PATH).

### Labels
- State: `ready` -> `in-progress` -> `needs-review`; `blocked` while waiting on something.
- Type: `bug`, `feature`, `chore`.
- Dispatch: `agent-ok` (safe for unattended background agents), `skip-plan` (launch with `work-ticket N auto`, no plan sign-off), `agent-failed` (set by the poller when a session failed; see below).
- `ready` means a human has reviewed the ticket and approved it for work. **Only the maintainer adds `ready`.** Agents that file tickets never set `ready` or `skip-plan`, even on unblocked tickets. They may set type labels, `agent-ok` and `blocked` (with `Blocked by #M`); the maintainer removes `agent-ok` during review if needed.
- Create or refresh the whole set in any repo with `setup-labels.sh [owner/repo]` (it adds `skip-plan` and `agent-failed` too).

### One ticket, one worktree
One ticket = one worktree = one branch (`issue-N-slug`) = one PR containing `Closes #N`. Agents may push their own `issue-N-*` branch; humans merge. Nobody pushes to `main`, force-pushes, or merges PRs from an agent session.

### Dependencies
Write `Blocked by #M` in the issue body (also `#3, #5` or `#3 and #5`; several lines allowed) and add `blocked`. See Label cleanup for when `blocked` is removed.

### Trust rule for public repos
Comments on a public repo can come from anyone, and an agent reading them is open to prompt injection. The skills pipe `gh` output through `scripts/trusted-comments.ts`, which keeps only comments, reviews and review comments whose author association is `OWNER`, `MEMBER` or `COLLABORATOR` (anything else, or a missing association, is dropped). The script prints how many were skipped and their authors' logins, never their bodies; agents never act on skipped comments and report the count. The issue body and PR body are not filtered, so the skills also check the issue or PR author's association and stop if it is not one of the three (the poller launches only owner-authored tickets, but manual launches can name any issue). The plugin also ships a PreToolUse hook (`hooks/guard-comments.sh`, tested by `hooks/test-guard-comments.sh`) that denies Bash commands reading comments or reviews (`--comments`, `--json` with comments/reviews fields, `gh api` comment/review endpoints, graphql) unless the output is piped into `trusted-comments.ts`. It is a text-matching guardrail, not a security boundary. The filter itself fails closed: it exits non-zero on comment-like fields it cannot filter (for example `latestReviews`), and if it fails the agent stops and tells the human. `resolve-conflicts` acts only on same-repo PRs by trusted authors and never checks out a fork's code. This applies to public consuming repos too.

Limits of the trust rule:
- `MEMBER` means anyone in the owning organisation, even without access to this repo, and `COLLABORATOR` includes read-only collaborators.
- A trusted user who quotes untrusted text (for example pasting an outsider's comment) still passes that text through; the filter checks authors, not content.

Stopgap: GitHub's temporary interaction limits (repo Settings, Moderation options) restrict commenting to collaborators for a period.

### Working a ticket
Agents follow the `work-ticket` skill with an explicit issue number, either run manually (`/ticket-workflow:work-ticket N`) or launched by the poller. Agents never pick tickets themselves. See [Workflow](#workflow).

## Dispatch (automatic ticket pickup)

A poller runs every 3 minutes from a macOS LaunchAgent and starts one interactive background Claude Code session per eligible ticket, across all configured repos. Sessions show up in `claude agents`.

A ticket is picked up when it is **open**, authored by the repo's configured `owner`, and labelled **`agent-ok` + `ready`** (and is not `in-progress`, `blocked` or `agent-failed`). The session is named `<sessionPrefix>-<issue>` (e.g. `app-12`) and runs `work-ticket`.

The poller, installer and config live in this repo and run from the local clone (`~/Projects/claude-workflow`), not from the plugin cache: a LaunchAgent needs a stable path.

### Onboarding a new repo
1. Make sure the repo provides what the previous section lists (`npm run check`, guard hook, plugin enabled).
2. Create the labels: `setup-labels.sh owner/repo`.
3. Add the label-cleanup caller workflow (below).
4. Add the repo to `~/.config/claude-workflow/repos.json`:

        [
          {
            "repo": "example-owner/example-app",
            "dir": "~/Projects/example-app",
            "sessionPrefix": "app",
            "owner": "example-owner"
          }
        ]

   `repo` is `owner/name`; `dir` is the main checkout the sessions start in (not a worktree); `sessionPrefix` names sessions and must be unique per repo; `owner` is the only ticket author whose tickets are launched; `bgFlags` (optional) adds `claude --bg` flags for that repo, e.g. `--permission-mode acceptEdits`.
5. Trust the directory: run `claude` once in `dir`, accept the prompt, exit. `claude --bg` fails in an untrusted workspace.
6. Install the LaunchAgent once, from the main clone of this repo (not a worktree): `dispatch/install-launchd.sh`. Remove with `dispatch/install-launchd.sh uninstall`. Adding more repos later only needs a config edit. `dispatch/repos.example.json` is a starting point for the config (the installer refuses to run without it).
   Migrating from an older single-repo poller: pass `--legacy-label <its launchd label>` (booted out, plist removed) and `--migrate-state <its state dir> <sessionPrefix>` (copies `launched.json` / `conflicts.json` into this poller's per-repo state, never overwriting) so in-flight tickets are not relaunched. Keep the old session naming as `sessionPrefix` so reconciliation finds the live sessions.
7. Check with `dispatch/agent-poller.sh --dry-run`.

### Daily use
1. Write the ticket, review it, then add `ready` (your approval; agents normally already set `agent-ok`, remove it if the ticket shouldn't run unattended). Within ~3 minutes a session starts.
2. Open `claude agents`. A session in the `blocked` state is waiting for you: usually the plan sign-off, but also questions and permission prompts. Attach with `claude attach <prefix>-<issue>`, answer, and leave it running.
3. For easy tickets add `skip-plan`: the session runs `work-ticket N auto` and skips the sign-off (it still asks if the ticket is ambiguous or risky).
4. When it finishes, the ticket is `needs-review` with a PR. Review, then use `address-feedback`.

### Conflict resolution
After launching tickets, the poller lists open, same-repo PRs by `owner` on `issue-N-*` branches whose `mergeable` is `CONFLICTING` and launches `claude --bg --name <prefix>-N-conflict "/ticket-workflow:resolve-conflicts N"`. The skill merges `main` into the branch (merge, not rebase: force-push is not allowed).
- Fork PRs and PRs by anyone other than `owner` are skipped (and logged) whatever their branch name, since a fork can name its branch `issue-N-*`. The skill repeats the check (not a fork, author `OWNER`, `MEMBER` or `COLLABORATOR`) and only takes the branch from `origin`, so manual launches are covered too.
- `UNKNOWN` (GitHub computes it lazily) is retried next poll; `BEHIND` without conflicts is ignored.
- Skipped when `<prefix>-N` is `working` or `blocked` (it owns the branch), a `<prefix>-N-conflict` session is alive, the ticket is closed, not `agent-ok`, not by `owner`, or has `agent-failed`.
- At most one attempt per `{pr, main SHA}`; a new commit on main allows a new attempt.
- A conflict session that fails, is stopped, or finishes with the PR still `CONFLICTING` gets `agent-failed` on the ticket plus a comment on the PR and ticket.

### When something fails
If a session fails, is stopped, or ends without handing the ticket off, the poller adds `agent-failed` and comments with how to inspect it (`claude logs <prefix>-<issue>`). To retry, remove `agent-failed` and add `ready` again. Only the states `done` (checked for hand-off), `failed` and `stopped` end a tracked session; any other state (`working`, `blocked`, `waiting`, `idle`, unknown) counts as alive.

### Checking on it
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
Per repo, in `repos.json` (above). Global, as environment variables: set them in `EnvironmentVariables` of the plist template and rerun the installer (it regenerates the installed copy, so edits made only to `~/Library/LaunchAgents/` are overwritten), or prefix a one-off run, e.g. `CLAUDE_BG_FLAGS="--permission-mode acceptEdits" dispatch/agent-poller.sh --dry-run`.

| Variable | Default | Meaning |
|---|---|---|
| `CLAUDE_BG_FLAGS` | empty | Extra flags for `claude --bg`, applied to every repo (per-repo `bgFlags` adds to it). |
| `EXTRA_PATH` | empty | Directories prepended to the poller's PATH (inherited by sessions). fnm's default bin dir (`~/.local/share/fnm/aliases/default/bin`) is always included so sessions find `node`/`npm`. |
| `STATE_DIR` | `~/.local/state/claude-workflow` | Lock file and per-repo `launched.json` / `conflicts.json`. |

### Notes
- The poller never claims a ticket itself: the session does that (`in-progress`) as part of `work-ticket`.
- A ticket is launched once. Delete its entry from `launched.json` to force a relaunch of a ticket that still has `ready`.
- There is no concurrency limit: every eligible ticket gets a session on the next poll.
- The Mac must be awake and logged in. Nothing runs while it sleeps; the next run after wake picks up anything missed.

## Label cleanup on close

When an issue is closed (e.g. by merging a PR with `Closes #N`), a workflow:
- removes `ready`, `in-progress`, `needs-review`, `blocked` from the closed issue (only those it has);
- for each open `blocked` issue whose body has `Blocked by #N`, removes `blocked` once every referenced blocker is closed (issues closed as not planned count as closed);
- never adds `ready`.

It is a reusable workflow (`workflow_call`) in this repo (ticket #15). A consuming repo adds a short caller, `.github/workflows/ticket-labels.yml`, triggered on `issues: closed` that calls `askrzypczak/claude-workflow/.github/workflows/ticket-labels.yml@main`, with `issues: write` and `contents: read` permissions. This repo is public, so a caller's default `GITHUB_TOKEN` can use it and no Actions access setting is needed.

## Workflow

1. Read and claim the ticket (planning counts as work), reading only trusted comments (owner, member, collaborator).
2. Plan, with human sign-off.
3. Branch in a worktree.
4. Implementer builds the code and tests.
5. Green/red/green proof.
6. Reviewer on complex changes; the orchestrator triages its findings (blockers and cheap fixes to the implementer, the rest deferred).
7. Open an active (non-draft) PR with CI green.
8. Human review, then address-feedback.
9. Human merges.

## License

MIT, see [LICENSE](LICENSE).
