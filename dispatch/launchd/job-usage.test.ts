// Tests for the job's argument handling: runJob in dispatch/launchd/job.ts, and dispatch/launchd/job.sh.
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FAKE_HOME, fakeIo } from "../setup/fake-io.ts";
import { runJob } from "./job.ts";

const ROOT = resolve(import.meta.dirname, "../..");

afterEach(() => vi.restoreAllMocks());

describe("runJob", () => {
  it("returns 2 on a usage error and runs nothing", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    for (const argv of [["bogus"], ["deps", "halt"], ["--dry-run", "extra"], ["--yes"]]) {
      const { io, calls } = fakeIo({ docker: {} });

      expect(runJob(argv, { io, clone: "/clone", home: FAKE_HOME }), argv.join(" ")).toBe(2);
      expect(calls, argv.join(" ")).toEqual([]);
    }
  });

  it("routes halt to the halt step, which says no container session can be live when docker does not answer", () => {
    const printed: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => void printed.push(args.map(String).join(" ")));
    const { io } = fakeIo({ docker: { reachable: false } });

    expect(runJob(["halt"], { io, clone: "/clone", home: FAKE_HOME })).toBe(0);
    expect(printed.join("\n")).toContain("no container session can be live");
  });
});

describe("job.sh", () => {
  it("exits 2 with the usage on an unknown argument", () => {
    // A usage error: the job stops before it runs any command. The running node (24 or later)
    // comes first on the job's PATH.
    const r = spawnSync("bash", ["dispatch/launchd/job.sh", "bogus"], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, EXTRA_PATH: dirname(process.execPath) },
    });

    expect(r.status, r.stdout + r.stderr).toBe(2);
    expect(r.stderr).toContain("Usage:");
  });
});
