// The check phase's pieces: the poller's session environment, the probe result parser and
// the probe script, run with fake binaries in temp directories.
import { spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseProbeResult, pollerEnv, probeItems } from "./check.ts";

const POLLER_SCRIPT = join(import.meta.dirname, "..", "agent-poller.sh");
const PLIST = join(import.meta.dirname, "..", "launchd", "com.askrzypczak.claude-workflow-poller.plist");
const PROBE_SCRIPT = join(import.meta.dirname, "sandbox-probe.sh");
const REPO = "example-owner/example-tools";
/** The items the session appends after the script's. */
const SESSION_ITEMS = ["read-tool", "git-fetch", "git-push", "browser-tools"];

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "check-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function writeScript(path: string, body: string): void {
  writeFileSync(path, `#!/bin/bash\n${body}\n`);
  chmodSync(path, 0o755);
}

const keysIn = (home: string) => [join(home, ".ssh", "deploy-example-tools"), join(home, ".ssh", "id_ed25519")];
const pass = (item: string) => `SANDBOX-PROBE PASS ${item}: ok`;
const fail = (item: string) => `SANDBOX-PROBE FAIL ${item}: refused nothing`;
const END = "SANDBOX-PROBE END";

describe("pollerEnv", () => {
  it("pollerEnv's PATH is the PATH dispatch/agent-poller.sh builds from the plist's environment", () => {
    const home = join(dir, "home");
    const nodeBin = join(home, ".local", "share", "fnm", "aliases", "default", "bin");
    mkdirSync(nodeBin, { recursive: true });
    const out = join(dir, "path.txt");
    writeScript(
      join(nodeBin, "node"),
      `if [ "$1" = "-p" ]; then echo 24; exit 0; fi\nprintf '%s' "$PATH" >${JSON.stringify(out)}`,
    );
    const plistPath = /<key>PATH<\/key>\s*<string>([^<]*)<\/string>/.exec(readFileSync(PLIST, "utf8"))?.[1];
    expect(plistPath).toBeDefined();

    const r = spawnSync("/bin/bash", [POLLER_SCRIPT], {
      encoding: "utf8",
      env: { HOME: home, PATH: plistPath!.replaceAll("__HOME__", home) },
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);

    expect(pollerEnv(home)).toEqual({ HOME: home, PATH: readFileSync(out, "utf8") });
  });
});

describe("parseProbeResult", () => {
  const keys = ["/home/example/.ssh/deploy-example-tools", "/home/example/.ssh/id_ed25519"];

  it("a FAIL line fails the check", () => {
    const items = probeItems(keys);
    const failing = items[1]!;
    const lines = items.map((i) => (i === failing ? fail(i) : pass(i)));

    const result = parseProbeResult([...lines, END, ""].join("\n"), items);
    expect(result.finished).toBe(true);
    expect(result.verdicts.find((v) => v.item === failing)?.pass).toBe(false);
    expect(result.verdicts.filter((v) => v.item !== failing).every((v) => v.pass)).toBe(true);

    // A FAIL line beats a PASS line for the same item.
    const both = parseProbeResult([...items.map(pass), fail(failing), END].join("\n"), items);
    expect(both.verdicts.find((v) => v.item === failing)?.pass).toBe(false);
  });

  it("a missing item line fails the check", () => {
    const items = probeItems(keys);
    const absent = items[items.length - 1]!;

    const result = parseProbeResult([...items.filter((i) => i !== absent).map(pass), END].join("\n"), items);
    expect(result.verdicts.map((v) => v.item)).toEqual(items);
    expect(result.verdicts.find((v) => v.item === absent)?.pass).toBe(false);
  });

  it("a result without the END line fails the check as unfinished", () => {
    const items = probeItems(keys);

    expect(parseProbeResult(items.map(pass).join("\n"), items).finished).toBe(false);
    expect(parseProbeResult(undefined, items).finished).toBe(false);
  });

  it("every item PASS followed by END passes", () => {
    const items = probeItems(keys);

    const result = parseProbeResult([...items.map(pass), END, ""].join("\n"), items);
    expect(result.finished).toBe(true);
    expect(result.verdicts.map((v) => v.item)).toEqual(items);
    expect(result.verdicts.every((v) => v.pass)).toBe(true);
  });
});

describe("sandbox-probe.sh", () => {
  it("the probe script writes one PASS or FAIL line per script item under the prefix the parser reads", () => {
    const home = join(dir, "home");
    const bin = join(dir, "bin");
    mkdirSync(join(home, ".ssh"), { recursive: true });
    mkdirSync(bin);
    const keys = keysIn(home);
    for (const key of keys) writeFileSync(key, "FAKE-KEY-BODY-FOR-TESTS\n");
    writeScript(join(bin, "gh"), `echo ${REPO}`);
    writeScript(join(bin, "curl"), "exit 7");
    const result = join(dir, "result.txt");
    const scriptItems = probeItems(keys).filter((i) => !SESSION_ITEMS.includes(i));

    const r = spawnSync("/bin/bash", [PROBE_SCRIPT, result, REPO, ...keys], {
      encoding: "utf8",
      env: { HOME: home, PATH: `${bin}:/usr/bin:/bin` },
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);

    expect(existsSync(result), "the result file").toBe(true);
    const lines = readFileSync(result, "utf8").split("\n");
    expect(scriptItems.length).toBeGreaterThan(0);
    for (const item of scriptItems) {
      const matching = lines.filter(
        (l) => l.startsWith(`SANDBOX-PROBE PASS ${item}: `) || l.startsWith(`SANDBOX-PROBE FAIL ${item}: `),
      );
      expect(matching, item).toHaveLength(1);
    }
  });
});
