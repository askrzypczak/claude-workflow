# dispatch

Local dispatch tooling that runs from this clone (it is not part of the plugin).

## agent-poller.sh

Polls every configured GitHub repo for agent-ready tickets and starts one interactive background session per ticket (`claude --bg`, visible in `claude agents`). Intended to run every few minutes from a LaunchAgent. Per repo it:

1. Reconciles sessions it launched earlier (marks tickets `agent-failed` when a session failed, stopped, vanished, or finished without handing off).
2. Launches `<prefix>-N` (`/ticket-workflow:work-ticket N`, or `N auto` with the `skip-plan` label) for each open issue authored by the repo's `owner` with `agent-ok` + `ready` and none of `in-progress`, `blocked`, `agent-failed`.
3. Launches `<prefix>-N-conflict` (`/ticket-workflow:resolve-conflicts N`) for open, same-repo `issue-N-*` PRs authored by `owner` that conflict with main, while ticket N is open, at most once per main SHA. Fork PRs and other authors' PRs are skipped: a fork can use any branch name.
4. Launches `<prefix>-N-ci` (`/ticket-workflow:fix-ci N`) for open, same-repo `issue-N-*` PRs authored by `owner` that are mergeable but have a failed check (and none still running), while ticket N is open, once per PR head SHA and at most twice per PR. Pending checks, conflicting PRs and a live ticket, conflict or CI-fix session for N launch nothing.

`claude agents --json --all` is fetched once per run and shared. A failure in one repo is logged (`[prefix] poll failed ...`), the others still run, and the run exits non-zero at the end.

### Layout

`agent-poller.sh` is a thin entrypoint (the path the LaunchAgent runs): it sets `PATH` and runs the TypeScript poller with Node 24 (type stripping, no build step). If `node` is not on `PATH` or older than 24, or the clone has no `node_modules` (dependencies not installed), it logs one line and exits 1.

```
agent-poller.sh        entrypoint: PATH setup, then exec node poller/main.ts
poller/main.ts         startup checks, lock, session list, repo loop, exit code
poller/poll.ts         one repo's poll: reconcile, launch tickets, resolve conflicts, fix CI
poller/decide.ts       pure decisions: session state, caps, bypass flags, reconcile, eligibility
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
| `bgFlags`       | no       | Extra `claude --bg` flags for this repo, appended after `CLAUDE_BG_FLAGS`; bypass flags are refused (below) |
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
    "owner": "example-owner",
    "bgFlags": "--permission-mode acceptEdits"
  }
]
```

The run aborts non-zero (with a log line naming each bad field, e.g. `[0].repo: not of the form owner/name`, before launching anything) if the file is missing or unreadable, is not valid JSON or not an array, an entry lacks a required non-empty string field, `sessionPrefix` has characters outside `[A-Za-z0-9_-]`, `repo` is not `owner/name`, `bgFlags` is present but not a string, `maxSessions` is present but not a positive integer, `dir` does not exist, or two entries share a `sessionPrefix` (compared case-insensitively). Unknown fields are ignored. Unique prefixes guarantee session names (`<prefix>-N`) never collide across repos.

### State

`${STATE_DIR:-~/.local/state/claude-workflow}`:

```
lock/                           global run lock (one poller at a time)
repos/<sessionPrefix>/launched.json   {"<N>": {name, at}, "conflict-<N>": {name, at, pr, mainSha}, "ci-<N>": {name, at, pr}}
repos/<sessionPrefix>/conflicts.json  {"<N>": {pr, mainSha}}  last conflict attempt per ticket
repos/<sessionPrefix>/ci-attempts.json  {"<pr>": {headSha, count}}  CI-fix attempts per PR (missing = {})
```

Migrating from a single-repo poller: copy its `launched.json` and `conflicts.json` into `repos/<sessionPrefix>/` (entry shapes are unchanged), or let the installer do it (below).

### install-launchd.sh

    dispatch/install-launchd.sh [install|uninstall] [--yes] [--purge] [--legacy-label LABEL]... [--migrate-state DIR PREFIX]...

`install` first runs `npm ci` in the clone (the poller's runtime dependencies; a failure aborts with nothing installed). Before writing or starting anything, it then runs `agent-poller.sh --dry-run`, prints the output and asks `Install and start polling? [y/N]`: the LaunchAgent runs the poller at load, so this is the first look at what would launch. Anything but `y` (or EOF on stdin) exits 1 with nothing written. A failing dry run always aborts, even with `--yes`. Installs `~/Library/LaunchAgents/com.askrzypczak.claude-workflow-poller.plist` (from `launchd/`, filled in with this clone's path) and bootstraps it: the poller runs at load and every 3 minutes, logging to `~/Library/Logs/claude-workflow-poller.log`. Rerunning `install` regenerates the plist and reloads it. It refuses to run from a worktree (the plist would point at a path that disappears) or without a config file; start from `repos.example.json`.

- `--yes`: skip the confirmation question (the dry run is still run and shown), e.g. for scripted reinstalls.
- `--legacy-label LABEL` (repeatable): boot out and delete an older LaunchAgent, before the new one starts. `LABEL` becomes a file name, so only letters, digits, `.`, `_` and `-` are accepted (exit 2 otherwise).
- `--migrate-state DIR PREFIX` (repeatable): copy `launched.json` and `conflicts.json` from an old poller's state dir to `repos/PREFIX/`, skipping files that already exist. `PREFIX` is the `sessionPrefix` whose sessions that poller named (`<PREFIX>-N`); only letters, digits, `_` and `-` are accepted.
- `uninstall` boots out and removes the plist (and any `--legacy-label` jobs), then lists what it left behind: the state dir, the config, the log file, sessions still recorded in `launched.json` (each with its `claude stop <name>`) and the plugin removal commands (`claude plugin uninstall ticket-workflow`, `claude plugin marketplace remove askrzypczak-plugins`).
- `uninstall --purge` also deletes the state dir, the config file and the log file. It never stops sessions or removes the plugin. `--purge` is rejected for `install`.

The plist is filled in with the clone path and `$HOME` XML-escaped, written to a temp file, checked with `plutil -lint` (when available) and moved into place only if valid, so a failure never leaves a broken plist.

### Running

    dispatch/agent-poller.sh --dry-run   # log what would happen; no launches, labels or comments, and no changes to session or ticket tracking (it still takes the lock, but writes no state files)
    dispatch/agent-poller.sh

Environment:

- `CLAUDE_WORKFLOW_CONFIG`: config path (above).
- `STATE_DIR`: state root (above).
- `CLAUDE_BG_FLAGS`: default extra flags for every `claude --bg`, e.g. `--permission-mode acceptEdits`. Placed after the built-in `--model opus --effort high`, so a `--model` or `--effort` here (or in `bgFlags`) overrides them.
- `CLAUDE_ALLOW_BYPASS_PERMISSIONS`: set to `1` to allow `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions` and `--permission-mode bypassPermissions` (also the `=` form) in the combined flags. Without it a repo with such flags is skipped, logged (`refusing bypass flags ...`) and counted as a failure (non-zero exit); other repos still run.
- `CLAUDE_MAX_SESSIONS`: positive integer, default `10`. Live sessions are tracked entries in `launched.json` (tickets and conflict sessions) whose session is not `done`, `failed` or `stopped`; unlisted just-launched ones count. The global cap counts across all repos, a repo's `maxSessions` only that repo. At a cap the poller logs `deferred #N: at session cap` and leaves state untouched, so the launch is retried next poll. `--dry-run` applies the same caps. An invalid value aborts the run.
- The effective flags are logged on every launch line (`flags: ...`, or `<none>`).
- `EXTRA_PATH`: prepended to `PATH` (the script also adds the fnm default bin dir, `~/.local/bin` and Homebrew, since launchd does not read your shell profile). Used by the tests to inject fake binaries.

Requires Node 24 (`node` on the `PATH` above, which is what the LaunchAgent sees), the clone's npm dependencies (`npm ci`; the installer runs it, and you rerun it, or the installer, after pulling a change to `package-lock.json`), plus `gh` and `claude`. The poller itself does not need `jq` (the installer's `uninstall` uses it, if present, to list leftover sessions).

### CI fixes

A `ci-<N>` entry in `launched.json` is reconciled like `conflict-<N>`: a session that fails or is stopped, or finishes with its PR still open and red, marks ticket N `agent-failed` and comments on the PR and ticket. `ci-attempts.json` keeps the last head SHA and attempt count per PR (kept when the session fails), so a head SHA is tried once and a PR at most twice. The skill never force-pushes, rebases or merges.

### Tests

Both groups run from `npm test` (after `npm ci`; Node 24), one vitest runner:

- `dispatch/poller/*.test.ts`: unit tests for the config, the decisions, and one repo's poll against a fake `PollerIo`.
- `dispatch/*.test.ts`: end-to-end suites that run the real entrypoint (`agent-poller.test.ts`) and the installer (`install-launchd.test.ts`) with fake `gh`, `claude`, `launchctl` and `npm` binaries; nothing real is touched.

To run one part:

    npx vitest run dispatch/poller
    npx vitest run dispatch/agent-poller
    npx vitest run dispatch/install-launchd
