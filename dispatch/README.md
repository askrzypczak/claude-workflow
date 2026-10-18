# dispatch

Local dispatch tooling that runs from this clone (it is not part of the plugin).

## agent-poller.sh

Polls every configured GitHub repo for agent-ready tickets and starts one interactive background session per ticket (`claude --bg`, visible in `claude agents`). Intended to run every few minutes from a LaunchAgent. Per repo it:

1. Reconciles sessions it launched earlier (marks tickets `agent-failed` when a session failed, stopped, vanished, or finished without handing off).
2. Launches `<prefix>-N` (`/ticket-workflow:work-ticket N`, or `N auto` with the `skip-plan` label) for each open issue authored by the repo's `owner` with `agent-ok` + `ready` and none of `in-progress`, `blocked`, `agent-failed`.
3. Launches `<prefix>-N-conflict` (`/ticket-workflow:resolve-conflicts N`) for open, same-repo `issue-N-*` PRs authored by `owner` that conflict with main, while ticket N is open, at most once per main SHA. Fork PRs and other authors' PRs are skipped: a fork can use any branch name.

`claude agents --json --all` is fetched once per run and shared. Each repo is polled in its own subshell: a failure in one repo is logged (`[prefix] poll failed ...`), the others still run, and the run exits non-zero at the end.

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

The run aborts non-zero (with a log line, before launching anything) if the file is missing or unreadable, is not an array, an entry lacks a required string field, `repo` is not `owner/name`, `dir` does not exist, `maxSessions` is present but not a positive integer, or two entries share a `sessionPrefix` (compared case-insensitively). Unique prefixes guarantee session names (`<prefix>-N`) never collide across repos.

### State

`${STATE_DIR:-~/.local/state/claude-workflow}`:

```
lock/                           global run lock (one poller at a time)
repos/<sessionPrefix>/launched.json   {"<N>": {name, at}, "conflict-<N>": {name, at, pr, mainSha}}
repos/<sessionPrefix>/conflicts.json  {"<N>": {pr, mainSha}}  last conflict attempt per ticket
```

Migrating from a single-repo poller: copy its `launched.json` and `conflicts.json` into `repos/<sessionPrefix>/` (entry shapes are unchanged), or let the installer do it (below).

### install-launchd.sh

    dispatch/install-launchd.sh [install|uninstall] [--yes] [--legacy-label LABEL]... [--migrate-state DIR PREFIX]...

Before writing or starting anything, `install` runs `agent-poller.sh --dry-run`, prints the output and asks `Install and start polling? [y/N]`: the LaunchAgent runs the poller at load, so this is the first look at what would launch. Anything but `y` (or EOF on stdin) exits 1 with nothing written. A failing dry run always aborts, even with `--yes`. Installs `~/Library/LaunchAgents/com.askrzypczak.claude-workflow-poller.plist` (from `launchd/`, filled in with this clone's path) and bootstraps it: the poller runs at load and every 3 minutes, logging to `~/Library/Logs/claude-workflow-poller.log`. Rerunning `install` regenerates the plist and reloads it. It refuses to run from a worktree (the plist would point at a path that disappears) or without a config file; start from `repos.example.json`.

- `--yes`: skip the confirmation question (the dry run is still run and shown), e.g. for scripted reinstalls.
- `--legacy-label LABEL` (repeatable): boot out and delete an older LaunchAgent, before the new one starts.
- `--migrate-state DIR PREFIX` (repeatable): copy `launched.json` and `conflicts.json` from an old poller's state dir to `repos/PREFIX/`, skipping files that already exist. `PREFIX` is the `sessionPrefix` whose sessions that poller named (`<PREFIX>-N`).
- `uninstall` boots out and removes the plist (and any `--legacy-label` jobs).

### Running

    dispatch/agent-poller.sh --dry-run   # log what would happen; no launches, labels or comments, and no changes to session or ticket tracking (it still creates the lock and empty state files)
    dispatch/agent-poller.sh

Environment:

- `CLAUDE_WORKFLOW_CONFIG`: config path (above).
- `STATE_DIR`: state root (above).
- `CLAUDE_BG_FLAGS`: default extra flags for every `claude --bg`, e.g. `--permission-mode acceptEdits`. Placed after the built-in `--model sonnet --effort xhigh`, so a `--model` or `--effort` here (or in `bgFlags`) overrides them.
- `CLAUDE_ALLOW_BYPASS_PERMISSIONS`: set to `1` to allow `--dangerously-skip-permissions`, `--allow-dangerously-skip-permissions` and `--permission-mode bypassPermissions` (also the `=` form) in the combined flags. Without it a repo with such flags is skipped, logged (`refusing bypass flags ...`) and counted as a failure (non-zero exit); other repos still run.
- `CLAUDE_MAX_SESSIONS`: positive integer, default `10`. Live sessions are tracked entries in `launched.json` (tickets and conflict sessions) whose session is not `done`, `failed` or `stopped`; unlisted just-launched ones count. The global cap counts across all repos, a repo's `maxSessions` only that repo. At a cap the poller logs `deferred #N: at session cap` and leaves state untouched, so the launch is retried next poll. `--dry-run` applies the same caps. An invalid value aborts the run.
- The effective flags are logged on every launch line (`flags: ...`, or `<none>`).
- `EXTRA_PATH`: prepended to `PATH` (the script also adds the fnm default bin dir, `~/.local/bin` and Homebrew, since launchd does not read your shell profile). Used by the tests to inject fake binaries.

Requires `bash` (3.2 compatible), `jq`, `gh` and `claude` on `PATH`.

### Tests

Plain `node:test`, no dependencies (Node 24; there is no `package.json`). Fake `gh` and `claude` binaries are put on `PATH`.

    node --test dispatch/*.test.mjs

`install-launchd.test.mjs` runs a copy of the installer against a fake `launchctl`; nothing real is touched.
