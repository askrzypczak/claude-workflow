# Agent container

An image for unattended agent sessions: Claude Code, git, gh and Playwright's Chromium, behind a default-deny egress firewall that the container applies to itself at startup. If the firewall cannot be applied, the container exits instead of starting.

## Build

From the repository root:

```sh
docker build -t claude-workflow-agent dispatch/container
```

Claude Code and Playwright are pinned by the build arguments `CLAUDE_CODE_VERSION` and `PLAYWRIGHT_VERSION`, with defaults in the `Dockerfile`. The image does not update itself; to update, rebuild with a new version, for example `--build-arg CLAUDE_CODE_VERSION=<version>`.

## Run

```sh
docker run -d --name claude-workflow-agent --init \
  --cap-add=NET_ADMIN --cap-add=NET_RAW --security-opt no-new-privileges \
  -v claude-workflow-home:/home/node claude-workflow-agent
```

- The entrypoint runs as root, with `NET_ADMIN` and `NET_RAW`, only to apply the firewall and refresh it. Sessions run as `node`, which holds no capabilities and cannot change the rules or signal the entrypoint.
- `claude-workflow-home` is a named volume holding `/home/node`, so clones, logins and Claude Code's state survive a restart or a rebuild.
- Add no bind mounts and do not mount the Docker socket.
- The `container` phase of `dispatch/setup-agents.sh` runs it with these flags plus `--env-file ~/.config/claude-workflow/claude-agent.env` (the Claude token), `-e FORCE_AUTOUPDATE_PLUGINS=1` and a `claude-workflow.config` label, whose change makes the phase replace the container.
- The entrypoint takes no arguments. It re-resolves the allowlist every `FIREWALL_REFRESH_SECONDS` (default 300; set it with `-e`). GitHub's address ranges come from `api.github.com/meta`, which allows 60 unauthenticated requests an hour per IP address, so they are fetched on every start but at most hourly on a refresh.

Wait for the readiness line before the first `docker exec`:

```sh
docker logs --since "$(docker inspect -f '{{.State.StartedAt}}' claude-workflow-agent)" claude-workflow-agent 2>&1 | grep 'entrypoint: firewall applied'
```

Every start logs the line again, and `--since` reads only the latest start's lines, so this works after a restart too.

A failed start logs `entrypoint: firewall failed; not starting`; a failed refresh logs `entrypoint: firewall refresh failed; current rules kept`.

## Exec

Run every command other than `claude` with `-u node`:

```sh
docker exec -it -u node claude-workflow-agent bash
docker exec -u node -w /home/node/<repo> claude-workflow-agent git status
```

`docker exec` runs as root by default. A root command writes into `/root` rather than the home volume, and holds `NET_ADMIN`, so it can change the firewall.

`claude` needs no flag: `/usr/local/bin/claude` is a wrapper that, started as root, switches to `node` with every capability dropped before Claude Code starts. For example:

```sh
docker exec -it -w /home/node/<repo> claude-workflow-agent claude agents
```

## Allowlist

The allowlist is in `init-firewall.sh`. [The allowlist](../../docs/containers.md#the-allowlist) gives the reason for each host and the firewall's limits.

## Verify

Start Colima with no host directories mounted into its VM:

```sh
colima start --cpu 4 --memory 4 --disk 40 --mount none
```

Then, from the repository root:

```sh
dispatch/container/test-container.sh
```

It builds `claude-workflow-agent:test`, checks the firewall and the privilege boundaries in throwaway containers, and prints `PASS` or `FAIL` for each check. It exits 0 when every check passes, 1 when any fails and 2 when docker is unreachable. It removes the containers and the volume it creates and keeps the image. A first build takes 10 to 20 minutes; a run with a cached build takes a few minutes.
