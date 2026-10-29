import { afterEach, describe, expect, it, vi } from "vitest";
import { createIo } from "./io.ts";

const PRINT = "process.stdout.write(JSON.stringify([process.env.GH_TOKEN ?? null, process.env.GITHUB_TOKEN ?? null, process.env.EXTRA ?? null, require('fs').readFileSync(0, 'utf8')]))";

describe("createIo().run", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("gives the child this environment without GH_TOKEN or GITHUB_TOKEN, plus the call's env and input", () => {
    vi.stubEnv("GH_TOKEN", "from-the-shell");
    vi.stubEnv("GITHUB_TOKEN", "from-the-shell");

    const result = createIo().run(process.execPath, ["-e", PRINT], { env: { EXTRA: "added" }, input: "stdin text" });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([null, null, "added", "stdin text"]);
  });

  it("returns exit 127 for a command that cannot start, instead of throwing", () => {
    const result = createIo().run("/nonexistent/command", []);

    expect(result.status).toBe(127);
  });
});
