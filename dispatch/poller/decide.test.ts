import { describe, expect, it } from "vitest";
import {
  alreadyAttempted,
  atCap,
  conflictIssueEligible,
  conflictSessionGate,
  conflictStillOpen,
  epoch,
  handedOff,
  hasBypassFlag,
  liveCount,
  parseStateKey,
  prCandidate,
  reconcileDecision,
  sessionState,
  stateKeys,
  ticketLaunchDecision,
} from "./decide.ts";

const labels = (...names: string[]) => names.map((name) => ({ name }));

describe("sessionState", () => {
  it("returns the state of the newest session with that name", () => {
    const sessions = [
      { name: "a-1", state: "working", startedAt: 5 },
      { name: "a-1", state: "done", startedAt: 9 },
      { name: "a-1", state: "failed", startedAt: 2 },
      { name: "a-2", state: "blocked", startedAt: 99 },
    ];
    expect(sessionState(sessions, "a-1")).toBe("done");
    expect(sessionState(sessions, "a-2")).toBe("blocked");
  });

  it("returns empty for a missing name or a missing state", () => {
    expect(sessionState([{ name: "a-1", state: "working" }], "a-9")).toBe("");
    expect(sessionState([{ name: "a-1", startedAt: 1 }], "a-1")).toBe("");
    expect(sessionState([], "a-1")).toBe("");
  });

  it("sorts a missing startedAt first, and keeps input order on ties", () => {
    expect(
      sessionState(
        [
          { name: "x", state: "working", startedAt: 1 },
          { name: "x", state: "done" },
        ],
        "x",
      ),
    ).toBe("working");
    expect(
      sessionState(
        [
          { name: "x", state: "first", startedAt: 3 },
          { name: "x", state: "second", startedAt: 3 },
        ],
        "x",
      ),
    ).toBe("second");
  });

  it("sorts numbers before strings, like jq", () => {
    expect(
      sessionState(
        [
          { name: "x", state: "iso", startedAt: "2026-01-01" },
          { name: "x", state: "num", startedAt: 9e12 },
        ],
        "x",
      ),
    ).toBe("iso");
  });
});

describe("liveCount", () => {
  const now = 10_000;
  it("counts listed sessions that are not done/failed/stopped", () => {
    const state = {
      1: { name: "a-1", at: 0 },
      2: { name: "a-2", at: 0 },
      3: { name: "a-3", at: 0 },
      4: { name: "a-4", at: 0 },
      5: { name: "a-5", at: 0 },
    };
    const sessions = [
      { name: "a-1", state: "working" },
      { name: "a-2", state: "done" },
      { name: "a-3", state: "failed" },
      { name: "a-4", state: "stopped" },
      { name: "a-5", state: "idle" },
    ];
    expect(liveCount(state, sessions, now)).toBe(2);
  });

  it("counts unlisted entries younger than 600s only", () => {
    const state = {
      1: { name: "a-1", at: now - 599 },
      2: { name: "a-2", at: now - 600 },
      3: { name: "a-3" },
    };
    expect(liveCount(state, [], now)).toBe(1);
  });

  it("counts an unlisted entry whose at is a string of digits by its age", () => {
    const state = {
      1: { name: "a-1", at: String(now - 10) },
      2: { name: "a-2", at: String(now - 3600) },
      3: { name: "a-3", at: "soon" },
    };
    expect(liveCount(state, [], now)).toBe(1);
  });

  it("ignores entries without a name", () => {
    expect(liveCount({ 1: { at: now } }, [], now)).toBe(0);
  });
});

describe("epoch", () => {
  it("accepts numbers and strings of digits only", () => {
    expect(epoch(1700)).toBe(1700);
    expect(epoch("1700")).toBe(1700);
    for (const bad of [undefined, null, "", "17a", "-5", "1.5", true, {}]) {
      expect(epoch(bad)).toBeUndefined();
    }
  });
});

describe("atCap", () => {
  const base = { repoLive: 0, repoLaunches: 0, globalLive: 0, totalLaunches: 0, max: 3 };
  it("uses the global cap when there is no repo cap", () => {
    expect(atCap({ ...base, globalLive: 2 })).toBe(false);
    expect(atCap({ ...base, globalLive: 3 })).toBe(true);
  });

  it("counts launches made this run toward the global cap", () => {
    expect(atCap({ ...base, globalLive: 1, totalLaunches: 1 })).toBe(false);
    expect(atCap({ ...base, globalLive: 1, totalLaunches: 2 })).toBe(true);
  });

  it("hits the repo cap first, counting this repo's launches", () => {
    expect(atCap({ ...base, repoMax: 2, repoLive: 1 })).toBe(false);
    expect(atCap({ ...base, repoMax: 2, repoLive: 1, repoLaunches: 1 })).toBe(true);
    expect(atCap({ ...base, repoMax: 5, repoLive: 1, globalLive: 3 })).toBe(true);
  });
});

describe("hasBypassFlag", () => {
  for (const flags of [
    ["--dangerously-skip-permissions"],
    ["--model", "x", "--allow-dangerously-skip-permissions"],
    ["--permission-mode=bypassPermissions"],
    ["--permission-mode", "bypassPermissions"],
  ]) {
    it(`detects ${flags.join(" ")}`, () => {
      expect(hasBypassFlag(flags)).toBe(true);
    });
  }

  it("allows other permission modes and a stray bypassPermissions word", () => {
    expect(hasBypassFlag(["--permission-mode", "acceptEdits"])).toBe(false);
    expect(hasBypassFlag(["--model", "bypassPermissions"])).toBe(false);
    expect(hasBypassFlag(["bypassPermissions", "--permission-mode"])).toBe(false);
    expect(hasBypassFlag([])).toBe(false);
  });
});

describe("stateKeys / parseStateKey", () => {
  it("orders keys as plain strings, not JS integer order", () => {
    expect(stateKeys({ 5: {}, 10: {}, "conflict-5": {}, 9: {} })).toEqual([
      "10",
      "5",
      "9",
      "conflict-5",
    ]);
  });

  it("splits conflict keys", () => {
    expect(parseStateKey("conflict-12")).toEqual({ n: "12", conflict: true });
    expect(parseStateKey("12")).toEqual({ n: "12", conflict: false });
  });
});

describe("reconcileDecision", () => {
  it("waits on an unlisted session younger than 600s, fails it after", () => {
    expect(reconcileDecision("", 599)).toEqual({ kind: "wait" });
    expect(reconcileDecision("", 600)).toEqual({ kind: "fail", reason: "no session found" });
  });

  it("fails failed and stopped sessions", () => {
    expect(reconcileDecision("failed", 1)).toEqual({ kind: "fail", reason: "session failed" });
    expect(reconcileDecision("stopped", 1)).toEqual({ kind: "fail", reason: "session stopped" });
  });

  it("checks the hand-off of a done session", () => {
    expect(reconcileDecision("done", 1)).toEqual({ kind: "check" });
  });

  for (const st of ["working", "blocked", "waiting", "idle", "something-new"]) {
    it(`leaves a ${st} session alone`, () => {
      expect(reconcileDecision(st, 99_999)).toEqual({ kind: "leave" });
    });
  }
});

describe("handedOff / conflictStillOpen", () => {
  it("accepts a closed issue or a hand-off label", () => {
    expect(handedOff({ state: "CLOSED", labels: [] })).toBe(true);
    for (const l of ["needs-review", "blocked", "agent-failed"]) {
      expect(handedOff({ state: "OPEN", labels: labels("in-progress", l) })).toBe(true);
    }
    expect(handedOff({ state: "OPEN", labels: labels("in-progress") })).toBe(false);
    expect(handedOff({ state: "OPEN", labels: labels("needs-review-x") })).toBe(false);
  });

  it("only an open, conflicting PR still has the conflict", () => {
    expect(conflictStillOpen({ state: "OPEN", mergeable: "CONFLICTING" })).toBe(true);
    expect(conflictStillOpen({ state: "OPEN", mergeable: "MERGEABLE" })).toBe(false);
    expect(conflictStillOpen({ state: "MERGED", mergeable: "CONFLICTING" })).toBe(false);
    expect(conflictStillOpen({ state: "CLOSED", mergeable: "CONFLICTING" })).toBe(false);
  });
});

describe("ticketLaunchDecision", () => {
  const opts = { owner: "me", prefix: "app", launched: {} };
  const row = (n: number, author: string, ...names: string[]) => ({
    number: n,
    author: { login: author },
    labels: labels("agent-ok", ...names),
  });

  for (const l of ["in-progress", "blocked", "agent-failed"]) {
    it(`silently skips ${l}`, () => {
      expect(ticketLaunchDecision(row(1, "me", "ready", l), opts)).toEqual({ kind: "skip" });
    });
  }

  it("silently skips a ticket that is not ready", () => {
    expect(ticketLaunchDecision(row(1, "me"), opts)).toEqual({ kind: "skip" });
  });

  it("skips another author with a log line", () => {
    expect(ticketLaunchDecision(row(4, "you", "ready"), opts)).toEqual({
      kind: "skip",
      log: "#4: author you is not me; skipping",
    });
  });

  it("checks the label skips before the author", () => {
    expect(ticketLaunchDecision(row(4, "you", "ready", "blocked"), opts)).toEqual({ kind: "skip" });
  });

  it("silently skips a ticket already tracked", () => {
    expect(
      ticketLaunchDecision(row(7, "me", "ready"), { ...opts, launched: { 7: { name: "app-7", at: 1 } } }),
    ).toEqual({ kind: "skip" });
  });

  it("launches with the ticket number, or `N auto` with skip-plan", () => {
    expect(ticketLaunchDecision(row(7, "me", "ready"), opts)).toEqual({
      kind: "launch",
      n: "7",
      name: "app-7",
      arg: "7",
    });
    expect(ticketLaunchDecision(row(8, "me", "ready", "skip-plan"), opts)).toEqual({
      kind: "launch",
      n: "8",
      name: "app-8",
      arg: "8 auto",
    });
  });
});

describe("conflict filters", () => {
  const pr = (p: Record<string, unknown> = {}) => ({
    number: 9,
    headRefName: "issue-5-thing",
    isCrossRepository: false,
    author: { login: "me" },
    mergeable: "CONFLICTING",
    ...p,
  });

  describe("prCandidate", () => {
    it("accepts a same-repo, owner-authored, conflicting issue-N-* PR", () => {
      expect(prCandidate(pr(), "me")).toEqual({ kind: "candidate", n: "5", pr: "9" });
      expect(prCandidate(pr({ headRefName: "issue-12-3-x" }), "me")).toMatchObject({ n: "12" });
    });

    it("silently ignores branches that are not issue-N-*", () => {
      for (const headRefName of ["feature-x", "issue-5", "x-issue-5-y", "issue-a-b"]) {
        expect(prCandidate(pr({ headRefName }), "me")).toEqual({ kind: "skip" });
      }
    });

    it("skips forks, including a missing isCrossRepository", () => {
      const log = "#5: PR #9 is from a fork; skipping";
      expect(prCandidate(pr({ isCrossRepository: true }), "me")).toEqual({ kind: "skip", log });
      expect(prCandidate(pr({ isCrossRepository: undefined }), "me")).toEqual({ kind: "skip", log });
      expect(prCandidate(pr({ isCrossRepository: null }), "me")).toEqual({ kind: "skip", log });
    });

    it("skips another author's PR, after the fork check", () => {
      expect(prCandidate(pr({ author: { login: "x" } }), "me")).toEqual({
        kind: "skip",
        log: "#5: PR #9 author x is not me; skipping",
      });
      expect(prCandidate(pr({ author: { login: "x" }, isCrossRepository: true }), "me")).toMatchObject({
        log: "#5: PR #9 is from a fork; skipping",
      });
    });

    it("logs UNKNOWN mergeability and silently skips anything but CONFLICTING", () => {
      expect(prCandidate(pr({ mergeable: "UNKNOWN" }), "me")).toEqual({
        kind: "skip",
        log: "#5: PR #9 mergeability unknown; retry next poll",
      });
      expect(prCandidate(pr({ mergeable: "MERGEABLE" }), "me")).toEqual({ kind: "skip" });
    });
  });

  describe("conflictSessionGate", () => {
    const gate = (sessions: unknown[], launched = {}) =>
      conflictSessionGate({ n: "5", pr: "9", prefix: "app", sessions, launched });

    for (const st of ["working", "blocked"]) {
      it(`skips with a log while the ticket session is ${st}`, () => {
        expect(gate([{ name: "app-5", state: st }])).toEqual({
          kind: "skip",
          log: "#5: PR #9 conflicts but app-5 is active; skipping",
        });
      });
    }

    it("passes when the ticket session is idle or done", () => {
      expect(gate([{ name: "app-5", state: "idle" }])).toEqual({ kind: "ok" });
      expect(gate([{ name: "app-5", state: "done" }])).toEqual({ kind: "ok" });
    });

    it("silently skips while a conflict session is alive", () => {
      expect(gate([{ name: "app-5-conflict", state: "waiting" }])).toEqual({ kind: "skip" });
      for (const st of ["done", "failed", "stopped"]) {
        expect(gate([{ name: "app-5-conflict", state: st }])).toEqual({ kind: "ok" });
      }
    });

    it("silently skips a conflict entry already tracked", () => {
      expect(gate([], { "conflict-5": { name: "app-5-conflict", at: 1 } })).toEqual({ kind: "skip" });
      expect(gate([], { 5: { name: "app-5", at: 1 } })).toEqual({ kind: "ok" });
    });
  });

  describe("conflictIssueEligible", () => {
    const issue = (p: Record<string, unknown> = {}) => ({
      state: "OPEN",
      author: { login: "me" },
      labels: labels("agent-ok"),
      ...p,
    });

    it("accepts an open agent-ok ticket by the owner", () => {
      expect(conflictIssueEligible(issue(), "5", "me")).toEqual({ kind: "ok" });
    });

    it("skips a ticket that is not open, with a log", () => {
      expect(conflictIssueEligible(issue({ state: "CLOSED" }), "5", "me")).toEqual({
        kind: "skip",
        log: "#5: issue is not open; skipping conflict resolution",
      });
    });

    it("silently skips without agent-ok or with agent-failed", () => {
      expect(conflictIssueEligible(issue({ labels: labels("needs-review") }), "5", "me")).toEqual({ kind: "skip" });
      expect(
        conflictIssueEligible(issue({ labels: labels("agent-ok", "agent-failed") }), "5", "me"),
      ).toEqual({ kind: "skip" });
    });

    it("skips another author with a log", () => {
      expect(conflictIssueEligible(issue({ author: { login: "x" } }), "5", "me")).toEqual({
        kind: "skip",
        log: "#5: author is not me; skipping conflict resolution",
      });
    });
  });

  describe("alreadyAttempted", () => {
    it("matches the same PR and main SHA, compared as strings", () => {
      const attempts = { 5: { pr: "9", mainSha: "sha1" } };
      expect(alreadyAttempted(attempts, "5", "9", "sha1")).toBe(true);
      expect(alreadyAttempted(attempts, "5", "9", "sha2")).toBe(false);
      expect(alreadyAttempted(attempts, "5", "10", "sha1")).toBe(false);
      expect(alreadyAttempted(attempts, "6", "9", "sha1")).toBe(false);
    });

    it("does not match a PR number stored as a number", () => {
      const attempts = { 5: { pr: 9, mainSha: "sha1" } } as unknown as Record<string, { pr: string; mainSha: string }>;
      expect(alreadyAttempted(attempts, "5", "9", "sha1")).toBe(false);
    });
  });
});
