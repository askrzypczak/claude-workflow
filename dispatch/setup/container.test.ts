// The container phase on the fake SetupIo (fake-io.ts) and its docker world: docker itself, the
// container's run flags, readiness, and when the container is replaced or left running.
//
// Report keywords these tests match on (case-insensitive):
// - dry run, `would` lines: "setup-token" or "CLAUDE_CODE_OAUTH_TOKEN" (the env file), "build"
//   (the image), "volume", "docker run", "deploy key", "known_hosts", "clone", "user.name" (the
//   git identity), "gh auth login", ".claude.json" and "plugin";
// - a live session's to-do names its fix, `claude stop <id>`;
// - a rerun's steps in place are `already` lines.
import { describe, expect, it } from "vitest";
import { container, ENV_FILE } from "./container.ts";
import { FAKE_HOME, FAKE_REPO, fakeIo, fileWrites, parseDockerExec, writeCalls } from "./fake-io.ts";
import type { FakeCall, FakeDocker, FakeWorld } from "./fake-io.ts";
import type { SetupContext } from "./main.ts";

const CLONE = "/clone";
const OTHER = "/work/example-other";
const OTHER_REPO = "example-owner/example-other";
const ENV_PATH = `${FAKE_HOME}/${ENV_FILE}`;
const CLAUDE_TOKEN = "sk-ant-oat01-fake-token-for-tests";
const READY = "entrypoint: firewall applied";
const NOT_STARTING = "entrypoint: firewall failed; not starting";
const NEWER_IMAGE = `sha256:${"2".repeat(64)}`;

/** A Claude token in the env file and a gh login in the container, so no step prompts. */
function world(docker: FakeDocker = {}, overrides: FakeWorld = {}): FakeWorld {
  return {
    deployKeys: [FAKE_REPO, OTHER_REPO],
    files: { [ENV_PATH]: `CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_TOKEN}\n` },
    ...overrides,
    docker: { ghLogin: "fine-grained", ...docker },
  };
}

function setup(w: FakeWorld, opts: { dryRun?: boolean } = {}) {
  const fake = fakeIo(w);
  const ctx: SetupContext = {
    io: fake.io,
    dryRun: opts.dryRun ?? false,
    clone: CLONE,
    home: FAKE_HOME,
    repos: [
      { repo: FAKE_REPO, dir: CLONE },
      { repo: OTHER_REPO, dir: OTHER },
    ],
  };
  return { ...fake, ctx, run: (more: Partial<SetupContext> = {}) => container.run({ ...ctx, ...more }) };
}

const isDocker = (c: FakeCall, sub: string) => c.cmd === "docker" && c.args[0] === sub;
const isExec = (c: FakeCall) => parseDockerExec(c) !== undefined;
const isKeygen = (c: FakeCall) => {
  const command = parseDockerExec(c)?.command ?? [];
  return command[0] === "ssh-keygen" && command.includes("-t");
};
/** The calls that stop, remove or create the container. */
const replacing = (calls: readonly FakeCall[]) => calls.filter((c) => isDocker(c, "stop") || isDocker(c, "rm") || isDocker(c, "run"));
/** `--flag value` or `--flag=value` among the arguments. */
const hasOpt = (args: readonly string[], flag: string, value: string) =>
  args.some((a, i) => a === `${flag}=${value}` || (a === flag && args[i + 1] === value));
/** The values given to a flag, in `--flag value` or `--flag=value` form. */
const optValues = (args: readonly string[], flags: readonly string[]) =>
  args.flatMap((a, i) => {
    for (const f of flags) {
      if (a === f) return [args[i + 1] ?? ""];
      if (a.startsWith(`${f}=`)) return [a.slice(f.length + 1)];
    }
    return [];
  });

describe("container phase", () => {
  it("docker unreachable stops the phase with a to-do naming the colima start command", () => {
    const { run, reports, calls } = setup(world({ reachable: false }));

    expect(run()).toBe("stop");
    const todos = reports.filter((r) => r.status === "todo").map((r) => r.text);
    expect(todos.some((t) => t.includes("colima start --cpu 4 --memory 4 --disk 40 --mount none"))).toBe(true);
    expect(writeCalls(calls)).toEqual([]);
  });

  it("under --dry-run every step is listed as would and only reads run", () => {
    const { run, reports, calls, fileOps } = setup(world({ ghLogin: undefined }, { files: {} }), { dryRun: true });

    expect(run()).toBe("ok");
    expect(writeCalls(calls)).toEqual([]);
    expect(fileWrites(fileOps)).toEqual([]);
    const would = reports.filter((r) => r.status === "would").map((r) => r.text);
    const steps = [
      /setup-token|CLAUDE_CODE_OAUTH_TOKEN/i,
      /build/i,
      /volume/i,
      /docker run/i,
      /deploy key/i,
      /known_hosts/i,
      /clone/i,
      /user\.name/i,
      /gh auth login/i,
      /\.claude\.json/i,
      /plugin/i,
    ];
    for (const step of steps) expect(would.some((t) => step.test(t)), `a would line matching ${step}`).toBe(true);
  });

  it("the container runs with the README's flags, the env file, FORCE_AUTOUPDATE_PLUGINS=1, the config label and the home volume, and no bind mount", () => {
    const { run, calls, docker } = setup(world());

    expect(run()).toBe("ok");
    const runs = calls.filter((c) => isDocker(c, "run"));
    expect(runs).toHaveLength(1);
    const args = runs[0]!.args;
    expect(args.includes("-d") || args.includes("--detach")).toBe(true);
    expect(args).toContain("--init");
    expect(hasOpt(args, "--name", "claude-workflow-agent")).toBe(true);
    expect(hasOpt(args, "--cap-add", "NET_ADMIN")).toBe(true);
    expect(hasOpt(args, "--cap-add", "NET_RAW")).toBe(true);
    expect(hasOpt(args, "--security-opt", "no-new-privileges")).toBe(true);
    expect(hasOpt(args, "--env-file", ENV_PATH)).toBe(true);
    expect(hasOpt(args, "-e", "FORCE_AUTOUPDATE_PLUGINS=1") || hasOpt(args, "--env", "FORCE_AUTOUPDATE_PLUGINS=1")).toBe(true);
    expect(optValues(args, ["--label", "-l"]).some((v) => /^claude-workflow\.config=\S+$/.test(v))).toBe(true);
    expect(optValues(args, ["-v", "--volume"])).toEqual(["claude-workflow-home:/home/node"]);
    expect(optValues(args, ["--mount"])).toEqual([]);
    expect(args.some((a) => a.startsWith("--restart") || a === "--privileged" || a.includes("docker.sock"))).toBe(false);
    expect(args[args.length - 1]).toBe("claude-workflow-agent");
    expect(args.join(" ")).not.toContain(CLAUDE_TOKEN);
    expect(docker.container()?.mounts.map((m) => `${m.type} ${m.name} ${m.destination}`)).toEqual([
      "volume claude-workflow-home /home/node",
    ]);
  });

  it("no docker exec runs before entrypoint: firewall applied is logged", () => {
    const never = setup(world({ startLog: [] }));
    expect(never.run()).toBe("stop");
    expect(never.calls.some((c) => isDocker(c, "run"))).toBe(true);
    expect(never.calls.some(isExec)).toBe(false);

    const { run, calls } = setup(world({ startLog: [READY] }));
    expect(run()).toBe("ok");
    const started = calls.findIndex((c) => isDocker(c, "run"));
    const logs = calls.findIndex((c, i) => i > started && isDocker(c, "logs"));
    const firstExec = calls.findIndex((c, i) => i > started && isExec(c));
    expect(started).toBeGreaterThanOrEqual(0);
    expect(logs).toBeGreaterThan(started);
    expect(firstExec).toBeGreaterThan(logs);
  });

  it("a container logging entrypoint: firewall failed; not starting stops the phase with that line, and nothing runs in it", () => {
    const { run, calls, reports } = setup(world({ startLog: [NOT_STARTING] }));

    expect(run()).toBe("stop");
    expect(reports.some((r) => (r.status === "todo" || r.status === "fail") && r.text.includes(NOT_STARTING))).toBe(true);
    expect(calls.some(isExec)).toBe(false);
  });

  it("every docker exec other than claude runs with -u node", () => {
    const { run, calls } = setup(world({ ghLogin: undefined }));

    expect(run()).toBe("ok");
    const execs = calls.map(parseDockerExec).filter((x) => x !== undefined);
    const others = execs.filter((x) => x!.command[0] !== "claude");
    expect(others.length).toBeGreaterThan(5);
    for (const x of others) expect(x!.user, x!.command.join(" ")).toBe("node");
  });

  it("a container on an older image is replaced on the same volume", () => {
    const w = world();
    const { run, calls, docker } = setup(w);
    expect(run()).toBe("ok");
    const key = docker.file("/home/node/.ssh/deploy-example-tools");
    expect(key).toBeDefined();

    w.docker!.buildId = NEWER_IMAGE;
    const from = calls.length;
    expect(run()).toBe("ok");
    const second = calls.slice(from);
    expect(second.some((c) => isDocker(c, "stop") || (isDocker(c, "rm") && c.args.includes("-f")))).toBe(true);
    const runs = second.filter((c) => isDocker(c, "run"));
    expect(runs).toHaveLength(1);
    expect(optValues(runs[0]!.args, ["-v", "--volume"])).toEqual(["claude-workflow-home:/home/node"]);
    expect(second.some((c) => c.cmd === "docker" && c.args[0] === "volume" && c.args[1] === "rm")).toBe(false);
    expect(second.some(isKeygen)).toBe(false);
    expect(docker.container()?.image).toBe(NEWER_IMAGE);
    expect(docker.file("/home/node/.ssh/deploy-example-tools")).toBe(key);
  });

  it("a container whose config label differs is replaced", () => {
    const { run, calls, files, docker } = setup(world());
    expect(run()).toBe("ok");
    const before = docker.container()!.labels["claude-workflow.config"];
    expect(before).toBeDefined();

    files[ENV_PATH] = "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fake-rotated-token\n";
    const from = calls.length;
    expect(run()).toBe("ok");
    const second = calls.slice(from);
    expect(second.filter((c) => isDocker(c, "run"))).toHaveLength(1);
    expect(docker.container()!.labels["claude-workflow.config"]).not.toBe(before);
    expect(docker.container()!.env.CLAUDE_CODE_OAUTH_TOKEN).toBe("sk-ant-oat01-fake-rotated-token");
  });

  it("--rebuild builds with --pull --no-cache and replaces the container", () => {
    const { run, calls, docker } = setup(world());
    expect(run()).toBe("ok");
    const key = docker.file("/home/node/.ssh/deploy-example-tools");

    const from = calls.length;
    expect(run({ rebuild: true })).toBe("ok");
    const second = calls.slice(from);
    const builds = second.filter((c) => isDocker(c, "build") || (c.args[0] === "buildx" && c.args[1] === "build"));
    expect(builds.length).toBeGreaterThan(0);
    expect(builds.some((c) => c.args.includes("--pull") && c.args.includes("--no-cache"))).toBe(true);
    const runs = second.filter((c) => isDocker(c, "run"));
    expect(runs).toHaveLength(1);
    expect(optValues(runs[0]!.args, ["-v", "--volume"])).toEqual(["claude-workflow-home:/home/node"]);
    expect(second.some((c) => c.cmd === "docker" && c.args[0] === "volume" && c.args[1] === "rm")).toBe(false);
    expect(second.some(isKeygen)).toBe(false);
    expect(docker.file("/home/node/.ssh/deploy-example-tools")).toBe(key);
  });

  it("a live container session stops the phase before a replace, with claude stop <id> for each", () => {
    const triggers: [string, (w: FakeWorld) => Partial<SetupContext>][] = [
      ["an older image", (w) => {
        w.docker!.buildId = NEWER_IMAGE;
        return {};
      }],
      ["--rebuild", () => ({ rebuild: true })],
    ];
    for (const [label, trigger] of triggers) {
      const w = world();
      const { run, calls, reports, docker } = setup(w);
      expect(run(), label).toBe("ok");
      docker.sessions().push(
        { id: "fake-live-1", name: "tools-12", state: "running", startedAt: 1 },
        { id: "fake-live-2", name: "tools-13", state: "waiting", startedAt: 2 },
      );

      const more = trigger(w);
      const from = calls.length;
      const reportsFrom = reports.length;
      expect(run(more), label).toBe("stop");
      const todos = reports.slice(reportsFrom).filter((r) => r.status === "todo").map((r) => r.text);
      expect(todos.some((t) => t.includes("claude stop fake-live-1")), label).toBe(true);
      expect(todos.some((t) => t.includes("claude stop fake-live-2")), label).toBe(true);
      expect(replacing(calls.slice(from)), label).toEqual([]);
      expect(docker.container()?.state, label).toBe("running");
    }
  });

  it("a container on the current image and label is left running", () => {
    const { run, calls, docker } = setup(world());
    expect(run()).toBe("ok");
    const startedAt = docker.container()!.startedAt;

    const from = calls.length;
    expect(run()).toBe("ok");
    const second = calls.slice(from);
    expect(replacing(second)).toEqual([]);
    expect(second.some((c) => isDocker(c, "start"))).toBe(false);
    expect(docker.container()?.state).toBe("running");
    expect(docker.container()?.startedAt).toBe(startedAt);
  });

  it("a rerun with everything in place reports already done and makes no write call", () => {
    const { run, calls, reports, fileOps } = setup(world());
    expect(run()).toBe("ok");

    const from = calls.length;
    const reportsFrom = reports.length;
    const opsFrom = fileOps.length;
    expect(run()).toBe("ok");
    expect(fileWrites(fileOps.slice(opsFrom))).toEqual([]);
    // The image build and the plugin update run on every run; nothing else may write.
    const everyRun = (c: FakeCall) => {
      if (isDocker(c, "build")) return true;
      const command = parseDockerExec(c)?.command ?? [];
      return command[0] === "claude" && command[1] === "plugin" &&
        (command[2] === "update" || (command[2] === "marketplace" && command[3] === "update"));
    };
    expect(writeCalls(calls.slice(from)).filter((c) => !everyRun(c))).toEqual([]);
    const second = reports.slice(reportsFrom);
    expect(second.filter((r) => r.status === "already").length).toBeGreaterThanOrEqual(5);
    expect(second.some((r) => r.status === "todo" || r.status === "fail")).toBe(false);
  });
});
