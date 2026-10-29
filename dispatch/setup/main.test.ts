import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeIo } from "./fake-io.ts";
import type { SetupIo } from "./io.ts";
import { runSetup } from "./main.ts";

const base = (io: SetupIo) => ({ io, clone: "/clone", home: "/home/example", configPath: "/nonexistent/repos.json" });

describe("runSetup", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("exits 2 and runs nothing on an unknown phase, an unknown flag or a second phase", () => {
    for (const argv of [["nonsense"], ["--force"], ["credentials", "credentials"]]) {
      const { io, calls, reports } = fakeIo();

      expect(runSetup(argv, base(io)), argv.join(" ")).toBe(2);
      expect(calls).toEqual([]);
      expect(reports).toEqual([]);
    }
  });

  it("exits 0 when the phase passes and 1 when it stops", () => {
    expect(runSetup(["credentials"], base(fakeIo({ login: "fine-grained" }).io))).toBe(0);
    const live = fakeIo({ sessions: [{ name: "tools-3", state: "running", startedAt: 1 }] });
    expect(runSetup(["credentials"], base(live.io))).toBe(1);
  });

  it("with --no-managed, the sandbox phase leaves out the managed copy written through sudo", () => {
    const world = () => ({
      plugins: [{ id: "ticket-workflow@askrzypczak-plugins", scope: "user", installPath: "/plugin", version: "1.0.0" }],
      files: { "/plugin/skills/work-ticket/SKILL.md": "Create the branch with `--no-track`.\n" },
    });

    const managed = fakeIo(world());
    expect(runSetup(["sandbox"], base(managed.io))).toBe(0);
    expect(managed.calls.some((c) => c.cmd === "sudo")).toBe(true);

    const skipped = fakeIo(world());
    expect(runSetup(["sandbox", "--no-managed"], base(skipped.io))).toBe(0);
    expect(skipped.calls.some((c) => c.cmd === "sudo")).toBe(false);
  });

  it("exits 1 with a single error line when a read fails", () => {
    const { io } = fakeIo({ fail: (c) => c.cmd === "gh" && c.args[0] === "auth" });

    expect(runSetup(["credentials"], base(io))).toBe(1);
    expect(console.error).toHaveBeenCalledTimes(1);
  });
});
