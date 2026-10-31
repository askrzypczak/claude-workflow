# Agent container

One long-lived container, `claude-workflow-agent`, runs every unattended session, the poller and orchestration. It runs under Colima on the Mac, from the image in [`dispatch/container/`](../dispatch/container/README.md), behind a default-deny egress firewall that it applies to itself at startup. The served repos' clones live in it, in `/home/node/<name>` on the `claude-workflow-home` volume. The `container` phase of `dispatch/setup-agents.sh` builds the image, runs the container and sets up everything a session in it needs ([Onboarding a repo](../dispatch/README.md#onboarding-a-repo)). Interactive sessions stay on the host ([Sessions on the host](#sessions-on-the-host)).

Spike #164 moved unattended sessions here from Claude Code's sandbox on macOS. Results described as tested come from that spike, from spike #169 and from `dispatch/container/test-container.sh`.

## What the container confines

- **Files.** A session sees only the container's own filesystem and the home volume, `claude-workflow-home` at `/home/node`. The container has no bind mounts and no Docker socket. The `check` phase's `mounts` item fails on any mount other than the home volume.
- **The VM.** Colima runs the container in a Linux VM. Started with `colima start --cpu 4 --memory 4 --disk 40 --mount none`, the VM mounts no host directory. A first `colima start` without `--mount` mounts the home directory into the VM (#164), so always start it with that command; the setup script's to-dos and the poll job use it. `colima ssh -- mount` lists the VM's mounts: it should show no `virtiofs`, `9p` or `sshfs` entry.
- **Privileges.** Sessions run as `node`, with no capabilities, so they cannot change the firewall or signal the entrypoint. Root runs only the entrypoint, which applies the firewall and refreshes it, with `NET_ADMIN` and `NET_RAW`. `docker exec` runs as root by default, so every command other than `claude` needs `-u node`. `/usr/local/bin/claude` is a wrapper that switches a root start to `node`, with every capability dropped and no-new-privs set ([Exec](../dispatch/container/README.md#exec)).
- **Credentials.** The container holds only its own: a deploy key per served repo, generated in it; its own `gh` login ([The container's token](agent-credentials.md#the-containers-token)); and the Claude token ([The Claude token](agent-credentials.md#the-claude-token)). Nothing of the host's reaches it: not the keychain, not the account's SSH key, not the browser profiles. The `check` phase's `ssh-keys` item fails on a private key that is no served repo's deploy key, and on a set `SSH_AUTH_SOCK`.
- **Every tool.** The boundary is the container, so it covers the Read, Edit and Write tools, hooks and MCP servers as well as Bash. Under Claude Code's sandbox those ran outside it, with the maintainer's full access.

Why not Claude Code's sandbox: under it, 136 of the served app's 610 integration tests failed; in the container all 610 passed, with no exceptions (#164, answer 1). Every workaround the sandbox needed goes: `enableWeakerNetworkIsolation`, the excluded git commands, the readable keychain and `--no-track` as a requirement (the skills keep `--no-track`; it is harmless). No sandbox runs nested inside the container: `bwrap` cannot create a namespace there, and Claude Code's weaker nested mode was not wanted (#164, answer 6).

## The allowlist

The firewall, `dispatch/container/init-firewall.sh`, drops everything by default and refuses what it does not allow at once, with a TCP reset or an ICMP refusal, so a refused host fails fast instead of timing out. It allows HTTPS (port 443) to:

| Host | Why |
|---|---|
| `api.github.com` | `gh`, and GitHub's address ranges from `https://api.github.com/meta`. Every refresh resolves and adds it first, so the ranges can still be fetched after its address changes. |
| GitHub's `web` and `api` ranges, from `/meta` | `github.com` and GitHub's API, including the plugin marketplace's clone over HTTPS (the image sets `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1`). |
| GitHub's `git` ranges, from `/meta` | Git over SSH (port 22) through the deploy keys, and HTTPS. |
| `results-receiver.actions.githubusercontent.com` | `gh run view --log`, which `fix-ci` and the pre-swap test use. |
| `registry.npmjs.org` | `npm ci` in the clones. Claude Code: "Plugin installs (fetching npm-source plugin packages and installing plugins' Node.js package dependencies), `npx`-launched MCP servers, and the package registry for npm and bun installs of Claude Code itself". |
| `api.anthropic.com` | "Claude API requests, including the WebFetch domain safety check, feature flag fetches, and telemetry event logging". |
| `claude.ai` | "claude.ai account authentication". |
| `claude.com` | "claude.ai account sign-in opens a `claude.com` page in the browser, which redirects to `claude.ai`; pre-approved WebFetch documentation lookups also reach this host from the CLI". |
| `platform.claude.com` | "OAuth token exchange, refresh, and revocation also go to this host for claude.ai accounts". |
| `downloads.claude.ai` | "Plugin executable downloads; native installer, native auto-updater, and update version checks". |
| `raw.githubusercontent.com` | "Changelog feed for `/release-notes`". |

The quoted reasons are Claude Code's own, from *Enterprise network configuration*, "Network access requirements", which asks for these hosts to be allowed "especially in containerized or restricted network environments". GitHub's ranges come from `/meta`.

Beyond HTTPS:

- SSH (port 22) goes only to GitHub's `git` ranges.
- DNS (port 53) goes only to the nameservers in the container's `/etc/resolv.conf`, which must be owned and writable by root alone. On Colima's default bridge that is the VM's resolver, `192.168.5.1`.
- IPv6 is refused. Loopback and replies to allowed connections pass.
- Hosts are allowed by the IPv4 addresses they resolved to at the last refresh, not by name.

Left out:

- `mcp-proxy.anthropic.com`: claude.ai connectors, which a `setup-token` login cannot fetch anyway ([The Claude token](agent-credentials.md#the-claude-token)).
- `storage.googleapis.com`: plugin install counts and metadata shown in `/plugin`.
- The Datadog intake hosts: optional operational telemetry.
- `bridge.claudeusercontent.com`: Claude in Chrome's bridge, which container sessions cannot use ([Claude in Chrome](#claude-in-chrome)).
- `code.claude.com`: documentation lookups; "Blocking this host only affects documentation lookups" (same page).

#164 ran the Claude logins, the plugin install and the test suites with the first three blocked, and saw no effect.

**Refresh.** The entrypoint applies the firewall at every start, then runs `init-firewall.sh refresh` every `FIREWALL_REFRESH_SECONDS` (default 300). A refresh resolves every host again and re-adds each address, which resets its timeout. An address expires 12 intervals after it was last added (an hour at the default), so one a host no longer resolves to drops out. GitHub's ranges come from `/meta`, which allows 60 unauthenticated requests an hour per address: they are fetched at every start, and on a refresh at most once an hour (the last good copy is kept under `/run/init-firewall`, readable by root only).

**The limit.** A refresh fails as a whole when one host does not resolve, or when `/meta` cannot be fetched once its copy is an hour old: it then adds nothing (or only `api.github.com`, which goes in first). If it keeps failing, every other entry expires after 12 intervals and only `api.github.com` stays reachable, so the firewall fails closed: sessions lose git, npm and Claude's hosts. `docker logs claude-workflow-agent` shows each failure, an `init-firewall:` line naming the host or the fetch, then `entrypoint: firewall refresh failed; current rules kept`. The rules are kept, but the entries they allow keep expiring.

**Changing it.** Edit `https_hosts` in `init-firewall.sh`, keep the table above in step, and rerun `dispatch/setup-agents.sh container`: the image changes, so the container is replaced, which refuses while a session is live in it.

A firewall, not a proxy: #164 weighed a domain-based egress proxy. It would avoid stale addresses, but it adds a second container, still needs a firewall to force traffic through it, and does not carry SSH. It stays the option if stale addresses cause trouble.

## What it can't stop

The container limits what a session can reach, not what it does with what it can reach.

- **Allowed hosts are ways out.** A session can put data in a GitHub issue, a comment or a pushed branch, or send it to `api.anthropic.com`. An address on the allowlist also opens every other site served from it: npm sits on shared Cloudflare addresses (`104.16.x.x`), and whether other sites there are reachable is untested. DNS through the resolver might carry data too (untested). Claude Code's docs say of dev containers: "When executed with `--dangerously-skip-permissions`, dev containers do not prevent a malicious project from exfiltrating anything accessible inside the container" (*Development containers*). Sessions here run in auto mode instead, whose classifier may block such an action; the firewall does not.
- **A session can read its own credentials.** The Claude token is in its environment, the `gh` token in `~/.config/gh/hosts.yml`, and every served repo's deploy key in `~/.ssh`, and all three can leave by the routes above. With a deploy key, a session can push, force-push or delete any branch other than the default branch, and any tag, in every served repo, not only its own: `protect-main` covers only the default branch, and the project's deny rules ([Requirements](setup.md#requirements)) are the backstop.
- **A session can change what the poller and later sessions use.** Everything in the home volume belongs to `node`: the poller's state (`~/.local/state/claude-workflow`), its copy of the dispatch config (rewritten before every poll), the poller's clone of this repo (`/home/node/claude-workflow`; install's `deps` step refuses a clone with local changes to tracked files), and also Claude Code's settings, the installed plugin and the other repos' clones. #164 judged that editing the poller's clone gains a session nothing beyond the container's own credentials.
- **Merging** is stopped by GitHub, not by the container: no token a session holds has Contents write ([Agent credentials](agent-credentials.md#why)).

## Runtime: Colima

- Why Colima: MIT licence, `brew install colima docker`, no sudo, and it starts from a launchd job in the poller's domain (`gui/<uid>`). Spike #164 started the VM and ran a container from such a job, with the poller plist's `HOME` and `PATH`, in 18 seconds. Docker Desktop was read about, not installed. Neither was tried while logged out; the poller needs a login either way.
- The command, `colima start --cpu 4 --memory 4 --disk 40 --mount none`, gives the VM 4 CPUs, 4 GiB of memory and a 40 GiB disk, on an 8 GB Mac. The image is about 4 GB. In #164 the container's sampled peak was 1.29 GiB while the served app's checks ran; several opus sessions at full load are untested, and are the main practical risk.
- The image, on `node:24-bookworm`, pins Claude Code (`CLAUDE_CODE_VERSION`, 2.1.309) and Playwright (`PLAYWRIGHT_VERSION`, 1.64.1) by build arguments and sets `DISABLE_AUTOUPDATER=1`, so Claude Code never updates itself there: an update is a rebuild ([Updates](#updates)).

## Restart behaviour

- The container has no restart policy: when it stops, it stays stopped until the next poll or `container` run starts it. Each start fetches GitHub's ranges, so a tight restart loop would use up `/meta`'s 60 requests an hour.
- Every start applies the firewall again (a restart removes every rule, #164) and logs `entrypoint: firewall applied`, or exits after `entrypoint: firewall failed; not starting`. The setup script and the poll job run nothing in a started container before that line, and wait up to 3 minutes for it.
- Each poll starts Colima and the container when they are down, unless dispatch is paused: `pause` disables the job, so nothing starts either until `resume`.
- A restart ends the sessions in the container. A `working` session becomes `failed`, and the poller marks its ticket `agent-failed`; a `done` session stays `done`. `claude attach <id>`, run in the container, reopens a failed session with its conversation (#164).
- The `container` phase replaces the container when its image or its config label changes (the env file or the run flags), or with `--rebuild`. A replacement refuses while a session is live in the container, idle ones included, and keeps the volume, so clones, keys, logins and Claude Code's state survive.

## Updates

- **The plugin.** Every poll updates it in the container (`claude plugin marketplace update askrzypczak-plugins`, then `claude plugin update ticket-workflow@askrzypczak-plugins --scope user`; a failure is logged and the poll goes on with the installed plugin), and so does every `container` run. Between them, Claude Code's marketplace auto-update, which the phase turns on (`autoUpdate` on the marketplace entry, and `FORCE_AUTOUPDATE_PLUGINS=1` in the container, since `DISABLE_AUTOUPDATER=1` would turn it off too), runs in an interactive session after its first message. Claude Code's docs do not say whether `--bg` sessions run it.
- **Claude Code.** Bump `CLAUDE_CODE_VERSION` in `dispatch/container/Dockerfile`, then run `dispatch/setup-agents.sh container --rebuild`: it rebuilds the image with `--pull --no-cache` and replaces the container, which refuses while a session is live in it.
- **The poller.** It runs from the container's clone of this repo, which install's `deps` step pins to the host clone's commit: after pulling, rerun `dispatch/install-launchd.sh install`.
- **The Claude token**: [rotating it](agent-credentials.md#the-claude-token).

## Talking to sessions

Container sessions do not show in the host's `claude agents`. Open the container's agent view from a host terminal:

    docker exec -it -w /home/node/claude-workflow claude-workflow-agent claude agents

It shows the same states and takes the same answers: plan sign-off, questions and permission prompts. `claude attach <id>`, `claude logs <name>` and `claude stop <id>` work the same way through `docker exec`; stop a session by its id, not its name (#164). The `agent-claude` shell function in the [dispatch README](../dispatch/README.md#overview) shortens these commands.

## Sessions on the host

What applies to an interactive session on the Mac:

- The host's fine-grained `gh` login, which cannot merge ([Agent credentials](agent-credentials.md)).
- The deny rules the `host` phase merges into `~/.claude/settings.json` from [`dispatch/setup/host-settings.json`](../dispatch/setup/host-settings.json):
  - Read and Edit denies on Claude Code's credential store (`~/.claude/.credentials.json`), the container's env file (`~/.config/claude-workflow/claude-agent.env`), the Chrome, Brave, Arc, Edge, Firefox and Safari profiles, and `~/Library/Cookies`;
  - Edit denies on `~/.gitconfig`, `~/.config/git/**` and every repository's `.git/hooks` and `.git/config`, where a setting or a hook could make git run a program;
  - `Bash(git fetch *--upl*)`, `Bash(git pull *--upl*)`, `Bash(git push *--rece*)` and `Bash(git push *--e*)`, which deny `--upload-pack`, `--receive-pack` and `--exec`, the options that name a program for git to run.
- The project's deny rules ([Requirements](setup.md#requirements)).
- `CLAUDE_CODE_ENABLE_CFC=0`, which keeps Claude in Chrome off unless a session starts with `--chrome` ([Claude in Chrome](#claude-in-chrome)).

These rules match tool calls as written. They are backstops, not a boundary: with no sandbox, a Bash command can read anything the maintainer can, the env file and the keychain included.

Dropped on the host: Claude Code's sandbox and the deploy-key arrangement. The maintainer's own key pushes, which cannot merge a PR, and `protect-main` refuses its direct pushes to `main`. The `host` phase notes a `sandbox` block left in `~/.claude/settings.json`, or a managed settings file left in `/Library/Application Support/ClaudeCode/`, each with the command that removes it, and changes neither.

What runs where: unattended sessions, the poller and orchestration run in the container. To orchestrate an epic there, start the session from a host terminal, then run `/ticket-workflow:orchestrate-epic E` in it:

    docker exec -it -w /home/node/<repo> claude-workflow-agent claude --permission-mode auto

The flag matters: a session signed in with a `setup-token` token starts in manual mode and stops at its first Bash call (#164, answer 5). Claude in Chrome and other interactive work that needs the host stay there, in sessions the maintainer watches.

### Claude in Chrome

Claude in Chrome acts in the maintainer's own browser, with its sign-ins. In auto mode, "when the auto mode classifier itself approves a browser call to a site, the extension skips its own per-site check for that call, unless your permission rules deny any site to Claude in Chrome" (Claude Code docs, *Use Claude Code with Chrome*). So keeping github.com out of the extension's site permissions is not a boundary in auto mode, and the docs give no rule syntax for denying a site to Claude in Chrome.

Container sessions cannot use it at all:

- "If you authenticate with an API key or a long-lived token from `claude setup-token`, Claude Code keeps Chrome integration off, even when you pass `--chrome`." (same page).
- Its bridge, `bridge.claudeusercontent.com`, is not on the allowlist.
- The `check` phase's probe session lists its browser tools and fails on a Claude in Chrome tool.

On the host:

- `CLAUDE_CODE_ENABLE_CFC=0` keeps it off by default. The variable "Takes precedence over the `claudeInChromeDefaultEnabled` setting. The `--chrome` and `--no-chrome` flags take precedence over both." (Claude Code docs, *Environment variables*). So no `/chrome` toggle needs changing. Start `claude --chrome` only for an interactive session you are watching.
- Under `exempt`, the merge screen has no bypass box ([The Actions token](agent-credentials.md#the-actions-token)), so in a browser signed in to GitHub, a green PR's Merge button is one click away.
- So install the extension only in a dedicated Chrome profile that is not signed in to GitHub, remove it from every other profile, and keep github.com out of its site permissions. A session that drives that profile has no signed-in Merge button to reach. This is reasoned, not tested.
- The Claude desktop app's built-in browser pane keeps its own sign-ins: do not sign in to github.com there (the same route as Claude in Chrome).

### Freeing memory

On an 8 GB Mac, work on the host can need the memory the Colima VM holds. To free it:

1. Run `dispatch/install-launchd.sh pause`. It ends a poll running in the container and lists the container's live sessions by id.
2. Finish or stop those sessions (`docker exec claude-workflow-agent claude stop <id>`). A session still working when the VM stops becomes `failed`, and its ticket gets `agent-failed`.
3. Run `colima stop`.
4. Afterwards, run `dispatch/install-launchd.sh resume`: the poll it starts brings Colima and the container back up.

Pause first: otherwise the next poll starts Colima again.

## Unverified until the first real run

Built and tested against fakes, but not yet shown by a real run:

- From #166: whether `--bg` sessions run the plugin auto-update pass; that the trust keys the `container` phase seeds in `~/.claude.json` (`hasCompletedOnboarding`, `projects.<dir>.hasTrustDialogAccepted`, undocumented) still let `claude --bg` start on Claude Code 2.1.309; `claude stop <id>` through `docker exec` without `-w`; a `--bg` session outliving the `docker exec` that started it.
- From #167 (PR #174): `colima start` from the launchd job; `claude logs <name>` and `claude attach` through `docker exec -it` from a host terminal; `pause`'s `pkill` of a running poll.
