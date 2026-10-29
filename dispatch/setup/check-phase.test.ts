// The check phase on the fake SetupIo (fake-io.ts): the static settings checks, the probe
// session launched the way the poller launches, and when dispatch resumes.
import { describe, expect, it } from "vitest";
import { LAUNCH_FLAGS } from "../poller/config.ts";
import { check, pollerEnv, probeItems } from "./check.ts";
import { FAKE_HOME, FAKE_REPO, fakeIo } from "./fake-io.ts";
import type { FakeCall, FakeLaunch, FakeWorld } from "./fake-io.ts";
import type { SetupContext } from "./main.ts";
import { sandboxSettings } from "./sandbox.ts";

const CLONE = "/clone";
const OTHER = "/work/example-other";
const SETTINGS = `${FAKE_HOME}/.claude/settings.json`;
/** Sorted, as findPrivateKeys returns them. */
const KEYS = [`${FAKE_HOME}/.ssh/deploy-example-tools`, `${FAKE_HOME}/.ssh/id_ed25519`];
const PRIVATE_KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nFAKE-KEY-BODY-FOR-TESTS\n-----END OPENSSH PRIVATE KEY-----\n";
const INSTALL_LAUNCHD = `${CLONE}/dispatch/install-launchd.sh`;

const text = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** Every probe item passes, then the END line. */
const passing = () => [...probeItems(KEYS).map((i) => `SANDBOX-PROBE PASS ${i}: ok`), "SANDBOX-PROBE END", ""].join("\n");

/** The given item fails; every other passes; then the END line. */
const failingAt = (index: number) => () =>
  [
    ...probeItems(KEYS).map((i, n) => (n === index ? `SANDBOX-PROBE FAIL ${i}: not refused` : `SANDBOX-PROBE PASS ${i}: ok`)),
    "SANDBOX-PROBE END",
    "",
  ].join("\n");

/** Two keys in ~/.ssh and user settings generated for them. */
function world(overrides: FakeWorld = {}, settings: unknown = sandboxSettings(KEYS, FAKE_HOME)): FakeWorld {
  return {
    files: {
      [KEYS[0]!]: PRIVATE_KEY,
      [`${KEYS[0]!}.pub`]: "ssh-ed25519 AAAAFAKEdeploy deploy\n",
      [KEYS[1]!]: PRIVATE_KEY,
      [`${KEYS[1]!}.pub`]: "ssh-ed25519 AAAAFAKEaccount account\n",
      [SETTINGS]: text(settings),
    },
    probe: passing,
    ...overrides,
  };
}

function setup(w: FakeWorld, opts: { dryRun?: boolean; fullRun?: boolean } = {}) {
  const fake = fakeIo(w);
  const ctx: SetupContext = {
    io: fake.io,
    dryRun: opts.dryRun ?? false,
    clone: CLONE,
    home: FAKE_HOME,
    repos: [
      { repo: FAKE_REPO, dir: CLONE },
      { repo: "example-owner/example-other", dir: OTHER },
    ],
    ...(opts.fullRun === undefined ? {} : { fullRun: opts.fullRun }),
  };
  return { ...fake, ctx, run: () => check.run(ctx) };
}

const isResume = (c: FakeCall) => c.cmd === INSTALL_LAUNCHD && c.args[0] === "resume";
const isStopOf = (launch: FakeLaunch | undefined) => (c: FakeCall) =>
  launch !== undefined && c.cmd === "claude" && c.args[0] === "stop" && c.args[1] === launch.name;
const isAnyStop = (c: FakeCall) => c.cmd === "claude" && c.args[0] === "stop";

describe("check phase", () => {
  it("launches the probe session once with LAUNCH_FLAGS in the first served repo's dir", () => {
    const { run, launches } = setup(world(), { fullRun: true });

    run();
    expect(launches).toHaveLength(1);
    expect(launches[0]!.dir).toBe(CLONE);
    expect(launches[0]!.flags).toEqual(LAUNCH_FLAGS);
    expect(launches[0]!.name).toMatch(/^sandbox-probe-/);
  });

  it("gives the probe session an environment holding only HOME and PATH", () => {
    const { run, launches } = setup(world(), { fullRun: true });

    run();
    expect(launches).toHaveLength(1);
    const env = launches[0]!.env;
    expect(Object.keys(env).sort()).toEqual(["HOME", "PATH"]);
    expect(env.HOME).toBe(FAKE_HOME);
    expect(env.PATH).toBe(pollerEnv(FAKE_HOME).PATH);
  });

  it("no result within the timeout fails the check and stops the probe session", () => {
    const { run, launches, calls, reports } = setup(world({ probe: () => undefined }), { fullRun: true });

    expect(run()).toBe("stop");
    expect(launches).toHaveLength(1);
    expect(calls.some(isStopOf(launches[0]))).toBe(true);
    expect(reports.some((r) => r.status === "todo")).toBe(true);
    expect(calls.some(isResume)).toBe(false);
  });

  it("removes the result file and stops the probe session on pass, fail and timeout", () => {
    const probes: [string, FakeWorld["probe"]][] = [
      ["pass", passing],
      ["fail", failingAt(0)],
      ["timeout", () => undefined],
    ];
    for (const [label, probe] of probes) {
      const { run, launches, calls, fileOps } = setup(world({ probe }), { fullRun: true });

      run();
      expect(launches, label).toHaveLength(1);
      const launch = launches[0]!;
      const removed = fileOps.filter((o) => o.op === "removeFile").map((o) => o.path);
      expect(removed, label).toContain(`${launch.dir}/.${launch.name}.txt`);
      expect(calls.filter(isStopOf(launch)), label).toHaveLength(1);
    }
  });

  it("a full run resumes dispatch when the static checks and every probe item pass", () => {
    const { run, calls, reports } = setup(world(), { fullRun: true });

    expect(run()).toBe("ok");
    expect(calls.filter(isResume)).toHaveLength(1);
    expect(reports.filter((r) => r.status === "pass").length).toBeGreaterThanOrEqual(probeItems(KEYS).length);
    expect(reports.some((r) => r.status === "fail" || r.status === "todo")).toBe(false);
  });

  it("a FAIL item leaves dispatch paused and stops the phase", () => {
    const { run, calls, reports } = setup(world({ probe: failingAt(2) }), { fullRun: true });

    expect(run()).toBe("stop");
    expect(calls.some(isResume)).toBe(false);
    expect(reports.some((r) => r.status === "fail")).toBe(true);
    expect(reports.some((r) => r.status === "todo")).toBe(true);
  });

  it("failing static checks stop the phase before the probe launches", () => {
    const incomplete = sandboxSettings(KEYS, FAKE_HOME) as { sandbox: Record<string, unknown> };
    delete incomplete.sandbox.enabled;
    const { run, launches, calls, reports } = setup(world({}, incomplete), { fullRun: true });

    expect(run()).toBe("stop");
    expect(launches).toEqual([]);
    expect(calls.some(isAnyStop)).toBe(false);
    expect(calls.some(isResume)).toBe(false);
    expect(reports.some((r) => r.status === "fail" && r.text.includes("sandbox.enabled"))).toBe(true);
    expect(reports.some((r) => r.status === "todo")).toBe(true);
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
    expect(calls.some(isAnyStop)).toBe(false);
    expect(calls.some(isResume)).toBe(false);
    expect(fileOps.some((o) => o.op === "removeFile" || o.op === "waitForFile")).toBe(false);
    const would = reports.filter((r) => r.status === "would").map((r) => r.text);
    expect(would.some((t) => /probe/i.test(t))).toBe(true);
    expect(would.some((t) => /resume/i.test(t))).toBe(true);
    // The static checks still run.
    expect(fileOps.some((o) => o.op === "readFile" && o.path === SETTINGS)).toBe(true);
  });
});
