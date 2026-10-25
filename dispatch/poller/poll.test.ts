import { describe, expect, it } from "vitest";
import type { RepoConfig } from "./config.ts";
import type { PollerIo } from "./io.ts";
import { pollRepo } from "./poll.ts";
import type { RunContext } from "./poll.ts";
import type { Check, Issue, IssueRow, PrRow, PrStatus, RepoState, Session } from "./schemas.ts";

const NOW = 100_000;

interface Fake {
  issues?: IssueRow[];
  prs?: PrRow[];
  /** `viewIssue` results by issue number; a missing number throws. */
  issueViews?: Record<number, Issue>;
  prStatus?: PrStatus;
  sha?: string;
  /** Method names that throw. */
  fail?: (keyof PollerIo)[];
}

/** A PollerIo over in-memory data that records every effect as a string. */
function fakeIo(fake: Fake) {
  const effects: string[] = [];
  const logs: string[] = [];
  const saved: RepoState[] = [];
  const guard = (name: keyof PollerIo) => {
    if (fake.fail?.includes(name)) throw new Error(`${name} failed`);
  };
  const io: PollerIo = {
    listIssues: () => (guard("listIssues"), fake.issues ?? []),
    listPrs: () => (guard("listPrs"), fake.prs ?? []),
    viewIssue: (_repo, n) => {
      guard("viewIssue");
      const issue = fake.issueViews?.[n];
      if (!issue) throw new Error(`no issue ${n}`);
      return issue;
    },
    viewPr: () => (guard("viewPr"), fake.prStatus ?? { state: "OPEN", mergeable: "MERGEABLE", statusCheckRollup: [] }),
    mainSha: () => (guard("mainSha"), fake.sha ?? "abcdef123456"),
    editLabels: (repo, n, add, remove) => {
      effects.push(`label ${repo}#${n} +${add.join(",")} -${remove.join(",")}`);
      guard("editLabels");
    },
    commentOnIssue: (repo, n) => {
      effects.push(`comment ${repo}#${n}`);
      guard("commentOnIssue");
    },
    commentOnPr: (repo, pr) => {
      effects.push(`comment ${repo} PR #${pr}`);
      guard("commentOnPr");
    },
    launch: (dir, name, flags, prompt) => {
      guard("launch");
      effects.push(`launch ${name} in ${dir}: ${[...flags, prompt].join(" ")}`);
    },
    saveState: (_prefix, state) => saved.push(structuredClone(state)),
    now: () => NOW,
    log: (m) => logs.push(m),
  };
  return { io, effects, logs, saved };
}

const repo = (p: Partial<RepoConfig> = {}): RepoConfig => ({
  repo: "org/app",
  dir: "/work/app",
  sessionPrefix: "app",
  owner: "me",
  ...p,
});

const run = (p: Partial<RunContext> = {}): RunContext => ({
  sessions: [],
  maxSessions: 10,
  live: new Map(),
  ...p,
});

const empty = (): RepoState => ({ launched: {}, attempts: {}, ciAttempts: {} });
const session = (name: string, state: string): Session => ({ name, state, startedAt: 1 });
const ready = (n: number, ...labels: string[]): IssueRow => ({
  number: n,
  author: { login: "me" },
  labels: ["agent-ok", "ready", ...labels],
});
const conflictPr = (number: number, n: number): PrRow => ({
  number,
  headRefName: `issue-${n}-x`,
  headRefOid: "head1",
  mergeable: "CONFLICTING",
  isCrossRepository: false,
  author: { login: "me" },
  statusCheckRollup: [],
});
const openIssue: Issue = { state: "OPEN", author: { login: "me" }, labels: ["agent-ok"] };
const FAILED: Check = { status: "COMPLETED", conclusion: "FAILURE" };
const PASSED: Check = { status: "COMPLETED", conclusion: "SUCCESS" };
const RUNNING: Check = { status: "IN_PROGRESS", conclusion: "" };
/** A same-repo, owner-authored, MERGEABLE `issue-N-*` PR with a failed check. */
const redPr = (number: number, n: number, headRefOid = "head1"): PrRow => ({
  number,
  headRefName: `issue-${n}-x`,
  headRefOid,
  mergeable: "MERGEABLE",
  isCrossRepository: false,
  author: { login: "me" },
  statusCheckRollup: [PASSED, FAILED],
});

describe("pollRepo: reconcile", () => {
  const tracked = (): RepoState => ({
    launched: { 3: { name: "app-3", at: NOW - 3600 } },
    attempts: {},
    ciAttempts: {},
  });

  it("fails a failed ticket session: label, comment, entry removed and saved", () => {
    const f = fakeIo({});
    const state = tracked();
    pollRepo(repo(), state, run({ sessions: [session("app-3", "failed")] }), f.io);
    expect(f.effects).toEqual(["label org/app#3 +agent-failed -in-progress", "comment org/app#3"]);
    expect(f.logs).toContain("[app] #3: app-3 state=failed");
    expect(f.logs).toContain("[app] #3: session failed -> agent-failed");
    expect(state.launched).toEqual({});
    expect(f.saved.at(-1)?.launched).toEqual({});
  });

  it("keeps a young unlisted session and a working one untouched", () => {
    const f = fakeIo({});
    const state: RepoState = {
      launched: { 3: { name: "app-3", at: NOW - 60 }, 4: { name: "app-4", at: 0 } },
      attempts: {},
      ciAttempts: {},
    };
    pollRepo(repo(), state, run({ sessions: [session("app-4", "working")] }), f.io);
    expect(f.effects).toEqual([]);
    expect(Object.keys(state.launched)).toEqual(["3", "4"]);
    expect(f.logs).toContain("[app] #3: app-3 state=<none>");
  });

  it("clears a done session that handed off, and fails one that did not", () => {
    const handed = fakeIo({ issueViews: { 3: { state: "OPEN", labels: ["needs-review"] } } });
    const state = tracked();
    pollRepo(repo(), state, run({ sessions: [session("app-3", "done")] }), handed.io);
    expect(handed.effects).toEqual([]);
    expect(state.launched).toEqual({});

    const dropped = fakeIo({ issueViews: { 3: { state: "OPEN", labels: ["in-progress"] } } });
    pollRepo(repo(), tracked(), run({ sessions: [session("app-3", "done")] }), dropped.io);
    expect(dropped.effects).toEqual(["label org/app#3 +agent-failed -in-progress", "comment org/app#3"]);
    expect(dropped.logs).toContain("[app] #3: session finished but the ticket was not handed off -> agent-failed");
  });

  it("fails a done conflict session whose PR still conflicts, on the PR and the issue", () => {
    const f = fakeIo({ prStatus: { state: "OPEN", mergeable: "CONFLICTING", statusCheckRollup: [] } });
    const state: RepoState = {
      launched: { "conflict-3": { name: "app-3-conflict", at: 0, pr: "9", mainSha: "s" } },
      attempts: { 3: { pr: "9", mainSha: "s" } },
      ciAttempts: {},
    };
    pollRepo(repo(), state, run({ sessions: [session("app-3-conflict", "done")] }), f.io);
    expect(f.effects).toEqual(["label org/app#3 +agent-failed -", "comment org/app PR #9", "comment org/app#3"]);
    expect(state.launched).toEqual({});
    expect(state.attempts).toEqual({ 3: { pr: "9", mainSha: "s" } });
  });

  it("clears a done conflict session whose PR no longer conflicts", () => {
    const f = fakeIo({ prStatus: { state: "OPEN", mergeable: "MERGEABLE", statusCheckRollup: [] } });
    const state: RepoState = {
      launched: { "conflict-3": { name: "app-3-conflict", at: 0, pr: "9", mainSha: "s" } },
      attempts: {},
      ciAttempts: {},
    };
    pollRepo(repo(), state, run({ sessions: [session("app-3-conflict", "done")] }), f.io);
    expect(f.effects).toEqual([]);
    expect(state.launched).toEqual({});
  });

  it("carries on when labelling fails, but keeps the entry if the issue comment fails", () => {
    const labelFails = fakeIo({ fail: ["editLabels"] });
    const state = tracked();
    pollRepo(repo(), state, run({ sessions: [session("app-3", "stopped")] }), labelFails.io);
    expect(labelFails.effects).toContain("comment org/app#3");
    expect(labelFails.logs).toContain("[app] could not label #3: editLabels failed");
    expect(state.launched).toEqual({});

    const commentFails = fakeIo({ fail: ["commentOnIssue"] });
    const kept = tracked();
    expect(() =>
      pollRepo(repo(), kept, run({ sessions: [session("app-3", "stopped")] }), commentFails.io),
    ).toThrow("commentOnIssue failed");
    expect(Object.keys(kept.launched)).toEqual(["3"]);
  });
});

describe("pollRepo: a ticket failed by reconcile is not relaunched in the same poll", () => {
  // The label edit fails, so the issue still looks ready (as it does in a dry run).
  const failedTicket = (): RepoState => ({ launched: { 5: { name: "app-5", at: 0 } }, attempts: {}, ciAttempts: {} });

  it("skips its ticket launch", () => {
    const f = fakeIo({ issues: [ready(5), ready(6)], fail: ["editLabels"] });
    const ctx = run({ sessions: [session("app-5", "failed")] });
    pollRepo(repo(), failedTicket(), ctx, f.io);
    expect(f.effects.filter((e) => e.startsWith("launch"))).toEqual([
      "launch app-6 in /work/app: --model opus --effort xhigh /ticket-workflow:work-ticket 6",
    ]);
    expect(f.logs).toContain("[app] #5: failed earlier in this poll; not relaunching");
    expect(ctx.live.get("app")).toBe(1);
  });

  it("skips its conflict resolution", () => {
    const f = fakeIo({ prs: [conflictPr(9, 5)], issueViews: { 5: openIssue }, fail: ["editLabels"] });
    pollRepo(repo(), failedTicket(), run({ sessions: [session("app-5", "stopped")] }), f.io);
    expect(f.effects.filter((e) => e.startsWith("launch"))).toEqual([]);
    expect(f.logs).toContain("[app] #5: failed earlier in this poll; skipping conflict resolution");
  });

  it("covers a failed conflict session's ticket too", () => {
    const f = fakeIo({ issues: [ready(5)], fail: ["editLabels"] });
    const state: RepoState = {
      launched: { "conflict-5": { name: "app-5-conflict", at: 0, pr: "9", mainSha: "s" } },
      attempts: {},
      ciAttempts: {},
    };
    pollRepo(repo(), state, run({ sessions: [session("app-5-conflict", "failed")] }), f.io);
    expect(f.effects.filter((e) => e.startsWith("launch"))).toEqual([]);
  });
});

describe("pollRepo: launch tickets", () => {
  it("launches ready tickets in the repo dir with the launch flags, records and counts them", () => {
    const f = fakeIo({ issues: [ready(1), ready(2, "skip-plan"), { ...ready(3), author: { login: "eve" } }] });
    const state = empty();
    const ctx = run({ live: new Map([["other", 4]]) });
    pollRepo(repo(), state, ctx, f.io);
    expect(f.effects).toEqual([
      "launch app-1 in /work/app: --model opus --effort xhigh /ticket-workflow:work-ticket 1",
      "launch app-2 in /work/app: --model opus --effort xhigh /ticket-workflow:work-ticket 2 auto",
    ]);
    expect(state.launched).toEqual({ 1: { name: "app-1", at: NOW }, 2: { name: "app-2", at: NOW } });
    expect(f.saved).toHaveLength(2);
    expect(ctx.live).toEqual(new Map([["other", 4], ["app", 2]]));
    expect(f.logs).toContain("[app] #1: launching app-1 (flags: --model opus --effort xhigh)");
    expect(f.logs).toContain("[app] #3: author eve is not me; skipping");
  });

  it("defers launches past the global cap, counting other repos' live sessions", () => {
    const f = fakeIo({ issues: [ready(1), ready(2)] });
    const state = empty();
    pollRepo(repo(), state, run({ maxSessions: 3, live: new Map([["other", 2]]) }), f.io);
    expect(f.effects).toEqual(["launch app-1 in /work/app: --model opus --effort xhigh /ticket-workflow:work-ticket 1"]);
    expect(f.logs).toContain("[app] deferred #2: at session cap");
    expect(Object.keys(state.launched)).toEqual(["1"]);
  });

  it("defers past the repo's own maxSessions", () => {
    const f = fakeIo({ issues: [ready(1)] });
    pollRepo(repo({ maxSessions: 1 }), empty(), run({ live: new Map([["app", 1]]) }), f.io);
    expect(f.effects).toEqual([]);
    expect(f.logs).toContain("[app] deferred #1: at session cap");
  });

  it("does not record a launch that failed, and the failure aborts the repo", () => {
    const f = fakeIo({ issues: [ready(1)], fail: ["launch"] });
    const state = empty();
    expect(() => pollRepo(repo(), state, run(), f.io)).toThrow("launch failed");
    expect(state.launched).toEqual({});
  });
});

describe("pollRepo: resolve conflicts", () => {
  it("launches a conflict session and records the session and the attempt", () => {
    const f = fakeIo({ prs: [conflictPr(9, 5)], issueViews: { 5: openIssue }, sha: "sha1" });
    const state = empty();
    pollRepo(repo(), state, run(), f.io);
    expect(f.effects).toEqual(["launch app-5-conflict in /work/app: --model opus --effort xhigh /ticket-workflow:resolve-conflicts 5"]);
    expect(state.launched).toEqual({ "conflict-5": { name: "app-5-conflict", at: NOW, pr: "9", mainSha: "sha1" } });
    expect(state.attempts).toEqual({ 5: { pr: "9", mainSha: "sha1" } });
    expect(f.logs).toContain("[app] #5: PR #9 conflicts with main; launching app-5-conflict (flags: --model opus --effort xhigh)");
  });

  it("does not read the issue for a PR that fails the PR checks", () => {
    const f = fakeIo({ prs: [{ ...conflictPr(9, 5), isCrossRepository: true }], fail: ["viewIssue"] });
    pollRepo(repo(), empty(), run(), f.io);
    expect(f.logs).toContain("[app] #5: PR #9 is from a fork; skipping");
    expect(f.effects).toEqual([]);
  });

  it("skips a PR whose issue cannot be read or is not eligible, and carries on", () => {
    const f = fakeIo({
      prs: [conflictPr(8, 4), conflictPr(9, 5), conflictPr(10, 6)],
      issueViews: { 5: { ...openIssue, state: "CLOSED" }, 6: openIssue },
    });
    pollRepo(repo(), empty(), run(), f.io);
    expect(f.logs).toContain("[app] #4: cannot read issue; skipping");
    expect(f.logs).toContain("[app] #5: issue is not open; skipping conflict resolution");
    expect(f.effects).toEqual(["launch app-6-conflict in /work/app: --model opus --effort xhigh /ticket-workflow:resolve-conflicts 6"]);
  });

  it("does not repeat an attempt against the same main SHA, but retries once main moves", () => {
    const attempts = { 5: { pr: "9", mainSha: "abcdef123456" } };
    const same = fakeIo({ prs: [conflictPr(9, 5)], issueViews: { 5: openIssue } });
    pollRepo(repo(), { launched: {}, attempts: { ...attempts }, ciAttempts: {} }, run(), same.io);
    expect(same.effects).toEqual([]);
    expect(same.logs).toContain("[app] #5: PR #9 already attempted against main abcdef1; skipping");

    const moved = fakeIo({ prs: [conflictPr(9, 5)], issueViews: { 5: openIssue }, sha: "newsha" });
    const state: RepoState = { launched: {}, attempts: { ...attempts }, ciAttempts: {} };
    pollRepo(repo(), state, run(), moved.io);
    expect(moved.effects).toHaveLength(1);
    expect(state.attempts).toEqual({ 5: { pr: "9", mainSha: "newsha" } });
  });

  it("stops the phase without failing when main's SHA cannot be read", () => {
    const f = fakeIo({ prs: [conflictPr(9, 5), conflictPr(10, 6)], issueViews: { 5: openIssue, 6: openIssue }, fail: ["mainSha"] });
    pollRepo(repo(), empty(), run(), f.io);
    expect(f.logs.filter((l) => l.includes("cannot read main SHA"))).toEqual(["[app] cannot read main SHA; skipping conflict phase"]);
    expect(f.effects).toEqual([]);
  });

  it("counts conflict launches toward the cap", () => {
    const f = fakeIo({ issues: [ready(1)], prs: [conflictPr(9, 5)], issueViews: { 5: openIssue } });
    const state = empty();
    pollRepo(repo(), state, run({ maxSessions: 1 }), f.io);
    expect(f.effects).toEqual(["launch app-1 in /work/app: --model opus --effort xhigh /ticket-workflow:work-ticket 1"]);
    expect(f.logs).toContain("[app] deferred #5: at session cap (conflict resolution for PR #9)");
    expect(state.attempts).toEqual({});
  });

  it("launches one conflict session per ticket when two PRs share it", () => {
    const f = fakeIo({ prs: [conflictPr(9, 5), conflictPr(10, 5)], issueViews: { 5: openIssue } });
    pollRepo(repo(), empty(), run(), f.io);
    expect(f.effects).toHaveLength(1);
  });
});

describe("pollRepo: fix CI", () => {
  const CI_LAUNCH = "launch app-5-ci in /work/app: --model opus --effort xhigh /ticket-workflow:fix-ci 5";
  const launches = (effects: string[]) => effects.filter((e) => e.startsWith("launch"));

  it("launches `app-N-ci` with `/ticket-workflow:fix-ci N`, tracks `ci-N`, records head SHA and count 1 (AC1)", () => {
    const f = fakeIo({ prs: [redPr(9, 5)], issueViews: { 5: openIssue } });
    const state = empty();
    const ctx = run();
    pollRepo(repo(), state, ctx, f.io);
    expect(f.effects).toEqual([CI_LAUNCH]);
    expect(state.launched).toEqual({ "ci-5": { name: "app-5-ci", at: NOW, pr: "9" } });
    expect(state.ciAttempts).toEqual({ 9: { headSha: "head1", count: 1 } });
    expect(f.saved.at(-1)).toEqual(state);
    expect(ctx.live.get("app")).toBe(1);
  });

  it("does not relaunch for the same head SHA; a new head SHA launches with count 2; a third is capped (AC1)", () => {
    const same = fakeIo({ prs: [redPr(9, 5, "head1")], issueViews: { 5: openIssue } });
    const sameState: RepoState = { ...empty(), ciAttempts: { 9: { headSha: "head1", count: 1 } } };
    pollRepo(repo(), sameState, run(), same.io);
    expect(launches(same.effects)).toEqual([]);
    expect(sameState.ciAttempts).toEqual({ 9: { headSha: "head1", count: 1 } });

    const moved = fakeIo({ prs: [redPr(9, 5, "head2")], issueViews: { 5: openIssue } });
    const movedState: RepoState = { ...empty(), ciAttempts: { 9: { headSha: "head1", count: 1 } } };
    pollRepo(repo(), movedState, run(), moved.io);
    expect(launches(moved.effects)).toEqual([CI_LAUNCH]);
    expect(movedState.ciAttempts).toEqual({ 9: { headSha: "head2", count: 2 } });

    const capped = fakeIo({ prs: [redPr(9, 5, "head3")], issueViews: { 5: openIssue } });
    const cappedState: RepoState = { ...empty(), ciAttempts: { 9: { headSha: "head2", count: 2 } } };
    pollRepo(repo(), cappedState, run(), capped.io);
    expect(launches(capped.effects)).toEqual([]);
    expect(cappedState.ciAttempts).toEqual({ 9: { headSha: "head2", count: 2 } });
    expect(capped.logs.some((l) => l.startsWith("[app] ") && l.includes("#9")), capped.logs.join("\n")).toBe(true);
  });

  it("launches nothing for pending checks or a conflicting PR; a conflicting red PR gets only the conflict session (AC1)", () => {
    const f = fakeIo({
      prs: [
        { ...redPr(9, 5), statusCheckRollup: [FAILED, RUNNING] },
        { ...redPr(10, 6), mergeable: "CONFLICTING" },
        redPr(11, 7),
      ],
      issueViews: { 5: openIssue, 6: openIssue, 7: openIssue },
      sha: "sha1",
    });
    const state = empty();
    pollRepo(repo(), state, run(), f.io);
    expect(f.effects).toEqual([
      "launch app-6-conflict in /work/app: --model opus --effort xhigh /ticket-workflow:resolve-conflicts 6",
      "launch app-7-ci in /work/app: --model opus --effort xhigh /ticket-workflow:fix-ci 7",
    ]);
    expect(Object.keys(state.launched).sort()).toEqual(["ci-7", "conflict-6"]);
    expect(state.ciAttempts).toEqual({ 11: { headSha: "head1", count: 1 } });
  });

  it("skips with a log when ticket N is working/blocked or a ci session is live (AC2)", () => {
    for (const [name, st] of [
      ["app-5", "working"],
      ["app-5", "blocked"],
      ["app-5-ci", "working"],
    ]) {
      const f = fakeIo({ prs: [redPr(9, 5)], issueViews: { 5: openIssue } });
      const state = empty();
      pollRepo(repo(), state, run({ sessions: [session(name, st)] }), f.io);
      expect(launches(f.effects), `${name} ${st}`).toEqual([]);
      expect(
        f.logs.some((l) => l.startsWith("[app] #5: PR #9") && l.includes(name)),
        `${name} ${st}: ${f.logs.join("\n")}`,
      ).toBe(true);
      expect(state.ciAttempts).toEqual({});
    }
    const idle = fakeIo({ prs: [redPr(9, 5)], issueViews: { 5: openIssue } });
    pollRepo(repo(), empty(), run({ sessions: [session("app-5", "idle")] }), idle.io);
    expect(launches(idle.effects)).toEqual([CI_LAUNCH]);
  });

  it("skips a closed, non-`agent-ok` or `agent-failed` ticket; defers at the session cap (AC1, AC2)", () => {
    for (const issue of [
      { ...openIssue, state: "CLOSED" },
      { ...openIssue, labels: ["needs-review"] },
      { ...openIssue, labels: ["agent-ok", "agent-failed"] },
    ]) {
      const f = fakeIo({ prs: [redPr(9, 5)], issueViews: { 5: issue } });
      const state = empty();
      pollRepo(repo(), state, run(), f.io);
      expect(launches(f.effects), JSON.stringify(issue)).toEqual([]);
      expect(state.ciAttempts).toEqual({});
      if (issue.state === "CLOSED") {
        expect(f.logs.some((l) => l.startsWith("[app] #5: issue is not open; skipping")), f.logs.join("\n")).toBe(true);
      }
    }

    const f = fakeIo({ prs: [redPr(9, 5)], issueViews: { 5: openIssue } });
    const state = empty();
    pollRepo(repo(), state, run({ maxSessions: 1, live: new Map([["other", 1]]) }), f.io);
    expect(f.effects).toEqual([]);
    expect(f.logs.some((l) => l.startsWith("[app] deferred #5: at session cap")), f.logs.join("\n")).toBe(true);
    expect(state.launched).toEqual({});
    expect(state.ciAttempts).toEqual({});
  });

  const trackedCi = (): RepoState => ({
    launched: { "ci-5": { name: "app-5-ci", at: 0, pr: "9" } },
    attempts: {},
    ciAttempts: { 9: { headSha: "head1", count: 1 } },
  });

  it("fails a failed/stopped ci session: label, PR comment, issue comment, entry removed, attempts kept (AC3)", () => {
    for (const st of ["failed", "stopped"]) {
      const f = fakeIo({});
      const state = trackedCi();
      pollRepo(repo(), state, run({ sessions: [session("app-5-ci", st)] }), f.io);
      expect(f.effects, st).toEqual(["label org/app#5 +agent-failed -", "comment org/app PR #9", "comment org/app#5"]);
      expect(state.launched).toEqual({});
      expect(state.ciAttempts).toEqual({ 9: { headSha: "head1", count: 1 } });
      expect(f.saved.at(-1)?.launched).toEqual({});
    }
  });

  it("fails a done ci session whose PR is still red (AC3)", () => {
    const f = fakeIo({ prStatus: { state: "OPEN", mergeable: "MERGEABLE", statusCheckRollup: [PASSED, FAILED] } });
    const state = trackedCi();
    pollRepo(repo(), state, run({ sessions: [session("app-5-ci", "done")] }), f.io);
    expect(f.effects).toEqual(["label org/app#5 +agent-failed -", "comment org/app PR #9", "comment org/app#5"]);
    expect(state.launched).toEqual({});
    expect(state.ciAttempts).toEqual({ 9: { headSha: "head1", count: 1 } });
  });

  it("clears a done ci session whose PR is green, pending, closed or merged, with no effects (AC3)", () => {
    const statuses: PrStatus[] = [
      { state: "OPEN", mergeable: "MERGEABLE", statusCheckRollup: [PASSED] },
      { state: "OPEN", mergeable: "MERGEABLE", statusCheckRollup: [FAILED, RUNNING] },
      { state: "CLOSED", mergeable: "MERGEABLE", statusCheckRollup: [FAILED] },
      { state: "MERGED", mergeable: "MERGEABLE", statusCheckRollup: [FAILED] },
    ];
    for (const prStatus of statuses) {
      const f = fakeIo({ prStatus });
      const state = trackedCi();
      pollRepo(repo(), state, run({ sessions: [session("app-5-ci", "done")] }), f.io);
      expect(f.effects, JSON.stringify(prStatus)).toEqual([]);
      expect(state.launched).toEqual({});
    }
  });

  it("does not relaunch a ticket whose ci session failed earlier in this poll (AC3)", () => {
    // The label edit fails, so the issue still looks eligible (as it does in a dry run).
    const f = fakeIo({ prs: [redPr(9, 5, "head2")], issueViews: { 5: openIssue }, fail: ["editLabels"] });
    const state = trackedCi();
    pollRepo(repo(), state, run({ sessions: [session("app-5-ci", "failed")] }), f.io);
    expect(launches(f.effects)).toEqual([]);
    expect(f.logs.some((l) => l.startsWith("[app] #5: failed earlier in this poll")), f.logs.join("\n")).toBe(true);
    expect(state.launched).toEqual({});
  });
});

describe("pollRepo: failures abort the repo", () => {
  it("throws when a list read fails, after the earlier phases ran", () => {
    const f = fakeIo({ issues: [ready(1)], fail: ["listPrs"] });
    expect(() => pollRepo(repo(), empty(), run(), f.io)).toThrow("listPrs failed");
    expect(f.effects).toHaveLength(1);
  });

  it("throws when a finished session's ticket cannot be read", () => {
    const f = fakeIo({});
    const state: RepoState = { launched: { 3: { name: "app-3", at: 0 } }, attempts: {}, ciAttempts: {} };
    expect(() => pollRepo(repo(), state, run({ sessions: [session("app-3", "done")] }), f.io)).toThrow("no issue 3");
    expect(Object.keys(state.launched)).toEqual(["3"]);
  });
});
