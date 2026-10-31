import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeItems } from "./check.ts";
import { FAKE_REPO, fakeIo, fileWrites, isMergeProbe, parseGhApi, writeCalls } from "./fake-io.ts";
import type { FakeCall, FakeDocker } from "./fake-io.ts";
import type { SetupIo } from "./io.ts";
import { runSetup } from "./main.ts";

const base = (io: SetupIo) => ({ io, clone: "/clone", home: "/home/example", configPath: "/nonexistent/repos.json" });

/** Everything console.log and console.error printed, one string per call. */
const printed = () =>
  [...vi.mocked(console.log).mock.calls, ...vi.mocked(console.error).mock.calls].map((args) => args.join(" "));

/** A running, ready container with the repo cloned, its deploy key, a gh login and a passing probe. */
const readyContainer = (): FakeDocker => ({
  container: { state: "running" },
  clones: { "/home/node/example-tools": `git@github.com-example-tools:${FAKE_REPO}.git` },
  files: {
    "/home/node/.ssh/deploy-example-tools":
      "-----BEGIN OPENSSH PRIVATE KEY-----\nFAKE-KEY-BODY-FOR-TESTS\n-----END OPENSSH PRIVATE KEY-----\n",
  },
  ghLogin: "fine-grained",
  probe: () => [...probeItems().map((i) => `SETUP-PROBE PASS ${i}: ok`), "SETUP-PROBE END", ""].join("\n"),
});

const PAUSED_LINE =
  "Dispatch stays paused until a full run of dispatch/setup-agents.sh passes every phase, or until dispatch/install-launchd.sh resume.";
const isStopLine = (line: string) => line.startsWith("Stopped in credentials:");
const liveSession = [{ name: "tools-3", state: "running" as const, startedAt: 1 }];
/** No served repo has an open PR. */
const noPrs = (c: FakeCall) =>
  c.cmd === "gh" && c.args[0] === "pr" && c.args[1] === "list" ? { status: 0, stdout: "[]\n", stderr: "" } : undefined;

describe("runSetup", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exits 2 and runs nothing on an unknown phase, an unknown flag or a second phase", () => {
    for (const argv of [["nonsense"], ["--force"], ["credentials", "credentials"]]) {
      const { io, calls, reports } = fakeIo();

      expect(runSetup(argv, base(io)), argv.join(" ")).toBe(2);
      expect(calls).toEqual([]);
      expect(reports).toEqual([]);
    }
  });

  it("--help exits 2 with a usage naming credentials, host, container and check, and no ssh or sandbox", () => {
    const { io, calls } = fakeIo();

    expect(runSetup(["--help"], base(io))).toBe(2);
    expect(calls).toEqual([]);
    const usage = printed().join("\n");
    for (const phase of ["credentials", "host", "container", "check"]) {
      expect(usage, phase).toMatch(new RegExp(`\\b${phase}\\b`));
    }
    expect(usage).not.toMatch(/\bssh\b/);
    expect(usage).not.toMatch(/\bsandbox\b/);
  });

  it("container --dry-run exits 0 with no write call and no file write", () => {
    const { io, calls, fileOps } = fakeIo({ docker: {} });

    expect(runSetup(["container", "--dry-run"], base(io))).toBe(0);
    expect(writeCalls(calls)).toEqual([]);
    expect(fileWrites(fileOps)).toEqual([]);
    expect(calls.some((c) => c.cmd === "docker")).toBe(true);
  });

  it("a full run takes credentials, host, container, check in that order", () => {
    const { io } = fakeIo({ docker: {} });

    runSetup(["--dry-run"], base(io));
    const headers = printed()
      .map((line) => /^--- (\S+)/.exec(line)?.[1])
      .filter((name) => name !== undefined);
    expect(headers).toEqual(["credentials", "host", "container", "check"]);
  });

  it("exits 0 when the phase passes and 1 when it stops", () => {
    expect(runSetup(["credentials"], base(fakeIo({ login: "fine-grained" }).io))).toBe(0);
    const live = fakeIo({ sessions: [{ name: "tools-3", state: "running", startedAt: 1 }] });
    expect(runSetup(["credentials"], base(live.io))).toBe(1);
  });

  it("the check phase run on its own exits 0 without resuming dispatch and says it stays paused", () => {
    const { io, calls, reports } = fakeIo({ deployKeys: [FAKE_REPO], docker: readyContainer() });

    expect(runSetup(["check"], base(io))).toBe(0);
    expect(calls.some((c) => c.cmd.endsWith("install-launchd.sh") && c.args[0] === "resume")).toBe(false);
    expect(reports.some((r) => r.status === "note" && /paused/i.test(r.text))).toBe(true);
  });

  it("exits 1 with a single error line when a read fails", () => {
    const { io } = fakeIo({ fail: (c) => c.cmd === "gh" && c.args[0] === "auth" });

    expect(runSetup(["credentials"], base(io))).toBe(1);
    expect(console.error).toHaveBeenCalledTimes(1);
  });

  it("a full run with no open PR in any served repo probes the login's token and goes on past credentials to the later phases", () => {
    const { io, calls } = fakeIo({ login: "fine-grained", deployKeys: [FAKE_REPO], docker: readyContainer(), respond: noPrs });

    runSetup([], base(io));
    const headers = printed()
      .map((line) => /^--- (\S+)/.exec(line)?.[1])
      .filter((name) => name !== undefined);
    expect(headers).toEqual(expect.arrayContaining(["credentials", "host", "container"]));
    expect(printed().some(isStopLine)).toBe(false);
    expect(console.error).not.toHaveBeenCalled();
    const loginProbes = calls.filter((c) => isMergeProbe(c) && c.env.GH_TOKEN === undefined);
    expect(loginProbes.map((c) => parseGhApi(c)!.endpoint)).toEqual([`repos/${FAKE_REPO}/git/refs`]);
  });

  it("a phase that stops while dispatch is paused says after the stop line that dispatch stays paused and how to resume it", () => {
    const { io } = fakeIo({ dispatch: "paused", sessions: liveSession });

    expect(runSetup(["credentials"], base(io))).toBe(1);
    const lines = printed();
    const stop = lines.findIndex(isStopLine);
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(lines.slice(stop + 1)).toEqual([PAUSED_LINE]);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("a phase that stops while dispatch runs prints nothing about pausing", () => {
    const { io, calls } = fakeIo({
      dispatch: "running",
      respond: (c) =>
        c.cmd.endsWith("install-launchd.sh") && c.args[0] === "pause"
          ? { status: 1, stdout: "", stderr: "launchctl: permission denied" }
          : undefined,
    });

    expect(runSetup(["credentials"], base(io))).toBe(1);
    expect(calls.some((c) => c.cmd.endsWith("install-launchd.sh") && c.args[0] === "pause")).toBe(true);
    const lines = printed();
    expect(lines.findIndex(isStopLine)).toBe(lines.length - 1);
    expect(lines.some((line) => /paused/i.test(line))).toBe(false);
    expect(console.error).not.toHaveBeenCalled();
  });
});
