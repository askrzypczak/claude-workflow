// Tests for dispatch/launchd/job.ts on the fake SetupIo's docker world. Calls the world has no
// script for (colima, git rev-parse/fetch/checkout, npm ci, pkill and the poller run) are answered
// through its `respond` hook.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MARKETPLACE, PLUGIN } from "../setup/container.ts";
import { COLIMA_ARGS, CONTAINER, FAILED_LINE, READY_LINE } from "../setup/docker.ts";
import { FAKE_HOME, fakeIo, parseDockerExec } from "../setup/fake-io.ts";
import type { FakeCall, FakeDocker, FakeExec, FakeWorld } from "../setup/fake-io.ts";
import type { RunResult } from "../setup/io.ts";
import { deps, halt, poll } from "./job.ts";
import type { JobContext } from "./job.ts";

/** The container's clone of this repo: the fake host clone's origin is example-owner/example-tools. */
const CLONE_DIR = "/home/node/example-tools";
const HOST_CONFIG = `${FAKE_HOME}/.config/claude-workflow/repos.json`;
const CONTAINER_CONFIG = "/home/node/.config/claude-workflow/repos.json";
const CONFIG = JSON.stringify([
  { repo: "example-owner/example-app", dir: "/home/node/example-app", sessionPrefix: "app", owner: "example-owner" },
]);
const SHA = "0123456789abcdef0123456789abcdef01234567";

const ok = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });
const failed = (stderr: string, status = 1): RunResult => ({ status, stdout: "", stderr: `${stderr}\n` });

/** The command a call runs in the container, or undefined for any other call. */
const execOf = (call: FakeCall): FakeExec | undefined => parseDockerExec(call);
const isPollerRun = (call: FakeCall) => execOf(call)?.command.some((a) => a.includes("dispatch/agent-poller.sh")) === true;
const commandStarts = (call: FakeCall, ...words: string[]) => {
  const command = execOf(call)?.command ?? [];
  return words.every((w, i) => command[i] === w);
};

/** A running, ready container with the plugin installed. */
const readyDocker = (overrides: Partial<FakeDocker> = {}): FakeDocker => ({
  container: { state: "running" },
  marketplaces: [MARKETPLACE],
  plugins: [{ id: PLUGIN, scope: "user", installPath: "/home/node/.claude/plugins/cache/example/1.0.0", version: "1.0.0" }],
  clones: { [CLONE_DIR]: "git@github.com-example-tools:example-owner/example-tools.git" },
  ...overrides,
});

interface Setup {
  docker?: FakeDocker;
  env?: Record<string, string>;
  files?: Record<string, string>;
  /** The poller run's result. Default exit 0 with one line. */
  poller?: RunResult;
  /** Answers before the defaults below; undefined falls through. */
  respond?: (call: FakeCall) => RunResult | undefined;
}

function setup(s: Setup = {}) {
  const world: FakeWorld = {
    docker: s.docker ?? readyDocker(),
    env: s.env ?? {},
    files: s.files ?? { [HOST_CONFIG]: CONFIG },
    respond: (call) => {
      const own = s.respond?.(call);
      if (own) return own;
      if (isPollerRun(call)) return s.poller ?? ok("2026-10-31 10:00:00 [app] polled\n2026-10-31 10:00:01 done\n");
      return undefined;
    },
  };
  const fake = fakeIo(world);
  const ctx: JobContext = { io: fake.io, clone: "/clone", home: FAKE_HOME };
  return { ...fake, world, ctx };
}

let printed: string[];
beforeEach(() => {
  printed = [];
  const keep = (...args: unknown[]) => void printed.push(args.map(String).join(" "));
  vi.spyOn(console, "log").mockImplementation(keep);
  vi.spyOn(console, "error").mockImplementation(keep);
  const write = (chunk: unknown) => (printed.push(String(chunk)), true);
  vi.spyOn(process.stdout, "write").mockImplementation(write as typeof process.stdout.write);
  vi.spyOn(process.stderr, "write").mockImplementation(write as typeof process.stderr.write);
});
afterEach(() => vi.restoreAllMocks());

const output = () => printed.join("\n");
const indexOf = (calls: readonly FakeCall[], match: (call: FakeCall) => boolean) => calls.findIndex(match);
const isMarketplaceUpdate = (c: FakeCall) => commandStarts(c, "claude", "plugin", "marketplace", "update", MARKETPLACE);
const isPluginUpdate = (c: FakeCall) => commandStarts(c, "claude", "plugin", "update", PLUGIN);
const isColima = (c: FakeCall) => c.cmd === "colima";
const isDockerStart = (c: FakeCall) => c.cmd === "docker" && (c.args[0] === "start" || (c.args[0] === "container" && c.args[1] === "start"));

describe("poll", () => {
  it("updates the marketplace, then the plugin, in the container before the poll", () => {
    const { ctx, calls } = setup();

    expect(poll(ctx, { dryRun: false })).toBe(0);
    const market = indexOf(calls, isMarketplaceUpdate);
    const plugin = indexOf(calls, isPluginUpdate);
    const poller = indexOf(calls, isPollerRun);
    expect(market, calls.map((c) => c.args.join(" ")).join("\n")).toBeGreaterThanOrEqual(0);
    expect(plugin).toBeGreaterThan(market);
    expect(poller).toBeGreaterThan(plugin);
  });

  it("a failed plugin update is logged and the poll still runs", () => {
    const { ctx, calls } = setup({
      respond: (call) => (isPluginUpdate(call) ? failed("example plugin update failure") : undefined),
    });

    expect(poll(ctx, { dryRun: false })).toBe(0);
    expect(output()).toContain("example plugin update failure");
    expect(calls.some(isPollerRun)).toBe(true);
  });

  it("a dry run starts neither Colima nor the container and updates no plugin", () => {
    // Docker does not answer: the dry run starts nothing and exits 1.
    const down = setup({ docker: readyDocker({ reachable: false }) });
    expect(poll(down.ctx, { dryRun: true })).toBe(1);
    expect(down.calls.some(isColima)).toBe(false);
    expect(down.calls.some(isPollerRun)).toBe(false);

    // The container is stopped: the dry run leaves it stopped and exits 1.
    const stopped = setup({ docker: readyDocker({ container: { state: "stopped" } }) });
    expect(poll(stopped.ctx, { dryRun: true })).toBe(1);
    expect(stopped.calls.some(isDockerStart)).toBe(false);
    expect(stopped.docker.container()?.state).toBe("stopped");
    expect(stopped.calls.some(isPollerRun)).toBe(false);

    // The container runs: the dry run lists the two plugin commands, runs neither, and polls with --dry-run.
    printed = [];
    const running = setup();
    expect(poll(running.ctx, { dryRun: true })).toBe(0);
    expect(running.calls.some(isColima)).toBe(false);
    expect(running.calls.some(isDockerStart)).toBe(false);
    expect(running.calls.some(isMarketplaceUpdate)).toBe(false);
    expect(running.calls.some(isPluginUpdate)).toBe(false);
    expect(output()).toContain(`claude plugin marketplace update ${MARKETPLACE}`);
    expect(output()).toContain(`claude plugin update ${PLUGIN}`);
    const pollerRun = running.calls.find(isPollerRun);
    expect(execOf(pollerRun!)?.command).toContain("--dry-run");
  });

  it("starts Colima with no host mount when docker does not answer, then polls", () => {
    const docker = readyDocker({ reachable: false });
    const { ctx, calls } = setup({
      docker,
      respond: (call) => {
        if (!isColima(call)) return undefined;
        docker.reachable = true;
        return ok();
      },
    });

    expect(poll(ctx, { dryRun: false })).toBe(0);
    const colima = calls.filter(isColima);
    expect(colima).toHaveLength(1);
    expect(colima[0]!.args).toEqual([...COLIMA_ARGS]);
    const mount = colima[0]!.args.indexOf("--mount");
    expect(colima[0]!.args[0]).toBe("start");
    expect(colima[0]!.args[mount + 1]).toBe("none");
    expect(indexOf(calls, isPollerRun)).toBeGreaterThan(indexOf(calls, isColima));
  });

  it("starts a stopped container with docker start and waits for its latest start's readiness line", () => {
    // An earlier start failed its firewall; the start the job makes logs the readiness line.
    const { ctx, calls, docker, polls } = setup({
      docker: readyDocker({ container: { state: "stopped", log: [FAILED_LINE] }, startLog: [READY_LINE] }),
    });

    expect(poll(ctx, { dryRun: false })).toBe(0);
    const start = indexOf(calls, isDockerStart);
    expect(start).toBeGreaterThanOrEqual(0);
    expect(calls[start]!.args.at(-1)).toBe(CONTAINER);
    expect(docker.container()?.state).toBe("running");
    const startedAt = docker.container()!.startedAt;
    const readLatest = calls.findIndex(
      (c, i) => i > start && c.cmd === "docker" && c.args[0] === "logs" && c.args.includes(startedAt),
    );
    expect(readLatest).toBeGreaterThan(start);
    expect(polls.length).toBeGreaterThan(0);
    expect(indexOf(calls, isPollerRun)).toBeGreaterThan(readLatest);
  });

  it("does not poll when the latest start logged the firewall failure line", () => {
    // An earlier start was ready; the start the job makes fails its firewall.
    const { ctx, calls } = setup({
      docker: readyDocker({ container: { state: "stopped", log: [READY_LINE] }, startLog: [FAILED_LINE] }),
    });

    expect(poll(ctx, { dryRun: false })).toBe(1);
    expect(calls.some(isPollerRun)).toBe(false);
    expect(calls.some(isPluginUpdate)).toBe(false);
    expect(output()).toMatch(/firewall/i);
  });

  it("exits 1 naming the container phase when there is no container", () => {
    const { ctx, calls } = setup({ docker: { marketplaces: [MARKETPLACE] } });

    expect(poll(ctx, { dryRun: false })).toBe(1);
    expect(output()).toContain("setup-agents.sh container");
    expect(calls.some(isPollerRun)).toBe(false);
    expect(calls.some(isColima)).toBe(false);
  });

  it("copies the host's dispatch config into the container before the poll", () => {
    // The default place.
    const seen: (string | undefined)[] = [];
    const first = setup({
      respond: (call) => {
        if (isPollerRun(call)) seen.push(first.docker.file(CONTAINER_CONFIG));
        return undefined;
      },
    });
    expect(poll(first.ctx, { dryRun: false })).toBe(0);
    expect(seen).toEqual([CONFIG]);

    // CLAUDE_WORKFLOW_CONFIG names another file.
    const other = JSON.stringify([]);
    const second = setup({
      env: { CLAUDE_WORKFLOW_CONFIG: "/srv/example/dispatch.json" },
      files: { "/srv/example/dispatch.json": other, [HOST_CONFIG]: CONFIG },
    });
    expect(poll(second.ctx, { dryRun: false })).toBe(0);
    expect(second.docker.file(CONTAINER_CONFIG)).toBe(other);

    // No config on the host: no poll.
    const third = setup({ files: {} });
    expect(poll(third.ctx, { dryRun: false })).toBe(1);
    expect(third.calls.some(isPollerRun)).toBe(false);
  });

  it("runs dispatch/agent-poller.sh as node in the container's clone of this repo and returns its status", () => {
    const { ctx, calls } = setup({ poller: { status: 3, stdout: "2026-10-31 10:00:00 example poller line\n", stderr: "" } });

    expect(poll(ctx, { dryRun: false })).toBe(3);
    const runs = calls.filter(isPollerRun).map((c) => execOf(c)!);
    expect(runs).toHaveLength(1);
    expect(runs[0]!.user).toBe("node");
    expect(runs[0]!.workdir).toBe(CLONE_DIR);
    expect(runs[0]!.container).toBe(CONTAINER);
    expect(runs[0]!.command).not.toContain("--dry-run");
    expect(output()).toContain("example poller line");
  });

  it("passes CLAUDE_MAX_SESSIONS to the poller only when the job has it", () => {
    const withIt = setup({ env: { CLAUDE_MAX_SESSIONS: "3" } });
    expect(poll(withIt.ctx, { dryRun: false })).toBe(0);
    const given = execOf(withIt.calls.find(isPollerRun)!)!;
    expect(given.env).toContain("CLAUDE_MAX_SESSIONS=3");

    const without = setup();
    expect(poll(without.ctx, { dryRun: false })).toBe(0);
    const none = execOf(without.calls.find(isPollerRun)!)!;
    expect(none.env.some((kv) => kv.startsWith("CLAUDE_MAX_SESSIONS="))).toBe(false);
    expect(none.command.some((a) => a.includes("CLAUDE_MAX_SESSIONS"))).toBe(false);
  });
});

/** Answers the host's `git rev-parse` with SHA and the container clone's git calls; `onOrigin` false makes SHA unknown there. */
const gitWorld = (opts: { onOrigin: boolean }) => (call: FakeCall): RunResult | undefined => {
  if (call.cmd === "git" && call.args.includes("rev-parse")) return ok(`${SHA}\n`);
  const x = execOf(call);
  if (x?.command[0] === "git") {
    const args = x.command.slice(1);
    if (!opts.onOrigin && args.some((a) => a.includes(SHA))) return failed(`fatal: bad object ${SHA}`, 128);
    if (args.includes("fetch")) return ok();
    if (args.includes("status")) return ok("");
    if (args.includes("rev-parse")) return ok(`${SHA}\n`);
    return ok();
  }
  if (x?.command[0] === "npm") return ok("added 3 packages\n");
  return undefined;
};

/** Whether a container call runs in the container's clone of this repo. */
const inClone = (x: FakeExec) => x.workdir === CLONE_DIR || x.command.join(" ").includes(`-C ${CLONE_DIR}`);

describe("deps", () => {
  it("deps checks out the host clone's commit in the container's clone, then runs npm ci there as node", () => {
    const { ctx, calls } = setup({ respond: gitWorld({ onOrigin: true }) });

    expect(deps(ctx)).toBe(0);
    const inContainer = calls.map((c, i) => ({ i, x: execOf(c) })).filter((e) => e.x !== undefined) as { i: number; x: FakeExec }[];
    const fetch = inContainer.find((e) => e.x.command[0] === "git" && e.x.command.includes("fetch"));
    const checkout = inContainer.find(
      (e) => e.x.command[0] === "git" && e.x.command.includes("checkout") && e.x.command.includes("--detach") && e.x.command.includes(SHA),
    );
    const npm = inContainer.find((e) => e.x.command[0] === "npm" && e.x.command[1] === "ci");
    expect(fetch, "git fetch in the container").toBeDefined();
    expect(checkout, "git checkout --detach <sha> in the container").toBeDefined();
    expect(npm, "npm ci in the container").toBeDefined();
    expect(fetch!.i).toBeLessThan(checkout!.i);
    expect(checkout!.i).toBeLessThan(npm!.i);
    for (const step of [fetch!, checkout!, npm!]) {
      expect(step.x.user).toBe("node");
      expect(inClone(step.x)).toBe(true);
    }
    expect(npm!.x.workdir).toBe(CLONE_DIR);
  });

  it("deps exits 1 when the host clone's commit is not on origin", () => {
    const { ctx, calls } = setup({ respond: gitWorld({ onOrigin: false }) });

    expect(deps(ctx)).toBe(1);
    expect(calls.some((c) => execOf(c)?.command[0] === "npm")).toBe(false);
    expect(output()).toMatch(/push/i);
  });
});

describe("halt", () => {
  it("halt ends a poll running in the container and lists each live session's stop command by id", () => {
    const { ctx, calls } = setup({
      docker: readyDocker({
        sessions: [
          { id: "fake-live-1", name: "app-3", state: "working", startedAt: 1 },
          { id: "fake-live-2", name: "app-4", state: "waiting", startedAt: 2 },
          { id: "fake-ended-3", name: "app-5", state: "done", startedAt: 3 },
        ],
      }),
      respond: (call) => (execOf(call)?.command[0] === "pkill" ? ok() : undefined),
    });

    expect(halt(ctx)).toBe(0);
    const pkill = calls.map(execOf).filter((x) => x?.command[0] === "pkill");
    expect(pkill).toHaveLength(1);
    expect(pkill[0]!.user).toBe("node");
    expect(pkill[0]!.command).toEqual(["pkill", "-f", `${CLONE_DIR}/dispatch/poller/main.ts`]);
    expect(output()).toContain(`docker exec ${CONTAINER} claude stop fake-live-1`);
    expect(output()).toContain(`docker exec ${CONTAINER} claude stop fake-live-2`);
    expect(output()).not.toContain("fake-ended-3");
    // Halt lists sessions; it stops none.
    expect(calls.some((c) => commandStarts(c, "claude", "stop"))).toBe(false);
  });

  it("halt says no container session can be live when docker does not answer", () => {
    const { ctx, calls } = setup({ docker: readyDocker({ reachable: false }) });

    halt(ctx);
    expect(output()).toMatch(/session/i);
    expect(output()).toMatch(/live/i);
    expect(output()).not.toMatch(/claude stop/);
    expect(calls.some(isColima)).toBe(false);
    expect(calls.some(isDockerStart)).toBe(false);
  });
});
