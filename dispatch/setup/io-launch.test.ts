// The real SetupIo's launch and waitForFile, with a fake claude and files in a temp directory.
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createIo } from "./io.ts";

/** What bash itself may set in a child's environment. */
const BASH_SET = new Set(["PWD", "SHLVL", "_", "OLDPWD"]);

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "io-launch-"));
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("createIo launch", () => {
  it("launch passes exactly the given environment to claude", () => {
    const bin = join(dir, "bin");
    const home = join(dir, "home");
    const work = join(dir, "work");
    mkdirSync(bin);
    mkdirSync(home);
    mkdirSync(work);
    const out = join(dir, "env.txt");
    writeFileSync(join(bin, "claude"), `#!/bin/bash\n/usr/bin/env >${JSON.stringify(out)}\n`);
    chmodSync(join(bin, "claude"), 0o755);
    const env = { HOME: home, PATH: `${bin}:/usr/bin:/bin` };

    createIo().launch(work, "sandbox-probe-test", ["--model", "opus"], "probe the sandbox", env);

    const seen = Object.fromEntries(
      readFileSync(out, "utf8")
        .split("\n")
        .filter((l) => l.includes("="))
        .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
    );
    expect(seen.HOME).toBe(home);
    expect(seen.PATH).toBe(env.PATH);
    const leaked = Object.keys(seen).filter((k) => k !== "HOME" && k !== "PATH" && !BASH_SET.has(k));
    expect(leaked).toEqual([]);
  });
});

describe("createIo waitForFile", () => {
  it("waitForFile returns the text once done holds, and the last text read when the timeout passes", () => {
    const io = createIo();
    const file = join(dir, "result.txt");
    writeFileSync(file, "SANDBOX-PROBE PASS network: refused\nSANDBOX-PROBE END\n");

    expect(io.waitForFile(file, (t) => t.includes("SANDBOX-PROBE END"), 2000)).toBe(
      "SANDBOX-PROBE PASS network: refused\nSANDBOX-PROBE END\n",
    );

    const partial = join(dir, "partial.txt");
    writeFileSync(partial, "SANDBOX-PROBE PASS network: refused\n");
    expect(io.waitForFile(partial, (t) => t.includes("SANDBOX-PROBE END"), 200)).toBe(
      "SANDBOX-PROBE PASS network: refused\n",
    );

    expect(io.waitForFile(join(dir, "never.txt"), () => true, 200)).toBeUndefined();
  });
});
