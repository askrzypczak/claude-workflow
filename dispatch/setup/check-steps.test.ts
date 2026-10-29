// The check phase's steps on the fake SetupIo (fake-io.ts): the resume after
// `install-launchd.sh status`, and the probe script command the session is told to run.
import { describe, expect, it } from "vitest";
import { check, probeItems } from "./check.ts";
import { FAKE_HOME, FAKE_REPO, fakeIo } from "./fake-io.ts";
import type { FakeCall, FakeWorld } from "./fake-io.ts";
import type { SetupContext } from "./main.ts";
import { sandboxSettings } from "./sandbox.ts";

const CLONE = "/clone";
const SETTINGS = `${FAKE_HOME}/.claude/settings.json`;
/** Sorted, as findPrivateKeys returns them. */
const KEYS = [`${FAKE_HOME}/.ssh/deploy-example-tools`, `${FAKE_HOME}/.ssh/id_ed25519`];
const PRIVATE_KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nFAKE-KEY-BODY-FOR-TESTS\n-----END OPENSSH PRIVATE KEY-----\n";
const INSTALL_LAUNCHD = `${CLONE}/dispatch/install-launchd.sh`;

/** Every probe item passes, then the END line. */
const passing = () => [...probeItems(KEYS).map((i) => `SANDBOX-PROBE PASS ${i}: ok`), "SANDBOX-PROBE END", ""].join("\n");

/** Two keys in ~/.ssh, user settings generated for them, and a probe where every item passes. */
function world(overrides: FakeWorld = {}): FakeWorld {
  return {
    files: {
      [KEYS[0]!]: PRIVATE_KEY,
      [KEYS[1]!]: PRIVATE_KEY,
      [SETTINGS]: `${JSON.stringify(sandboxSettings(KEYS, FAKE_HOME), null, 2)}\n`,
    },
    probe: passing,
    ...overrides,
  };
}

/** A full run of the check phase, with the clone as the only served repo. */
function fullRun(w: FakeWorld) {
  const fake = fakeIo(w);
  const ctx: SetupContext = {
    io: fake.io,
    dryRun: false,
    fullRun: true,
    clone: CLONE,
    home: FAKE_HOME,
    repos: [{ repo: FAKE_REPO, dir: CLONE }],
  };
  return { ...fake, result: check.run(ctx) };
}

const isResume = (c: FakeCall) => c.cmd === INSTALL_LAUNCHD && c.args[0] === "resume";

describe("check phase resume", () => {
  it("a full run with dispatch already running reports it as already done and does not resume", () => {
    const { result, calls, reports } = fullRun(world({ dispatch: "running" }));

    expect(result).toBe("ok");
    expect(reports.some((r) => r.status === "already")).toBe(true);
    expect(calls.some(isResume)).toBe(false);
  });

  it("a full run with the poller not installed notes it, does not resume and passes", () => {
    const notInstalled = (c: FakeCall) =>
      c.cmd === INSTALL_LAUNCHD && c.args[0] === "status"
        ? { status: 0, stdout: "Installed: no\nLoaded:    no\nDisabled:  no\n", stderr: "" }
        : undefined;
    const { result, calls, reports } = fullRun(world({ respond: notInstalled }));

    expect(result).toBe("ok");
    expect(reports.some((r) => r.status === "note" && r.text.includes("install-launchd.sh"))).toBe(true);
    expect(calls.some(isResume)).toBe(false);
  });
});

describe("check phase probe prompt", () => {
  it("the prompt has the session run the probe script with the result file, the repo and each key, each quoted", () => {
    const { launches } = fullRun(world());

    expect(launches).toHaveLength(1);
    const { name, prompt } = launches[0]!;
    const command =
      `bash '${CLONE}/dispatch/setup/sandbox-probe.sh' '${CLONE}/.${name}.txt' '${FAKE_REPO}' ` +
      `'${KEYS[0]!}' '${KEYS[1]!}'`;
    expect(prompt).toContain(command);
  });
});
