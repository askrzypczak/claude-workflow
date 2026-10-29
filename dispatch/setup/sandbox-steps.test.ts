// The sandbox phase's dry run, its first write of ~/.claude/settings.json and its stops on a
// missing install and on the managed copy, on the fake SetupIo (fake-io.ts).
import { describe, expect, it } from "vitest";
import { FAKE_HOME, FAKE_REPO, fakeIo, fileWrites, writeCalls } from "./fake-io.ts";
import type { FakeCall, FakeWorld } from "./fake-io.ts";
import type { SetupContext } from "./main.ts";
import { MANAGED_SETTINGS, sandbox } from "./sandbox.ts";

const CLONE = "/clone";
const PLUGIN = "ticket-workflow@askrzypczak-plugins";
const INSTALL = "/plugins/ticket-workflow";
const SETTINGS = `${FAKE_HOME}/.claude/settings.json`;
const SKILL = `${INSTALL}/skills/work-ticket/SKILL.md`;
const KEY = `${FAKE_HOME}/.ssh/id_ed25519`;
const SKILL_CURRENT = "Create the branch with `--no-track`.\n";

function world(skill: string, files: Record<string, string> = {}, overrides: FakeWorld = {}): FakeWorld {
  return {
    plugins: [{ id: PLUGIN, scope: "user", installPath: INSTALL, version: "1.0.0" }],
    files: {
      [SKILL]: skill,
      [KEY]: "-----BEGIN OPENSSH PRIVATE KEY-----\nFAKE-KEY-BODY-FOR-TESTS\n-----END OPENSSH PRIVATE KEY-----\n",
      ...files,
    },
    ...overrides,
  };
}

const isSudo = (c: FakeCall) => c.cmd === "sudo";

function setup(w: FakeWorld, dryRun: boolean) {
  const fake = fakeIo(w);
  const ctx: SetupContext = { io: fake.io, dryRun, clone: CLONE, home: FAKE_HOME, repos: [{ repo: FAKE_REPO, dir: CLONE }] };
  return { ...fake, run: () => sandbox.run(ctx) };
}

describe("sandbox phase steps", () => {
  it("a dry run changes nothing and goes on past a stale skill and an unparseable settings file to the managed copy", () => {
    const { run, calls, fileOps, reports } = setup(world("Run the tracker.\n", { [SETTINGS]: "{ not json" }), true);

    expect(run()).toBe("ok");
    expect(writeCalls(calls)).toEqual([]);
    expect(fileWrites(fileOps)).toEqual([]);
    expect(reports.some((r) => r.status === "todo" && r.text.includes("settings.json"))).toBe(true);
    expect(reports.some((r) => r.status === "would" && r.text.includes(MANAGED_SETTINGS))).toBe(true);
  });

  it("creates a missing ~/.claude/settings.json with the sandbox settings, with no backup", () => {
    const { run, files, fileOps } = setup(world(SKILL_CURRENT), false);

    expect(run()).toBe("ok");
    expect(fileOps.some((o) => o.op === "copyFile")).toBe(false);
    const settings = JSON.parse(files[SETTINGS] ?? "null") as { sandbox: { enabled: boolean }; permissions: { deny: string[] } };
    expect(settings.sandbox.enabled).toBe(true);
    expect(settings.permissions.deny).toEqual(expect.arrayContaining(["Read(~/.ssh/id_ed25519)", "Edit(~/.ssh/id_ed25519)"]));
  });

  it("stops with a to-do and writes nothing when no install is checked", () => {
    const { run, calls, fileOps, reports } = setup(world(SKILL_CURRENT, {}, { plugins: [] }), false);

    expect(run()).toBe("stop");
    expect(reports.some((r) => r.status === "todo" && r.text.includes("claude plugin install"))).toBe(true);
    expect(fileWrites(fileOps)).toEqual([]);
    expect(calls.filter(isSudo)).toEqual([]);
  });

  it("a failed sudo tee is a to-do that stops the phase, and the managed copy is not written", () => {
    const { run, files, reports } = setup(
      world(SKILL_CURRENT, {}, { fail: (c) => c.cmd === "sudo" && c.args[0] === "tee" }),
      false,
    );

    expect(run()).toBe("stop");
    expect(reports.some((r) => r.status === "todo" && r.text.includes(MANAGED_SETTINGS))).toBe(true);
    expect(files[MANAGED_SETTINGS]).toBeUndefined();
  });

  it("an unparseable managed settings copy stops the phase with a to-do, runs no sudo and leaves the file as it is", () => {
    const managed = "{ not json";
    const { run, calls, files, reports } = setup(world(SKILL_CURRENT, { [MANAGED_SETTINGS]: managed }), false);

    expect(run()).toBe("stop");
    expect(reports.some((r) => r.status === "todo")).toBe(true);
    expect(calls.filter(isSudo)).toEqual([]);
    expect(files[MANAGED_SETTINGS]).toBe(managed);
  });
});
