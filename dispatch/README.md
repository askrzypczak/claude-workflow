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

The job, the installer and the config live in the local clone of this repo, not the plugin cache: a LaunchAgent needs a stable path.

What runs where: the LaunchAgent's job, `dispatch/launchd/job.sh`, runs on the host. The poller and the sessions it starts run in the [agent container](../docs/containers.md), the poller from the container's clone of this repo, `/home/node/claude-workflow`. Each poll, the job starts Colima and the container when they are down, updates the plugin in the container, copies the dispatch config in and runs the poller there as `node`. Interactive sessions stay on the host.

The job is TypeScript run by Node 24 on the host. It needs `node` on the launchd `PATH`, which is minimal (`job.sh` adds fnm's default bin, `~/.local/bin` and Homebrew to it), the clone's npm dependencies (the installer runs `npm ci` in the clone), and `docker` and `colima`. The poller uses the container's `node`, `gh` and `claude`. Rerun the installer after pulling: its `deps` step pins the container's clone to this clone's commit, so a pulled change reaches the poller only then.

### What this can do on your machine

Labels on GitHub start unattended agent sessions locally:

- Sessions run in the agent container as `node`, with the container's own `gh` token and every served repo's deploy key ([What it can't stop](../docs/containers.md#what-it-cant-stop)). They can use that token on every repo it reaches, and push with the keys to every served repo, not only the configured one.
- They work in their repo's clone in the container, in auto permission mode: the launch flags include `--permission-mode auto`, because a session signed in with the container's Claude token would start in manual mode and stop at its first Bash call. Auto mode's classifier approves or blocks each action instead of a prompt, but "if the classifier blocks an action 3 times in a row or 20 times total, auto mode pauses and Claude Code resumes prompting" (Claude Code docs, *Choose a permission mode*); the session then shows as `blocked` in the agent view.
- Every session uses your Claude usage limits and costs money if you pay per token. Several `ready` tickets start several sessions at once.
- At most 10 sessions are live at once across all repos (`CLAUDE_MAX_SESSIONS`; per-repo `maxSessions`). Extra tickets log `deferred #N: at session cap` and start on a later poll.
- Launch flags are logged on every launch. Anyone who can get `owner` to label an issue `ready` can start a session, so keep labelling rights tight.

### Onboarding a repo

1. Meet the [requirements](../docs/setup.md#requirements) (`npm run check`, deny rules, the plugin at user scope).
2. Create the labels: `setup-labels.sh owner/repo`.
3. Optionally add the [label-cleanup caller](../docs/setup.md#label-cleanup-on-close).
4. Add the repo to `~/.config/claude-workflow/repos.json` (`dispatch/repos.example.json` is a starting point; the installer refuses to run without the file):

        [
          {
            "repo": "example-owner/example-app",
            "dir": "/home/node/example-app",
            "sessionPrefix": "app",
            "owner": "example-owner"
          }
        ]

   - `repo`: `owner/name`.
   - `dir`: the repo's clone in the agent container, `/home/node/<name>` for `owner/<name>`, which sessions start in. The `container` phase clones it there and trusts it; setup refuses any other value.
   - `sessionPrefix`: names sessions; unique per repo.
   - `owner`: the only ticket author whose tickets are launched.
   - `maxSessions` (optional, positive integer): cap on live sessions for this repo.
5. The maintainer, in a terminal and never from an agent session, sets the machine up from the clone (`npm ci` there once). `dispatch/setup-agents.sh --dry-run` first lists every step and changes nothing; then `dispatch/setup-agents.sh` runs the four phases in order and stops at the first step that needs the maintainer: do what it prints and rerun.
   - `credentials`: the host's `gh` token, each repo's `restrict-updates` ruleset and auto-merge; see [Agent credentials](../docs/agent-credentials.md). It refuses while a session is live on the host or in the container.
   - `host`: `CLAUDE_CODE_ENABLE_CFC=0` and the deny rules of `dispatch/setup/host-settings.json`, merged into `~/.claude/settings.json` after a backup. A `sandbox` block or a managed settings file left from the old setup gets a note with the command that removes it, and is left as it is.
   - `container`: the [agent container](container/README.md), built and started with the `claude-workflow-home` volume (it needs Colima running: `colima start --cpu 4 --memory 4 --disk 40 --mount none`), and in it, as `node`: per repo, a deploy key (after a `protect-main` check) and an SSH host alias, which you add on GitHub with "Allow write access" when asked, and a clone in `/home/node/<name>`; the host's git identity; a gh login with a fine-grained token of its own, refused unless the merge probe with it gets 403 on every served repo; a rerun probes the stored login the same way; workspace trust; and the plugin. The Claude token, from `claude setup-token`, goes to `~/.config/claude-workflow/claude-agent.env` (mode 0600), which the container reads.
     - The plugin reaches `main`'s latest commit in two ways. Every `container` run updates it (`claude plugin marketplace update` and `claude plugin update`, with sessions live). Between runs, Claude Code's marketplace auto-update, which the phase turns on (`autoUpdate` on the marketplace entry, `FORCE_AUTOUPDATE_PLUGINS=1` in the container, since the image sets `DISABLE_AUTOUPDATER=1`), runs in an interactive session after its first message; Claude Code's docs do not say whether background sessions run it.
     - The container is replaced when its image changes or its config (the env file or the run flags) does. `container --rebuild` rebuilds the image with `--pull --no-cache` and replaces the container. Either refuses only while a session is live in the container, listing `claude stop <id>` for each, and keeps the volume, so clones, keys and logins survive.
   - `check`: in the container, as `node`, the firewall (`api.github.com` reached, `example.com` refused), the private keys (only the deploy keys, and no `SSH_AUTH_SOCK`), the gh login (`gh repo view` in the first clone) and the mounts (only the home volume); then a probe session started in the first clone with the poller's launch flags, which include `--permission-mode auto`, which runs `git fetch` and `git push --dry-run` and reports its browser tools. The probe session is stopped by its id afterwards.

   `credentials` pauses dispatch, and so does `container` before it starts or replaces the container, changes its gh login or writes its `~/.claude.json`. A full run resumes it at the end, only when every phase passes. A run of `credentials`, `container` or `check` alone leaves it paused and says so; the way out without a full run is `dispatch/install-launchd.sh resume`. On a first setup, before step 6, there is nothing to resume: the LaunchAgent is not installed yet, and step 6's install starts polling. [Setting up the machine](../docs/setup.md#setting-up-the-machine) gives the order to run them in.
6. Install the LaunchAgent once, from the main clone (not a worktree): `dispatch/install-launchd.sh`.
   - The installer first runs `npm ci` in the clone, then the job's `deps` step: in the container's clone of this repo it checks out this clone's commit (detached; the commit must be on origin) and runs `npm ci` there. Before `deps` first runs, the container's clone has no `node_modules`, so the poller cannot run in it. A clone with local changes is left as it is and stops the install. A failure aborts with nothing installed.
   - The agent polls as soon as it loads, so the installer then runs the dry run `dispatch/launchd/job.sh --dry-run`, which logs which tickets would launch and with which flags and launches nothing, shows its output and asks `Install and start polling? [y/N]` before writing or starting anything. Anything but `y`, no input, a failing dry run, or a poll already running aborts. `--yes` skips the question for scripted reinstalls.
   - launchd only gives the job `HOME` and `PATH`, so the dry run drops `CLAUDE_MAX_SESSIONS` from your shell. Set it in the plist's `EnvironmentVariables` for the real poller.
   - Remove with `dispatch/install-launchd.sh uninstall`.

A repo added later needs no reinstall. It does need:

- adding to the config, with `dir` `/home/node/<name>`, and to the host token's repository access (edit the token in the browser);
- its `restrict-updates` ruleset, created in the browser as [The Actions token](../docs/agent-credentials.md#the-actions-token) describes (the fine-grained login cannot create it);
- then a full rerun of `dispatch/setup-agents.sh`, or its phases in order: `credentials` (checks the ruleset and the token's access), `container` (the new repo's `protect-main` check, deploy key, alias, clone and trust; edit the container's token in the browser so it can see the repo too). Only a full run resumes dispatch; after single phases, finish with `check`, which does not resume it either: run `dispatch/install-launchd.sh resume`.

Migrating from an older poller on the host: pass `--legacy-label <its launchd label>` (booted out, plist removed). Its state is not carried into the container, so the new poller may try a conflicting or red PR again that the old one already tried, and it does not see the sessions the old one started on the host: let those finish first.

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
| What would launch now | `dispatch/launchd/job.sh --dry-run` |
| Pause everything | `dispatch/install-launchd.sh pause` |
| Resume | `dispatch/install-launchd.sh resume` |
| Free memory | `dispatch/install-launchd.sh pause`, then `colima stop` ([Freeing memory](../docs/containers.md#freeing-memory)) |

### Options

Per repo options are in `repos.json` (above). Global options are environment variables: set them in `EnvironmentVariables` of the plist template and rerun the installer (it regenerates the installed copy, so edits made only under `~/Library/LaunchAgents/` are overwritten), or prefix a one-off run, e.g. `CLAUDE_MAX_SESSIONS=3 dispatch/launchd/job.sh --dry-run`. The job runs on the host and passes only `CLAUDE_MAX_SESSIONS` on to the poller in the container.

| Variable | Default | Meaning |
|---|---|---|
| `CLAUDE_MAX_SESSIONS` | `10` | Most sessions live at once across all repos (positive integer; invalid values abort the run). A guard against a runaway label batch; raise it deliberately. |
| `EXTRA_PATH` | empty | Directories prepended to the job's `PATH` on the host, ahead of fnm's default bin dir (`~/.local/share/fnm/aliases/default/bin`), `~/.local/bin` and Homebrew, which it always adds, so the job finds `node`, `docker` and `colima`. It does not reach the container. |

### Notes

- The poller never claims a ticket; the session does (`in-progress`) as part of `work-ticket`.
- A ticket is launched once. Delete its entry from `launched.json` in the container ([State](#state)) to relaunch a ticket that still has `ready`.
- A live session is a tracked launch that is not `done`, `failed` or `stopped`. Tickets over the cap are deferred, not dropped.
- The Mac must be awake and logged in. Nothing runs while it sleeps; the next run after wake picks up anything missed.

## agent-poller.sh

Polls every configured GitHub repo for agent-ready tickets and starts one interactive background session per ticket (`claude --bg`, visible in the agent container's agent view: `docker exec -it -w /home/node/claude-workflow claude-workflow-agent claude agents`, or `agent-claude`). It runs in the agent container, started by the LaunchAgent's job every 3 minutes. Per repo it:

1. Reconciles sessions it launched earlier (marks tickets `agent-failed` when a session failed, stopped, vanished, or finished without handing off).
2. Launches `<prefix>-N` (`/ticket-workflow:work-ticket N`, or `N auto` with the `skip-plan` label) for each open issue authored by the repo's `owner` with `agent-ok` + `ready` and none of `in-progress`, `blocked`, `agent-failed`, `orchestrate-epic-run`.
3. Launches `<prefix>-N-conflict` (`/ticket-workflow:resolve-conflicts N`) for open, same-repo `issue-N-*` PRs authored by `owner` that conflict with main, while ticket N is open, at most once per main SHA. Fork PRs and other authors' PRs are skipped: a fork can use any branch name. A PR or ticket labelled `orchestrate-epic-run` is skipped too.
4. Launches `<prefix>-N-ci` (`/ticket-workflow:fix-ci N`) for open, same-repo `issue-N-*` PRs authored by `owner` that are mergeable but have a failed check (and none still running), while ticket N is open, once per PR head SHA and at most twice per PR. Pending checks, conflicting PRs and a live ticket, conflict or CI-fix session for N launch nothing, and so does a PR or ticket labelled `orchestrate-epic-run`.

`claude agents --json --all` is fetched once per run and shared. A failure in one repo is logged (`[prefix] poll failed ...`), the others still run, and the run exits non-zero at the end.

The poller and the sessions it starts run `gh` with the container's own login, a fine-grained token that cannot merge ([The container's token](../docs/agent-credentials.md#the-containers-token)), so neither can merge a PR.

The sessions it starts run in the agent container, behind its egress firewall ([Agent container](../docs/containers.md)).

### Layout

`agent-poller.sh` is a thin entrypoint, which the job runs in the container: it sets `PATH` and runs the TypeScript poller with Node 24 (type stripping, no build step). If `node` is not on `PATH` or older than 24, or the clone has no `node_modules` (dependencies not installed), it logs one line and exits 1. `poller/main.ts` runs the [firewall preflight](#firewall-preflight) after the config loads and before it takes the lock. `launchd/job.sh`, the LaunchAgent's program, is the same kind of entrypoint for `launchd/job.ts` on the host.

```
launchd/job.sh         the LaunchAgent's program, on the host: PATH setup, then exec node launchd/job.ts
launchd/job.ts         poll (Colima and the container up, plugin update, config copy, the poller), deps, halt
agent-poller.sh        entrypoint, in the container: PATH setup, then exec node poller/main.ts
poller/main.ts         startup checks, firewall preflight, lock, session list, repo loop, exit code
poller/poll.ts         one repo's poll: reconcile, launch tickets, resolve conflicts, fix CI
poller/decide.ts       pure decisions: session state, caps, reconcile, eligibility
poller/config.ts       the repos config (zod schema), CLAUDE_MAX_SESSIONS and launch flags
poller/schemas.ts      zod schemas for gh / claude output and the state files
poller/io.ts           side effects (gh, claude, curl, state files, lock, log) behind PollerIo
poller/*.test.ts       vitest unit tests
```

Every JSON input (the config, `gh` and `claude agents` output, the state files) is parsed once against its schema, and nothing launches from input that does not match. A bad config or session list aborts the run. A bad `gh` answer (e.g. a PR row without `isCrossRepository`) or state file fails that repo's poll (`[prefix] poll failed: ...`, non-zero exit); the other repos still run, and a repo with an unreadable `launched.json` still counts its listed sessions (`<prefix>-...`) toward the global cap.

### Config

`${CLAUDE_WORKFLOW_CONFIG:-~/.config/claude-workflow/repos.json}` on the host: a JSON array. Before every poll, dry runs included, the job copies it into the container, to `/home/node/.config/claude-workflow/repos.json`, where the poller reads it.

| Field           | Required | Meaning                                                                        |
| --------------- | -------- | ------------------------------------------------------------------------------ |
| `repo`          | yes      | `owner/name` on GitHub (passed to `gh --repo`)                                 |
| `dir`           | yes      | The repo's clone in the agent container, `/home/node/<name>`, which the sessions start in (`~/` is expanded to `/home/node`); setup refuses any other value |
| `sessionPrefix` | yes      | Session name prefix and state dir name; `[A-Za-z0-9_-]+`, unique across repos, case-insensitively |
| `owner`         | yes      | Only tickets (and, for conflict resolution, PRs) authored by this login are picked up |
| `maxSessions`   | no       | Positive integer: most live sessions for this repo (on top of the global `CLAUDE_MAX_SESSIONS`) |

```json
[
  {
    "repo": "example-owner/example-app",
    "dir": "/home/node/example-app",
    "sessionPrefix": "app",
    "owner": "example-owner"
  },
  {
    "repo": "example-owner/example-tools",
    "dir": "/home/node/example-tools",
    "sessionPrefix": "tools",
    "owner": "example-owner"
  }
]
```

The run aborts non-zero (with a log line naming each bad field, e.g. `[0].repo: not of the form owner/name`, before launching anything) if the file is missing or unreadable, is not valid JSON or not an array, an entry lacks a required non-empty string field, `sessionPrefix` has characters outside `[A-Za-z0-9_-]`, `repo` is not `owner/name`, `maxSessions` is present but not a positive integer, `dir` does not exist in the container, or two entries share a `sessionPrefix` (compared case-insensitively). Unknown fields are ignored. Unique prefixes guarantee session names (`<prefix>-N`) never collide across repos.

### State

`/home/node/.local/state/claude-workflow` in the container, on the `claude-workflow-home` volume:

```
lock/                           global run lock (one poller at a time)
repos/<sessionPrefix>/launched.json   {"<N>": {name, at}, "conflict-<N>": {name, at, pr, mainSha}, "ci-<N>": {name, at, pr}}
repos/<sessionPrefix>/conflicts.json  {"<N>": {pr, mainSha}}  last conflict attempt per ticket
repos/<sessionPrefix>/ci-attempts.json  {"<pr>": {headSha, count}}  CI-fix attempts per PR (missing = {})
```

The log stays on the host, in `~/Library/Logs/claude-workflow-poller.log`: the job writes its own lines there and the poller's output at the end of each poll.

### Firewall preflight

Every run, `--dry-run` included, checks that it runs behind the agent container's firewall, after the config loads and before it takes the run lock. It judges by behaviour: `https://api.github.com/rate_limit` must be reachable and `https://example.com` refused (`curl`, 10 seconds each).

Otherwise the run logs `firewall preflight failed: <reason>; launching nothing, aborting`, exits 1 and launches nothing. A passing `--dry-run` logs `firewall preflight passed (https://api.github.com/rate_limit reachable, https://example.com refused)`; a normal run logs nothing then.

On the host `example.com` is reachable, so a run there always fails: run the poller through the job, or in the container ([Running](#running)). In the container, a failing preflight means the firewall is not applied, or its entries have expired ([The allowlist](../docs/containers.md#the-allowlist)).

### install-launchd.sh

    dispatch/install-launchd.sh [install|uninstall|pause|resume|status] [--yes] [--purge] [--legacy-label LABEL]...

`install` refuses to run from a worktree (the plist would point at a path that disappears) or without a config file; start from `repos.example.json`. It runs, in order:

1. `npm ci` in the clone, the job's runtime dependencies.
2. `dispatch/launchd/job.sh deps`: Colima and the container up, then, in the container's clone of this repo, `git fetch origin`, a check that this clone's commit is on origin, a check for local changes (tracked files only; a clone with changes stops the install), `git checkout --detach <commit>` and `npm ci`.
3. The dry run, `dispatch/launchd/job.sh --dry-run`, without `CLAUDE_MAX_SESSIONS` from your shell, as launchd runs it; it prints the output and asks `Install and start polling? [y/N]`: the LaunchAgent runs the job at load, so this is the first look at what would launch. Anything but `y` (or EOF on stdin) exits 1 with nothing written. A failing dry run always aborts, even with `--yes`, and so does a poll already running.
4. It installs `~/Library/LaunchAgents/com.askrzypczak.claude-workflow-poller.plist` (from `launchd/`, filled in with this clone's path) and bootstraps it: the job runs at load and every 3 minutes, logging to `~/Library/Logs/claude-workflow-poller.log`.

A failure in steps 1 to 3 aborts with nothing installed. Rerunning `install` regenerates the plist, re-enables it if `pause` disabled it, and reloads it.

- `--yes`: skip the confirmation question (the dry run is still run and shown), e.g. for scripted reinstalls.
- `--legacy-label LABEL` (repeatable): boot out and delete an older LaunchAgent, before the new one starts. `LABEL` becomes a file name, so only letters, digits, `.`, `_` and `-` are accepted (exit 2 otherwise).
- `uninstall` boots out and removes the plist (and any `--legacy-label` jobs), runs the job's `halt` step (below), then lists what it left behind: the host's state dir (`~/.local/state/claude-workflow`, from a poller that ran on the host), the config, the log file and the plugin removal commands (`claude plugin uninstall ticket-workflow`, `claude plugin marketplace remove askrzypczak-plugins`).
- `uninstall --purge` also deletes those three, and prints the command that deletes the poller's state in the container (`docker exec -u node claude-workflow-agent rm -rf /home/node/.local/state/claude-workflow`). It never stops sessions or removes the plugin. `--purge` is rejected for `install`.
- `pause` stops polling until `resume`: it disables the LaunchAgent and boots it out, so the job stays off across logins and reboots and starts neither Colima nor the container. The plist stays in place. Then the job's `halt` step ends a poll still running in the container (launchd's bootout ends only the host job) and lists the container's live sessions, each with its stop command by id (`docker exec claude-workflow-agent claude stop <id>`). Sessions already running are not stopped. A failing `halt` is reported and does not undo the pause.
- `resume` enables the LaunchAgent and bootstraps the installed plist, so the poller runs now and every 3 minutes again. It needs an installed plist; without one it exits 1 and points at `install`. It skips `npm ci` and the dry run. If the job is already loaded, it says so and exits 0.
- `status` prints three lines: whether the plist is installed, whether the job is loaded, and whether it is disabled (paused). It exits 0 whether or not the job is loaded.
- `--purge` and `--legacy-label` are rejected (exit 2) for `pause`, `resume` and `status`.

The plist is filled in with the clone path and `$HOME` XML-escaped, written to a temp file, checked with `plutil -lint` (when available) and moved into place only if valid, so a failure never leaves a broken plist.

### Running

    dispatch/launchd/job.sh --dry-run   # one poll with --dry-run: starts neither Colima nor the container, updates no plugin and launches nothing; it refreshes the container's copy of the config
    dispatch/launchd/job.sh             # one poll, as launchd runs it

The poller's own `--dry-run` logs what would happen: no launches, labels or comments, and no changes to session or ticket tracking (it still takes the lock, but writes no state files). To run it in the container by hand, on the config copy the last poll left:

    docker exec -u node claude-workflow-agent /home/node/claude-workflow/dispatch/agent-poller.sh --dry-run

Environment (of the poller; under the job only `CLAUDE_MAX_SESSIONS` reaches it):

- `CLAUDE_WORKFLOW_CONFIG`: config path. On the host it names the file the job copies in; in the container the poller reads its default path, where the copy goes.
- `STATE_DIR`: state root, `~/.local/state/claude-workflow` by default.
- `CLAUDE_MAX_SESSIONS`: positive integer, default `10`. Live sessions are tracked entries in `launched.json` (tickets and conflict sessions) whose session is not `done`, `failed` or `stopped`; unlisted just-launched ones count. The global cap counts across all repos, a repo's `maxSessions` only that repo. At a cap the poller logs `deferred #N: at session cap` and leaves state untouched, so the launch is retried next poll. `--dry-run` applies the same caps. An invalid value aborts the run.
- The launch flags are logged on every launch line (`flags: ...`).
- `EXTRA_PATH`: prepended to `PATH` (`agent-poller.sh` and `job.sh` also add the fnm default bin dir, `~/.local/bin` and Homebrew, since launchd does not read your shell profile). Used by the tests to inject fake binaries.

The job requires Node 24 on the host (`node` on the `PATH` above, which is what the LaunchAgent sees), the clone's npm dependencies, `docker` and `colima`. The poller requires the container's clone at the right commit with its dependencies, which install's `deps` step provides. Neither needs `jq`.

### CI-fix state

A `ci-<N>` entry in `launched.json` is reconciled like `conflict-<N>`: a session that fails or is stopped, or finishes with its PR still open and red, marks ticket N `agent-failed` and comments on the PR and ticket. `ci-attempts.json` keeps the last head SHA and attempt count per PR (kept when the session fails), so a head SHA is tried once and a PR at most twice. The skill never force-pushes, rebases or merges.

### Tests

These groups run from `npm test` (after `npm ci`; Node 24), one vitest runner:

- `dispatch/poller/*.test.ts`: unit tests for the config, the decisions, and one repo's poll against a fake `PollerIo`.
- `dispatch/setup/*.test.ts`: the setup phases against the fake `SetupIo` in `setup/fake-io.ts`, whose docker world stands in for the container.
- `dispatch/launchd/*.test.ts`: the job's poll, `deps` and `halt` on the same fake docker world.
- `dispatch/*.test.ts`: end-to-end suites that run the real entrypoint (`agent-poller.test.ts`, with fake `gh`, `claude` and `curl`) and the installer (`install-launchd.test.ts`, with fake `launchctl`, `npm` and job); nothing real is touched.

`dispatch/container/test-container.sh` checks the image itself: it needs Colima and runs by hand, not from `npm test` ([Verify](container/README.md#verify)).

To run one part:

    npx vitest run dispatch/poller
    npx vitest run dispatch/setup
    npx vitest run dispatch/launchd
    npx vitest run dispatch/agent-poller
    npx vitest run dispatch/install-launchd
