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
    "repo": "askrzypczak/ttrpg-agents",
    "dir": "~/Projects/ttrpg-agents",
    "sessionPrefix": "ttrpg",
    "owner": "askrzypczak"
  },
  {
    "repo": "askrzypczak/claude-workflow",
    "dir": "~/Projects/claude-workflow",
    "sessionPrefix": "cw",
    "owner": "askrzypczak",
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

Migrating from the old single-repo poller in ttrpg-agents: copy its `launched.json` and `conflicts.json` into `repos/ttrpg/` (entry shapes are unchanged).

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
