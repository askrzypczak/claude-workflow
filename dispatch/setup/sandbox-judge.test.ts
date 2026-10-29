// judgeSandbox on the fake SetupIo (fake-io.ts): the settings file a session would run under,
// judged against the settings generated for the keys in ~/.ssh.
import { describe, expect, it } from "vitest";
import { FAKE_HOME, fakeIo } from "./fake-io.ts";
import type { SetupIo } from "./io.ts";
import { judgeSandbox, sandboxSettings } from "./sandbox.ts";

const SETTINGS = `${FAKE_HOME}/.claude/settings.json`;
const MANAGED = "/managed/managed-settings.json";
/** Sorted, as findPrivateKeys returns them. */
const KEYS = [`${FAKE_HOME}/.ssh/deploy-example-tools`, `${FAKE_HOME}/.ssh/id_ed25519`];
const PRIVATE_KEY = "-----BEGIN OPENSSH PRIVATE KEY-----\nFAKE-KEY-BODY-FOR-TESTS\n-----END OPENSSH PRIVATE KEY-----\n";

const keyFiles = (): Record<string, string> => ({
  [KEYS[0]!]: PRIVATE_KEY,
  [`${KEYS[0]!}.pub`]: "ssh-ed25519 AAAAFAKEdeploy deploy\n",
  [KEYS[1]!]: PRIVATE_KEY,
  [`${KEYS[1]!}.pub`]: "ssh-ed25519 AAAAFAKEaccount account\n",
});

const text = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

describe("judgeSandbox", () => {
  it("an entry in ~/.ssh that cannot be read fails the judgement instead of throwing", () => {
    const { io } = fakeIo({ files: { ...keyFiles(), [SETTINGS]: text(sandboxSettings(KEYS, FAKE_HOME)) } });
    const unreadable = KEYS[1]!;
    const wrapped: SetupIo = {
      ...io,
      readFirstLine(path) {
        if (path === unreadable) {
          throw Object.assign(new Error(`EACCES: permission denied, open '${path}'`), { code: "EACCES" });
        }
        return io.readFirstLine(path);
      },
    };

    let judgement: ReturnType<typeof judgeSandbox> | undefined;
    expect(() => {
      judgement = judgeSandbox(wrapped, FAKE_HOME, MANAGED);
    }).not.toThrow();
    expect(judgement?.missing.length).toBeGreaterThan(0);
    expect(judgement?.missing.some((line) => line.includes(".ssh"))).toBe(true);
  });

  it("a missing or invalid settings file fails the judgement, naming the file", () => {
    const cases: [string, Record<string, string>][] = [
      ["missing", {}],
      ["invalid JSON", { [SETTINGS]: "{not json" }],
      ["not an object", { [SETTINGS]: "[]\n" }],
    ];
    for (const [label, files] of cases) {
      const { io } = fakeIo({ files: { ...keyFiles(), ...files } });

      const judgement = judgeSandbox(io, FAKE_HOME, MANAGED);
      expect(judgement.file, label).toBe(SETTINGS);
      expect(judgement.missing.length, label).toBeGreaterThan(0);
      expect(judgement.missing.some((line) => line.includes(SETTINGS)), label).toBe(true);
    }

    // A read that throws is judged the same way.
    const { io } = fakeIo({ files: keyFiles() });
    const throwing: SetupIo = {
      ...io,
      readFile(path) {
        if (path === SETTINGS) throw Object.assign(new Error(`EACCES: permission denied, open '${path}'`), { code: "EACCES" });
        return io.readFile(path);
      },
    };
    const judgement = judgeSandbox(throwing, FAKE_HOME, MANAGED);
    expect(judgement.file).toBe(SETTINGS);
    expect(judgement.missing.some((line) => line.includes(SETTINGS))).toBe(true);
  });

  it("a generated entry missing from the judged file, such as strictAllowlist, fails the judgement", () => {
    const complete = sandboxSettings(KEYS, FAKE_HOME) as {
      model?: string;
      sandbox: { network: { strictAllowlist?: boolean } };
    };
    const withExtras = { ...structuredClone(complete), model: "opus" };
    const lacking = structuredClone(complete);
    delete lacking.sandbox.network.strictAllowlist;

    const passing = judgeSandbox(fakeIo({ files: { ...keyFiles(), [SETTINGS]: text(withExtras) } }).io, FAKE_HOME, MANAGED);
    expect(passing.missing).toEqual([]);
    expect(passing.keys).toEqual(KEYS);

    const judgement = judgeSandbox(fakeIo({ files: { ...keyFiles(), [SETTINGS]: text(lacking) } }).io, FAKE_HOME, MANAGED);
    expect(judgement.file).toBe(SETTINGS);
    expect(judgement.missing.length).toBeGreaterThan(0);
    expect(judgement.missing.every((line) => line.includes("sandbox.network.strictAllowlist"))).toBe(true);
  });
});
