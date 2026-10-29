// The sandbox phase's dry run, its first write of ~/.claude/settings.json and its stops on a
// missing install and on the managed copy, its handling of stale key entries in the managed
// copy (a gone key's entries dropped, a present file's or a glob kept as extras) and of plugin
// list entries without an install path, on the fake SetupIo (fake-io.ts).
import { describe, expect, it } from "vitest";
import { FAKE_HOME, FAKE_REPO, fakeIo, fileWrites, writeCalls } from "./fake-io.ts";
import type { FakeCall, FakeWorld } from "./fake-io.ts";
import type { SetupContext } from "./main.ts";
import { MANAGED_SETTINGS, sandbox, sandboxSettings } from "./sandbox.ts";

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
const isManagedTee = (c: FakeCall) => c.cmd === "sudo" && c.args[0] === "tee" && c.args[1] === MANAGED_SETTINGS;

const asText = (settings: unknown) => `${JSON.stringify(settings, null, 2)}\n`;

/** The settings generated for the world's one key, plus the three deny entries for `path`. */
function withKeyEntries(path: string): Record<string, unknown> {
  const settings = sandboxSettings([KEY], FAKE_HOME) as {
    sandbox: { credentials: { files: unknown[] } };
    permissions: { deny: unknown[] };
  };
  settings.sandbox.credentials.files.push({ path, mode: "deny" });
  settings.permissions.deny.push(`Read(${path})`, `Edit(${path})`);
  return settings;
}

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

  it("overwrites a managed copy holding a gone key's three entries without a to-do, and names the removal", () => {
    const { run, calls, reports } = setup(
      world(SKILL_CURRENT, { [MANAGED_SETTINGS]: asText(withKeyEntries("~/.ssh/old-key")) }),
      false,
    );

    expect(run()).toBe("ok");
    expect(reports.filter((r) => r.status === "todo")).toEqual([]);
    const tees = calls.filter(isManagedTee);
    expect(tees).toHaveLength(1);
    expect(tees[0]!.input).toBe(asText(sandboxSettings([KEY], FAKE_HOME)));
    expect(
      reports.some((r) => r.status === "done" && r.text.includes(MANAGED_SETTINGS) && r.text.includes("~/.ssh/old-key")),
    ).toBe(true);
  });

  it("keeps a still-present file's three entries in the managed copy as extras", () => {
    const managed = asText(withKeyEntries("~/.ssh/legacy-key"));
    const { run, calls, files, reports } = setup(
      world(SKILL_CURRENT, {
        [`${FAKE_HOME}/.ssh/legacy-key`]: "PuTTY-User-Key-File-3: ssh-ed25519\nEncryption: none\n",
        [MANAGED_SETTINGS]: managed,
      }),
      false,
    );

    expect(run()).toBe("stop");
    expect(reports.some((r) => r.status === "todo" && r.text.includes("legacy-key"))).toBe(true);
    expect(calls.filter(isSudo)).toEqual([]);
    expect(files[MANAGED_SETTINGS]).toBe(managed);
  });

  it("keeps a glob deny under ~/.ssh in the managed copy as an extra", () => {
    const settings = sandboxSettings([KEY], FAKE_HOME) as { permissions: { deny: unknown[] } };
    settings.permissions.deny.push("Read(~/.ssh/*)");
    const managed = asText(settings);
    const { run, calls, files, reports } = setup(world(SKILL_CURRENT, { [MANAGED_SETTINGS]: managed }), false);

    expect(run()).toBe("stop");
    expect(reports.some((r) => r.status === "todo" && r.text.includes("~/.ssh/*"))).toBe(true);
    expect(calls.filter(isSudo)).toEqual([]);
    expect(files[MANAGED_SETTINGS]).toBe(managed);
  });

  it("an unrelated plugin list entry without an installPath does not end the run", () => {
    const listing = JSON.stringify([
      { id: PLUGIN, scope: "user", installPath: INSTALL, version: "1.0.0" },
      { id: "other-plugin@elsewhere", scope: "user", version: "1.0.0" },
    ]);
    const isList = (c: FakeCall) => c.cmd === "claude" && c.args.join(" ") === "plugin list --json";
    const { run, files } = setup(
      world(SKILL_CURRENT, {}, { respond: (c) => (isList(c) ? { status: 0, stdout: listing, stderr: "" } : undefined) }),
      false,
    );

    expect(run()).toBe("ok");
    const settings = JSON.parse(files[SETTINGS] ?? "null") as { sandbox: { enabled: boolean } } | null;
    expect(settings?.sandbox.enabled).toBe(true);
  });
});
