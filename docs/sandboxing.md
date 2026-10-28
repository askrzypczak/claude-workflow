# Sandboxing agent sessions

Agent sessions run their Bash commands in Claude Code's sandbox, set in the maintainer's user settings so that every session on the machine has it: interactive sessions, the poller's background sessions ("its Bash commands are sandboxed when its settings enable sandboxing") and their subagents ("Bash commands inside a subagent are sandboxed when sandboxing is enabled in the parent session"; both Claude Code docs, *Configure the sandboxed Bash tool*). These are the maintainer's steps; no agent applies them. Results described as tested come from nested `claude -p --settings` sessions in auto mode on macOS 26, with Claude Code 2.1.308 and `gh` 2.102.0.

## Settings

Merge these keys into `~/.claude/settings.json`, adding to any `env` and `permissions.deny` entries already there. The `~/.ssh` entries must name every private key file on the machine, the account key and every deploy key ([Deploy keys](#deploy-keys)), each in `credentials.files` and in a `Read(...)` and an `Edit(...)` rule. The three below are example names: replace them with yours. After setup, run `ls ~/.ssh` and confirm that each private key in it is listed.

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_PREFER_HTTPS": "1",
    "CLAUDE_CODE_ENABLE_CFC": "0"
  },
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,
    "allowUnsandboxedCommands": false,
    "enableWeakerNetworkIsolation": true,
    "excludedCommands": ["git fetch *", "git pull *", "git push *"],
    "network": {
      "allowedDomains": [
        "api.github.com",
        "results-receiver.actions.githubusercontent.com",
        "registry.npmjs.org"
      ],
      "strictAllowlist": true
    },
    "credentials": {
      "files": [
        { "path": "~/.ssh/id_ed25519", "mode": "deny" },
        { "path": "~/.ssh/deploy-claude-workflow", "mode": "deny" },
        { "path": "~/.ssh/deploy-example-app", "mode": "deny" },
        { "path": "~/.claude/.credentials.json", "mode": "deny" },
        { "path": "~/Library/Application Support/Google/Chrome", "mode": "deny" },
        { "path": "~/Library/Application Support/BraveSoftware", "mode": "deny" },
        { "path": "~/Library/Application Support/Arc", "mode": "deny" },
        { "path": "~/Library/Application Support/Microsoft Edge", "mode": "deny" },
        { "path": "~/Library/Application Support/Firefox", "mode": "deny" },
        { "path": "~/Library/Safari", "mode": "deny" },
        { "path": "~/Library/Cookies", "mode": "deny" }
      ]
    }
  },
  "permissions": {
    "deny": [
      "Read(~/.ssh/id_ed25519)",
      "Edit(~/.ssh/id_ed25519)",
      "Read(~/.ssh/deploy-claude-workflow)",
      "Edit(~/.ssh/deploy-claude-workflow)",
      "Read(~/.ssh/deploy-example-app)",
      "Edit(~/.ssh/deploy-example-app)",
      "Read(~/.claude/.credentials.json)",
      "Edit(~/.claude/.credentials.json)",
      "Read(~/Library/Application Support/Google/Chrome/**)",
      "Edit(~/Library/Application Support/Google/Chrome/**)",
      "Read(~/Library/Application Support/BraveSoftware/**)",
      "Edit(~/Library/Application Support/BraveSoftware/**)",
      "Read(~/Library/Application Support/Arc/**)",
      "Edit(~/Library/Application Support/Arc/**)",
      "Read(~/Library/Application Support/Microsoft Edge/**)",
      "Edit(~/Library/Application Support/Microsoft Edge/**)",
      "Read(~/Library/Application Support/Firefox/**)",
      "Edit(~/Library/Application Support/Firefox/**)",
      "Read(~/Library/Safari/**)",
      "Edit(~/Library/Safari/**)",
      "Read(~/Library/Cookies/**)",
      "Edit(~/Library/Cookies/**)",
      "Edit(~/.gitconfig)",
      "Edit(~/.config/git/**)",
      "Edit(//**/.git/hooks/**)",
      "Edit(//**/.git/config)",
      "Bash(git fetch *--upl*)",
      "Bash(git pull *--upl*)",
      "Bash(git push *--rece*)",
      "Bash(git push *--e*)"
    ]
  }
}
```

- `enabled` also turns on auto-allow mode: a sandboxed command is approved "automatically, with no prompt" whatever the permission mode, with a few exceptions such as plan mode, while excluded commands still go through the regular permission flow (*Configure the sandboxed Bash tool*). To keep prompts for Bash, also set `autoAllowBashIfSandboxed` to `false`.
- `failIfUnavailable` makes Claude Code exit at startup when the sandbox can't start, instead of running commands unsandboxed. `allowUnsandboxedCommands: false` takes away Claude's retry outside the sandbox: "With the retry disabled, Claude Code ignores the `dangerouslyDisableSandbox` parameter." (same page).
- `allowedDomains`: `api.github.com` for `gh`, `results-receiver.actions.githubusercontent.com` for `gh run view --log`, `registry.npmjs.org` for `npm ci`; not `github.com` as a whole. `strictAllowlist` refuses every other host. Without it, auto mode lets a command name extra hosts for the classifier to approve, and `bypassPermissions` allows any host (Claude Code docs, *All settings*, `sandbox.network.strictAllowlist`).
- `credentials.files`: by default sandboxed commands can read "Most of the machine, including credential files such as `~/.ssh` and `~/.aws/credentials`", and "There is no built-in credential deny list, so only the files and variables you list are restricted." (*Configure the sandboxed Bash tool*). The list: the private key files, Claude Code's credential store `~/.claude/.credentials.json`, the Chrome, Brave, Arc, Edge, Firefox and Safari profile directories, and `~/Library/Cookies`.
  - The key files are listed by name, not `~/.ssh` as a whole, because sandboxed `gh` reads `~/.ssh/config` ([macOS exceptions](#macos-exceptions)). In a test, a `~/.ssh` deny with `~/.ssh/config` re-opened through `filesystem.allowRead` left the file unreadable.
  - `~/Library/Keychains` stays readable: sandboxed `gh` reads its token from the keychain through `security`, and with the keychain denied every authenticated `gh` call failed in a test (`HTTP 401: Requires authentication` from `gh issue view`), while `gh api` on a public repo still worked because it needs no token. [What stays outside](#what-stays-outside) has the cost.
  - `~/.config/gh` stays readable: it holds `gh`'s configuration and no token while the login is stored in the keyring (`gh auth status` shows `(keyring)`).
- `permissions.deny`: the file tools run outside the sandbox ("A `denyRead` entry doesn't stop the Read tool", same page), so each denied path also gets a `Read(...)` and an `Edit(...)` rule. `Edit` rules cover the Write tool too ("`Edit` rules apply to all built-in tools that edit files."), and `Write(...)` path rules never match (Claude Code docs, *Configure permissions*). The git rules are explained under [macOS exceptions](#macos-exceptions).
- `env`: `CLAUDE_CODE_PLUGIN_PREFER_HTTPS` ([Deploy keys](#deploy-keys)) and `CLAUDE_CODE_ENABLE_CFC` ([Claude in Chrome on demand](#claude-in-chrome-on-demand)).

## macOS exceptions

**Git over SSH.** "On macOS, `git fetch`, `git pull`, and `git push` against an SSH remote fail inside the sandbox even when the host is allowed." (*Configure the sandboxed Bash tool*). The JSON takes those three out of the sandbox with `excludedCommands`, the fix that page gives. "An excluded command runs with your full access.", and "The excluded git commands can reach any host, not only the ones in `allowedDomains`." (same page). They read `~/.ssh/config`, the key files and `~/.gitconfig`, so [Deploy keys](#deploy-keys) keeps the account key out of their reach, and these rules keep them from running a program Claude chose:

- `Bash(git fetch *--upl*)`, `Bash(git pull *--upl*)`, `Bash(git push *--rece*)` and `Bash(git push *--e*)` deny `--upload-pack`, `--receive-pack` and `--exec`, which name a program for git to run. Git accepts any unambiguous prefix of a long option, so each rule matches the shortest one. In a test, `git fetch --upload-pack=<script> .` and `git push --dry-run --receive-pack=<script> . <ref>` ran the script inside the sandbox even though both matched the exclusions, but *All settings* lists the call shapes that stay sandboxed only "among others", so the rules keep this from resting on undocumented behaviour.
- A variable prefix needs no rule: in a test, `GIT_SSH_COMMAND=<script> git fetch origin` and a `PATH=...` prefix ran the script inside the sandbox, so there are no `GIT_SSH*` or `GIT_CONFIG*` rules. `git -c core.sshCommand=... fetch` doesn't start with `git fetch`, and a pattern matches "everything before the first `*` as written" (*Configure permissions*), so that call stays sandboxed too.
- `Edit(~/.gitconfig)` and `Edit(~/.config/git/**)`: a `core.sshCommand`, or another setting that names a program, written there by the Edit or Write tool, which run outside the sandbox, would run with full access under an excluded git command. Sandboxed commands can't write there.
- `Edit(//**/.git/hooks/**)` and `Edit(//**/.git/config)`: excluded git commands also run the repository's `.git/hooks` and read its `.git/config`. Sandboxed commands can't write them (protected paths), and these rules close the Edit and Write tools' path. A relative pattern would match only under the current directory and miss the main repository's `.git` in a worktree session, so the rules anchor at the filesystem root, the closest documented form for "any repository" (*Configure permissions*: "To write a rule in user settings that applies inside every project, use a `//` absolute path or a `~/` home-relative path", and `Read(//**/.env)` blocks "any `.env` anywhere on the filesystem").

**`gh`** runs sandboxed. Without `enableWeakerNetworkIsolation` it failed TLS verification in a test (`x509: OSStatus -26276`); with it, `gh api`, `gh pr checks`, a redirected `gh` call and the trust-rule pipe (`gh issue view ... | node .../trusted-comments.ts`) worked. The cost: "This reduces security by opening a potential data exfiltration path through the trust service." (*All settings*, `sandbox.enableWeakerNetworkIsolation`). The docs' other fix, excluding `gh *`, is worse here:

- An exclusion covers a call only when every command in it matches, and a redirect keeps the call sandboxed, so piped and redirected `gh` calls would still fail TLS (tested with `gh ... | cat`). The [trust rule](../README.md#trust-rule-for-public-repos) pipe is such a call, used in 11 places in the plugin's skills and agents.
- An excluded `gh` runs with full access: it can read any file and post it with `--body-file`.

With `gh` inside the sandbox, `gh extension` and `gh alias` need no deny rules: they can't write outside the working directory or reach a host outside the allowlist. Sandboxed `gh` reads `~/.ssh/config` to resolve alias remotes: go-gh's `pkg/ssh/ssh.go` runs `ssh -G <host>` and, when that fails, keeps "the original hostname unchanged", which no GitHub host matches.

**`integrate-child.sh`** gets no exclusion. A pattern for it needs a `*` for the plugin cache path, which carries a commit SHA, and in a test a `*` in an exclusion let another script out: `<root>/plugin/*/scripts/integrate-child.sh *` matched `<root>/plugin/../other.sh /scripts/integrate-child.sh x`, which ran outside the sandbox. Instead, the script runs no git network command: `orchestrate-epic` fetches before `integrate-child.sh merge` and pushes `epic-E` before `integrate-child.sh close`, as plain commands, which the exclusions match.

**What breaks under the sandbox:**

- Creating a branch that tracks a remote one (`git switch -c X origin/Y`, `git checkout -b X origin/Y`, `git worktree add -b X <path> origin/Y`, and `git switch Y` or `git worktree add <path> Y` when only `origin/Y` exists) fails in the clone and in a worktree, because the upstream is written to git's `config`. The sandbox protects "`hooks` and `config` inside `.git`" in the working directory, and for a worktree the main repository's: "Writes to `hooks/` and `config` inside that directory remain denied." (*Configure the sandboxed Bash tool*). Create the branch with `--no-track`, then let `git push -u origin <branch>` (an excluded command) set the upstream. The skills do this: `work-ticket`, `orchestrate-epic`, `fix-ci`, `resolve-conflicts` and `address-feedback` create their branches with `--no-track` and set the upstream with `git push -u origin <branch>` on the first push.
- Bare `mktemp -d` creates its directory under the system temp folder (`/var/folders/...`) even with `TMPDIR` set (macOS `mktemp(1)` prefers `_CS_DARWIN_USER_TEMP_DIR`), and the sandbox denies it. Pass a template: `mktemp -d "$TMPDIR/name.XXXXXX"`.
- A call with a `cd` or `git -C` stays sandboxed (*All settings*, `sandbox.excludedCommands`: "A `cd`, `pushd`, or `popd`, wherever it appears in the call"; *Configure the sandboxed Bash tool*: "A call that adds a `cd`, uses `git -C`, or contains a command substitution stays sandboxed."); in a test, `git -C . fetch` failed at the proxy with `github.com:22: 403 host is not on the allow list`. Run git's network commands as plain commands from the working directory. The skills name each push as its own call for this reason; run fetches the same way.

## Deploy keys

An excluded git command uses whatever key ssh offers it. With the account key, that is every repo the account can push to; with a deploy key, one: "If you use multiple repositories on one server, you will need to generate a dedicated key pair for each one. You can't reuse a deploy key for multiple repositories." (GitHub Docs, *Managing deploy keys*). Within its repo a write key is broad: "Deploy keys with write access can perform the same actions as an organization member with admin access, or a collaborator on a personal repository." (same page). Deploy keys are a bypass actor a ruleset can name (the bypass `actor_type` "Can be one of: `Integration`, `OrganizationAdmin`, `RepositoryRole`, `Team`, `DeployKey`, `User`", GitHub Docs, *REST API endpoints for rules*), so a ruleset binds their pushes unless its bypass list names them: keep deploy keys off every ruleset's bypass list.

For each served repo, and for this one:

1. `ssh-keygen -t ed25519 -N "" -f ~/.ssh/deploy-<repo>`. No passphrase, since sessions push unattended; the file is denied to sandboxed commands and opens one repo. Add `~/.ssh/deploy-<repo>.pub` in the repo's Settings, Deploy keys, with "Allow write access".
2. Add a host alias to `~/.ssh/config`. `IdentitiesOnly yes` makes ssh offer only that key, "even if ssh-agent(1) or a PKCS11Provider or SecurityKeyProvider offers more identities" (`ssh_config(5)`):

        Host github.com-<repo>
          HostName github.com
          User git
          IdentityFile ~/.ssh/deploy-<repo>
          IdentitiesOnly yes

3. In the repo's clone (a served repo's `dir`; for this repo, the clone the poller runs from): `git remote set-url origin git@github.com-<repo>:<owner>/<repo>.git`. Worktrees share the clone's remotes.
4. Add the key file to the [Settings](#settings) JSON.

The account key:

- Out of `ssh-agent`: `ssh-add -D`, or `ssh-add -d --apple-use-keychain <key>`, which also removes its stored passphrase ("When removing identities with -d, each passphrase will be removed from it.", `ssh-add(1)` on macOS).
- No `UseKeychain` or `AddKeysToAgent` lines for it in `~/.ssh/config`: they would load it again.
- Off the disk, or kept passphrase-protected: an excluded git command can read the file, and ssh tries default key names such as `~/.ssh/id_ed25519` on its own.

The marketplace clone moves to HTTPS; the repo is public, so it needs no credentials. For an `owner/repo` source Claude Code "probes `ssh -T git@github.com` and clones over SSH when the probe succeeds", and "Installs from `/plugin` inside a session and plugin updates don't fall back" (Claude Code docs, *Host and maintain a marketplace*). `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1` in the JSON covers new clones. Switch the existing one: `git -C ~/.claude/plugins/marketplaces/askrzypczak-plugins remote set-url origin https://github.com/askrzypczak/claude-workflow.git`.

The maintainer pushes through the same alias remotes. For a repo without a deploy key, load the account key briefly with dispatch paused, as [Admin work](agent-credentials.md#admin-work) does, and `ssh-add -D` afterwards.

## Claude in Chrome on demand

Claude in Chrome acts in the maintainer's own browser, with its sign-ins, and in auto mode, "when the auto mode classifier itself approves a browser call to a site, the extension skips its own per-site check for that call, unless your permission rules deny any site to Claude in Chrome" (Claude Code docs, *Use Claude Code with Chrome*). So keeping github.com out of the extension's site permissions is not a boundary in auto mode, and the docs give no rule syntax for denying a site to Claude in Chrome. The control is when it runs: off by default, never in a background session, and on only in an interactive session the maintainer is watching:

- Run `/chrome` and turn off **Enabled by default** (the `claudeInChromeDefaultEnabled` key in `~/.claude.json`).
- `CLAUDE_CODE_ENABLE_CFC=0` in the JSON's `env` keeps it off; the variable "Takes precedence over the `claudeInChromeDefaultEnabled` setting. The `--chrome` and `--no-chrome` flags take precedence over both." (Claude Code docs, *Environment variables*).
- Start `claude --chrome` only for an interactive session you are watching. Keep github.com out of the extension's site permissions as well ([Wiring](agent-credentials.md#wiring)).

In a test, `-p` sessions loaded no Chrome tools even with Enabled by default on. Background sessions are interactive, so [Checks](#checks) covers them.

## What stays outside

- Hooks, local MCP servers and the other processes Claude Code starts "run with your full access" (*Configure the sandboxed Bash tool*). Connectors act on their services with their own credentials.
- The Read, Edit, Write and web tools follow permission rules, not the sandbox; beyond the deny rules above, they reach what the permission mode allows. WebFetch reaches any host its permission rules allow, a way out that the network allowlist doesn't touch ("in-process tools such as `WebFetch` still follow their permission rules", *Configure the sandboxed Bash tool*). A file the Edit tool writes, such as a shell startup file, can change what an unsandboxed process does, and the Edit tool can write `~/.claude/settings.json` and `~/.claude.json` themselves, the files that hold the sandbox and Chrome keys (both are protected paths, so in auto mode such a write goes to the classifier); the managed-settings copy under Repository settings below closes that too.
- Exfiltration through GitHub: the allowed hosts are enough to put data in an issue, a comment or a pushed branch. The proxy also checks only hostnames: "code running inside the sandbox can potentially use domain fronting or similar techniques to reach hosts outside the allowlist" (*Configure the sandboxed Bash tool*).
- The excluded git commands, within the limits under [macOS exceptions](#macos-exceptions). The repository hooks they run and the `.git/config` they read are closed to sandboxed commands (protected paths) and to the file tools (the `.git` deny rules).
- The keychain. Sandboxed commands can read the `gh` token through `security`, and any other item `security` reads without a prompt: with no keychain deny, `security find-generic-password -s gh:github.com -w` exited 0 from a sandboxed command in a test.
- The `gh` token cannot merge ([Agent credentials](agent-credentials.md)) and, from a sandboxed session, reaches only the allowed hosts. But it could be posted to GitHub and used elsewhere until rotated, which is why the expiry note in [The token](agent-credentials.md#the-token) matters.
- An untested alternative: deny `~/Library/Keychains` (in `credentials.files` and as `Read(...)` and `Edit(...)` rules) and store the `gh` token in `~/.config/gh/hosts.yml` with `gh auth login --with-token --insecure-storage`. That exposes only that token to sandboxed commands and leaves other keychain items closed, at the cost of a plaintext token file. The `gh` check in [Checks](#checks) covers it if the maintainer chooses it.
- The trust-service path that `enableWeakerNetworkIsolation` opens.
- Repository settings: "A `false` in your user settings doesn't make the sandbox admin-required, so a project's other sandbox settings still apply." (*Configure the sandboxed Bash tool*). A repo's `.claude/settings.json` or `.claude/settings.local.json` can set `enabled: false`, add `excludedCommands` or turn on weaker options. Sandboxed commands can't write those files, and Edit-tool writes to them go to the classifier in auto mode (`.claude` is a protected path, *Choose a permission mode*). `strictAllowlist` in user settings already makes Claude Code ignore a repo's `allowedDomains` (*Configure the sandboxed Bash tool*, "Locks that apply without an admin-required sandbox"). The same JSON in `/Library/Application Support/ClaudeCode/managed-settings.json` closes the rest: `allowUnsandboxedCommands: false` there makes the sandbox admin-required, and Claude Code then ignores "the settings in a repository's files that loosen the sandbox, `excludedCommands` entries included" (same page); a managed `enabled` "overrides anything a developer sets" (*All settings*).
- A separate macOS user or a container would put all of the above behind one boundary. Left for later.

## Checks

Ask Claude to run these in a session started in a served `dir`: "What you type at the `!` prompt usually runs outside the sandbox, so typing a line yourself doesn't test it." (*Configure the sandboxed Bash tool*). Credential checks test readability only; never print a key.

1. `touch ~/sandbox-probe`: fails with `Operation not permitted`. If it succeeds, delete `~/sandbox-probe` and check `/sandbox`.
2. `curl -sS https://example.com`: refused, naming the host as not on the allow list.
3. For each private key file, `test -r ~/.ssh/<key> && echo READABLE || echo DENIED`: `DENIED`. The same for `~/.ssh/config`: `READABLE`, since sandboxed `gh` needs it.
4. The Read tool on a non-secret file inside a denied directory, such as Chrome's empty `~/Library/Application Support/Google/Chrome/First Run`: refused. Don't point the Read tool at a real key: if the deny were wrong, the key would land in the transcript.
5. `gh repo view --json nameWithOwner` in a `dir` whose remote uses an alias: prints the repo. Then `gh issue view <i> --json number,title`: prints the issue. That call needs the token: it failed with `HTTP 401` in the test where sandboxed `gh` couldn't read it.
6. `git fetch origin` and `git push --dry-run origin <branch>` there: both succeed, through the deploy key.
7. `claude --bg --name sandbox-check "list your tools"` in a served `dir`, then `claude attach sandbox-check`: `/sandbox` shows the same settings on its Config tab, and the session has no browser tools.
