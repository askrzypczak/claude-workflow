// The poll's Claude Code update on the fake SetupIo's docker world: npm's stable dist-tag, the
// container's `claude --version` and the poller run are answered through its `respond` hook.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_FILE, MARKETPLACE, PLUGIN } from "../setup/container.ts";
import { CONFIG_LABEL, FAILED_LINE } from "../setup/docker.ts";
import { FAKE_HOME, fakeIo, parseDockerExec } from "../setup/fake-io.ts";
import type { FakeCall, FakeDocker, FakeWorld } from "../setup/fake-io.ts";
import type { RunResult } from "../setup/io.ts";
import type { Session } from "../poller/schemas.ts";
import { poll } from "./job.ts";
import type { JobContext } from "./job.ts";

/** The container's clone of this repo: the fake host clone's origin is example-owner/example-tools. */
const CLONE_DIR = "/home/node/example-tools";
const HOST_CONFIG = `${FAKE_HOME}/.config/claude-workflow/repos.json`;
const ENV_PATH = `${FAKE_HOME}/${ENV_FILE}`;
const CONFIG = JSON.stringify([
  { repo: "example-owner/example-app", dir: "/home/node/example-app", sessionPrefix: "app", owner: "example-owner" },
]);
const OLD_IMAGE = `sha256:${"3".repeat(64)}`;
const NEW_IMAGE = `sha256:${"4".repeat(64)}`;
const OLD_LABEL = "example-config-digest";
const KEY_PATH = "/home/node/.ssh/deploy-example-tools";
const KEY_TEXT = "example deploy key\n";

const ok = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });
const failed = (stderr: string, status = 1): RunResult => ({ status, stdout: "", stderr: `${stderr}\n` });

const isDocker = (c: FakeCall, sub: string) => c.cmd === "docker" && c.args[0] === sub;
const isNpmView = (c: FakeCall) => c.cmd === "npm" && c.args.includes("view") && c.args.includes("dist-tags.stable");
const inContainer = (c: FakeCall) => parseDockerExec(c)?.command ?? [];
const isVersion = (c: FakeCall) => {
  const command = inContainer(c);
  return command[0] === "claude" && command[1] === "--version";
};
const isAgentsList = (c: FakeCall) => {
  const command = inContainer(c);
  return command[0] === "claude" && command[1] === "agents";
};
const isPollerRun = (c: FakeCall) => inContainer(c).some((a) => a.includes("dispatch/agent-poller.sh"));
/** The calls that stop, remove or create the container. */
const replacing = (calls: readonly FakeCall[]) => calls.filter((c) => isDocker(c, "stop") || isDocker(c, "rm") || isDocker(c, "run"));
/** The values given to a flag, in `--flag value` or `--flag=value` form. */
const optValues = (args: readonly string[], flags: readonly string[]) =>
  args.flatMap((a, i) => {
    for (const f of flags) {
      if (a === f) return [args[i + 1] ?? ""];
      if (a.startsWith(`${f}=`)) return [a.slice(f.length + 1)];
    }
    return [];
  });

interface Setup {
  /** What npm's stable dist-tag names, or the failed npm view. */
  stable: string | RunResult;
  /** What `claude --version` in the container prints for its release, or the failed call. */
  installed: string | RunResult;
  docker?: Partial<FakeDocker>;
  /** Answers before the defaults; undefined falls through. */
  respond?: (call: FakeCall) => RunResult | undefined;
}

function setup(s: Setup) {
  const world: FakeWorld = {
    docker: {
      buildId: NEW_IMAGE,
      container: { state: "running", image: OLD_IMAGE, labels: { [CONFIG_LABEL]: OLD_LABEL } },
      marketplaces: [MARKETPLACE],
      plugins: [{ id: PLUGIN, scope: "user", installPath: "/home/node/.claude/plugins/cache/example/1.0.0", version: "1.0.0" }],
      clones: { [CLONE_DIR]: "git@github.com-example-tools:example-owner/example-tools.git" },
      files: { [KEY_PATH]: KEY_TEXT },
      ...s.docker,
    },
    env: {},
    files: { [HOST_CONFIG]: CONFIG, [ENV_PATH]: "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fake-token-for-tests\n" },
    respond: (call) => {
      const own = s.respond?.(call);
      if (own) return own;
      if (isNpmView(call)) return typeof s.stable === "string" ? ok(`${s.stable}\n`) : s.stable;
      if (isVersion(call)) return typeof s.installed === "string" ? ok(`${s.installed} (Claude Code)\n`) : s.installed;
      if (isPollerRun(call)) return ok("2026-11-12 10:00:00 [app] polled\n");
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
/** Every printed line, without the log's timestamp. */
const logLines = () =>
  printed.flatMap((p) => p.split("\n")).map((l) => l.replace(/^\d{4}-\d\d-\d\d \d\d:\d\d:\d\d /, "")).filter((l) => l !== "");

describe("poll's Claude Code update", () => {
  it("a newer stable Claude Code with no live container session rebuilds the image with that version, replaces the container on the home volume with its config label, then polls", () => {
    const { ctx, calls, docker } = setup({ stable: "2.1.100", installed: "2.1.99" });

    expect(poll(ctx, { dryRun: false })).toBe(0);
    expect(docker.builds).toEqual([
      ["build", "--build-arg", "CLAUDE_CODE_VERSION=2.1.100", "-t", "claude-workflow-agent", "/clone/dispatch/container"],
    ]);
    const build = calls.findIndex((c) => isDocker(c, "build"));
    const stop = calls.findIndex((c) => isDocker(c, "stop"));
    const rm = calls.findIndex((c) => isDocker(c, "rm"));
    const run = calls.findIndex((c) => isDocker(c, "run"));
    const poller = calls.findIndex(isPollerRun);
    expect(build).toBeGreaterThanOrEqual(0);
    expect(stop).toBeGreaterThan(build);
    expect(rm).toBeGreaterThan(stop);
    expect(run).toBeGreaterThan(rm);
    expect(poller).toBeGreaterThan(run);
    expect(calls.filter((c) => isDocker(c, "run"))).toHaveLength(1);

    const args = calls[run]!.args;
    expect(optValues(args, ["-v", "--volume"])).toEqual(["claude-workflow-home:/home/node"]);
    expect(optValues(args, ["--env-file"])).toEqual([ENV_PATH]);
    expect(optValues(args, ["--label", "-l"])).toEqual([`${CONFIG_LABEL}=${OLD_LABEL}`]);

    const now = docker.container();
    expect(now?.state).toBe("running");
    expect(now?.image).toBe(NEW_IMAGE);
    expect(now?.labels[CONFIG_LABEL]).toBe(OLD_LABEL);
    expect(now?.mounts.map((m) => `${m.type} ${m.name} ${m.destination}`)).toEqual(["volume claude-workflow-home /home/node"]);
    expect(docker.file(KEY_PATH)).toBe(KEY_TEXT);
    expect(logLines().some((l) => l.includes("2.1.100") && l.includes("2.1.99"))).toBe(true);
  });

  it("a newer stable Claude Code with a live container session is not rebuilt, and one log line names both versions and the live sessions", () => {
    const sessions: Session[] = [
      { id: "fake-live-1", name: "tools-12", state: "running", startedAt: 1 },
      { id: "fake-live-2", name: "tools-13", state: "waiting", startedAt: 2 },
      { id: "fake-ended-1", name: "tools-9", state: "done", startedAt: 0 },
    ];
    const { ctx, calls, docker } = setup({ stable: "2.1.320", installed: "2.1.311", docker: { sessions } });

    expect(poll(ctx, { dryRun: false })).toBe(0);
    expect(calls.some((c) => isDocker(c, "build"))).toBe(false);
    expect(replacing(calls)).toEqual([]);
    expect(docker.container()?.image).toBe(OLD_IMAGE);
    expect(calls.some(isPollerRun)).toBe(true);

    const named = logLines().filter((l) => l.includes("2.1.320") && l.includes("2.1.311"));
    expect(named).toHaveLength(1);
    const rest = named[0]!.split("2.1.320").join("").split("2.1.311").join("");
    const namesBoth = rest.includes("tools-12") && rest.includes("tools-13");
    const countsBoth = /\b2\b/.test(rest);
    expect(namesBoth || countsBoth, named[0]).toBe(true);
  });

  it("a container session list that cannot be read skips the rebuild with one log line and the poll runs", () => {
    const { ctx, calls, docker } = setup({
      stable: "2.1.320",
      installed: "2.1.311",
      respond: (call) => (isAgentsList(call) ? failed("example agents list failure") : undefined),
    });

    expect(poll(ctx, { dryRun: false })).toBe(0);
    expect(logLines().filter((l) => l.includes("example agents list failure"))).toHaveLength(1);
    expect(calls.some((c) => isDocker(c, "build"))).toBe(false);
    expect(replacing(calls)).toEqual([]);
    expect(docker.container()?.image).toBe(OLD_IMAGE);
    expect(calls.some(isPollerRun)).toBe(true);
  });

  it("a stable version equal to or older than the installed one rebuilds nothing", () => {
    for (const stable of ["2.1.311", "2.1.99", "1.10.0"]) {
      printed = [];
      const { ctx, calls, docker } = setup({ stable, installed: "2.1.311" });

      expect(poll(ctx, { dryRun: false }), stable).toBe(0);
      expect(calls.some(isNpmView), stable).toBe(true);
      expect(calls.some(isVersion), stable).toBe(true);
      expect(calls.some((c) => isDocker(c, "build")), stable).toBe(false);
      expect(replacing(calls), stable).toEqual([]);
      expect(docker.container()?.image, stable).toBe(OLD_IMAGE);
      expect(calls.some(isPollerRun), stable).toBe(true);
      expect(logLines().filter((l) => l.includes(stable)), stable).toEqual([]);
    }
  });

  it("npm view failing is logged and the poll runs with the installed Claude Code", () => {
    const { ctx, calls, docker } = setup({
      stable: failed("npm error code ENOTFOUND example registry unreachable"),
      installed: "2.1.311",
    });

    expect(poll(ctx, { dryRun: false })).toBe(0);
    const logged = logLines().filter((l) => l.includes("example registry unreachable"));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("npm view");
    expect(calls.some((c) => isDocker(c, "build"))).toBe(false);
    expect(replacing(calls)).toEqual([]);
    expect(docker.container()?.image).toBe(OLD_IMAGE);
    expect(calls.some(isPollerRun)).toBe(true);
  });

  it("claude --version failing in the container is logged and the poll runs with the installed Claude Code", () => {
    const { ctx, calls, docker } = setup({
      stable: "2.1.320",
      installed: failed("example claude version failure"),
    });

    expect(poll(ctx, { dryRun: false })).toBe(0);
    const logged = logLines().filter((l) => l.includes("example claude version failure"));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("claude --version");
    expect(calls.some((c) => isDocker(c, "build"))).toBe(false);
    expect(replacing(calls)).toEqual([]);
    expect(docker.container()?.image).toBe(OLD_IMAGE);
    expect(calls.some(isPollerRun)).toBe(true);
  });

  it("a failed image build is logged and the poll runs on the old container", () => {
    const { ctx, calls, docker } = setup({
      stable: "2.1.320",
      installed: "2.1.311",
      respond: (call) =>
        isDocker(call, "build")
          ? { status: 1, stdout: "#5 [2/6] RUN npm install\n", stderr: "#5 ERROR: example step failure\nERROR: failed to solve: example build failure\n" }
          : undefined,
    });

    expect(poll(ctx, { dryRun: false })).toBe(0);
    expect(calls.some((c) => isDocker(c, "build"))).toBe(true);
    expect(output()).toContain("ERROR: failed to solve: example build failure");
    expect(replacing(calls)).toEqual([]);
    expect(docker.container()?.state).toBe("running");
    expect(docker.container()?.image).toBe(OLD_IMAGE);
    expect(calls.some(isPollerRun)).toBe(true);
  });

  it("a replacement that does not come up ready fails the poll and logs why", () => {
    const { ctx, calls } = setup({ stable: "2.1.320", installed: "2.1.311", docker: { startLog: [FAILED_LINE] } });

    expect(poll(ctx, { dryRun: false })).toBe(1);
    expect(calls.some((c) => isDocker(c, "run"))).toBe(true);
    expect(output()).toContain(FAILED_LINE);
    expect(calls.some(isPollerRun)).toBe(false);
  });
});
