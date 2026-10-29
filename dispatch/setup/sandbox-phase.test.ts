// The sandbox phase on the fake SetupIo (fake-io.ts): the plugin gate, the merge into
// ~/.claude/settings.json and the managed settings copy written through sudo.
import { describe, expect, it } from "vitest";
import { FAKE_HOME, FAKE_REPO, fakeIo, fileWrites } from "./fake-io.ts";
import type { FakeCall, FakePlugin, FakeWorld } from "./fake-io.ts";
import type { SetupContext } from "./main.ts";
import { MANAGED_SETTINGS, sandbox, sandboxSettings } from "./sandbox.ts";

const CLONE = "/clone";
const PLUGIN = "ticket-workflow@askrzypczak-plugins";
const SETTINGS = `${FAKE_HOME}/.claude/settings.json`;
const CACHE = `${FAKE_HOME}/.claude/plugins/cache/askrzypczak-plugins/ticket-workflow`;
const CURRENT = `${CACHE}/2.0.0`;
const STALE = `${CACHE}/1.0.0`;
const PROJECT_STALE = "/clone/.claude/plugins/ticket-workflow";
const ELSEWHERE_STALE = "/elsewhere/.claude/plugins/ticket-workflow";
/** Sorted, as findPrivateKeys returns them. */
const KEYS = [`${FAKE_HOME}/.ssh/deploy-example-tools`, `${FAKE_HOME}/.ssh/id_ed25519`];

const skill = (dir: string) => `${dir}/skills/work-ticket/SKILL.md`;
const PRIVATE_KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nFAKE-KEY-BODY-FOR-TESTS\n-----END OPENSSH PRIVATE KEY-----\n";
const SKILL_CURRENT = "---\nname: work-ticket\n---\nRun the tracker with `--no-track` when asked.\n";
const SKILL_STALE = "---\nname: work-ticket\n---\nRun the tracker.\n";

const userInstall = (installPath = CURRENT): FakePlugin => ({ id: PLUGIN, scope: "user", installPath, version: "2.0.0" });

const EXISTING = {
  model: "opus",
  env: { MY_VAR: "1" },
  permissions: { allow: ["Bash(ls)"], deny: ["Bash(rm -rf *)"] },
};
const EXISTING_TEXT = `${JSON.stringify(EXISTING, null, 2)}\n`;

/** Two keys in ~/.ssh, a current user-scope install and existing user settings. */
function world(overrides: FakeWorld = {}, files: Record<string, string> = {}): FakeWorld {
  return {
    files: {
      [KEYS[0]!]: PRIVATE_KEY,
      [`${KEYS[0]!}.pub`]: "ssh-ed25519 AAAAFAKEdeploy deploy\n",
      [KEYS[1]!]: PRIVATE_KEY,
      [`${KEYS[1]!}.pub`]: "ssh-ed25519 AAAAFAKEaccount account\n",
      [skill(CURRENT)]: SKILL_CURRENT,
      [skill(STALE)]: SKILL_STALE,
      [skill(PROJECT_STALE)]: SKILL_STALE,
      [skill(ELSEWHERE_STALE)]: SKILL_STALE,
      [SETTINGS]: EXISTING_TEXT,
      ...files,
    },
    plugins: [userInstall()],
    ...overrides,
  };
}

function setup(w: FakeWorld, noManaged?: boolean) {
  const fake = fakeIo(w);
  const ctx: SetupContext = {
    io: fake.io,
    dryRun: false,
    clone: CLONE,
    home: FAKE_HOME,
    repos: [{ repo: FAKE_REPO, dir: CLONE }],
    ...(noManaged === undefined ? {} : { noManaged }),
  };
  return { ...fake, ctx, run: () => sandbox.run(ctx) };
}

const isSudo = (c: FakeCall) => c.cmd === "sudo";
const isPluginList = (c: FakeCall) => c.cmd === "claude" && c.args[0] === "plugin" && c.args[1] === "list";
const isPluginUpdate = (c: FakeCall) =>
  c.cmd === "claude" && c.args[0] === "plugin" && c.args[1] === "update" && c.args.includes(PLUGIN);
const scopeOf = (c: FakeCall) => c.args[c.args.indexOf("--scope") + 1];

interface Settings {
  [key: string]: unknown;
  env: Record<string, string>;
  sandbox: { enabled: boolean; credentials: { files: { path: string }[] } };
  permissions: { allow?: string[]; deny: string[] };
}
const parsed = (text: string | undefined) => JSON.parse(text ?? "null") as Settings;

describe("sandbox phase", () => {
  it("keeps unrelated keys and the existing env and permissions.deny entries of ~/.claude/settings.json", () => {
    const { run, files } = setup(world());

    expect(run()).toBe("ok");
    const settings = parsed(files[SETTINGS]);
    expect(settings.model).toBe("opus");
    expect(settings.env.MY_VAR).toBe("1");
    expect(settings.env.CLAUDE_CODE_PLUGIN_PREFER_HTTPS).toBe("1");
    expect(settings.permissions.allow).toEqual(["Bash(ls)"]);
    expect(settings.permissions.deny[0]).toBe("Bash(rm -rf *)");
    expect(settings.permissions.deny).toEqual(
      expect.arrayContaining(["Read(~/.ssh/id_ed25519)", "Edit(~/.ssh/deploy-example-tools)"]),
    );
    expect(settings.sandbox.enabled).toBe(true);
  });

  it("backs up ~/.claude/settings.json before writing the merged settings", () => {
    const { run, files, fileOps } = setup(world());

    run();
    const backup = fileOps.findIndex(
      (o) => o.op === "copyFile" && o.path === SETTINGS && /settings\.json\.bak-\d{8}-\d{6}$/.test(o.to ?? ""),
    );
    const write = fileOps.findIndex((o) => o.op === "writeFile" && o.path === SETTINGS);
    expect(backup).toBeGreaterThanOrEqual(0);
    expect(write).toBeGreaterThan(backup);
    expect(files[fileOps[backup]!.to!]).toBe(EXISTING_TEXT);
  });

  it("a re-run adds no duplicate, writes neither settings file and reports both as already done", () => {
    const { run, files, fileOps, calls, reports } = setup(world());

    expect(run()).toBe("ok");
    const firstSettings = files[SETTINGS];
    const firstManaged = files[MANAGED_SETTINGS];
    const opsBefore = fileOps.length;
    const callsBefore = calls.length;
    const reportsBefore = reports.length;

    expect(run()).toBe("ok");
    expect(fileWrites(fileOps.slice(opsBefore))).toEqual([]);
    expect(calls.slice(callsBefore).filter(isSudo)).toEqual([]);
    expect(files[SETTINGS]).toBe(firstSettings);
    expect(files[MANAGED_SETTINGS]).toBe(firstManaged);

    const settings = parsed(files[SETTINGS]);
    expect(new Set(settings.permissions.deny).size).toBe(settings.permissions.deny.length);
    const paths = settings.sandbox.credentials.files.map((f) => f.path);
    expect(new Set(paths).size).toBe(paths.length);

    const already = reports.slice(reportsBefore).filter((r) => r.status === "already");
    expect(already.some((r) => /managed/i.test(r.text))).toBe(true);
    expect(already.some((r) => !/managed/i.test(r.text) && /settings\.json/.test(r.text))).toBe(true);
  });

  it("an unparseable or non-object ~/.claude/settings.json stops the phase with a to-do and writes nothing", () => {
    for (const text of ["{ not json", "[1, 2]\n", "\"text\"\n"]) {
      const { run, files, fileOps, calls, reports } = setup(world({}, { [SETTINGS]: text }));

      expect(run(), text).toBe("stop");
      expect(reports.some((r) => r.status === "todo"), text).toBe(true);
      expect(fileWrites(fileOps), text).toEqual([]);
      expect(calls.filter(isSudo), text).toEqual([]);
      expect(files[SETTINGS], text).toBe(text);
    }
  });

  it("runs claude plugin update for a stale install and re-checks", () => {
    const { run, calls, fileOps } = setup(
      world({ plugins: [userInstall(STALE)], pluginUpdate: { installPath: CURRENT, version: "2.0.0" } }),
    );

    expect(run()).toBe("ok");
    const update = calls.findIndex(isPluginUpdate);
    expect(update).toBeGreaterThanOrEqual(0);
    expect(scopeOf(calls[update]!)).toBe("user");
    expect(calls.slice(update + 1).some(isPluginList)).toBe(true);
    expect(fileOps.some((o) => o.op === "writeFile" && o.path === SETTINGS)).toBe(true);
  });

  it("writes no settings while an installed work-ticket skill still lacks --no-track after the update, and says why", () => {
    const { run, calls, fileOps, reports } = setup(world({ plugins: [userInstall(STALE)] }));

    expect(run()).toBe("stop");
    expect(calls.some(isPluginUpdate)).toBe(true);
    expect(reports.some((r) => r.status === "todo" && r.text.includes("--no-track"))).toBe(true);
    expect(fileWrites(fileOps)).toEqual([]);
    expect(calls.filter(isSudo)).toEqual([]);
  });

  it("checks a served repo's project-scope install as well as the user-scope one", () => {
    const served: FakePlugin = { id: PLUGIN, scope: "project", installPath: PROJECT_STALE, version: "1.0.0", projectPath: CLONE };
    const elsewhere: FakePlugin = { id: PLUGIN, scope: "project", installPath: ELSEWHERE_STALE, version: "1.0.0", projectPath: "/elsewhere" };

    const stale = setup(world({ plugins: [userInstall(), served, elsewhere] }));
    expect(stale.run()).toBe("stop");
    expect(fileWrites(stale.fileOps)).toEqual([]);
    expect(stale.calls.filter(isSudo)).toEqual([]);
    const updates = stale.calls.filter(isPluginUpdate);
    expect(updates.some((c) => scopeOf(c) === "project" && c.cwd === CLONE)).toBe(true);
    expect(updates.some((c) => c.cwd === "/elsewhere")).toBe(false);

    const ignored = setup(world({ plugins: [userInstall(), elsewhere] }));
    expect(ignored.run()).toBe("ok");
    expect(ignored.calls.filter(isPluginUpdate).some((c) => c.cwd === "/elsewhere")).toBe(false);
  });

  it("writes the managed copy through sudo when its content differs", () => {
    const { run, calls, files } = setup(world());

    expect(run()).toBe("ok");
    const expected = sandboxSettings(KEYS, FAKE_HOME);
    const sudo = calls.filter(isSudo);
    const tee = sudo.find((c) => c.args[0] === "tee" && c.args[1] === MANAGED_SETTINGS);
    expect(tee).toBeDefined();
    expect(tee!.input).toBe(`${JSON.stringify(expected, null, 2)}\n`);
    expect(sudo.findIndex((c) => c.args[0] === "mkdir")).toBeLessThan(sudo.indexOf(tee!));
    expect(JSON.parse(files[MANAGED_SETTINGS] ?? "null")).toEqual(expected);
  });

  it("stops with a to-do naming the managed file's extra entries, and writes nothing", () => {
    const managed = `${JSON.stringify({ ...sandboxSettings(KEYS, FAKE_HOME), extraManagedKey: true }, null, 2)}\n`;
    const { run, calls, files, reports } = setup(world({}, { [MANAGED_SETTINGS]: managed }));

    expect(run()).toBe("stop");
    expect(reports.some((r) => r.status === "todo" && r.text.includes("extraManagedKey"))).toBe(true);
    expect(calls.filter(isSudo)).toEqual([]);
    expect(files[MANAGED_SETTINGS]).toBe(managed);
  });

  it("with --no-managed, does not write the managed copy", () => {
    const { run, calls, files, reports } = setup(world(), true);

    expect(run()).toBe("ok");
    expect(calls.filter(isSudo)).toEqual([]);
    expect(files[MANAGED_SETTINGS]).toBeUndefined();
    expect(parsed(files[SETTINGS]).sandbox.enabled).toBe(true);
    expect(reports.some((r) => r.status === "note")).toBe(true);
  });
});
