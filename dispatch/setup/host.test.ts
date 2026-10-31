// The host phase on the fake SetupIo (fake-io.ts): host-settings.json merged into
// ~/.claude/settings.json.
//
// Report keywords these tests match on (case-insensitive): a leftover block's `note` names
// "sandbox"; a managed settings file's `note` names its path.
import { describe, expect, it } from "vitest";
import { FAKE_HOME, FAKE_REPO, fakeIo, fileWrites, writeCalls } from "./fake-io.ts";
import type { FakeWorld } from "./fake-io.ts";
import { host, hostSettings } from "./host.ts";
import type { SetupContext } from "./main.ts";

const SETTINGS = `${FAKE_HOME}/.claude/settings.json`;
const MANAGED = "/Library/Application Support/ClaudeCode/managed-settings.json";

const text = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

function run(world: FakeWorld = {}, dryRun = false) {
  const fake = fakeIo(world);
  const ctx: SetupContext = {
    io: fake.io,
    dryRun,
    clone: "/clone",
    home: FAKE_HOME,
    repos: [{ repo: FAKE_REPO, dir: "/clone" }],
  };
  return { ...fake, result: host.run(ctx) };
}

/** The deny rules host-settings.json holds. */
const denyRules = () => {
  const deny = (hostSettings().permissions as { deny?: unknown } | undefined)?.deny;
  expect(Array.isArray(deny)).toBe(true);
  return deny as string[];
};

/** Settings that already hold everything the phase merges. */
const complete = (extra: Record<string, unknown> = {}) => ({
  env: { CLAUDE_CODE_ENABLE_CFC: "0" },
  permissions: { deny: denyRules() },
  ...extra,
});

describe("host phase", () => {
  it("CFC=0 and every deny rule are merged after a backup, keeping other entries", () => {
    const before = {
      model: "opus",
      env: { EXAMPLE_VAR: "1" },
      permissions: { allow: ["Bash(ls)"], deny: ["Bash(rm -rf *)"] },
    };
    const { result, files, fileOps } = run({ files: { [SETTINGS]: text(before) } });

    expect(result).toBe("ok");
    const backup = fileOps.findIndex((o) => o.op === "copyFile" && o.path === SETTINGS && o.to?.startsWith(`${SETTINGS}.bak`));
    const write = fileOps.findIndex((o) => o.op === "writeFile" && o.path === SETTINGS);
    expect(backup).toBeGreaterThanOrEqual(0);
    expect(write).toBeGreaterThan(backup);
    const after = JSON.parse(files[SETTINGS]!) as {
      model?: string;
      env?: Record<string, string>;
      permissions?: { allow?: string[]; deny?: string[] };
    };
    expect(after.model).toBe("opus");
    expect(after.env).toEqual({ EXAMPLE_VAR: "1", CLAUDE_CODE_ENABLE_CFC: "0" });
    expect(after.permissions?.allow).toEqual(["Bash(ls)"]);
    const deny = denyRules();
    expect(deny.length).toBeGreaterThan(0);
    expect(deny).toContain("Read(~/.claude/.credentials.json)");
    expect(after.permissions?.deny).toEqual(expect.arrayContaining([...deny, "Bash(rm -rf *)"]));
    expect(new Set(after.permissions?.deny).size).toBe(after.permissions?.deny?.length);
  });

  it("the merged deny rules include reads of the container's Claude token file", () => {
    const { result, files } = run({ files: { [SETTINGS]: text({ model: "opus" }) } });

    expect(result).toBe("ok");
    const after = JSON.parse(files[SETTINGS]!) as { permissions?: { deny?: string[] } };
    expect(after.permissions?.deny).toContain("Read(~/.config/claude-workflow/claude-agent.env)");
  });

  it("settings already holding them are reported already and not written", () => {
    const { result, reports, fileOps, calls } = run({ files: { [SETTINGS]: text(complete({ model: "opus" })) } });

    expect(result).toBe("ok");
    expect(fileWrites(fileOps)).toEqual([]);
    expect(writeCalls(calls)).toEqual([]);
    expect(reports.some((r) => r.status === "already")).toBe(true);
  });

  it("a leftover sandbox block or managed file gets a note and is not changed", () => {
    const settings = complete({ sandbox: { enabled: true, failIfUnavailable: true } });
    const managed = text({ permissions: { deny: ["Read(~/.ssh/**)"] } });
    const { result, reports, files, fileOps, calls } = run({ files: { [SETTINGS]: text(settings), [MANAGED]: managed } });

    expect(result).toBe("ok");
    const notes = reports.filter((r) => r.status === "note").map((r) => r.text);
    expect(notes.some((t) => /sandbox/i.test(t))).toBe(true);
    expect(notes.some((t) => t.includes(MANAGED))).toBe(true);
    expect(fileWrites(fileOps)).toEqual([]);
    expect(writeCalls(calls)).toEqual([]);
    expect(JSON.parse(files[SETTINGS]!)).toEqual(settings);
    expect(files[MANAGED]).toBe(managed);
  });

  it("a settings file that is not a JSON object stops the phase with nothing written", () => {
    for (const bad of ["[1, 2]\n", "{ not json\n", "null\n"]) {
      const { result, reports, files, fileOps } = run({ files: { [SETTINGS]: bad } });

      expect(result, bad).toBe("stop");
      expect(reports.some((r) => r.status === "todo"), bad).toBe(true);
      expect(fileWrites(fileOps), bad).toEqual([]);
      expect(files[SETTINGS], bad).toBe(bad);
    }
  });
});
