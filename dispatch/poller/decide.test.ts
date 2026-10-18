import { describe, expect, it } from "vitest";
import {
  alreadyAttempted,
  atCap,
  conflictIssueVerdict,
  conflictRemains,
  conflictVerdict,
  handedOff,
  hasBypassFlag,
  liveByPrefix,
  liveCount,
  reconcileAction,
  sessionState,
  ticketPrompt,
  ticketVerdict,
} from "./decide.ts";
import type { IssueRow, Launched, PrRow, Session } from "./schemas.ts";

const session = (name: string, state: string, startedAt = 1): Session => ({ name, state, startedAt });

describe("sessionState", () => {
  it("is the state of the newest session with that name", () => {
    const sessions = [session("a-1", "done", 300), session("a-1", "working", 500), session("a-1", "failed", 100)];
    expect(sessionState(sessions, "a-1")).toBe("working");
  });

  it("is undefined when no session has that name", () => {
    expect(sessionState([session("a-1", "working"), { state: "working", startedAt: 1 }], "a-2")).toBeUndefined();
  });
});

describe("liveCount", () => {
  const now = 10_000;
  it("counts listed sessions that have not ended, and young unlisted ones", () => {
    const launched: Launched = {
      1: { name: "a-1", at: 0 },
      2: { name: "a-2", at: 0 },
      3: { name: "a-3", at: 0 },
      4: { name: "a-4", at: 0 },
      5: { name: "a-5", at: now - 599 },
      6: { name: "a-6", at: now - 600 },
      "conflict-7": { name: "a-7-conflict", at: 0, pr: "9", mainSha: "s" },
    };
    const sessions = [
      session("a-1", "working"),
      session("a-2", "done"),
      session("a-3", "failed"),
      session("a-4", "stopped"),
      session("a-7-conflict", "idle"),
    ];
    expect(liveCount(launched, sessions, now)).toBe(3); // a-1, a-5, a-7-conflict
  });
});

describe("liveByPrefix", () => {
  it("counts listed sessions named <prefix>-... that have not ended", () => {
    const sessions = [
      session("a-1", "working"),
      session("a-2-conflict", "blocked"),
      session("a-3", "done"),
      session("a-4", "failed"),
      session("ab-5", "working"),
      session("a", "working"),
      { state: "working", startedAt: 1 },
    ];
    expect(liveByPrefix(sessions, "a")).toBe(2);
  });
});

describe("atCap", () => {
  const live = new Map([
    ["a", 2],
    ["b", 1],
  ]);
  it("is reached when the total across repos hits the global cap", () => {
    expect(atCap(live, "a", { globalMax: 3 })).toBe(true);
    expect(atCap(live, "a", { globalMax: 4 })).toBe(false);
  });

  it("is reached when the repo hits its own cap, whatever the global room", () => {
    expect(atCap(live, "a", { repoMax: 2, globalMax: 10 })).toBe(true);
    expect(atCap(live, "b", { repoMax: 2, globalMax: 10 })).toBe(false);
    expect(atCap(live, "new", { repoMax: 1, globalMax: 10 })).toBe(false);
  });
});

describe("hasBypassFlag", () => {
  it.each([
    [["--dangerously-skip-permissions"]],
    [["--model", "x", "--allow-dangerously-skip-permissions"]],
    [["--permission-mode=bypassPermissions"]],
    [["--permission-mode", "bypassPermissions"]],
  ])("finds %j", (flags) => {
    expect(hasBypassFlag(flags)).toBe(true);
  });

  it.each([
    [[]],
    [["--permission-mode", "acceptEdits"]],
    [["bypassPermissions"]],
    [["--model", "bypassPermissions"]],
  ])("allows %j", (flags) => {
    expect(hasBypassFlag(flags)).toBe(false);
  });
});

describe("reconcileAction", () => {
  it.each([
    [undefined, 599, { action: "keep" }],
    [undefined, 600, { action: "fail", reason: "no session found" }],
    ["failed", 0, { action: "fail", reason: "session failed" }],
    ["stopped", 0, { action: "fail", reason: "session stopped" }],
    ["done", 0, { action: "check" }],
    ["working", 9999, { action: "keep" }],
    ["blocked", 9999, { action: "keep" }],
    ["something-new", 9999, { action: "keep" }],
  ])("state %s at age %d -> %j", (state, age, expected) => {
    expect(reconcileAction(state, age)).toEqual(expected);
  });
});

describe("handedOff and conflictRemains", () => {
  it("a ticket is handed off when closed or labelled for a human", () => {
    expect(handedOff({ state: "CLOSED", labels: [] })).toBe(true);
    for (const l of ["needs-review", "blocked", "agent-failed"]) {
      expect(handedOff({ state: "OPEN", labels: ["x", l] })).toBe(true);
    }
    expect(handedOff({ state: "OPEN", labels: ["in-progress"] })).toBe(false);
  });

  it("a conflict remains only on an open, conflicting PR", () => {
    expect(conflictRemains({ state: "OPEN", mergeable: "CONFLICTING" })).toBe(true);
    expect(conflictRemains({ state: "OPEN", mergeable: "MERGEABLE" })).toBe(false);
    expect(conflictRemains({ state: "MERGED", mergeable: "CONFLICTING" })).toBe(false);
  });
});

describe("ticketVerdict and ticketPrompt", () => {
  const issue = (labels: string[], login = "me", number = 5): IssueRow => ({
    number,
    author: { login },
    labels: ["agent-ok", ...labels],
  });

  it("launches a ready ticket by the owner that is not tracked yet", () => {
    expect(ticketVerdict(issue(["ready"]), "me", {})).toEqual({ ok: true });
  });

  it.each([[[]], [["ready", "in-progress"]], [["ready", "blocked"]], [["ready", "agent-failed"]]])(
    "silently skips labels %j",
    (labels) => {
      expect(ticketVerdict(issue(labels), "me", {})).toEqual({ ok: false });
    },
  );

  it("skips another author's ticket with a log line", () => {
    expect(ticketVerdict(issue(["ready"], "eve"), "me", {})).toEqual({
      ok: false,
      log: "#5: author eve is not me; skipping",
    });
  });

  it("skips a ticket that already has a tracked session", () => {
    expect(ticketVerdict(issue(["ready"]), "me", { 5: { name: "a-5", at: 1 } })).toEqual({ ok: false });
  });

  it("adds auto for skip-plan", () => {
    expect(ticketPrompt(issue(["ready"]))).toBe("/ticket-workflow:work-ticket 5");
    expect(ticketPrompt(issue(["ready", "skip-plan"]))).toBe("/ticket-workflow:work-ticket 5 auto");
  });
});

describe("conflictVerdict", () => {
  const pr = (p: Partial<PrRow> = {}): PrRow => ({
    number: 9,
    headRefName: "issue-5-thing",
    mergeable: "CONFLICTING",
    isCrossRepository: false,
    author: { login: "me" },
    ...p,
  });
  const verdict = (row: PrRow, sessions: Session[] = [], launched: Launched = {}) =>
    conflictVerdict(row, { owner: "me", prefix: "a", sessions, launched });

  it("accepts a same-repo, owner-authored, conflicting issue-N-* PR", () => {
    expect(verdict(pr())).toEqual({ ok: true, n: 5 });
  });

  it.each([
    [{ headRefName: "feature-x" }, undefined],
    [{ headRefName: "issue-x-5" }, undefined],
    [{ isCrossRepository: true }, "#5: PR #9 is from a fork; skipping"],
    [{ author: { login: "eve" } }, "#5: PR #9 author eve is not me; skipping"],
    [{ mergeable: "UNKNOWN" }, "#5: PR #9 mergeability unknown; retry next poll"],
    [{ mergeable: "MERGEABLE" }, undefined],
  ])("skips %j", (p, log) => {
    expect(verdict(pr(p))).toEqual(log ? { ok: false, log } : { ok: false });
  });

  it("skips while the ticket session is working or blocked, not otherwise", () => {
    for (const st of ["working", "blocked"]) {
      expect(verdict(pr(), [session("a-5", st)])).toEqual({
        ok: false,
        log: "#5: PR #9 conflicts but a-5 is active; skipping",
      });
    }
    for (const st of ["idle", "done"]) expect(verdict(pr(), [session("a-5", st)]).ok).toBe(true);
  });

  it("skips while a conflict session is live or tracked; an ended one does not block", () => {
    expect(verdict(pr(), [session("a-5-conflict", "working")])).toEqual({ ok: false });
    expect(verdict(pr(), [session("a-5-conflict", "failed")]).ok).toBe(true);
    const tracked = { "conflict-5": { name: "a-5-conflict", at: 1, pr: "9", mainSha: "s" } };
    expect(verdict(pr(), [], tracked)).toEqual({ ok: false });
  });
});

describe("conflictIssueVerdict", () => {
  const issue = { state: "OPEN", author: { login: "me" }, labels: ["agent-ok"] };

  it("accepts an open agent-ok issue by the owner", () => {
    expect(conflictIssueVerdict(issue, 5, "me")).toEqual({ ok: true });
  });

  it.each([
    [{ state: "CLOSED" }, "#5: issue is not open; skipping conflict resolution"],
    [{ labels: ["needs-review"] }, undefined],
    [{ labels: ["agent-ok", "agent-failed"] }, undefined],
    [{ author: { login: "eve" } }, "#5: author is not me; skipping conflict resolution"],
    [{ author: undefined }, "#5: author is not me; skipping conflict resolution"],
  ])("skips %j", (p, log) => {
    expect(conflictIssueVerdict({ ...issue, ...p }, 5, "me")).toEqual(log ? { ok: false, log } : { ok: false });
  });
});

describe("alreadyAttempted", () => {
  const attempts = { 5: { pr: "9", mainSha: "sha1" } };
  it("is true only for the same PR against the same main SHA", () => {
    expect(alreadyAttempted(attempts, 5, 9, "sha1")).toBe(true);
    expect(alreadyAttempted(attempts, 5, 9, "sha2")).toBe(false);
    expect(alreadyAttempted(attempts, 5, 10, "sha1")).toBe(false);
    expect(alreadyAttempted(attempts, 6, 9, "sha1")).toBe(false);
  });
});
