# dispatch

Local dispatch tooling that runs from this clone (it is not part of the plugin).

## Overview

A poller runs every 3 minutes from a macOS LaunchAgent and starts one interactive background Claude Code session per eligible ticket, across all configured repos. Sessions run in the agent container and show up in its agent view, which you open from a host terminal with `docker exec -it -w /home/node/claude-workflow claude-workflow-agent claude agents`. This shell function (for `~/.zshrc` or `~/.bashrc`) shortens that and the other session commands below:

```sh
# Claude Code in the agent container, from the clone of this repo. Alone it opens the agent view;
# `agent-claude attach <id>`, `agent-claude logs <name>` and `agent-claude stop <id>` also work.
agent-claude() { docker exec -it -w /home/node/claude-workflow claude-workflow-agent claude "${@:-agents}"; }
```

A ticket is picked up when it is open, authored by the repo's configured `owner`, and labelled `agent-ok` + `ready` (and not `in-progress`, `blocked`, `agent-failed` or `orchestrate-epic-run`). The session is named `<sessionPrefix>-<issue>` (e.g. `app-12`) and runs `work-ticket`.

The poller, installer and config run from the local clone of this repo, not the plugin cache: a LaunchAgent needs a stable path.

The poller is TypeScript run by Node 24. It needs `node` on the launchd `PATH`, which is minimal (the entrypoint adds fnm's default bin, `~/.local/bin` and Homebrew to it), and the clone's npm dependencies: the installer runs `npm ci` in the clone; rerun it (or the installer) after pulling a change to `package-lock.json`. It also needs `gh` and `claude`.

### What this can do on your machine

Labels on GitHub start unattended agent sessions locally:

- Sessions run as you, with your `gh` token. They can read and write every repo that token reaches, not only the configured one.
- They work in `dir` on your files, with your credentials and tools, under the permission mode from your Claude Code settings for that directory (user, project or local `settings.json`, `permissions.defaultMode`). By default that is Claude Code's default mode, so sessions stop and show as `blocked` in `claude agents` at permission prompts. `acceptEdits` widens what they do without asking; the poller does not check this setting, so `bypassPermissions` there lets unattended sessions act with no prompts.
- Every session uses your Claude usage limits and costs money if you pay per token. Several `ready` tickets start several sessions at once.
- At most 10 sessions are live at once across all repos (`CLAUDE_MAX_SESSIONS`; per-repo `maxSessions`). Extra tickets log `deferred #N: at session cap` and start on a later poll.
- Launch flags are logged on every launch. Anyone who can get `owner` to label an issue `ready` can start a session, so keep labelling rights tight.

### Onboarding a repo

1. Meet the [requirements](../docs/setup.md#requirements) (`npm run check`, deny rules, plugin enabled).
2. Create the labels: `setup-labels.sh owner/repo`.
3. Optionally add the [label-cleanup caller](../docs/setup.md#label-cleanup-on-close).
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
   - `maxSessions` (optional, positive integer): cap on live sessions for this repo.
5. Trust the directory: run `claude` once in `dir`, accept the prompt, exit. `claude --bg` fails in an untrusted workspace.
6. The maintainer, in a terminal and never from an agent session, sets the machine up from the clone (`npm ci` there once). `dispatch/setup-agents.sh --dry-run` first lists every step and changes nothing; then `dispatch/setup-agents.sh` runs the four phases in order and stops at the first step that needs the maintainer: do what it prints and rerun.
   - `credentials`: the agents' token, each repo's `restrict-updates` ruleset and auto-merge; see [Agent credentials](../docs/agent-credentials.md). It refuses while a session is live on the host or in the container.
   - `host`: `CLAUDE_CODE_ENABLE_CFC=0` and the deny rules of `dispatch/setup/host-settings.json`, merged into `~/.claude/settings.json` after a backup. A `sandbox` block or a managed settings file left from the old setup gets a note with the command that removes it, and is left as it is.
   - `container`: the [agent container](container/README.md), built and started with the `claude-workflow-home` volume (it needs Colima running: `colima start --cpu 4 --memory 4 --disk 40 --mount none`), and in it, as `node`: per repo, a deploy key (after a `protect-main` check) and an SSH host alias, which you add on GitHub with "Allow write access" when asked, and a clone in `/home/node/<name>`; the host's git identity; a gh login with a fine-grained token of its own, refused unless a wrong-sha merge with it gets 403 (so pasting a token needs an open, mergeable PR in a served repo); a rerun probes the stored login the same way when such a PR is open, and notes it when none is; workspace trust; and the plugin. The Claude token, from `claude setup-token`, goes to `~/.config/claude-workflow/claude-agent.env` (mode 0600), which the container reads.
     - The plugin reaches `main`'s latest commit in two ways. Every `container` run updates it (`claude plugin marketplace update` and `claude plugin update`, with sessions live). Between runs, Claude Code's marketplace auto-update, which the phase turns on (`autoUpdate` on the marketplace entry, `FORCE_AUTOUPDATE_PLUGINS=1` in the container, since the image sets `DISABLE_AUTOUPDATER=1`), runs in an interactive session after its first message; Claude Code's docs do not say whether background sessions run it.
     - The container is replaced when its image changes or its config (the env file or the run flags) does. `container --rebuild` rebuilds the image with `--pull --no-cache` and replaces the container. Either refuses only while a session is live in the container, listing `claude stop <id>` for each, and keeps the volume, so clones, keys and logins survive.
   - `check`: in the container, as `node`, the firewall (`api.github.com` reached, `example.com` refused), the private keys (only the deploy keys, and no `SSH_AUTH_SOCK`), the gh login (`gh repo view` in the first clone) and the mounts (only the home volume); then a probe session started in the first clone with the poller's launch flags and `--permission-mode auto`, which runs `git fetch` and `git push --dry-run` and reports its browser tools. The probe session is stopped by its id afterwards.

   `credentials` pauses dispatch, and so does `container` before it starts or replaces the container, changes its gh login or writes its `~/.claude.json`. A full run resumes it at the end, only when every phase passes. A run of `credentials`, `container` or `check` alone leaves it paused and says so; the way out without a full run is `dispatch/install-launchd.sh resume`. On a first setup, before step 8, there is nothing to resume: the LaunchAgent is not installed yet, and step 8's install starts polling.
7. Dry run: `dispatch/agent-poller.sh --dry-run` logs which tickets would launch and with which flags, and launches nothing. It stops at the [sandbox preflight](#sandbox-preflight) if the `sandbox` phase has not run.
8. Install the LaunchAgent once, from the main clone (not a worktree): `dispatch/install-launchd.sh`.
   - The installer first runs `npm ci` in the clone (a failure aborts with nothing installed).
   - The agent polls as soon as it loads, so the installer repeats the dry run, shows its output and asks `Install and start polling? [y/N]` before writing or starting anything. Anything but `y`, no input, a failing dry run, or a poll already running aborts. `--yes` skips the question for scripted reinstalls.
   - launchd only gives the job `HOME` and `PATH`, so the dry run drops `CLAUDE_MAX_SESSIONS` from your shell. Set it in the plist's `EnvironmentVariables` for the real poller.
   - Remove with `dispatch/install-launchd.sh uninstall`.

A repo added later needs no reinstall. It does need:

- adding to the config and to the token's repository access (edit the token in the browser);
- its `restrict-updates` ruleset, created in the browser as [The Actions token](../docs/agent-credentials.md#the-actions-token) describes (the fine-grained login cannot create it);
- then a full rerun of `dispatch/setup-agents.sh`, or its phases in order: `credentials` (checks the ruleset and the token's access), `container` (the new repo's `protect-main` check, deploy key, alias, clone and trust; edit the container's token in the browser so it can see the repo too). Only a full run resumes dispatch; after single phases, finish with `check`, which does not resume it either: run `dispatch/install-launchd.sh resume`.

Migrating from an older single-repo poller: pass `--legacy-label <its launchd label>` (booted out, plist removed) and `--migrate-state <its state dir> <sessionPrefix>` (copies `launched.json` / `conflicts.json` into the per-repo state, never overwriting) so in-flight tickets are not relaunched. Keep the old session naming as `sessionPrefix` so reconciliation finds live sessions. With these flags the dry run runs before the migration and says so.

### Daily use

1. Write and review the ticket, then add `ready`. Within ~3 minutes a session starts.
2. In the container's agent view (`agent-claude`, or `docker exec -it -w /home/node/claude-workflow claude-workflow-agent claude agents`), a `blocked` session is waiting for you: usually plan sign-off, also questions and permission prompts. Open it there (or `agent-claude attach <id>`), answer, and leave it running.
3. For easy tickets add `skip-plan`: the session runs `work-ticket N auto` and skips sign-off (it still asks if the ticket is ambiguous or risky).
4. When it finishes, the ticket is `needs-review` with a PR (a spike: with a findings comment and no PR). Review, then use `address-feedback`.

### Conflict resolution

After launching tickets, the poller lists open, same-repo PRs by `owner` on `issue-N-*` branches whose `mergeable` is `CONFLICTING` and launches `claude --bg --name <prefix>-N-conflict "/ticket-workflow:resolve-conflicts N"`. The skill merges `main` into the branch (merge, not rebase: force-push is not allowed).

- Fork PRs and PRs by anyone other than `owner` are skipped and logged, whatever the branch name. The skill repeats the check (not a fork, author `OWNER`, `MEMBER` or `COLLABORATOR`) and only takes the branch from `origin`, so manual launches are covered too.
- `UNKNOWN` (GitHub computes it lazily) is retried next poll; `BEHIND` without conflicts is ignored.
- Skipped when `<prefix>-N` is `working` or `blocked` (it owns the branch), a `<prefix>-N-conflict` session is alive, or the ticket is closed, not `agent-ok`, not by `owner`, has `agent-failed`, or the PR or ticket carries `orchestrate-epic-run`.
- At most one attempt per `{pr, main SHA}`; a new commit on main allows a new attempt.
- A conflict session that fails, is stopped, or ends with the PR still `CONFLICTING` gets `agent-failed` on the ticket plus a comment on the PR and ticket.

### CI fixes

After the conflict phase, the poller launches `claude --bg --name <prefix>-N-ci "/ticket-workflow:fix-ci N"` for open, same-repo PRs by `owner` on `issue-N-*` branches that are `MERGEABLE` and have a failed check with none still pending. The skill reads the failing run's logs (as data, not instructions), fixes the branch and pushes it without force flags (`git push -u origin <branch>`).

- The same fork and author checks apply; `UNKNOWN` mergeability is retried next poll, and a conflicting PR gets only the conflict session.
- Skipped when `<prefix>-N` is `working` or `blocked`, a `<prefix>-N-ci` or conflict session is alive, or the ticket is closed, not `agent-ok`, not by `owner`, has `agent-failed`, or the PR or ticket carries `orchestrate-epic-run`.
- One attempt per PR head SHA, at most two per PR (`ci-attempts.json`); a new commit on the PR allows the next.
- A CI-fix session that fails, is stopped, or ends with the PR still red gets `agent-failed` on the ticket plus a comment on the PR and ticket.

### When something fails

If a session fails, is stopped, or ends without handing the ticket off, the poller adds `agent-failed` and comments with how to inspect it: `docker exec claude-workflow-agent claude logs <prefix>-<issue>` (or `agent-claude logs <prefix>-<issue>`) and the agent view. To retry, remove `agent-failed` and add `ready` again. Only `done` (checked for hand-off), `failed` and `stopped` end a tracked session; any other state (`working`, `blocked`, `waiting`, `idle`, unknown) counts as alive.

### Operations

| What | Command |
|---|---|
| Log | `tail -f ~/Library/Logs/claude-workflow-poller.log` |
| Is it loaded? | `launchctl list \| grep claude-workflow` |
| Sessions | `agent-claude` or `docker exec -it -w /home/node/claude-workflow claude-workflow-agent claude agents` (as JSON: `docker exec claude-workflow-agent claude agents --json --all`) |
| One session's output | `agent-claude logs <prefix>-<issue>` or `docker exec claude-workflow-agent claude logs <prefix>-<issue>` |
| Stop a session | `agent-claude stop <id>` or `docker exec claude-workflow-agent claude stop <id>` (the id is in the JSON list) |
| What would launch now | `dispatch/agent-poller.sh --dry-run` |
| Pause everything | `dispatch/install-launchd.sh pause` |
| Resume | `dispatch/install-launchd.sh resume` |

### Options

Per repo options are in `repos.json` (above). Global options are environment variables: set them in `EnvironmentVariables` of the plist template and rerun the installer (it regenerates the installed copy, so edits made only under `~/Library/LaunchAgents/` are overwritten), or prefix a one-off run, e.g. `CLAUDE_MAX_SESSIONS=3 dispatch/agent-poller.sh --dry-run`.

| Variable | Default | Meaning |
|---|---|---|
| `CLAUDE_MAX_SESSIONS` | `10` | Most sessions live at once across all repos (positive integer; invalid values abort the run). A guard against a runaway label batch; raise it deliberately. |
| `EXTRA_PATH` | empty | Directories prepended to the poller's PATH (inherited by sessions). fnm's default bin dir (`~/.local/share/fnm/aliases/default/bin`) is always included so sessions find `node`/`npm`. |
| `STATE_DIR` | `~/.local/state/claude-workflow` | Lock file and per-repo `launched.json` / `conflicts.json` / `ci-attempts.json`. |

### Notes

- The poller never claims a ticket; the session does (`in-progress`) as part of `work-ticket`.
- A ticket is launched once. Delete its entry from `launched.json` to relaunch a ticket that still has `ready`.
- A live session is a tracked launch that is not `done`, `failed` or `stopped`. Tickets over the cap are deferred, not dropped.
- The Mac must be awake and logged in. Nothing runs while it sleeps; the next run after wake picks up anything missed.

## agent-poller.sh

Polls every configured GitHub repo for agent-ready tickets and starts one interactive background session per ticket (`claude --bg`, visible in the agent container's agent view: `docker exec -it -w /home/node/claude-workflow claude-workflow-agent claude agents`, or `agent-claude`). Intended to run every few minutes from a LaunchAgent. Per repo it:

1. Reconciles sessions it launched earlier (marks tickets `agent-failed` when a session failed, stopped, vanished, or finished without handing off).
2. Launches `<prefix>-N` (`/ticket-workflow:work-ticket N`, or `N auto` with the `skip-plan` label) for each open issue authored by the repo's `owner` with `agent-ok` + `ready` and none of `in-progress`, `blocked`, `agent-failed`, `orchestrate-epic-run`.
3. Launches `<prefix>-N-conflict` (`/ticket-workflow:resolve-conflicts N`) for open, same-repo `issue-N-*` PRs authored by `owner` that conflict with main, while ticket N is open, at most once per main SHA. Fork PRs and other authors' PRs are skipped: a fork can use any branch name. A PR or ticket labelled `orchestrate-epic-run` is skipped too.
4. Launches `<prefix>-N-ci` (`/ticket-workflow:fix-ci N`) for open, same-repo `issue-N-*` PRs authored by `owner` that are mergeable but have a failed check (and none still running), while ticket N is open, once per PR head SHA and at most twice per PR. Pending checks, conflicting PRs and a live ticket, conflict or CI-fix session for N launch nothing, and so does a PR or ticket labelled `orchestrate-epic-run`.

`claude agents --json --all` is fetched once per run and shared. A failure in one repo is logged (`[prefix] poll failed ...`), the others still run, and the run exits non-zero at the end.

The poller and the sessions it starts run `gh` with the machine's one login, the restricted fine-grained token described in [Agent credentials](../docs/agent-credentials.md), so neither can merge a PR.

The sessions it starts read user settings like any `claude` session started in `dir` ("A background session reads its settings from the directory it runs in", Claude Code docs, *Manage multiple agents with agent view*), so their Bash commands run in the sandbox described in [Sandboxing agent sessions](../docs/sandboxing.md).

### Layout

`agent-poller.sh` is a thin entrypoint (the path the LaunchAgent runs): it sets `PATH` and runs the TypeScript poller with Node 24 (type stripping, no build step). If `node` is not on `PATH` or older than 24, or the clone has no `node_modules` (dependencies not installed), it logs one line and exits 1. `poller/main.ts` runs the [sandbox preflight](#sandbox-preflight) before it takes the lock.

```
agent-poller.sh        entrypoint: PATH setup, then exec node poller/main.ts
poller/main.ts         startup checks, sandbox preflight, lock, session list, repo loop, exit code
poller/poll.ts         one repo's poll: reconcile, launch tickets, resolve conflicts, fix CI
poller/decide.ts       pure decisions: session state, caps, reconcile, eligibility
poller/config.ts       the repos config (zod schema), CLAUDE_MAX_SESSIONS and launch flags
poller/schemas.ts      zod schemas for gh / claude output and the state files
poller/io.ts           side effects (gh, claude, state files, lock, log) behind PollerIo
poller/*.test.ts       vitest unit tests
```

Every JSON input (the config, `gh` and `claude agents` output, the state files) is parsed once against its schema, and nothing launches from input that does not match. A bad config or session list aborts the run. A bad `gh` answer (e.g. a PR row without `isCrossRepository`) or state file fails that repo's poll (`[prefix] poll failed: ...`, non-zero exit); the other repos still run, and a repo with an unreadable `launched.json` still counts its listed sessions (`<prefix>-...`) toward the global cap.

### Config

`${CLAUDE_WORKFLOW_CONFIG:-~/.config/claude-workflow/repos.json}`: a JSON array.

| Field           | Required | Meaning                                                                        |
| --------------- | -------- | ------------------------------------------------------------------------------ |
| `repo`          | yes      | `owner/name` on GitHub (passed to `gh --repo`)                                 |
| `dir`           | yes      | Local checkout the sessions start in (`~/` is expanded)                        |
| `sessionPrefix` | yes      | Session name prefix and state dir name; `[A-Za-z0-9_-]+`, unique across repos, case-insensitively |
| `owner`         | yes      | Only tickets (and, for conflict resolution, PRs) authored by this login are picked up |
| `maxSessions`   | no       | Positive integer: most live sessions for this repo (on top of the global `CLAUDE_MAX_SESSIONS`) |

```json
[
  {
    "repo": "example-owner/example-app",
    "dir": "~/Projects/example-app",
    "sessionPrefix": "app",
    "owner": "example-owner"
  },
  {
    "repo": "example-owner/example-tools",
    "dir": "~/Projects/example-tools",
    "sessionPrefix": "tools",
    "owner": "example-owner"
  }
]
```

The run aborts non-zero (with a log line naming each bad field, e.g. `[0].repo: not of the form owner/name`, before launching anything) if the file is missing or unreadable, is not valid JSON or not an array, an entry lacks a required non-empty string field, `sessionPrefix` has characters outside `[A-Za-z0-9_-]`, `repo` is not `owner/name`, `maxSessions` is present but not a positive integer, `dir` does not exist, or two entries share a `sessionPrefix` (compared case-insensitively). Unknown fields are ignored. Unique prefixes guarantee session names (`<prefix>-N`) never collide across repos.

### State

`${STATE_DIR:-~/.local/state/claude-workflow}`:

```
lock/                           global run lock (one poller at a time)
repos/<sessionPrefix>/launched.json   {"<N>": {name, at}, "conflict-<N>": {name, at, pr, mainSha}, "ci-<N>": {name, at, pr}}
repos/<sessionPrefix>/conflicts.json  {"<N>": {pr, mainSha}}  last conflict attempt per ticket
repos/<sessionPrefix>/ci-attempts.json  {"<pr>": {headSha, count}}  CI-fix attempts per PR (missing = {})
```

Migrating from a single-repo poller: copy its `launched.json` and `conflicts.json` into `repos/<sessionPrefix>/` (entry shapes are unchanged), or let the installer do it (below).

### Sandbox preflight

Every run, `--dry-run` included, checks the sandbox settings after the config loads and before it takes the run lock; a config with no repos skips it, since nothing can launch. It judges the managed file `/Library/Application Support/ClaudeCode/managed-settings.json` when that exists, else `~/.claude/settings.json`. The file must hold every entry the `sandbox` phase of `dispatch/setup-agents.sh` generates ([Settings](../docs/sandboxing.md#settings)): those of the template `dispatch/setup/sandbox-settings.json`, plus a `sandbox.credentials.files` deny entry and `Read(...)` and `Edit(...)` rules for each private key in `~/.ssh`, detected by its first line. Objects are compared key by key, lists item by item, and other values must be equal. Extra entries are fine.

When an entry is missing, the run logs one line naming the judged file and each missing entry, such as `sandbox preflight failed (<file>): sandbox.enabled is missing (want true); run dispatch/setup-agents.sh sandbox; aborting`, exits 1 and launches nothing. A `~/.ssh` entry or a settings file it cannot read, a missing settings file, or one that is not a JSON object fails it the same way. A passing `--dry-run` logs `sandbox preflight passed (<file>)`; a normal run logs nothing then.

The fix is `dispatch/setup-agents.sh sandbox`. A template change pulled into the clone, a new key in `~/.ssh`, or a hand edit that drops an entry stops dispatch until that phase is rerun. `install-launchd.sh install` runs the poller's dry run first, so it fails the same way until the sandbox phase has run.

### install-launchd.sh

    dispatch/install-launchd.sh [install|uninstall|pause|resume|status] [--yes] [--purge] [--legacy-label LABEL]... [--migrate-state DIR PREFIX]...

`install` first runs `npm ci` in the clone (the poller's runtime dependencies; a failure aborts with nothing installed). Before writing or starting anything, it then runs `agent-poller.sh --dry-run`, prints the output and asks `Install and start polling? [y/N]`: the LaunchAgent runs the poller at load, so this is the first look at what would launch. Anything but `y` (or EOF on stdin) exits 1 with nothing written. A failing dry run always aborts, even with `--yes`. Installs `~/Library/LaunchAgents/com.askrzypczak.claude-workflow-poller.plist` (from `launchd/`, filled in with this clone's path) and bootstraps it: the poller runs at load and every 3 minutes, logging to `~/Library/Logs/claude-workflow-poller.log`. Rerunning `install` regenerates the plist, re-enables it if `pause` disabled it, and reloads it. It refuses to run from a worktree (the plist would point at a path that disappears) or without a config file; start from `repos.example.json`.

- `--yes`: skip the confirmation question (the dry run is still run and shown), e.g. for scripted reinstalls.
- `--legacy-label LABEL` (repeatable): boot out and delete an older LaunchAgent, before the new one starts. `LABEL` becomes a file name, so only letters, digits, `.`, `_` and `-` are accepted (exit 2 otherwise).
- `--migrate-state DIR PREFIX` (repeatable): copy `launched.json` and `conflicts.json` from an old poller's state dir to `repos/PREFIX/`, skipping files that already exist. `PREFIX` is the `sessionPrefix` whose sessions that poller named (`<PREFIX>-N`); only letters, digits, `_` and `-` are accepted.
- `uninstall` boots out and removes the plist (and any `--legacy-label` jobs), then lists what it left behind: the state dir, the config, the log file, sessions still recorded in `launched.json` (each with its `claude stop <name>`) and the plugin removal commands (`claude plugin uninstall ticket-workflow`, `claude plugin marketplace remove askrzypczak-plugins`).
- `uninstall --purge` also deletes the state dir, the config file and the log file. It never stops sessions or removes the plugin. `--purge` is rejected for `install`.
- `pause` stops polling until `resume`: it disables the LaunchAgent and boots it out, so the job stays off across logins and reboots. The plist stays in place and no files change. Sessions already running are not stopped. `pause` lists them from `launched.json`, each with its `claude stop <name>` command, the same list `uninstall` prints.
- `resume` enables the LaunchAgent and bootstraps the installed plist, so the poller runs now and every 3 minutes again. It needs an installed plist; without one it exits 1 and points at `install`. It skips `npm ci` and the dry run. If the job is already loaded, it says so and exits 0.
- `status` prints three lines: whether the plist is installed, whether the job is loaded, and whether it is disabled (paused). It exits 0 whether or not the job is loaded.
- `--purge`, `--legacy-label` and `--migrate-state` are rejected (exit 2) for `pause`, `resume` and `status`.

The plist is filled in with the clone path and `$HOME` XML-escaped, written to a temp file, checked with `plutil -lint` (when available) and moved into place only if valid, so a failure never leaves a broken plist.

### Running

    dispatch/agent-poller.sh --dry-run   # log what would happen; no launches, labels or comments, and no changes to session or ticket tracking (it still takes the lock, but writes no state files)
    dispatch/agent-poller.sh

Environment:

- `CLAUDE_WORKFLOW_CONFIG`: config path (above).
- `CLAUDE_WORKFLOW_MANAGED_SETTINGS`: the managed settings file the [sandbox preflight](#sandbox-preflight) judges when it exists, instead of `/Library/Application Support/ClaudeCode/managed-settings.json`. A test override; unset under launchd.
- `STATE_DIR`: state root (above).
- `CLAUDE_MAX_SESSIONS`: positive integer, default `10`. Live sessions are tracked entries in `launched.json` (tickets and conflict sessions) whose session is not `done`, `failed` or `stopped`; unlisted just-launched ones count. The global cap counts across all repos, a repo's `maxSessions` only that repo. At a cap the poller logs `deferred #N: at session cap` and leaves state untouched, so the launch is retried next poll. `--dry-run` applies the same caps. An invalid value aborts the run.
- The launch flags are logged on every launch line (`flags: ...`).
- `EXTRA_PATH`: prepended to `PATH` (the script also adds the fnm default bin dir, `~/.local/bin` and Homebrew, since launchd does not read your shell profile). Used by the tests to inject fake binaries.

Requires Node 24 (`node` on the `PATH` above, which is what the LaunchAgent sees), the clone's npm dependencies (`npm ci`; the installer runs it, and you rerun it, or the installer, after pulling a change to `package-lock.json`), plus `gh` and `claude`. The poller itself does not need `jq` (the installer's `uninstall` and `pause` use it, if present, to list sessions).

### CI-fix state

A `ci-<N>` entry in `launched.json` is reconciled like `conflict-<N>`: a session that fails or is stopped, or finishes with its PR still open and red, marks ticket N `agent-failed` and comments on the PR and ticket. `ci-attempts.json` keeps the last head SHA and attempt count per PR (kept when the session fails), so a head SHA is tried once and a PR at most twice. The skill never force-pushes, rebases or merges.

### Tests

Both groups run from `npm test` (after `npm ci`; Node 24), one vitest runner:

- `dispatch/poller/*.test.ts`: unit tests for the config, the decisions, and one repo's poll against a fake `PollerIo`.
- `dispatch/*.test.ts`: end-to-end suites that run the real entrypoint (`agent-poller.test.ts`) and the installer (`install-launchd.test.ts`) with fake `gh`, `claude`, `launchctl` and `npm` binaries; nothing real is touched.

To run one part:

    npx vitest run dispatch/poller
    npx vitest run dispatch/agent-poller
    npx vitest run dispatch/install-launchd
