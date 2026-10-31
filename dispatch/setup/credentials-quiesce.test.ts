// The credentials phase's first step on the fake SetupIo (fake-io.ts): it refuses to go on
// while a session is live on the host or in the agent container.
//
// Report keywords these tests match on (case-insensitive): a live session's to-do names its
// fix, `claude stop <id>` (for a container session, run through `docker exec … claude-workflow-agent`);
// with no container to read, a `note` naming "container".
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { credentials } from "./credentials.ts";
import { FAKE_REPO, fakeIo, parseDockerExec, protectMain, writeCalls } from "./fake-io.ts";
import type { FakeCall, FakeWorld } from "./fake-io.ts";
import { runSetup } from "./main.ts";

const CLONE = "/clone";
const HOME = "/home/example";

function run(world: FakeWorld) {
  const fake = fakeIo(world);
  const result = credentials.run({
    io: fake.io,
    dryRun: false,
    clone: CLONE,
    home: HOME,
    repos: [{ repo: FAKE_REPO }],
  });
  return { ...fake, result };
}

/** GitHub writes: the gh calls among the write commands. */
const githubWrites = (calls: readonly FakeCall[]) => writeCalls(calls).filter((c) => c.cmd === "gh");
/** A world where the phase would write to GitHub: no restrict-updates yet, auto-merge on. */
const wouldWrite: FakeWorld = { rulesets: [protectMain()], allowAutoMerge: true };

describe("credentials phase sessions", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a live container session stops the phase with a docker exec … claude stop <id> to-do, before any GitHub write", () => {
    const { result, reports, calls } = run({
      ...wouldWrite,
      docker: {
        container: { state: "running" },
        sessions: [
          { id: "c0ffee01", name: "tools-12", state: "running", startedAt: 1 },
          { id: "c0ffee02", name: "tools-9", state: "done", startedAt: 1 },
        ],
      },
    });

    expect(result).toBe("stop");
    const todos = reports.filter((r) => r.status === "todo").map((r) => r.text);
    expect(todos.some((t) => /docker exec .*claude-workflow-agent claude stop c0ffee01/.test(t))).toBe(true);
    expect(todos.some((t) => t.includes("c0ffee02"))).toBe(false);
    expect(githubWrites(calls)).toEqual([]);
    const listed = calls.map(parseDockerExec).some((x) => x?.command[0] === "claude" && x.command[1] === "agents");
    expect(listed).toBe(true);
  });

  it("no running container, or docker unreachable, passes with a note", () => {
    const worlds: [string, FakeWorld["docker"]][] = [
      ["docker unreachable", undefined],
      ["no container", {}],
      ["stopped container", { container: { state: "stopped" } }],
    ];
    for (const [label, docker] of worlds) {
      const { result, reports } = run({ login: "fine-grained", ...(docker === undefined ? {} : { docker }) });

      expect(result, label).toBe("ok");
      expect(reports.some((r) => r.status === "note" && /container/i.test(r.text)), label).toBe(true);
    }
  });

  it("an unreadable container session list stops the phase", () => {
    const unreadable = (c: FakeCall) => {
      const x = parseDockerExec(c);
      return x?.command[0] === "claude" && x.command[1] === "agents"
        ? { status: 1, stdout: "", stderr: "claude: could not read the session list" }
        : undefined;
    };
    const { io, calls } = fakeIo({ ...wouldWrite, docker: { container: { state: "running" } }, respond: unreadable });

    const code = runSetup(["credentials"], { io, clone: CLONE, home: HOME, configPath: "/nonexistent/repos.json" });

    expect(code).toBe(1);
    expect(calls.some((c) => unreadable(c) !== undefined)).toBe(true);
    expect(githubWrites(calls)).toEqual([]);
  });

  it("a live host session's to-do names claude stop <id>", () => {
    const { result, reports } = run({
      sessions: [{ id: "abc123", name: "tools-3", state: "running", startedAt: 1 }],
    });

    expect(result).toBe("stop");
    const todos = reports.filter((r) => r.status === "todo").map((r) => r.text);
    expect(todos.some((t) => t.includes("claude stop abc123") && !t.includes("docker exec"))).toBe(true);
  });
});
