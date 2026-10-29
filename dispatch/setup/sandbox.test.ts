// The sandbox settings: what the phase generates for a key list, and the check that reports
// what a settings object lacks.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { missingSandboxSettings, sandboxSettings } from "./sandbox.ts";

const HOME = "/home/example";
const ACCOUNT = `${HOME}/.ssh/id_ed25519`;
const DEPLOY = `${HOME}/.ssh/deploy-example-tools`;

interface Template {
  env: Record<string, string>;
  sandbox: { credentials: { files: { path: string; mode: string }[] } };
  permissions: { deny: string[] };
}

const template = JSON.parse(
  readFileSync(new URL("./sandbox-settings.json", import.meta.url), "utf8"),
) as Template;

/** The fewest settings that pass for `names` (files in ~/.ssh). */
function passing(names: readonly string[]) {
  return {
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      allowUnsandboxedCommands: false,
      credentials: { files: names.map((n) => ({ path: `~/.ssh/${n}`, mode: "deny" })) },
    },
    permissions: { deny: names.flatMap((n) => [`Read(~/.ssh/${n})`, `Edit(~/.ssh/${n})`]) },
  };
}

describe("sandbox settings", () => {
  it("the generated settings for two keys deny exactly those two, in credentials.files and as Read and Edit rules", () => {
    const settings = sandboxSettings([ACCOUNT, DEPLOY], HOME) as unknown as Template;
    const files = settings.sandbox.credentials.files;
    const deny = settings.permissions.deny;

    expect(files.filter((f) => f.path.startsWith("~/.ssh/"))).toEqual(
      expect.arrayContaining([
        { path: "~/.ssh/id_ed25519", mode: "deny" },
        { path: "~/.ssh/deploy-example-tools", mode: "deny" },
      ]),
    );
    expect(files.filter((f) => f.path.includes(".ssh"))).toHaveLength(2);
    expect(deny.filter((r) => r.includes(".ssh")).sort()).toEqual(
      [
        "Read(~/.ssh/id_ed25519)",
        "Edit(~/.ssh/id_ed25519)",
        "Read(~/.ssh/deploy-example-tools)",
        "Edit(~/.ssh/deploy-example-tools)",
      ].sort(),
    );
    expect(files).toEqual(expect.arrayContaining(template.sandbox.credentials.files));
    expect(deny).toEqual(expect.arrayContaining(template.permissions.deny));
    expect(settings.env).toEqual(template.env);
  });

  it("the expected-settings check reports sandbox.enabled, failIfUnavailable and allowUnsandboxedCommands when missing or wrong", () => {
    const names = ["id_ed25519"];
    const keys = [ACCOUNT];
    expect(missingSandboxSettings(passing(names), keys, HOME)).toEqual([]);

    const cases: [string, (s: ReturnType<typeof passing>) => void][] = [
      ["enabled", (s) => delete (s.sandbox as Partial<typeof s.sandbox>).enabled],
      ["enabled", (s) => ((s.sandbox as Record<string, unknown>).enabled = false)],
      ["failIfUnavailable", (s) => delete (s.sandbox as Partial<typeof s.sandbox>).failIfUnavailable],
      ["failIfUnavailable", (s) => ((s.sandbox as Record<string, unknown>).failIfUnavailable = false)],
      ["allowUnsandboxedCommands", (s) => delete (s.sandbox as Partial<typeof s.sandbox>).allowUnsandboxedCommands],
      ["allowUnsandboxedCommands", (s) => ((s.sandbox as Record<string, unknown>).allowUnsandboxedCommands = true)],
    ];
    for (const [name, change] of cases) {
      const settings = passing(names);
      change(settings);
      const missing = missingSandboxSettings(settings, keys, HOME);
      expect(missing, name).toHaveLength(1);
      expect(missing[0], name).toContain(name);
    }

    for (const settings of [{}, undefined, "not an object"]) {
      const missing = missingSandboxSettings(settings, [], HOME);
      expect(missing).toHaveLength(3);
      for (const name of ["enabled", "failIfUnavailable", "allowUnsandboxedCommands"]) {
        expect(missing.some((line) => line.includes(name)), name).toBe(true);
      }
    }
  });

  it("the expected-settings check reports each of a key's three entries when missing", () => {
    const names = ["id_ed25519", "deploy-example-tools"];
    const keys = [ACCOUNT, DEPLOY];

    const noFile = passing(names);
    noFile.sandbox.credentials.files = noFile.sandbox.credentials.files.filter((f) => !f.path.endsWith("/deploy-example-tools"));
    const fileMissing = missingSandboxSettings(noFile, keys, HOME);
    expect(fileMissing).toHaveLength(1);
    expect(fileMissing[0]).toContain("~/.ssh/deploy-example-tools");

    for (const rule of ["Read", "Edit"]) {
      const settings = passing(names);
      settings.permissions.deny = settings.permissions.deny.filter((r) => r !== `${rule}(~/.ssh/deploy-example-tools)`);
      const missing = missingSandboxSettings(settings, keys, HOME);
      expect(missing, rule).toHaveLength(1);
      expect(missing[0], rule).toContain(rule);
      expect(missing[0], rule).toContain("~/.ssh/deploy-example-tools");
    }

    const none = passing(["id_ed25519"]);
    const allMissing = missingSandboxSettings(none, keys, HOME);
    expect(allMissing).toHaveLength(3);
    expect(allMissing.every((line) => line.includes("deploy-example-tools"))).toBe(true);
    expect(allMissing.some((line) => line.includes("Read"))).toBe(true);
    expect(allMissing.some((line) => line.includes("Edit"))).toBe(true);
  });

  it("the expected-settings check passes the generated settings", () => {
    const keys = [DEPLOY, ACCOUNT];
    expect(missingSandboxSettings(sandboxSettings(keys, HOME), keys, HOME)).toEqual([]);
    expect(missingSandboxSettings(sandboxSettings([], HOME), [], HOME)).toEqual([]);
  });
});
