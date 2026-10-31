// The LaunchAgent's job, run by dispatch/launchd/job.sh: node dispatch/launchd/job.ts [--dry-run] | deps | halt
// It reaches the agent container only through dispatch/setup/docker.ts on SetupIo.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, posix, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { ENDED } from "../poller/decide.ts";
import { log } from "../poller/io.ts";
import { MARKETPLACE, PLUGIN } from "../setup/container.ts";
import {
  claudeExec,
  cloneDir,
  COLIMA_ARGS,
  CONTAINER,
  CONTAINER_HOME,
  containerSessions,
  containerState,
  nodeExec,
  waitReady,
  writeInContainer,
} from "../setup/docker.ts";
import { createIo } from "../setup/io.ts";
import type { RunResult, SetupIo } from "../setup/io.ts";
import { parseRemote } from "../setup/repos.ts";

export interface JobContext {
  io: SetupIo;
  /** The host clone of this repo. */
  clone: string;
  /** The host home directory. */
  home: string;
}

const COLIMA_START = `colima ${COLIMA_ARGS.join(" ")}`;
/** How long a start may take to log its readiness line. */
const READY_TIMEOUT_MS = 3 * 60 * 1000;
/** Where the poller in the container reads its config: its default under node's home. */
const CONTAINER_CONFIG = `${CONTAINER_HOME}/.config/claude-workflow/repos.json`;
/** The poller's entrypoint, run from the clone with its stderr merged into stdout. */
const POLLER = 'exec dispatch/agent-poller.sh "$@" 2>&1';
/**
 * The poller's process in the container, as `pkill -f` matches it: agent-poller.sh runs node on
 * this absolute path, so a session's own run of the poller in a worktree of the clone never matches.
 */
const pollerProcess = (clone: string) => `${clone}/dispatch/poller/main.ts`;
const INSTALL = "dispatch/install-launchd.sh install";
const USAGE = `Usage: dispatch/launchd/job.sh [--dry-run] | deps | halt
  (none)     one poll: Colima and the agent container up and ready, the plugin updated, the dispatch
             config copied in, then dispatch/agent-poller.sh in the container's clone of this repo.
  --dry-run  the same poll with --dry-run: starts neither Colima nor the container, updates no plugin
             and launches nothing; it refreshes the container's copy of the dispatch config.
  deps       check out this clone's commit in the container's clone of this repo and run npm ci there.
  halt       end a poll running in the container and list its live sessions with their stop commands.`;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const lines = (text: string) => text.split("\n").map((l) => l.trim()).filter((l) => l !== "");

/** The first line of stderr, else of stdout, else the exit status. */
function answer(result: RunResult): string {
  return lines(result.stderr)[0] ?? lines(result.stdout)[0] ?? `exit ${result.status}`;
}

/** A command's output, passed through to the log. */
function pass(result: RunResult): void {
  if (result.stdout !== "") process.stdout.write(result.stdout);
  if (result.stderr !== "") process.stderr.write(result.stderr);
}

/** Runs a step, logging a throw as its failure. */
function guarded(what: string, step: () => number): number {
  try {
    return step();
  } catch (err) {
    log(`${what} failed: ${message(err)}`);
    return 1;
  }
}

/** The container's clone of this repo, named by the host clone's origin. */
function containerClone(ctx: JobContext): string {
  const origin = ctx.io.run("git", ["-C", ctx.clone, "remote", "get-url", "origin"]);
  if (origin.status !== 0) throw new Error(`cannot read the origin remote of ${ctx.clone} (${answer(origin)})`);
  const url = origin.stdout.trim();
  const repo = parseRemote(url);
  if (repo === undefined) throw new Error(`origin remote '${url}' of ${ctx.clone} is not a github.com repo`);
  return cloneDir(repo);
}

/**
 * Colima and the container running and the container's latest start ready; false, logged, when
 * not. Only a real run starts either.
 */
function bringUp(io: SetupIo, opts: { dryRun: boolean }): boolean {
  let state = containerState(io);
  if (state.kind === "no-docker") {
    if (opts.dryRun) {
      log(`docker does not answer (${state.detail}); a dry run starts nothing: start Colima with ${COLIMA_START}`);
      return false;
    }
    const started = io.run("colima", [...COLIMA_ARGS]);
    if (started.status !== 0) {
      // Colima logs its progress first, so its last line says why it stopped.
      const why = lines(started.stderr).pop() ?? lines(started.stdout).pop() ?? `exit ${started.status}`;
      log(`${COLIMA_START} failed (${why})`);
      return false;
    }
    log(`started Colima (${COLIMA_START})`);
    state = containerState(io);
    if (state.kind === "no-docker") {
      log(`docker still does not answer after ${COLIMA_START} (${state.detail})`);
      return false;
    }
  }
  if (state.kind === "absent") {
    log(`there is no container ${CONTAINER}: run dispatch/setup-agents.sh container`);
    return false;
  }
  if (state.kind === "stopped") {
    if (opts.dryRun) {
      log(`${CONTAINER} is stopped; a dry run starts nothing: start it with docker start ${CONTAINER}`);
      return false;
    }
    // The container keeps its run flags and env file. A start whose firewall fails exits non-zero;
    // the start's own log lines then give the reason, read below.
    const started = io.run("docker", ["start", CONTAINER]);
    log(started.status === 0 ? `started ${CONTAINER}` : `docker start ${CONTAINER} failed (${answer(started)})`);
  }
  const ready = waitReady(io, READY_TIMEOUT_MS);
  if (!ready.ready) {
    log(`${CONTAINER} is not ready: ${ready.detail}`);
    return false;
  }
  return true;
}

/** The marketplace, then the plugin, updated in the container; a dry run lists the two commands. */
function updatePlugin(io: SetupIo, opts: { dryRun: boolean }): void {
  const steps = [
    ["plugin", "marketplace", "update", MARKETPLACE],
    ["plugin", "update", PLUGIN, "--scope", "user"],
  ];
  for (const args of steps) {
    const shown = `docker exec ${CONTAINER} claude ${args.join(" ")}`;
    if (opts.dryRun) {
      log(`[dry-run] ${shown}`);
      continue;
    }
    const result = claudeExec(io, undefined, args);
    if (result.status !== 0) {
      log(`${shown} failed (${answer(result)}); polling with the installed plugin`);
      return;
    }
    log(`${shown}: ${lines(result.stdout)[0] ?? "done"}`);
  }
}

/** The host's dispatch config, copied to the poller's default path in the container. */
function copyConfig(ctx: JobContext): boolean {
  const path = ctx.io.env("CLAUDE_WORKFLOW_CONFIG") || join(ctx.home, ".config/claude-workflow/repos.json");
  const text = ctx.io.readFile(path);
  if (text === undefined) {
    log(`no dispatch config at ${path}: copy dispatch/repos.example.json there and edit it`);
    return false;
  }
  const made = nodeExec(ctx.io, ["mkdir", "-p", posix.dirname(CONTAINER_CONFIG)]);
  const written = made.status === 0 ? writeInContainer(ctx.io, CONTAINER_CONFIG, text) : made;
  if (written.status !== 0) {
    log(`copying ${path} to ${CONTAINER_CONFIG} in the container failed (${answer(written)})`);
    return false;
  }
  log(`copied ${path} into the container (${CONTAINER_CONFIG})`);
  return true;
}

/** One poll: Colima and the container up and ready, the plugin updated, the config copied in, then the poller. */
export function poll(ctx: JobContext, opts: { dryRun: boolean }): number {
  return guarded("the poll", () => {
    const clone = containerClone(ctx);
    if (!bringUp(ctx.io, opts)) return 1;
    updatePlugin(ctx.io, opts);
    if (!copyConfig(ctx)) return 1;
    // launchd's EnvironmentVariables reach the job; of the poller's settings, only this one goes on.
    const max = ctx.io.env("CLAUDE_MAX_SESSIONS");
    const result = nodeExec(ctx.io, ["sh", "-c", POLLER, "sh", ...(opts.dryRun ? ["--dry-run"] : [])], {
      cwd: clone,
      ...(max === undefined ? {} : { env: { CLAUDE_MAX_SESSIONS: max } }),
    });
    pass(result);
    return result.status;
  });
}

/** Install's step: the container's clone of this repo at the host clone's commit, with npm ci run there. */
export function deps(ctx: JobContext): number {
  return guarded("deps", () => {
    const head = ctx.io.run("git", ["-C", ctx.clone, "rev-parse", "HEAD"]);
    if (head.status !== 0) {
      log(`cannot read the commit of ${ctx.clone} (${answer(head)})`);
      return 1;
    }
    const sha = head.stdout.trim();
    const clone = containerClone(ctx);
    if (!bringUp(ctx.io, { dryRun: false })) return 1;
    const inClone = (args: string[]) => nodeExec(ctx.io, args, { cwd: clone });
    const asNode = `docker exec -u node -w ${clone} ${CONTAINER}`;
    const rerun = `then rerun ${INSTALL}`;

    const fetched = inClone(["git", "fetch", "origin"]);
    if (fetched.status !== 0) {
      log(`git fetch origin in ${clone} failed (${answer(fetched)}): rerun dispatch/setup-agents.sh container, ${rerun}`);
      return 1;
    }
    const known = inClone(["git", "cat-file", "-e", `${sha}^{commit}`]);
    if (known.status !== 0) {
      log(`commit ${sha} of ${ctx.clone} is not on origin, so ${clone} cannot check it out: push it, ${rerun}`);
      return 1;
    }
    const status = inClone(["git", "status", "--porcelain", "--untracked-files=no"]);
    if (status.status !== 0) {
      log(`git status in ${clone} failed (${answer(status)}): see ${asNode} git status, ${rerun}`);
      return 1;
    }
    if (status.stdout.trim() !== "") {
      log(`${clone} in the container has local changes, so it was left as it is: see them with ${asNode} git status, commit, stash or discard them there, ${rerun}`);
      return 1;
    }
    const checkout = inClone(["git", "checkout", "--detach", sha]);
    if (checkout.status !== 0) {
      log(`git checkout --detach ${sha} in ${clone} failed (${answer(checkout)}): fix it with ${asNode} git, ${rerun}`);
      return 1;
    }
    log(`checked out ${sha} in ${clone}`);
    const npm = inClone(["npm", "ci"]);
    pass(npm);
    if (npm.status !== 0) {
      log(`npm ci in ${clone} failed (${answer(npm)}): fix it with ${asNode} npm ci, ${rerun}`);
      return 1;
    }
    return 0;
  });
}

/** Pause's and uninstall's step: ends a poll running in the container and lists its live sessions. */
export function halt(ctx: JobContext): number {
  return guarded("halt", () => {
    const io = ctx.io;
    const state = containerState(io);
    if (state.kind !== "running") {
      const why =
        state.kind === "no-docker" ? `docker does not answer (${state.detail})`
        : state.kind === "absent" ? `there is no container ${CONTAINER}`
        : `${CONTAINER} is stopped`;
      log(`${why}, so no poll runs in the container and no container session can be live`);
      return 0;
    }
    // Nothing runs in a started container before its readiness line: one still starting holds no poll or session.
    if (!waitReady(io, 0).ready) {
      log(`${CONTAINER} has not logged its readiness line yet, so no poll runs in it and no container session can be live`);
      return 0;
    }

    let status = 0;
    // launchd's bootout ends the host job, not the poll it started in the container.
    const clone = containerClone(ctx);
    const poller = pollerProcess(clone);
    const killed = nodeExec(io, ["pkill", "-f", poller]);
    if (killed.status === 0) log("ended the poll running in the container");
    else if (killed.status === 1) log("no poll was running in the container");
    else {
      log(`pkill -f ${poller} in the container failed (${answer(killed)}): run docker exec -u node ${CONTAINER} pkill -f ${poller}`);
      status = 1;
    }

    const live = (containerSessions(io) ?? []).filter((s) => !ENDED.includes(s.state));
    if (live.length === 0) {
      log("no container session is live");
      return status;
    }
    log("container sessions still running (stop each you want gone):");
    for (const s of live) {
      const shown = `${s.name ?? "an unnamed session"} (${s.state})`;
      console.log(
        s.id === undefined
          ? `  ${shown}: it has no id; stop it from the agent view, docker exec -it -w ${clone} ${CONTAINER} claude agents`
          : `  ${shown}: docker exec ${CONTAINER} claude stop ${s.id}`,
      );
    }
    return status;
  });
}

/** `[--dry-run] | deps | halt`; 2 on a usage error. */
export function runJob(argv: readonly string[], ctx: JobContext): number {
  if (argv.length <= 1) {
    switch (argv[0]) {
      case undefined:
        return poll(ctx, { dryRun: false });
      case "--dry-run":
        return poll(ctx, { dryRun: true });
      case "deps":
        return deps(ctx);
      case "halt":
        return halt(ctx);
    }
  }
  console.error(USAGE);
  return 2;
}

const self = fileURLToPath(import.meta.url);

/** True when node was started on this file, so importing it runs nothing. */
function isEntry(): boolean {
  const arg = process.argv[1];
  if (arg === undefined) return false;
  try {
    return realpathSync(arg) === realpathSync(self);
  } catch {
    return false;
  }
}

if (isEntry()) {
  process.exitCode = runJob(process.argv.slice(2), {
    io: createIo(),
    clone: resolve(dirname(self), "../.."),
    home: homedir(),
  });
}
