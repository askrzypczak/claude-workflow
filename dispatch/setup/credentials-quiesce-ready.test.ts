// The credentials phase's session check against an agent container that is running but has not
// logged its readiness line yet, on the fake SetupIo (fake-io.ts): nothing may run in it.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fakeIo, parseDockerExec, protectMain, writeCalls } from "./fake-io.ts";
import { runSetup } from "./main.ts";

describe("credentials phase with a starting container", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a running container with no readiness line yet stops the phase and runs nothing in it", () => {
    const { io, calls } = fakeIo({
      rulesets: [protectMain()],
      allowAutoMerge: true,
      docker: {
        container: { state: "running", log: [] },
        sessions: [{ id: "c0ffee01", name: "tools-12", state: "running", startedAt: 1 }],
      },
    });

    const code = runSetup(["credentials"], { io, clone: "/clone", home: "/home/example", configPath: "/nonexistent/repos.json" });

    expect(code).toBe(1);
    expect(calls.some((c) => parseDockerExec(c) !== undefined)).toBe(false);
    expect(writeCalls(calls).filter((c) => c.cmd === "gh")).toEqual([]);
  });
});
