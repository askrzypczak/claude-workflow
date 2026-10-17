# dispatch

Local dispatch tooling that runs from this clone (it is not part of the plugin).

## agent-poller.sh

Polls every configured GitHub repo for agent-ready tickets and starts one interactive background session per ticket (`claude --bg`, visible in `claude agents`). Intended to run every few minutes from a LaunchAgent. Per repo it:

1. Reconciles sessions it launched earlier (marks tickets `agent-failed` when a session failed, stopped, vanished, or finished without handing off).
2. Launches `<prefix>-N` (`/ticket-workflow:work-ticket N`, or `N auto` with the `skip-plan` label) for each open issue authored by the repo's `owner` with `agent-ok` + `ready` and none of `in-progress`, `blocked`, `agent-failed`.
3. Launches `<prefix>-N-conflict` (`/ticket-workflow:resolve-conflicts N`) for open `issue-N-*` PRs that conflict with main, at most once per main SHA.

`claude agents --json --all` is fetched once per run and shared. Each repo is polled in its own subshell: a failure in one repo is logged (`[prefix] poll failed ...`), the others still run, and the run exits non-zero at the end.

### Config

`${CLAUDE_WORKFLOW_CONFIG:-~/.config/claude-workflow/repos.json}`: a JSON array.

| Field           | Required | Meaning                                                                        |
| --------------- | -------- | ------------------------------------------------------------------------------ |
| `repo`          | yes      | `owner/name` on GitHub (passed to `gh --repo`)                                 |
| `dir`           | yes      | Local checkout the sessions start in (`~/` is expanded)                        |
| `sessionPrefix` | yes      | Session name prefix and state dir name; `[A-Za-z0-9_-]+`, unique across repos, case-insensitively |
| `owner`         | yes      | Only tickets authored by this login are picked up                              |
| `bgFlags`       | no       | Extra `claude --bg` flags for this repo, appended after `CLAUDE_BG_FLAGS`      |

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

The run aborts non-zero (with a log line, before launching anything) if the file is missing or unreadable, is not an array, an entry lacks a required string field, `repo` is not `owner/name`, `dir` does not exist, or two entries share a `sessionPrefix` (compared case-insensitively). Unique prefixes guarantee session names (`<prefix>-N`) never collide across repos.

### State

`${STATE_DIR:-~/.local/state/claude-workflow}`:

```
lock/                           global run lock (one poller at a time)
repos/<sessionPrefix>/launched.json   {"<N>": {name, at}, "conflict-<N>": {name, at, pr, mainSha}}
repos/<sessionPrefix>/conflicts.json  {"<N>": {pr, mainSha}}  last conflict attempt per ticket
```

Migrating from a single-repo poller: copy its `launched.json` and `conflicts.json` into `repos/<sessionPrefix>/` (entry shapes are unchanged), or let the installer do it (below).

### install-launchd.sh

    dispatch/install-launchd.sh [install|uninstall] [--legacy-label LABEL]... [--migrate-state DIR PREFIX]...

Installs `~/Library/LaunchAgents/com.askrzypczak.claude-workflow-poller.plist` (from `launchd/`, filled in with this clone's path) and bootstraps it: the poller runs at load and every 3 minutes, logging to `~/Library/Logs/claude-workflow-poller.log`. Rerunning `install` regenerates the plist and reloads it. It refuses to run from a worktree (the plist would point at a path that disappears) or without a config file; start from `repos.example.json`.

- `--legacy-label LABEL` (repeatable): boot out and delete an older LaunchAgent, before the new one starts.
- `--migrate-state DIR PREFIX` (repeatable): copy `launched.json` and `conflicts.json` from an old poller's state dir to `repos/PREFIX/`, skipping files that already exist. `PREFIX` is the `sessionPrefix` whose sessions that poller named (`<PREFIX>-N`).
- `uninstall` boots out and removes the plist (and any `--legacy-label` jobs).

### Running

    dispatch/agent-poller.sh --dry-run   # log what would happen; no launches, labels or comments, and no changes to session or ticket tracking (it still creates the lock and empty state files)
    dispatch/agent-poller.sh

Environment:

- `CLAUDE_WORKFLOW_CONFIG`: config path (above).
- `STATE_DIR`: state root (above).
- `CLAUDE_BG_FLAGS`: default extra flags for every `claude --bg`, e.g. `--permission-mode acceptEdits`.
- `EXTRA_PATH`: prepended to `PATH` (the script also adds the fnm default bin dir, `~/.local/bin` and Homebrew, since launchd does not read your shell profile). Used by the tests to inject fake binaries.

Requires `bash` (3.2 compatible), `jq`, `gh` and `claude` on `PATH`.

### Tests

Plain `node:test`, no dependencies (Node 24; there is no `package.json`). Fake `gh` and `claude` binaries are put on `PATH`.

    node --test dispatch/*.test.mjs

`install-launchd.test.mjs` runs a copy of the installer against a fake `launchctl`; nothing real is touched.
