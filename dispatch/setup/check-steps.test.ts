// The check phase's steps on the fake SetupIo (fake-io.ts): the resume after
// `install-launchd.sh status`, and what the probe session is told to do.
import { describe, expect, it } from "vitest";
import { check, probeItems } from "./check.ts";
import { FAKE_HOME, FAKE_REPO, fakeIo } from "./fake-io.ts";
import type { FakeCall, FakeWorld } from "./fake-io.ts";
import type { SetupContext } from "./main.ts";

const CLONE = "/clone";
const FIRST = "/home/node/example-tools";
const INSTALL_LAUNCHD = `${CLONE}/dispatch/install-launchd.sh`;

const pem = (name: string) => `-----BEGIN OPENSSH PRIVATE KEY-----\nFAKE-KEY-BODY-FOR-TESTS-${name}\n-----END OPENSSH PRIVATE KEY-----\n`;
/** Every probe item passes, then the END line. */
const passing = () => [...probeItems().map((i) => `SETUP-PROBE PASS ${i}: ok`), "SETUP-PROBE END", ""].join("\n");

/** A running, ready container with the repo cloned, its deploy key, a gh login and a passing probe. */
function world(overrides: FakeWorld = {}): FakeWorld {
  return {
    deployKeys: [FAKE_REPO],
    docker: {
      container: { state: "running" },
      clones: { [FIRST]: `git@github.com-example-tools:${FAKE_REPO}.git` },
      files: { "/home/node/.ssh/deploy-example-tools": pem("deploy-example-tools") },
      ghLogin: "fine-grained",
      probe: passing,
    },
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
    repos: [{ repo: FAKE_REPO }],
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
  it("the prompt has git fetch and git push --dry-run run as separate Bash calls, and the browser tools reported", () => {
    const { launches } = fullRun(world());

    expect(launches).toHaveLength(1);
    const { prompt } = launches[0]!;
    expect(prompt).toContain("git fetch origin");
    expect(prompt).toContain("git push --dry-run origin HEAD:refs/heads/setup-probe");
    // Each git command is its own Bash call, so auto mode judges each one alone.
    const lines = prompt.split("\n");
    const fetchLine = lines.findIndex((l) => l.includes("git fetch origin"));
    const pushLine = lines.findIndex((l) => l.includes("git push --dry-run"));
    expect(fetchLine).toBeGreaterThanOrEqual(0);
    expect(pushLine).toBeGreaterThan(fetchLine);
    expect(lines[fetchLine]).not.toContain("git push");
    expect(prompt).toMatch(/(own|separate) Bash calls?/i);
    expect(prompt).toMatch(/browser/i);
    for (const item of probeItems()) expect(prompt, item).toContain(item);
    expect(prompt).toContain(`.${launches[0]!.name}.txt`);
  });
});
