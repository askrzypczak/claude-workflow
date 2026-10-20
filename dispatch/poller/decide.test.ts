import { describe, expect, it } from "vitest";
import {
  alreadyAttempted,
  atCap,
  ciAttemptVerdict,
  ciRemains,
  ciState,
  ciVerdict,
  conflictRemains,
  conflictVerdict,
  handedOff,
  hasBypassFlag,
  liveByPrefix,
  liveCount,
  prIssueVerdict,
  reconcileAction,
  sessionState,
  ticketPrompt,
  ticketVerdict,
} from "./decide.ts";
import type { Check, IssueRow, Launched, PrRow, Session } from "./schemas.ts";

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
    expect(conflictRemains({ state: "OPEN", mergeable: "CONFLICTING", statusCheckRollup: [] })).toBe(true);
    expect(conflictRemains({ state: "OPEN", mergeable: "MERGEABLE", statusCheckRollup: [] })).toBe(false);
    expect(conflictRemains({ state: "MERGED", mergeable: "CONFLICTING", statusCheckRollup: [] })).toBe(false);
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
    headRefOid: "head1",
    mergeable: "CONFLICTING",
    isCrossRepository: false,
    author: { login: "me" },
    statusCheckRollup: [],
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

describe("prIssueVerdict", () => {
  const issue = { state: "OPEN", author: { login: "me" }, labels: ["agent-ok"] };

  it("accepts an open agent-ok issue by the owner", () => {
    expect(prIssueVerdict(issue, 5, "me", "conflict resolution")).toEqual({ ok: true });
  });

  it.each([
    [{ state: "CLOSED" }, "#5: issue is not open; skipping conflict resolution"],
    [{ labels: ["needs-review"] }, undefined],
    [{ labels: ["agent-ok", "agent-failed"] }, undefined],
    [{ author: { login: "eve" } }, "#5: author is not me; skipping conflict resolution"],
    [{ author: undefined }, "#5: author is not me; skipping conflict resolution"],
  ])("skips %j", (p, log) => {
    expect(prIssueVerdict({ ...issue, ...p }, 5, "me", "conflict resolution")).toEqual(
      log ? { ok: false, log } : { ok: false },
    );
  });

  it("prIssueVerdict keeps the conflict wording and uses the given action in its log", () => {
    const closed = { ...issue, state: "CLOSED" };
    const other = { ...issue, author: { login: "eve" } };
    expect(prIssueVerdict(closed, 5, "me", "conflict resolution")).toEqual({
      ok: false,
      log: "#5: issue is not open; skipping conflict resolution",
    });
    expect(prIssueVerdict(closed, 5, "me", "CI fix")).toEqual({
      ok: false,
      log: "#5: issue is not open; skipping CI fix",
    });
    expect(prIssueVerdict(other, 5, "me", "CI fix")).toEqual({
      ok: false,
      log: "#5: author is not me; skipping CI fix",
    });
  });
});

// statusCheckRollup rows: a CheckRun has status and conclusion, a StatusContext has state.
const checkRun = (conclusion: string, status = "COMPLETED"): Check => ({ status, conclusion });
const statusContext = (state: string): Check => ({ state });
const FAILED = checkRun("FAILURE");
const PASSED = checkRun("SUCCESS");

describe("ciState", () => {
  it("ciState is red for a failed check (FAILURE, ERROR, TIMED_OUT, STARTUP_FAILURE) with none pending (AC1)", () => {
    for (const c of ["FAILURE", "ERROR", "TIMED_OUT", "STARTUP_FAILURE"]) {
      expect(ciState([PASSED, checkRun(c)]), c).toBe("red");
    }
    for (const s of ["FAILURE", "ERROR"]) {
      expect(ciState([statusContext("SUCCESS"), statusContext(s)]), s).toBe("red");
    }
    expect(ciState([checkRun("CANCELLED"), checkRun("SKIPPED"), FAILED])).toBe("red");
  });

  it("ciState is pending while any check is queued, in progress or pending, even beside a failure (AC1)", () => {
    expect(ciState([FAILED, checkRun("", "QUEUED")])).toBe("pending");
    expect(ciState([FAILED, checkRun("", "IN_PROGRESS")])).toBe("pending");
    expect(ciState([FAILED, statusContext("PENDING")])).toBe("pending");
    expect(ciState([statusContext("ERROR"), statusContext("EXPECTED")])).toBe("pending");
    expect(ciState([PASSED, checkRun("", "IN_PROGRESS")])).toBe("pending");
  });

  it("ciState is ok for only success/cancelled/skipped/neutral checks, and for an empty rollup (AC1)", () => {
    expect(ciState([])).toBe("ok");
    expect(
      ciState([PASSED, checkRun("CANCELLED"), checkRun("SKIPPED"), checkRun("NEUTRAL"), statusContext("SUCCESS")]),
    ).toBe("ok");
  });
});

describe("ciVerdict", () => {
  const pr = (p: Partial<PrRow> = {}): PrRow => ({
    number: 9,
    headRefName: "issue-5-thing",
    headRefOid: "head1",
    mergeable: "MERGEABLE",
    isCrossRepository: false,
    author: { login: "me" },
    statusCheckRollup: [PASSED, FAILED],
    ...p,
  });
  const verdict = (row: PrRow, sessions: Session[] = [], launched: Launched = {}) =>
    ciVerdict(row, { owner: "me", prefix: "a", sessions, launched });

  it("ciVerdict accepts a MERGEABLE red PR on an `issue-N-*` branch and returns N (AC1)", () => {
    expect(verdict(pr())).toEqual({ ok: true, n: 5 });
    expect(verdict(pr({ headRefName: "issue-12-other" }))).toEqual({ ok: true, n: 12 });
  });

  it("ciVerdict launches nothing for a CONFLICTING PR, silently (AC1)", () => {
    expect(verdict(pr({ mergeable: "CONFLICTING" }))).toEqual({ ok: false });
  });

  it("ciVerdict logs and retries later for UNKNOWN mergeability (AC1)", () => {
    expect(verdict(pr({ mergeable: "UNKNOWN" }))).toEqual({
      ok: false,
      log: expect.stringMatching(/^#5: PR #9 .*retry/),
    });
  });

  it("ciVerdict skips pending and green PRs (AC1)", () => {
    expect(verdict(pr({ statusCheckRollup: [FAILED, checkRun("", "IN_PROGRESS")] })).ok).toBe(false);
    expect(verdict(pr({ statusCheckRollup: [FAILED, statusContext("PENDING")] })).ok).toBe(false);
    expect(verdict(pr({ statusCheckRollup: [PASSED] })).ok).toBe(false);
    expect(verdict(pr({ statusCheckRollup: [] })).ok).toBe(false);
  });

  it("ciVerdict skips forks, other authors and non-`issue-N-*` branches (AC1)", () => {
    expect(verdict(pr({ isCrossRepository: true })).ok).toBe(false);
    expect(verdict(pr({ author: { login: "eve" } })).ok).toBe(false);
    expect(verdict(pr({ headRefName: "feature-x" })).ok).toBe(false);
    expect(verdict(pr({ headRefName: "issue-x-5" })).ok).toBe(false);
  });

  it("ciVerdict skips with a log when the ticket session is working or blocked (AC2)", () => {
    for (const st of ["working", "blocked"]) {
      expect(verdict(pr(), [session("a-5", st)])).toEqual({
        ok: false,
        log: expect.stringMatching(/^#5: PR #9 .*a-5.*skipping$/),
      });
    }
    for (const st of ["idle", "done"]) expect(verdict(pr(), [session("a-5", st)]).ok).toBe(true);
  });

  it("ciVerdict skips a live or tracked `-ci` session, and a live or tracked conflict session (AC2)", () => {
    for (const st of ["working", "blocked", "idle"]) {
      expect(verdict(pr(), [session("a-5-ci", st)])).toEqual({
        ok: false,
        log: expect.stringMatching(/^#5: PR #9 .*a-5-ci.*skipping$/),
      });
    }
    expect(verdict(pr(), [session("a-5-ci", "failed")]).ok).toBe(true);
    expect(verdict(pr(), [], { "ci-5": { name: "a-5-ci", at: 1, pr: "9" } }).ok).toBe(false);
    expect(verdict(pr(), [session("a-5-conflict", "working")]).ok).toBe(false);
    expect(verdict(pr(), [], { "conflict-5": { name: "a-5-conflict", at: 1, pr: "9", mainSha: "s" } }).ok).toBe(
      false,
    );
    expect(verdict(pr(), [], { "ci-6": { name: "a-6-ci", at: 1, pr: "10" } })).toEqual({ ok: true, n: 5 });
  });
});

describe("ciAttemptVerdict", () => {
  it("ciAttemptVerdict skips the same head SHA, allows a new one, and skips at the cap with a log (AC1)", () => {
    expect(ciAttemptVerdict({}, 9, "head1")).toEqual({ ok: true });
    expect(ciAttemptVerdict({ 10: { headSha: "head1", count: 2 } }, 9, "head1")).toEqual({ ok: true });

    const once = { 9: { headSha: "head1", count: 1 } };
    expect(ciAttemptVerdict(once, 9, "head1").ok).toBe(false);
    expect(ciAttemptVerdict(once, 9, "head2")).toEqual({ ok: true });

    const capped = { 9: { headSha: "head2", count: 2 } };
    expect(ciAttemptVerdict(capped, 9, "head3")).toEqual({ ok: false, log: expect.stringContaining("#9") });
  });
});

describe("ciRemains", () => {
  it("ciRemains is true only for an open PR whose checks are red (AC3)", () => {
    const status = (state: string, statusCheckRollup: Check[]) => ({ state, mergeable: "MERGEABLE", statusCheckRollup });
    expect(ciRemains(status("OPEN", [PASSED, FAILED]))).toBe(true);
    expect(ciRemains(status("OPEN", [PASSED]))).toBe(false);
    expect(ciRemains(status("OPEN", []))).toBe(false);
    expect(ciRemains(status("OPEN", [FAILED, checkRun("", "QUEUED")]))).toBe(false);
    expect(ciRemains(status("CLOSED", [FAILED]))).toBe(false);
    expect(ciRemains(status("MERGED", [FAILED]))).toBe(false);
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
