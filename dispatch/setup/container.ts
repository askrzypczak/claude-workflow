// The container phase: the agent container, its image and home volume, and everything a session
// in it needs (deploy keys, clones, git identity, gh login, Claude token, trust, the plugin).
// dispatch/container/README.md gives the run flags and the exec rules; this file carries them out.
// Under --dry-run every write is a `would` line, and a step whose input does not exist yet
// (the container, a key) is listed as it would run.
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { timestamp } from "../poller/io.ts";
import { parseJson } from "../poller/schemas.ts";
import { checkProtectMain, quiesce, tokenFormUrl, wrongShaMerge } from "./credentials.ts";
import type { MergeVerdict } from "./credentials.ts";
import {
  claudeExec,
  cloneDir,
  CONFIG_LABEL,
  CONTAINER,
  CONTAINER_HOME,
  containerState,
  IMAGE,
  nodeExec,
  READY_LINE,
  readInContainer,
  VOLUME,
  waitReady,
  writeInContainer,
} from "./docker.ts";
import type { RunResult, StepStatus } from "./io.ts";
import type { Phase, SetupContext } from "./main.ts";
import type { ServedRepo } from "./repos.ts";

/** The Claude token's env file, under the home directory. */
export const ENV_FILE = ".config/claude-workflow/claude-agent.env";
export { CONFIG_LABEL };

/** Colima with no host directory mounted into its VM (dispatch/container/README.md, Verify). */
const COLIMA_START = "colima start --cpu 4 --memory 4 --disk 40 --mount none";
const READY_TIMEOUT_MS = 3 * 60 * 1000;
const GH_HOST = "github.com";
const FINE_GRAINED = "github_pat_";
const SSH_DIR = `${CONTAINER_HOME}/.ssh`;
const CLAUDE_JSON = `${CONTAINER_HOME}/.claude.json`;
const USER_SETTINGS = `${CONTAINER_HOME}/.claude/settings.json`;
export const MARKETPLACE = "askrzypczak-plugins";
const MARKETPLACE_REPO = "askrzypczak/claude-workflow";
export const PLUGIN = `ticket-workflow@${MARKETPLACE}`;
const IDENTITY = ["user.name", "user.email"] as const;
/** In-container commands, as the to-dos name them. */
const AS_NODE = `docker exec -u node ${CONTAINER}`;

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const repoName = (repo: string) => repo.slice(repo.indexOf("/") + 1);
const shortId = (id: string) => id.replace(/^sha256:/, "").slice(0, 12);

/** The first line of stderr, else of stdout, else the exit status. */
function answer(result: RunResult): string {
  const first = (text: string) => text.split("\n").map((l) => l.trim()).find((l) => l !== "");
  return first(result.stderr) ?? first(result.stdout) ?? `exit ${result.status}`;
}

/** The last line of stderr, else of stdout: where a long build prints its error. */
function lastAnswer(result: RunResult): string {
  const last = (text: string) => text.split("\n").map((l) => l.trim()).filter((l) => l !== "").pop();
  return last(result.stderr) ?? last(result.stdout) ?? `exit ${result.status}`;
}

/** The `docker run` arguments, with the env file and the config label's value. */
export function runArgs(envFile: string, config: string): string[] {
  return [
    "run", "-d", "--name", CONTAINER, "--init",
    "--cap-add=NET_ADMIN", "--cap-add=NET_RAW", "--security-opt", "no-new-privileges",
    "--env-file", envFile,
    // The image sets DISABLE_AUTOUPDATER=1, which also turns off plugin auto-update without this.
    "-e", "FORCE_AUTOUPDATE_PLUGINS=1",
    "--label", `${CONFIG_LABEL}=${config}`,
    "-v", `${VOLUME}:${CONTAINER_HOME}`,
    IMAGE,
  ];
}

/** The config label's value: a digest of the run arguments and the env file, never the token itself. */
function configDigest(envFile: string, envText: string): string {
  return createHash("sha256").update(JSON.stringify({ run: runArgs(envFile, ""), env: envText })).digest("hex");
}

/** The container's ~/.ssh/config: one alias per repo, each naming only that repo's deploy key. */
export function sshConfig(repos: readonly { repo: string }[]): string {
  const blocks = repos.map(({ repo }) => {
    const name = repoName(repo);
    return [`Host github.com-${name}`, "  HostName github.com", "  User git", `  IdentityFile ~/.ssh/deploy-${name}`, "  IdentitiesOnly yes", ""].join("\n");
  });
  return ["# Written by dispatch/setup-agents.sh container, which rewrites it on every run.", "", ...blocks].join("\n");
}

/** ~/.claude.json with onboarding done and each dir trusted; throws on text that is not an object. */
export function seedClaudeJson(text: string | undefined, dirs: readonly string[]): string {
  let root: JsonObject = {};
  if (text !== undefined) {
    const value: unknown = JSON.parse(text);
    if (!isObject(value)) throw new Error("~/.claude.json does not hold a JSON object");
    root = value;
  }
  const projects: JsonObject = isObject(root.projects) ? { ...root.projects } : {};
  for (const dir of dirs) {
    const project = projects[dir];
    projects[dir] = { ...(isObject(project) ? project : {}), hasTrustDialogAccepted: true };
  }
  return `${JSON.stringify({ ...root, hasCompletedOnboarding: true, projects }, null, 2)}\n`;
}

/** One pass of the phase. */
interface Pass extends SetupContext {
  /** Reports, with every pasted token replaced. */
  say(status: StepStatus, text: string): void;
  /** Pasted tokens, never shown. */
  hidden: string[];
  /** Whether quiesce passed in this run, so it runs at most once. */
  quiesced: boolean;
  /** Whether docker answers. */
  docker: boolean;
  /** Whether the container runs and logged its readiness line, so commands can run in it. */
  live: boolean;
}

/** The Claude token's env file: its text, or pending under --dry-run when it does not exist yet. */
type EnvFile = { text: string } | "pending";

/**
 * Pauses dispatch and refuses while a session is live in the container, once per run. Host
 * sessions are left out: starting, replacing or logging in the container never reaches them.
 */
function quiet(p: Pass): boolean {
  if (p.quiesced) return true;
  if (!quiesce(p, p.say, { host: false })) return false;
  p.quiesced = true;
  return true;
}

/** The clone dir, the deploy key and the alias are named by the repo part, so two repos must not share it. */
function distinctNames(p: Pass): boolean {
  const byName = new Map<string, string[]>();
  for (const { repo } of p.repos) {
    const name = repoName(repo).toLowerCase();
    byName.set(name, [...(byName.get(name) ?? []), repo]);
  }
  const shared = [...byName.values()].filter((repos) => repos.length > 1);
  for (const repos of shared) {
    p.say(
      "todo",
      `${repos.join(", ")} share the repo name ${repoName(repos[0]!)}, which names the clone ${cloneDir(repos[0]!)}, the deploy key and the host alias in the container: serve only one of them (remove the others from the dispatch config), then rerun`,
    );
  }
  return shared.length === 0 || p.dryRun;
}

function dockerStep(p: Pass): boolean {
  const info = p.io.run("docker", ["info", "--format", "{{.ServerVersion}}"]);
  if (info.status === 0) {
    p.say("pass", "docker answers");
    return true;
  }
  p.say("todo", `docker does not answer (${answer(info)}): start Colima with ${COLIMA_START}, then rerun`);
  return false;
}

/** The env file `docker run --env-file` reads: CLAUDE_CODE_OAUTH_TOKEN, mode 0600. */
function envFileStep(p: Pass): EnvFile | "stop" {
  const path = join(p.home, ENV_FILE);
  const text = p.io.readFile(path);
  if (text === undefined) {
    if (p.dryRun) {
      p.say(
        "would",
        `Claude token: read the token claude setup-token prints at a hidden prompt, then write it to ${path} as CLAUDE_CODE_OAUTH_TOKEN=<token>, mode 0600`,
      );
      return "pending";
    }
    p.say(
      "note",
      `Claude token: in another terminal, run claude setup-token and log in with the Claude account the agents use; it prints a long-lived token for ${path}`,
    );
    const token = p.io.readSecret("Paste the Claude token (input hidden), then press Enter: ").trim();
    if (token.length >= 12) p.hidden.push(token);
    if (token === "" || /\s/.test(token) || token.startsWith(FINE_GRAINED) || /^gh[opsur]_/.test(token)) {
      p.say(
        "todo",
        `Claude token: ${token === "" ? "nothing was pasted" : "that is not the token claude setup-token prints"}: rerun and paste the token claude setup-token printed`,
      );
      return "stop";
    }
    const written = `CLAUDE_CODE_OAUTH_TOKEN=${token}\n`;
    const made = p.io.run("mkdir", ["-p", dirname(path)]);
    if (made.status !== 0) {
      p.say("todo", `Claude token: mkdir -p ${dirname(path)} failed (${answer(made)}): fix that, then rerun`);
      return "stop";
    }
    try {
      p.io.writeFile(path, written);
    } catch (err) {
      p.say("todo", `Claude token: writing ${path} failed (${message(err)}): fix that, then rerun`);
      return "stop";
    }
    p.say("done", `Claude token: wrote it to ${path} as CLAUDE_CODE_OAUTH_TOKEN, mode 0600 (not shown)`);
    return { text: written };
  }

  if (!/^CLAUDE_CODE_OAUTH_TOKEN=\S+$/m.test(text)) {
    p.say("todo", `Claude token: ${path} has no CLAUDE_CODE_OAUTH_TOKEN=<token> line: delete the file, then rerun to paste the token again`);
    return p.dryRun ? "pending" : "stop";
  }
  const stat = p.io.run("stat", ["-f", "%Lp", path]);
  if (stat.status !== 0) throw new Error(`stat -f %Lp ${path} failed: ${answer(stat)}`);
  const mode = stat.stdout.trim();
  if (mode === "600") {
    p.say("already", `Claude token: ${path} holds CLAUDE_CODE_OAUTH_TOKEN, mode 0600`);
  } else if (p.dryRun) {
    p.say("would", `Claude token: chmod 600 ${path} (its mode is ${mode})`);
  } else {
    const changed = p.io.run("chmod", ["600", path]);
    if (changed.status !== 0) {
      p.say("todo", `Claude token: chmod 600 ${path} failed (${answer(changed)}): fix that, then rerun`);
      return "stop";
    }
    p.say("done", `Claude token: set ${path} to mode 0600 (it was ${mode})`);
  }
  return { text };
}

const ImageInspect = z.array(z.object({ Id: z.string() }));

/** The image's id, or undefined when there is none. */
function imageId(p: Pass): string | undefined {
  const args = ["image", "inspect", IMAGE];
  const result = p.io.run("docker", args);
  if (result.status !== 0) {
    if (/No such image/i.test(result.stderr)) return undefined;
    throw new Error(`docker ${args.join(" ")} failed: ${answer(result)}`);
  }
  return parseJson(ImageInspect, result.stdout, `docker ${args.join(" ")}`)[0]?.Id;
}

/** Builds the image on every run (cached after the first build); its id, or "stop". */
function imageStep(p: Pass): { id: string | undefined } | "stop" {
  const args = ["build", ...(p.rebuild ? ["--pull", "--no-cache"] : []), "-t", IMAGE, join(p.clone, "dispatch/container")];
  const command = `docker ${args.join(" ")}`;
  const time = p.rebuild ? "a build with --no-cache takes 10 to 20 minutes" : "the first build takes 10 to 20 minutes, a cached one seconds";
  if (p.dryRun || !p.docker) {
    p.say("would", `image: ${command} (${time})`);
    return { id: p.docker ? imageId(p) : undefined };
  }
  p.say("note", `image: running ${command}; ${time}`);
  const built = p.io.run("docker", args);
  if (built.status !== 0) {
    p.say("todo", `image: ${command} failed (${lastAnswer(built)}): fix that, then rerun`);
    return "stop";
  }
  const id = imageId(p);
  if (id === undefined) {
    p.say("todo", `image: ${command} passed but docker image inspect ${IMAGE} finds no image: rerun`);
    return "stop";
  }
  p.say("done", `image: built ${IMAGE} (${shortId(id)})`);
  return { id };
}

function volumeStep(p: Pass): boolean {
  const what = `volume: ${VOLUME} holds ${CONTAINER_HOME} (clones, keys, logins and Claude Code's state)`;
  if (!p.docker) {
    p.say("would", `${what}: docker volume create ${VOLUME} unless it exists`);
    return true;
  }
  if (p.io.run("docker", ["volume", "inspect", VOLUME]).status === 0) {
    p.say("already", `${what}: it exists`);
    return true;
  }
  if (p.dryRun) {
    p.say("would", `${what}: docker volume create ${VOLUME}`);
    return true;
  }
  const created = p.io.run("docker", ["volume", "create", VOLUME]);
  if (created.status !== 0) {
    p.say("todo", `volume: docker volume create ${VOLUME} failed (${answer(created)}): fix that, then rerun`);
    return false;
  }
  p.say("done", `volume: created ${VOLUME}`);
  return true;
}

/** Runs, replaces or starts the container as needed, then waits for its readiness line. */
function containerStep(p: Pass, env: EnvFile, image: { id: string | undefined }): boolean {
  const envFile = join(p.home, ENV_FILE);
  const config = env === "pending" ? undefined : configDigest(envFile, env.text);
  const run = `docker ${runArgs(envFile, config ?? "<a digest of the run arguments and the env file>").join(" ")}`;
  const then = `then wait up to ${READY_TIMEOUT_MS / 60_000} minutes for "${READY_LINE}" in docker logs`;
  if (!p.docker) {
    p.say("would", `container: ${run}; ${then}`);
    return true;
  }
  const state = containerState(p.io);
  if (state.kind === "no-docker") {
    p.say("todo", `container: docker does not answer (${state.detail}): start Colima with ${COLIMA_START}, then rerun`);
    return p.dryRun;
  }

  let action: "run" | "replace" | "start" | undefined;
  let why = "";
  if (state.kind === "absent") {
    action = "run";
  } else {
    const reasons: string[] = [];
    if (p.rebuild) reasons.push("--rebuild");
    if (image.id !== undefined && state.image !== image.id) {
      reasons.push(`it runs the image ${shortId(state.image)}, not ${shortId(image.id)}`);
    }
    if (config === undefined) reasons.push("the env file is written first");
    else if (state.label !== config) reasons.push("its config label differs: the env file or the run flags changed");
    if (reasons.length > 0) {
      action = "replace";
      why = reasons.join("; ");
    } else if (state.kind === "stopped") {
      action = "start";
    }
  }

  if (action === undefined) {
    p.say("already", `container: ${CONTAINER} runs the current image and config`);
  } else {
    // A replace or a start must not cut off a live session.
    if (!quiet(p)) return false;
    const replace = `docker stop ${CONTAINER} and docker rm ${CONTAINER} (the ${VOLUME} volume is kept), then ${run}`;
    if (p.dryRun) {
      const what =
        action === "run" ? run
        : action === "start" ? `docker start ${CONTAINER} (stopped, on the current image and config)`
        : `${replace} (${why})`;
      p.say("would", `container: ${what}; ${then}`);
      return true;
    }
    if (action === "start") {
      const started = p.io.run("docker", ["start", CONTAINER]);
      if (started.status !== 0) {
        p.say("todo", `container: docker start ${CONTAINER} failed (${answer(started)}): see docker logs ${CONTAINER}, then rerun`);
        return false;
      }
      p.say("done", `container: started ${CONTAINER} (it was stopped)`);
    } else {
      if (action === "replace") {
        for (const args of [["stop", CONTAINER], ["rm", CONTAINER]]) {
          const result = p.io.run("docker", args);
          if (result.status !== 0) {
            p.say("todo", `container: docker ${args.join(" ")} failed (${answer(result)}): fix that, then rerun`);
            return false;
          }
        }
      }
      const created = p.io.run("docker", runArgs(envFile, config!));
      if (created.status !== 0) {
        p.say("todo", `container: ${run} failed (${answer(created)}): fix that, then rerun`);
        return false;
      }
      p.say("done", action === "run" ? `container: ${run}` : `container: replaced ${CONTAINER} (${why}) on the ${VOLUME} volume: ${run}`);
    }
  }

  const ready = waitReady(p.io, READY_TIMEOUT_MS);
  if (!ready.ready) {
    p.say("todo", `container: ${CONTAINER} is not ready: ${ready.detail}. docker logs ${CONTAINER} shows its log; fix the cause, then rerun`);
    return p.dryRun;
  }
  p.say("pass", `container: ${CONTAINER} logged "${READY_LINE}" for its latest start`);
  p.live = true;
  return true;
}

/** One git config value; undefined when it is not set. */
function gitValue(result: RunResult, what: string): string | undefined {
  if (result.status === 1) return undefined;
  if (result.status !== 0) throw new Error(`${what} failed: ${answer(result)}`);
  const value = result.stdout.trim();
  return value === "" ? undefined : value;
}

/** The container's global user.name and user.email, copied from the host's when unset. */
function identityStep(p: Pass): boolean {
  const inContainer = new Map<string, string | undefined>();
  if (p.live) {
    for (const key of IDENTITY) {
      inContainer.set(key, gitValue(nodeExec(p.io, ["git", "config", "--global", "--get", key]), `${AS_NODE} git config --global --get ${key}`));
    }
  }
  const missing = IDENTITY.filter((key) => inContainer.get(key) === undefined);
  if (missing.length === 0) {
    p.say("already", `git identity: the container's global git config has ${IDENTITY.map((k) => `${k} ${inContainer.get(k)}`).join(" and ")}`);
    return true;
  }
  const host = new Map(missing.map((key) => [key, gitValue(p.io.run("git", ["config", "--global", "--get", key]), `git config --global --get ${key}`)]));
  const lacking = missing.filter((key) => host.get(key) === undefined);
  if (lacking.length > 0) {
    p.say(
      "todo",
      `git identity: the container's global git config has no ${missing.join(" or ")}, and the host's has no ${lacking.join(" or ")} to copy, so sessions could not commit: set them on the host (git config --global user.name "<name>" and git config --global user.email "<email>"), then rerun`,
    );
    return p.dryRun;
  }
  for (const key of missing) {
    const value = host.get(key)!;
    if (p.dryRun) {
      p.say("would", `git identity: copy the host's global ${key} (${value}) into the container's global git config`);
      continue;
    }
    const set = nodeExec(p.io, ["git", "config", "--global", key, value]);
    if (set.status !== 0) {
      p.say("todo", `git identity: setting ${key} in the container failed (${answer(set)}): run ${AS_NODE} git config --global ${key} "${value}", then rerun`);
      return false;
    }
    p.say("done", `git identity: copied the host's global ${key} (${value}) into the container's global git config`);
  }
  return true;
}

/** Writes `text` to `path` in the container unless it holds it already. */
function writeIfChanged(p: Pass, path: string, text: string, what: string): boolean {
  if (readInContainer(p.io, path) === text) {
    p.say("already", `${what}: ${path} is up to date`);
    return true;
  }
  if (p.dryRun) {
    p.say("would", `${what}: write ${path}`);
    return true;
  }
  const written = writeInContainer(p.io, path, text);
  if (written.status !== 0) {
    p.say("todo", `${what}: writing ${path} in the container failed (${answer(written)}): fix that, then rerun`);
    return false;
  }
  p.say("done", `${what}: wrote ${path}`);
  return true;
}

const Meta = z.object({ ssh_keys: z.array(z.string()).min(1) });

/** ~/.ssh as node: the directory, known_hosts from GitHub's meta, and the alias config. */
function sshStep(p: Pass): boolean {
  const hosts = p.repos.map((r) => `github.com-${repoName(r.repo)}`).join(", ");
  if (!p.live) {
    p.say(
      "would",
      `ssh: in the container as node, create ${SSH_DIR} (mode 0700), write ${SSH_DIR}/known_hosts from the ssh_keys of https://api.github.com/meta, and write ${SSH_DIR}/config with one alias per repo (${hosts}), each offering only its deploy key`,
    );
    return true;
  }
  const mode = nodeExec(p.io, ["stat", "-c", "%a", SSH_DIR]);
  if (mode.status === 0 && mode.stdout.trim() === "700") {
    p.say("already", `ssh: ${SSH_DIR} exists, mode 0700`);
  } else if (p.dryRun) {
    p.say("would", `ssh: install -d -m 0700 ${SSH_DIR}`);
  } else {
    const made = nodeExec(p.io, ["install", "-d", "-m", "0700", SSH_DIR]);
    if (made.status !== 0) {
      p.say("todo", `ssh: install -d -m 0700 ${SSH_DIR} failed (${answer(made)}): fix that, then rerun`);
      return false;
    }
    p.say("done", `ssh: ${SSH_DIR} exists, mode 0700`);
  }

  // Unauthenticated, from the container, as the firewall's own refresh reads it.
  const fetched = nodeExec(p.io, ["curl", "-q", "-fsS", "--max-time", "30", "https://api.github.com/meta"]);
  if (fetched.status !== 0) {
    p.say("todo", `ssh: reading https://api.github.com/meta in the container failed (${answer(fetched)}): rerun in a few minutes (it allows 60 unauthenticated reads an hour)`);
    return p.dryRun;
  }
  const meta = parseJson(Meta, fetched.stdout, "https://api.github.com/meta");
  const knownHosts = meta.ssh_keys.map((key) => `github.com ${key.trim()}\n`).join("");
  if (!writeIfChanged(p, `${SSH_DIR}/known_hosts`, knownHosts, "ssh: known_hosts with GitHub's host keys from its meta")) return false;
  return writeIfChanged(p, `${SSH_DIR}/config`, sshConfig(p.repos), `ssh: config with one alias per repo (${hosts})`);
}

const RepoInfo = z.object({ default_branch: z.string() });

/** protect-main must hold before a deploy key with write access exists for the repo. */
function protectMainStep(p: Pass, repo: string): boolean {
  const args = ["api", `repos/${repo}`];
  const read = p.io.run("gh", args);
  if (read.status !== 0) {
    p.say("todo", `${repo}: gh ${args.join(" ")} failed (${answer(read)}), so ${repo}'s protect-main could not be checked: the host's gh login must see the repo; fix that, then rerun`);
    return p.dryRun;
  }
  const { default_branch: branch } = parseJson(RepoInfo, read.stdout, `gh ${args.join(" ")}`);
  return checkProtectMain({ io: p.io, say: p.say }, repo, branch) || p.dryRun;
}

/** The deploy key in the container: "ok" when it exists, "pending" under --dry-run, or "stop". */
function keyStep(p: Pass, repo: string, key: string): "ok" | "pending" | "stop" {
  const generate = `ssh-keygen -t ed25519 -N "" -f ${key}`;
  if (!p.live) {
    p.say("would", `${repo}: generate the deploy key ${key} in the container as node (${generate}) unless it exists`);
    return "pending";
  }
  if (nodeExec(p.io, ["test", "-f", key]).status === 0) {
    p.say("already", `${repo}: deploy key ${key} exists in the container`);
    return "ok";
  }
  if (p.dryRun) {
    p.say("would", `${repo}: generate the deploy key ${key} in the container as node (${generate})`);
    return "pending";
  }
  const made = nodeExec(p.io, ["ssh-keygen", "-q", "-t", "ed25519", "-N", "", "-C", `${CONTAINER} ${repo}`, "-f", key]);
  if (made.status !== 0) {
    p.say("todo", `${repo}: generating the deploy key ${key} in the container failed (${answer(made)}): fix that, then rerun`);
    return "stop";
  }
  p.say("done", `${repo}: generated the deploy key ${key} in the container, with no passphrase`);
  return "ok";
}

/**
 * `git ls-remote` through the alias; when it fails, the paste flow: the public key on the
 * clipboard, the repo's new-deploy-key page in the browser, Enter, and the check again.
 */
function reachStep(p: Pass, repo: string, key: string, url: string, keyed: boolean): "ok" | "pending" | "stop" {
  const page = `https://github.com/${repo}/settings/keys/new`;
  const pub = `${key}.pub`;
  const flow = `copy ${pub}, open ${page}, paste it as the key with "Allow write access" ticked, wait for Enter, then check git ls-remote ${url} again`;
  if (!keyed) {
    p.say("would", `${repo}: check git ls-remote ${url} in the container; if it fails, ${flow}`);
    return "pending";
  }
  const lsRemote = () => nodeExec(p.io, ["git", "ls-remote", url, "HEAD"]);
  const first = lsRemote();
  if (first.status === 0) {
    p.say("already", `${repo}: GitHub has the deploy key: git ls-remote ${url} works in the container`);
    return "ok";
  }
  if (p.dryRun) {
    p.say("would", `${repo}: git ls-remote ${url} fails (${answer(first)}): ${flow}`);
    return "pending";
  }
  const text = readInContainer(p.io, pub);
  if (text === undefined) {
    p.say("todo", `${repo}: ${pub} is missing in the container: remove the key (${AS_NODE} rm ${key}), then rerun to generate a new one`);
    return "stop";
  }
  const copied = p.io.run("pbcopy", [], { input: text });
  if (copied.status !== 0) p.say("note", `could not copy the key (${answer(copied)}): copy it from the line below`);
  const opened = p.io.run("open", [page]);
  if (opened.status !== 0) p.say("note", `could not open the browser (${answer(opened)}): go to ${page}`);
  p.say(
    "note",
    `${repo}: GitHub does not have the deploy key yet (git ls-remote: ${answer(first)}). On ${page}, paste the copied key as the key, give it any title, tick "Allow write access" and click "Add key". The key: ${text.trim()}`,
  );
  p.io.waitForEnter(`Press Enter once the key is added to ${repo}.`);
  const second = lsRemote();
  if (second.status === 0) {
    p.say("done", `${repo}: deploy key added: git ls-remote ${url} works in the container`);
    return "ok";
  }
  p.say("todo", `${repo}: git ls-remote ${url} still fails in the container (${answer(second)}): add ${pub} on ${page} with "Allow write access", then rerun`);
  return "stop";
}

const sameUrl = (a: string, b: string) => {
  const norm = (u: string) => u.trim().toLowerCase().replace(/\/+$/, "").replace(/\.git$/, "");
  return norm(a) === norm(b);
};

/** The clone in /home/node/<name>, through the alias; an existing clone is left alone. */
function cloneStep(p: Pass, repo: string, dir: string, url: string, reached: boolean): boolean {
  const clone = `git clone ${url} ${dir}`;
  if (!p.live) {
    p.say("would", `${repo}: ${clone} in the container as node, unless ${dir} is a clone already`);
    return true;
  }
  const origin = nodeExec(p.io, ["git", "-C", dir, "remote", "get-url", "origin"]);
  if (origin.status === 0) {
    const current = origin.stdout.trim();
    if (sameUrl(current, url)) {
      p.say("already", `${repo}: ${dir} is a clone in the container (origin ${current})`);
      return true;
    }
    p.say(
      "todo",
      `${repo}: ${dir} in the container is a clone with origin ${current}, not ${url}: point it at the alias (${AS_NODE} git -C ${dir} remote set-url origin ${url}) if it is a clone of ${repo}, else move it away; then rerun`,
    );
    return p.dryRun;
  }
  if (nodeExec(p.io, ["test", "-e", dir]).status === 0) {
    p.say("todo", `${repo}: ${dir} exists in the container but is not a git clone: move it away (${AS_NODE} mv ${dir} ${dir}.old), then rerun`);
    return p.dryRun;
  }
  if (p.dryRun || !reached) {
    p.say("would", `${repo}: ${clone} in the container as node`);
    return true;
  }
  const cloned = nodeExec(p.io, ["git", "clone", "--quiet", url, dir]);
  if (cloned.status !== 0) {
    p.say("todo", `${repo}: ${clone} in the container failed (${answer(cloned)}): fix that, then rerun`);
    return false;
  }
  p.say("done", `${repo}: cloned ${url} into ${dir} in the container`);
  return true;
}

/** protect-main, the deploy key, GitHub's copy of it and the clone, for one repo. */
function repoStep(p: Pass, served: ServedRepo): boolean {
  const { repo } = served;
  const name = repoName(repo);
  const key = `${SSH_DIR}/deploy-${name}`;
  const url = `git@github.com-${name}:${repo}.git`;
  // Under exempt, protect-main is all that stops a write deploy key from updating the default branch.
  if (!protectMainStep(p, repo)) return false;
  const keyed = keyStep(p, repo, key);
  if (keyed === "stop") return false;
  const reached = reachStep(p, repo, key, url, keyed === "ok");
  if (reached === "stop") return false;
  return cloneStep(p, repo, cloneDir(repo), url, reached === "ok");
}

/** A stored gh login as the phase keeps it: whether its token is fine-grained, never the token. */
interface Account {
  login: string;
  state: string | undefined;
  fineGrained: boolean;
}

const AuthStatus = z.object({
  hosts: z
    .record(z.string(), z.array(z.object({ login: z.string(), state: z.string().optional(), token: z.string().optional() })))
    .nullish(),
});

/**
 * The container's github.com logins. --show-token gives the token, of which only its prefix is
 * kept; errors name the command and quote none of its output.
 */
function containerAccounts(p: Pass): Account[] {
  const args = ["gh", "auth", "status", "--json", "hosts", "--show-token"];
  const what = `${AS_NODE} ${args.join(" ")}`;
  const result = nodeExec(p.io, args);
  let data: unknown;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    if (result.status !== 0 && /not logged in/i.test(result.stderr)) return [];
    throw new Error(`${what} failed (exit ${result.status}); its output is not valid JSON`);
  }
  const parsed = AuthStatus.safeParse(data);
  if (!parsed.success) throw new Error(`${what}: the output is not a list of accounts per host`);
  return ((parsed.data.hosts ?? {})[GH_HOST] ?? []).map((a) => ({
    login: a.login,
    state: a.state,
    fineGrained: a.token?.startsWith(FINE_GRAINED) ?? false,
  }));
}

/** The served repos' owner, when they share one: the token form's resource owner. */
function sharedOwner(repos: readonly ServedRepo[]): string | undefined {
  const owners = new Set(repos.map((r) => r.repo.slice(0, r.repo.indexOf("/"))));
  return owners.size === 1 ? [...owners][0] : undefined;
}

/** What a failed wrong-sha merge tells the maintainer to do, per outcome. */
interface ProbeAdvice {
  /** Who holds the token, as the lines name it. */
  whose: string;
  /** What becomes of the token when the probe does not pass, as a clause ("it was not stored"). */
  outcome: string;
  /** The fix when the token can merge. */
  canMerge: string;
  /** The fix when the token cannot read a served repo's PRs. */
  unseen: string;
  /** With no PR to probe on, a note and the step passes, instead of a to-do. */
  noPr?: (computing: boolean) => string;
}

/**
 * The wrong-sha merge with `token` only as GH_TOKEN, on the host: true when GitHub refused it
 * with 403 (or, with `advice.noPr`, when no PR could take the probe), else a to-do with the
 * advice for what it got.
 */
function mergeRefused(p: Pass, token: string, advice: ProbeAdvice): boolean {
  const { whose, outcome } = advice;
  let verdict: MergeVerdict;
  try {
    verdict = wrongShaMerge(p.io, p.repos, { env: { GH_TOKEN: token } });
  } catch (err) {
    p.say("todo", `gh: with ${whose}, ${message(err)}, and ${outcome}: ${advice.unseen}`);
    return false;
  }
  switch (verdict.kind) {
    case "refused":
      p.say("pass", `gh: a wrong-sha merge of ${verdict.where} with ${whose} was refused with 403: it cannot merge`);
      return true;
    case "can-merge":
      p.say("todo", `gh: a wrong-sha merge of ${verdict.where} with ${whose} got ${verdict.code ?? "a success"}: the token can merge, and ${outcome}. ${advice.canMerge}`);
      return false;
    case "inconclusive":
      p.say("todo", `gh: the wrong-sha merge of ${verdict.where} with ${whose} was inconclusive (${verdict.answer}), and ${outcome}: rerun when an open PR is mergeable`);
      return false;
    case "no-pr":
      if (advice.noPr !== undefined) {
        p.say("note", advice.noPr(verdict.computing));
        return true;
      }
      p.say(
        "todo",
        verdict.computing
          ? `gh: GitHub is still computing whether the open PRs can be merged, so ${whose} could not be checked yet, and ${outcome}: rerun in a minute`
          : `gh: no served repo has an open, mergeable PR for the wrong-sha merge, so ${whose} could not be checked, and ${outcome}: open one, then rerun`,
      );
      return false;
  }
}

/**
 * The container's one fine-grained login, probed again on every run: its token must not be able
 * to merge. With no PR to probe on, it stands, as it was refused with 403 when it was pasted.
 */
function existingLoginStep(p: Pass, login: string): boolean {
  const whose = `the container's ${GH_HOST} login ${login} (its fine-grained token)`;
  const logout = `${AS_NODE} gh auth logout --hostname ${GH_HOST} --user ${login}`;
  // Read as node, where the login is stored; the token comes back on stdout and goes only to GH_TOKEN.
  const read = nodeExec(p.io, ["gh", "auth", "token", "--hostname", GH_HOST]);
  const token = read.stdout.trim();
  if (token.length >= 12) p.hidden.push(token);
  if (read.status !== 0 || token === "") {
    p.say(
      "todo",
      `gh: reading ${whose} in the container failed (${answer({ ...read, stdout: "" })}), so it could not be checked: log it out (${logout}), then rerun to paste a new token`,
    );
    return p.dryRun;
  }
  const notReprobed = `gh: the container's ${GH_HOST} login ${login} was not re-probed`;
  const refused = mergeRefused(p, token, {
    whose,
    outcome: "the phase stops here",
    canMerge: `Log it out in the container (${logout}), then rerun to paste a token with Contents read-only`,
    unseen: `the token must see every served repo; edit it at https://${GH_HOST}/settings/personal-access-tokens, then rerun`,
    noPr: (computing) =>
      computing
        ? `${notReprobed}: GitHub is still computing mergeability; rerun in a minute to re-probe`
        : `${notReprobed}: no served repo has an open, mergeable PR for the wrong-sha merge (its token was refused with 403 when it was pasted); the next container run with an open, mergeable PR probes it again`,
  });
  return refused || p.dryRun;
}

/**
 * The container's own fine-grained gh login: a pasted token is refused unless a wrong-sha merge
 * with it gets 403, and an existing login's token is probed the same way on every run.
 */
function ghStep(p: Pass): boolean {
  const name = `claude-workflow-container-${timestamp(new Date()).slice(0, 10)}`;
  const login = `gh auth login --hostname ${GH_HOST} --with-token in the container as node, the token on stdin`;
  const probe = "check that a wrong-sha merge with it is refused with 403 (it runs on the host with the token only as GH_TOKEN, and a token that can merge is never stored)";
  if (!p.live) {
    p.say(
      "would",
      `gh: if the container has one fine-grained login, read its token as node and check that a wrong-sha merge with it is refused with 403; else open the pre-filled token form (${name}), read the token at a hidden prompt, ${probe}, then ${login}`,
    );
    return true;
  }
  const accounts = containerAccounts(p);
  const only = accounts.length === 1 ? accounts[0]! : undefined;
  if (only !== undefined && only.fineGrained && only.state !== "error") return existingLoginStep(p, only.login);
  if (accounts.length > 0) {
    const shown = accounts
      .map((a) => `${a.login} (${a.fineGrained ? "fine-grained" : "not fine-grained"}${a.state === "error" ? ", refused by GitHub" : ""})`)
      .join(", ");
    p.say(
      "todo",
      `gh: the container's ${GH_HOST} logins are ${shown}, not one working fine-grained login: log them out (${AS_NODE} gh auth logout --hostname ${GH_HOST} --user <login>), then rerun to paste a new token`,
    );
    return p.dryRun;
  }
  if (p.dryRun) {
    p.say("would", `gh: open the pre-filled token form (${name}), read the token at a hidden prompt, ${probe}, then ${login}`);
    return true;
  }
  // A gh login change: no session may be live in the container while it happens.
  if (!quiet(p)) return false;

  const url = tokenFormUrl(sharedOwner(p.repos), name);
  const opened = p.io.run("open", [url]);
  if (opened.status === 0) p.say("done", `gh: opened the pre-filled token form ${url}`);
  else p.say("note", `gh: could not open the browser (${answer(opened)}): open ${url}`);
  p.say(
    "note",
    `gh: the container gets its own token, so it can be revoked alone (the host's fine-grained token is accepted too). In the form, under Repository access choose Only select repositories and select ${p.repos.map((r) => r.repo).join(", ")}; keep Contents read-only; choose an expiry; then Generate token and copy it`,
  );
  const token = p.io.readSecret("Paste the container's token (input hidden), then press Enter: ").trim();
  // Masked in later lines when it could be a token; a shorter paste is no secret.
  if (token.length >= 12) p.hidden.push(token);
  if (!token.startsWith(FINE_GRAINED)) {
    p.say("todo", "gh: no fine-grained token was pasted (one starts github_pat_): rerun and paste the token the form generated");
    return false;
  }
  const refused = mergeRefused(p, token, {
    whose: "the pasted token",
    outcome: "it was not stored",
    canMerge: `Delete it at https://${GH_HOST}/settings/personal-access-tokens, create one with Contents read-only, then rerun`,
    unseen: `the token must see every served repo; edit it at https://${GH_HOST}/settings/personal-access-tokens, then rerun and paste it again`,
  });
  if (!refused) return false;
  const loggedIn = nodeExec(p.io, ["gh", "auth", "login", "--hostname", GH_HOST, "--with-token"], { input: `${token}\n` });
  if (loggedIn.status !== 0) {
    p.say("todo", `gh: gh auth login in the container failed (${answer(loggedIn)}): rerun`);
    return false;
  }
  p.say("done", `gh: logged the container in to ${GH_HOST} with the pasted fine-grained token (as node, through stdin)`);
  return true;
}

/** ~/.claude.json: onboarding done and each clone trusted, so claude --bg starts there. */
function claudeJsonStep(p: Pass): boolean {
  const dirs = p.repos.map((r) => cloneDir(r.repo));
  const what = `trust: ${CLAUDE_JSON} with hasCompletedOnboarding and hasTrustDialogAccepted for ${dirs.join(", ")}`;
  if (!p.live) {
    p.say("would", `${what}, keeping its other keys`);
    return true;
  }
  const text = readInContainer(p.io, CLAUDE_JSON);
  let seeded: string;
  try {
    seeded = seedClaudeJson(text, dirs);
  } catch (err) {
    p.say("todo", `trust: ${CLAUDE_JSON} in the container is not a JSON object (${message(err)}): fix or remove it, then rerun`);
    return p.dryRun;
  }
  if (text !== undefined && isDeepStrictEqual(JSON.parse(text), JSON.parse(seeded))) {
    p.say("already", `${what}: in place`);
    return true;
  }
  if (p.dryRun) {
    p.say("would", `${what}: write it, keeping its other keys`);
    return true;
  }
  // Claude Code rewrites this file, so no session may be live while it is written.
  if (!quiet(p)) return false;
  const written = writeInContainer(p.io, CLAUDE_JSON, seeded);
  if (written.status !== 0) {
    p.say("todo", `trust: writing ${CLAUDE_JSON} in the container failed (${answer(written)}): fix that, then rerun`);
    return false;
  }
  p.say("done", `${what}: written, its other keys kept`);
  return true;
}

const Marketplaces = z
  .array(z.unknown())
  .transform((entries) => entries.flatMap((e) => (isObject(e) && typeof e.name === "string" ? [e.name] : [])));
/** Only this plugin's entries are validated, so a malformed entry of another plugin does not end the run. */
const Installs = z
  .array(z.unknown())
  .transform((entries) => entries.filter((e) => isObject(e) && e.id === PLUGIN))
  .pipe(z.array(z.object({ id: z.string(), scope: z.string() })));

/** A claude command in the container, as the reports name it. */
const claudeLine = (args: readonly string[]) => `docker exec ${CONTAINER} claude ${args.join(" ")}`;

function claudeRead<T extends z.ZodType>(p: Pass, schema: T, args: string[]): z.output<T> {
  const result = claudeExec(p.io, undefined, args);
  if (result.status !== 0) throw new Error(`${claudeLine(args)} failed: ${answer(result)}`);
  return parseJson(schema, result.stdout, claudeLine(args));
}

/** Runs a plugin command in the container, or lists it under --dry-run. */
function pluginCommand(p: Pass, args: string[], done: string): boolean {
  if (p.dryRun) {
    p.say("would", `plugin: ${claudeLine(args)}`);
    return true;
  }
  const result = claudeExec(p.io, undefined, args);
  if (result.status !== 0) {
    p.say("todo", `plugin: ${claudeLine(args)} failed (${answer(result)}): fix that, then rerun`);
    return false;
  }
  p.say("done", `plugin: ${done} (${claudeLine(args)})`);
  return true;
}

/**
 * The plugin at user scope, installed once and updated on every run (sessions may stay live),
 * then the marketplace's auto-update on, so a merge to main also arrives between runs.
 */
function pluginStep(p: Pass): boolean {
  if (!p.live) {
    p.say(
      "would",
      `plugin: in the container, claude plugin marketplace add ${MARKETPLACE_REPO} and claude plugin install ${PLUGIN} --scope user when they are missing, else claude plugin marketplace update ${MARKETPLACE} and claude plugin update ${PLUGIN} --scope user, on every run; then autoUpdate true on the ${MARKETPLACE} entry of extraKnownMarketplaces in ${USER_SETTINGS}`,
    );
    return true;
  }
  const listed = claudeRead(p, Marketplaces, ["plugin", "marketplace", "list", "--json"]).includes(MARKETPLACE);
  const marketplace = listed
    ? pluginCommand(p, ["plugin", "marketplace", "update", MARKETPLACE], `updated the ${MARKETPLACE} marketplace`)
    : pluginCommand(p, ["plugin", "marketplace", "add", MARKETPLACE_REPO], `added the ${MARKETPLACE} marketplace`);
  if (!marketplace) return false;
  const installed = claudeRead(p, Installs, ["plugin", "list", "--json"]).some((i) => i.scope === "user");
  const plugin = installed
    ? pluginCommand(p, ["plugin", "update", PLUGIN, "--scope", "user"], `updated ${PLUGIN}`)
    : pluginCommand(p, ["plugin", "install", PLUGIN, "--scope", "user"], `installed ${PLUGIN}`);
  return plugin && autoUpdateStep(p);
}

/** `autoUpdate: true` on the marketplace's entry in the container's user settings. */
function autoUpdateStep(p: Pass): boolean {
  const what = `plugin: autoUpdate true on the ${MARKETPLACE} entry of extraKnownMarketplaces in ${USER_SETTINGS}`;
  const text = readInContainer(p.io, USER_SETTINGS);
  let settings: JsonObject = {};
  if (text !== undefined) {
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      value = undefined;
    }
    if (!isObject(value)) {
      p.say("todo", `${what}: ${USER_SETTINGS} in the container is not a JSON object: fix it, then rerun`);
      return p.dryRun;
    }
    settings = value;
  }
  const markets = isObject(settings.extraKnownMarketplaces) ? settings.extraKnownMarketplaces : {};
  const entry = isObject(markets[MARKETPLACE]) ? markets[MARKETPLACE] : {};
  const source = isObject(entry.source) && entry.source.repo === MARKETPLACE_REPO ? entry.source : { source: "github", repo: MARKETPLACE_REPO };
  const wanted = { ...entry, source, autoUpdate: true };
  if (isDeepStrictEqual(entry, wanted)) {
    p.say("already", `${what}: in place`);
    return true;
  }
  if (p.dryRun) {
    p.say("would", what);
    return true;
  }
  const next = { ...settings, extraKnownMarketplaces: { ...markets, [MARKETPLACE]: wanted } };
  const written = writeInContainer(p.io, USER_SETTINGS, `${JSON.stringify(next, null, 2)}\n`);
  if (written.status !== 0) {
    p.say("todo", `${what}: writing ${USER_SETTINGS} in the container failed (${answer(written)}): fix that, then rerun`);
    return false;
  }
  p.say("done", what);
  return true;
}

export const container: Phase = {
  name: "container",
  run(ctx) {
    const hidden: string[] = [];
    const p: Pass = {
      ...ctx,
      hidden,
      quiesced: false,
      docker: false,
      live: false,
      say(status, text) {
        ctx.io.report(status, hidden.reduce((line, secret) => line.split(secret).join("<token>"), text));
      },
    };

    if (!distinctNames(p)) return "stop";
    p.docker = dockerStep(p);
    // Under --dry-run the steps after are still listed, as they would run once docker answers.
    if (!p.docker && !p.dryRun) return "stop";
    const env = envFileStep(p);
    if (env === "stop") return "stop";
    // --rebuild always replaces the container, so the session check comes before a long build.
    if (p.rebuild && !quiet(p)) return "stop";
    const image = imageStep(p);
    if (image === "stop") return "stop";
    if (!volumeStep(p)) return "stop";
    if (!containerStep(p, env, image)) return "stop";
    if (!identityStep(p)) return "stop";
    if (!sshStep(p)) return "stop";
    for (const served of p.repos) {
      if (!repoStep(p, served)) return "stop";
    }
    if (!ghStep(p)) return "stop";
    if (!claudeJsonStep(p)) return "stop";
    return pluginStep(p) ? "ok" : "stop";
  },
};
