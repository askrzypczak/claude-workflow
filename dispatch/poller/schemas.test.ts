import { describe, expect, it } from "vitest";
import { ENDED, reconcileAction } from "./decide.ts";
import { parseJson, Sessions } from "./schemas.ts";

// A background session as `claude agents --json --all` listed it in the agent container on
// 2026-11-02 (Claude Code 2.1.309), with `cwd` redacted.
const CAPTURED_BACKGROUND = {
  pid: 349237,
  id: "23e70b04",
  cwd: "/work/claude-workflow/.claude/worktrees/epic-195",
  kind: "background",
  startedAt: 1793598345511,
  sessionId: "23e70b04-0207-4d9e-a89d-aa89823a49f8",
  name: "claude-workflow-epic-195",
  status: "busy",
  state: "working",
};

// An interactive session as 2.1.309 lists it on a host: the fields the ticket reports, with
// illustrative values.
const HOST_INTERACTIVE = {
  pid: 41027,
  cwd: "/work/example-tools",
  kind: "interactive",
  startedAt: 1793598400000,
  sessionId: "00000000-0000-4000-8000-000000000001",
  name: "example-tools",
  status: "busy",
};

const WHAT = "claude agents --json --all";

describe("Sessions", () => {
  it("parses Claude Code 2.1.309 output: keeps the agent container's captured background session and leaves out the host's interactive session", () => {
    const text = JSON.stringify([CAPTURED_BACKGROUND, HOST_INTERACTIVE]);
    expect(parseJson(Sessions, text, WHAT)).toEqual([
      { id: "23e70b04", name: "claude-workflow-epic-195", state: "working", startedAt: 1793598345511 },
    ]);
  });

  it("each state and status value Claude Code 2.1.309 lists counts as live or ended, an ended one reconciles to a hand-off check or a failure, and an interactive entry is left out", () => {
    const background = (fields: Record<string, string>) => ({
      pid: 1000,
      cwd: "/work/example-app",
      kind: "background",
      startedAt: 1793598345511,
      sessionId: "00000000-0000-4000-8000-000000000002",
      name: "app-5",
      ...fields,
    });
    const interactive = (status: string) => ({
      pid: 2000,
      cwd: "/work/example-tools",
      kind: "interactive",
      startedAt: 1793598400000,
      sessionId: "00000000-0000-4000-8000-000000000003",
      name: "example-tools",
      status,
    });
    interface Kept {
      state: string;
      ended: boolean;
      reconcile: ReturnType<typeof reconcileAction>;
    }
    const rows: { label: string; entry: object; expected: Kept | "left out" }[] = [
      {
        label: "background, state working, status busy",
        entry: background({ id: "a0000001", state: "working", status: "busy" }),
        expected: { state: "working", ended: false, reconcile: { action: "keep" } },
      },
      {
        label: "background, state blocked, status waiting",
        entry: background({ id: "a0000002", state: "blocked", status: "waiting" }),
        expected: { state: "blocked", ended: false, reconcile: { action: "keep" } },
      },
      {
        label: "background, state done, status idle",
        entry: background({ id: "a0000003", state: "done", status: "idle" }),
        expected: { state: "done", ended: true, reconcile: { action: "check" } },
      },
      {
        label: "background, state done, no status",
        entry: background({ id: "a0000004", state: "done" }),
        expected: { state: "done", ended: true, reconcile: { action: "check" } },
      },
      {
        label: "background, state failed",
        entry: background({ id: "a0000005", state: "failed" }),
        expected: { state: "failed", ended: true, reconcile: { action: "fail", reason: "session failed" } },
      },
      {
        label: "background, state stopped",
        entry: background({ id: "a0000006", state: "stopped" }),
        expected: { state: "stopped", ended: true, reconcile: { action: "fail", reason: "session stopped" } },
      },
      {
        label: "background, no state, status busy",
        entry: background({ status: "busy" }),
        expected: { state: "working", ended: false, reconcile: { action: "keep" } },
      },
      {
        label: "background, no state, status idle",
        entry: background({ status: "idle" }),
        expected: { state: "working", ended: false, reconcile: { action: "keep" } },
      },
      {
        label: "background, no state, status waiting",
        entry: background({ status: "waiting" }),
        expected: { state: "blocked", ended: false, reconcile: { action: "keep" } },
      },
      { label: "interactive, status busy", entry: interactive("busy"), expected: "left out" },
      { label: "interactive, status idle", entry: interactive("idle"), expected: "left out" },
      { label: "interactive, status waiting", entry: interactive("waiting"), expected: "left out" },
    ];

    for (const { label, entry, expected } of rows) {
      const parsed = parseJson(Sessions, JSON.stringify([entry]), `${WHAT} (${label})`);
      if (expected === "left out") {
        expect(parsed, label).toEqual([]);
        continue;
      }
      expect(
        parsed.map((s) => s.state),
        label,
      ).toEqual([expected.state]);
      const st = parsed[0]?.state;
      expect(st !== undefined && ENDED.includes(st), label).toBe(expected.ended);
      expect(reconcileAction(st, 0), label).toEqual(expected.reconcile);
    }
  });
});
