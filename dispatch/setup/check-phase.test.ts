// The check phase on the fake SetupIo (fake-io.ts) and its docker world: the probe session in
// the container, how it is stopped and cleaned up, and when dispatch resumes.
//
// Report keywords these tests match on (case-insensitive): `would` lines naming "probe" and
// "resume" under --dry-run; a `note` naming "paused" on a check-only run.
import { describe, expect, it } from "vitest";
import { LAUNCH_FLAGS } from "../poller/config.ts";
import { check, probeItems } from "./check.ts";
import { FAKE_HOME, FAKE_REPO, fakeIo, parseDockerExec, writeCalls } from "./fake-io.ts";
import type { FakeCall, FakeDocker, FakeWorld } from "./fake-io.ts";
import type { SetupContext } from "./main.ts";

const CLONE = "/clone";
const OTHER_REPO = "example-owner/example-other";
const FIRST = "/home/node/example-tools";
const INSTALL_LAUNCHD = `${CLONE}/dispatch/install-launchd.sh`;

const pem = (name: string) => `-----BEGIN OPENSSH PRIVATE KEY-----\nFAKE-KEY-BODY-FOR-TESTS-${name}\n-----END OPENSSH PRIVATE KEY-----\n`;

/** Every probe item passes, then the END line. */
const passing = () => [...probeItems().map((i) => `SETUP-PROBE PASS ${i}: ok`), "SETUP-PROBE END", ""].join("\n");

/** The given item fails; every other passes; then the END line. */
const failingAt = (index: number) => () =>
  [
    ...probeItems().map((i, n) => (n === index ? `SETUP-PROBE FAIL ${i}: not refused` : `SETUP-PROBE PASS ${i}: ok`)),
    "SETUP-PROBE END",
    "",
  ].join("\n");

/** A running, ready container with both repos cloned, their deploy keys, a gh login and a passing probe. */
function dockerWorld(overrides: FakeDocker = {}): FakeDocker {
  return {
    container: { state: "running" },
    clones: {
      [FIRST]: `git@github.com-example-tools:${FAKE_REPO}.git`,
      "/home/node/example-other": `git@github.com-example-other:${OTHER_REPO}.git`,
    },
    files: {
      "/home/node/.ssh/deploy-example-tools": pem("deploy-example-tools"),
      "/home/node/.ssh/deploy-example-tools.pub": { text: "ssh-ed25519 AAAAFAKEtools deploy\n", mode: 0o644 },
      "/home/node/.ssh/deploy-example-other": pem("deploy-example-other"),
      "/home/node/.ssh/deploy-example-other.pub": { text: "ssh-ed25519 AAAAFAKEother deploy\n", mode: 0o644 },
    },
    ghLogin: "fine-grained",
    probe: passing,
    ...overrides,
  };
}

function world(docker: FakeDocker = {}, overrides: FakeWorld = {}): FakeWorld {
  return { deployKeys: [FAKE_REPO, OTHER_REPO], docker: dockerWorld(docker), ...overrides };
}

function setup(w: FakeWorld, opts: { dryRun?: boolean; fullRun?: boolean } = {}) {
  const fake = fakeIo(w);
  const ctx: SetupContext = {
    io: fake.io,
    dryRun: opts.dryRun ?? false,
    clone: CLONE,
    home: FAKE_HOME,
    repos: [
      { repo: FAKE_REPO },
      { repo: OTHER_REPO },
    ],
    ...(opts.fullRun === undefined ? {} : { fullRun: opts.fullRun }),
  };
  return { ...fake, ctx, run: () => check.run(ctx) };
}

const isResume = (c: FakeCall) => c.cmd === INSTALL_LAUNCHD && c.args[0] === "resume";
/** The command a docker exec call runs, or undefined for any other call. */
const execCommand = (c: FakeCall) => parseDockerExec(c)?.command;
const isClaudeStop = (c: FakeCall) => {
  const command = execCommand(c);
  return (command?.[0] === "claude" && command[1] === "stop") || (c.cmd === "claude" && c.args[0] === "stop");
};
const stopTarget = (c: FakeCall) => execCommand(c)?.[2] ?? c.args[1];
const isProbeStart = (c: FakeCall) => execCommand(c)?.[0] === "claude" && (execCommand(c) ?? []).includes("--bg");

describe("check phase", () => {
  it("a container that is not running stops the check with a to-do, and no session starts", () => {
    const worlds: [string, FakeWorld][] = [
      ["stopped", world({ container: { state: "stopped" } })],
      ["absent", world({ container: undefined, volume: true })],
      ["no docker", world({ reachable: false })],
    ];
    for (const [label, w] of worlds) {
      const { run, launches, calls, reports } = setup(w, { fullRun: true });

      expect(run(), label).toBe("stop");
      expect(reports.some((r) => r.status === "todo"), label).toBe(true);
      expect(launches, label).toEqual([]);
      expect(calls.some(isProbeStart), label).toBe(false);
      expect(calls.some(isResume), label).toBe(false);
    }
  });

  it("the probe session starts in the first clone with LAUNCH_FLAGS and --permission-mode auto", () => {
    const { run, launches, calls } = setup(world(), { fullRun: true });

    run();
    expect(launches).toHaveLength(1);
    const launch = launches[0]!;
    expect(launch.dir).toBe(FIRST);
    expect(launch.name).toMatch(/^setup-probe-/);
    expect(launch.flags.join(" ")).toContain(LAUNCH_FLAGS.join(" "));
    const mode = launch.flags.indexOf("--permission-mode");
    expect(mode).toBeGreaterThanOrEqual(0);
    expect(launch.flags[mode + 1]).toBe("auto");
    const started = calls.filter(isProbeStart);
    expect(started).toHaveLength(1);
    expect(parseDockerExec(started[0]!)?.workdir).toBe(FIRST);
  });

  it("the probe session is stopped with claude stop <id>, the id found by the session's name", () => {
    const { run, launches, calls, docker } = setup(
      world({ sessions: [{ id: "fake-other-1", name: "tools-3", state: "done", startedAt: 1 }] }),
      { fullRun: true },
    );

    run();
    expect(launches).toHaveLength(1);
    const name = launches[0]!.name;
    const id = docker.sessions().find((s) => s.name === name)?.id;
    expect(id).toBeDefined();
    const stops = calls.filter(isClaudeStop);
    expect(stops.map(stopTarget)).toEqual([id]);
    const listed = calls.findIndex((c) => execCommand(c)?.[0] === "claude" && execCommand(c)?.[1] === "agents");
    expect(listed).toBeGreaterThanOrEqual(0);
    expect(listed).toBeLessThan(calls.indexOf(stops[0]!));
    expect(docker.sessions().find((s) => s.id === id)?.state).toBe("stopped");
  });

  it("a probe session missing from the list gets a note, and no stop by name runs", () => {
    const { run, launches, calls, reports } = setup(world({ unlisted: true }), { fullRun: true });

    run();
    expect(launches).toHaveLength(1);
    const name = launches[0]!.name;
    expect(calls.filter(isClaudeStop).map(stopTarget)).not.toContain(name);
    expect(calls.some(isClaudeStop)).toBe(false);
    expect(reports.some((r) => r.status === "note" && r.text.includes(name))).toBe(true);
  });

  it("the probe result is read and removed through docker exec on pass, fail and timeout", () => {
    const probes: [string, FakeDocker["probe"]][] = [
      ["pass", passing],
      ["fail", failingAt(0)],
      ["timeout", () => undefined],
    ];
    for (const [label, probe] of probes) {
      const { run, launches, calls, fileOps, docker } = setup(world({ probe }), { fullRun: true });

      run();
      expect(launches, label).toHaveLength(1);
      const result = `${FIRST}/.${launches[0]!.name}.txt`;
      const asNode = calls.map(parseDockerExec).filter((x) => x !== undefined && x.user === "node");
      expect(asNode.some((x) => x!.command[0] === "cat" && x!.command.includes(result)), label).toBe(true);
      expect(asNode.some((x) => x!.command[0] === "rm" && x!.command.includes(result)), label).toBe(true);
      expect(fileOps.some((o) => o.path === result), label).toBe(false);
      expect(docker.file(result), label).toBeUndefined();
    }
  });

  it("a FAIL item stops the phase and leaves dispatch paused", () => {
    const { run, calls, reports } = setup(world({ probe: failingAt(0) }), { fullRun: true });

    expect(run()).toBe("stop");
    expect(calls.some(isResume)).toBe(false);
    expect(reports.some((r) => r.status === "fail")).toBe(true);
    expect(reports.some((r) => r.status === "todo")).toBe(true);
  });

  it("no result within the timeout fails the check and stops the probe session", () => {
    const { run, launches, calls, reports, docker } = setup(world({ probe: () => undefined }), { fullRun: true });

    expect(run()).toBe("stop");
    expect(launches).toHaveLength(1);
    const id = docker.sessions().find((s) => s.name === launches[0]!.name)?.id;
    expect(calls.filter(isClaudeStop).map(stopTarget)).toEqual([id]);
    expect(reports.some((r) => r.status === "todo")).toBe(true);
    expect(calls.some(isResume)).toBe(false);
  });

  it("a full run resumes dispatch when the direct checks and every probe item pass", () => {
    const { run, calls, reports } = setup(world(), { fullRun: true });

    expect(run()).toBe("ok");
    expect(calls.filter(isResume)).toHaveLength(1);
    expect(reports.filter((r) => r.status === "pass").length).toBeGreaterThanOrEqual(probeItems().length);
    expect(reports.some((r) => r.status === "fail" || r.status === "todo")).toBe(false);
  });

  it("a check-only run leaves dispatch paused and says so", () => {
    for (const fullRun of [undefined, false]) {
      const { run, launches, calls, reports } = setup(world(), fullRun === undefined ? {} : { fullRun });

      expect(run(), String(fullRun)).toBe("ok");
      expect(launches, String(fullRun)).toHaveLength(1);
      expect(calls.some(isResume), String(fullRun)).toBe(false);
      expect(reports.some((r) => r.status === "note" && /paused/i.test(r.text)), String(fullRun)).toBe(true);
    }
  });

  it("under --dry-run nothing launches or resumes, and the probe and the resume are listed as would", () => {
    const { run, launches, calls, reports, fileOps } = setup(world(), { dryRun: true, fullRun: true });

    expect(run()).toBe("ok");
    expect(launches).toEqual([]);
    expect(writeCalls(calls)).toEqual([]);
    expect(calls.some(isClaudeStop)).toBe(false);
    expect(calls.some(isResume)).toBe(false);
    expect(fileOps.some((o) => o.op === "writeFile")).toBe(false);
    const would = reports.filter((r) => r.status === "would").map((r) => r.text);
    expect(would.some((t) => /probe/i.test(t))).toBe(true);
    expect(would.some((t) => /resume/i.test(t))).toBe(true);
  });
});
