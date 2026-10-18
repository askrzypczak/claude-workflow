import { describe, expect, it } from "vitest";
import { CommandError } from "./io.ts";
import type { PollerIo } from "./io.ts";
import { pollRepo } from "./poll.ts";
import type { ConflictAttempts, LaunchedState, RepoRun, RunContext } from "./types.ts";

const NOW = 100_000;

interface FakeData {
  state?: LaunchedState;
  attempts?: ConflictAttempts;
  issues?: unknown[];
  prs?: unknown[];
  /** `gh issue view N` results by N; a missing N fails the command. */
  issueViews?: Record<string, unknown>;
  prView?: unknown;
  /** Raw `gh pr view` output, overriding prView. */
  prViewText?: string;
  /** Thrown by readState / readAttempts (an unparsable state file). */
  stateError?: Error;
  attemptsError?: Error;
  sha?: string | null;
  /** Commands (joined args prefix) that fail. */
  fail?: string[];
}

function fakeIo(data: FakeData) {
  const calls = {
    gh: [] as string[],
    ghRun: [] as string[],
    launch: [] as { cwd: string; args: string[] }[],
    writeState: [] as LaunchedState[],
    writeAttempts: [] as ConflictAttempts[],
    log: [] as string[],
  };
  const failIf = (cmd: string) => {
    if ((data.fail ?? []).some((f) => cmd.startsWith(f))) throw new CommandError(cmd, 4);
  };
  const io: PollerIo = {
    gh(args) {
      const cmd = args.join(" ");
      calls.gh.push(cmd);
      failIf(cmd);
      if (cmd.startsWith("issue list")) return JSON.stringify(data.issues ?? []);
      if (cmd.startsWith("pr list")) return JSON.stringify(data.prs ?? []);
      if (cmd.startsWith("pr view")) return data.prViewText ?? JSON.stringify(data.prView ?? {});
      if (cmd.startsWith("issue view")) {
        const view = data.issueViews?.[args[2] as string];
        if (view === undefined) throw new CommandError(cmd, 1);
        return JSON.stringify(view);
      }
      if (cmd.startsWith("api")) {
        return JSON.stringify(data.sha === undefined ? { sha: "abcdef123456" } : { sha: data.sha });
      }
      throw new Error(`unexpected gh ${cmd}`);
    },
    ghRun(args) {
      const cmd = args.join(" ");
      calls.ghRun.push(cmd);
      failIf(cmd);
    },
    launch(cwd, args) {
      calls.launch.push({ cwd, args });
      failIf(`claude ${args.join(" ")}`);
    },
    readState: () => {
      if (data.stateError) throw data.stateError;
      return structuredClone(data.state ?? {});
    },
    writeState: (_p, s) => calls.writeState.push(structuredClone(s)),
    readAttempts: () => {
      if (data.attemptsError) throw data.attemptsError;
      return structuredClone(data.attempts ?? {});
    },
    writeAttempts: (_p, a) => calls.writeAttempts.push(structuredClone(a)),
    now: () => NOW,
    log: (m) => calls.log.push(m),
  };
  return { io, calls };
}

const repo = (p: Partial<RepoRun> = {}): RepoRun => ({
  repo: "org/app",
  dir: "/work/app",
  prefix: "app",
  owner: "me",
  flags: ["--model", "sonnet"],
  repoLive: 0,
  ...p,
});

const ctx = (p: Partial<RunContext> = {}): RunContext => ({
  dry: false,
  maxSessions: 10,
  globalLive: 0,
  sessions: [],
  launches: new Map(),
  ...p,
});

const readyIssue = (n: number, ...extra: string[]) => ({
  number: n,
  author: { login: "me" },
  labels: ["agent-ok", "ready", ...extra].map((name) => ({ name })),
});

const conflictPr = (number: number, n: number) => ({
  number,
  headRefName: `issue-${n}-x`,
  isCrossRepository: false,
  author: { login: "me" },
  mergeable: "CONFLICTING",
});

const openIssue = { state: "OPEN", author: { login: "me" }, labels: [{ name: "agent-ok" }] };

describe("pollRepo", () => {
  const everything: FakeData = {
    state: {
      3: { name: "app-3", at: NOW - 3600 },
      4: { name: "app-4", at: NOW - 3600 },
    },
    issues: [readyIssue(1), readyIssue(2, "skip-plan")],
    prs: [conflictPr(9, 5)],
    issueViews: { 5: openIssue },
  };
  const sessions = [{ name: "app-3", state: "failed", startedAt: 1 }, { name: "app-4", state: "working" }];

  it("dry-run logs every side effect and writes nothing, but counts launches", () => {
    const { io, calls } = fakeIo(everything);
    const c = ctx({ dry: true, sessions });
    pollRepo(repo(), c, io);
    expect(calls.writeState).toEqual([]);
    expect(calls.writeAttempts).toEqual([]);
    expect(calls.ghRun).toEqual([]);
    expect(calls.launch).toEqual([]);
    expect(c.launches.get("app")).toBe(3);
    expect(calls.log).toEqual([
      "[app] #3: app-3 state=failed",
      "[app] #3: session failed -> agent-failed",
      "[app] [dry-run] gh issue edit 3 --repo org/app --add-label agent-failed --remove-label in-progress",
      "[app] [dry-run] gh issue comment 3 --repo org/app --body Background session `app-3` ended without finishing: session failed. See `claude logs app-3` or `claude agents`. To retry, remove `agent-failed` and add `ready`.",
      "[app] #4: app-4 state=working",
      "[app] #1: launching app-1 (flags: --model sonnet)",
      '[app] [dry-run] (cd /work/app && claude --bg --name app-1 --model sonnet "/ticket-workflow:work-ticket 1")',
      "[app] #2: launching app-2 (flags: --model sonnet)",
      '[app] [dry-run] (cd /work/app && claude --bg --name app-2 --model sonnet "/ticket-workflow:work-ticket 2 auto")',
      "[app] #5: PR #9 conflicts with main; launching app-5-conflict (flags: --model sonnet)",
      '[app] [dry-run] (cd /work/app && claude --bg --name app-5-conflict --model sonnet "/ticket-workflow:resolve-conflicts 5")',
    ]);
  });

  it("a real run labels, comments, launches and records state", () => {
    const { io, calls } = fakeIo(everything);
    const c = ctx({ sessions });
    pollRepo(repo(), c, io);
    expect(calls.ghRun.map((x) => x.split(" --body")[0])).toEqual([
      "issue edit 3 --repo org/app --add-label agent-failed --remove-label in-progress",
      "issue comment 3 --repo org/app",
    ]);
    expect(calls.launch).toEqual([
      { cwd: "/work/app", args: ["--bg", "--name", "app-1", "--model", "sonnet", "/ticket-workflow:work-ticket 1"] },
      { cwd: "/work/app", args: ["--bg", "--name", "app-2", "--model", "sonnet", "/ticket-workflow:work-ticket 2 auto"] },
      { cwd: "/work/app", args: ["--bg", "--name", "app-5-conflict", "--model", "sonnet", "/ticket-workflow:resolve-conflicts 5"] },
    ]);
    expect(calls.writeState.at(-1)).toEqual({
      1: { name: "app-1", at: NOW },
      2: { name: "app-2", at: NOW },
      4: { name: "app-4", at: NOW - 3600 },
      "conflict-5": { name: "app-5-conflict", at: NOW, pr: "9", mainSha: "abcdef123456" },
    });
    expect(calls.writeAttempts).toEqual([{ 5: { pr: "9", mainSha: "abcdef123456" } }]);
    expect(c.launches.get("app")).toBe(3);
  });

  it("reconciles keys in plain string order", () => {
    const { io, calls } = fakeIo({
      state: {
        5: { name: "app-5", at: NOW - 3600 },
        10: { name: "app-10", at: NOW - 3600 },
        "conflict-5": { name: "app-5-conflict", at: NOW - 3600, pr: "9", mainSha: "s" },
      },
    });
    pollRepo(repo(), ctx(), io);
    expect(calls.log.filter((l) => l.includes("state="))).toEqual([
      "[app] #10: app-10 state=<none>",
      "[app] #5: app-5 state=<none>",
      "[app] #5: app-5-conflict state=<none>",
    ]);
  });

  it("checks the hand-off of done sessions and always drops them", () => {
    const done = (name: string) => ({ name, state: "done", startedAt: 1 });
    const { io, calls } = fakeIo({
      state: {
        5: { name: "app-5", at: NOW - 3600 },
        6: { name: "app-6", at: NOW - 3600 },
        "conflict-7": { name: "app-7-conflict", at: NOW - 3600, pr: "70", mainSha: "s" },
      },
      issueViews: {
        5: { state: "OPEN", labels: [{ name: "needs-review" }] },
        6: { state: "OPEN", labels: [{ name: "in-progress" }] },
      },
      prView: { state: "OPEN", mergeable: "CONFLICTING" },
    });
    pollRepo(repo(), ctx({ sessions: [done("app-5"), done("app-6"), done("app-7-conflict")] }), io);
    expect(calls.gh).toContain("pr view 70 --repo org/app --json state,mergeable");
    expect(calls.log).toContain("[app] #6: session finished but the ticket was not handed off -> agent-failed");
    expect(calls.log).toContain("[app] #7: session finished but the conflict remains (PR #70) -> agent-failed");
    expect(calls.log.some((l) => l.includes("#5: session"))).toBe(false);
    expect(calls.ghRun.map((x) => x.split(" --body")[0])).toEqual([
      "issue edit 6 --repo org/app --add-label agent-failed --remove-label in-progress",
      "issue comment 6 --repo org/app",
      "issue edit 7 --repo org/app --add-label agent-failed",
      "pr comment 70 --repo org/app",
      "issue comment 7 --repo org/app",
    ]);
    expect(calls.writeState.at(-1)).toEqual({});
  });

  it("aborts the repo when a tracked entry has no launch time", () => {
    const { io } = fakeIo({ state: { 5: { name: "app-5" } as never } });
    expect(() => pollRepo(repo(), ctx(), io)).toThrow(/has no launch time/);
  });

  it("tolerates a failed label edit or PR comment but not a failed issue comment", () => {
    const state = { "conflict-7": { name: "app-7-conflict", at: NOW - 3600, pr: "70", mainSha: "s" } };
    const sessions = [{ name: "app-7-conflict", state: "failed" }];
    let f = fakeIo({ state, fail: ["issue edit", "pr comment"] });
    pollRepo(repo(), ctx({ sessions }), f.io);
    expect(f.calls.writeState.at(-1)).toEqual({});

    f = fakeIo({ state, fail: ["issue comment"] });
    expect(() => pollRepo(repo(), ctx({ sessions }), f.io)).toThrow(CommandError);
    expect(f.calls.writeState).toEqual([]);
    expect(f.calls.gh.some((c) => c.startsWith("issue list"))).toBe(false);
  });

  it("a gh failure in the launch phase propagates and stops the poll", () => {
    const { io, calls } = fakeIo({ fail: ["issue list"] });
    expect(() => pollRepo(repo(), ctx(), io)).toThrow(CommandError);
    expect(calls.gh.some((c) => c.startsWith("pr list"))).toBe(false);
  });

  it("a failed launch aborts the repo after earlier launches were counted", () => {
    const { io } = fakeIo({ issues: [readyIssue(1), readyIssue(2)], fail: ["claude --bg --name app-2"] });
    const c = ctx();
    expect(() => pollRepo(repo(), c, io)).toThrow(CommandError);
    expect(c.launches.get("app")).toBe(1);
  });

  it("defers at the cap without recording, counting launches from other repos", () => {
    const { io, calls } = fakeIo({ issues: [readyIssue(1), readyIssue(2)], prs: [conflictPr(9, 5)], issueViews: { 5: openIssue } });
    const c = ctx({ maxSessions: 3, globalLive: 1, launches: new Map([["other", 1]]) });
    pollRepo(repo(), c, io);
    expect(calls.launch.map((l) => l.args[2])).toEqual(["app-1"]);
    expect(calls.log).toContain("[app] deferred #2: at session cap");
    expect(calls.log).toContain("[app] deferred #5: at session cap (conflict resolution for PR #9)");
    expect(calls.writeAttempts).toEqual([]);
  });

  it("respects the repo cap with this repo's live sessions", () => {
    const { io, calls } = fakeIo({ issues: [readyIssue(1), readyIssue(2)] });
    pollRepo(repo({ maxSessions: 2, repoLive: 1 }), ctx(), io);
    expect(calls.launch.map((l) => l.args[2])).toEqual(["app-1"]);
    expect(calls.log).toContain("[app] deferred #2: at session cap");
  });

  it("fetches main once, skips PRs already attempted against it, and keeps going", () => {
    const { io, calls } = fakeIo({
      prs: [conflictPr(9, 5), conflictPr(10, 6)],
      issueViews: { 5: openIssue, 6: openIssue },
      attempts: { 5: { pr: "9", mainSha: "abcdef123456" }, 6: { pr: "10", mainSha: "older" } },
    });
    pollRepo(repo(), ctx(), io);
    expect(calls.gh.filter((c) => c.startsWith("api"))).toEqual(["api repos/org/app/commits/main"]);
    expect(calls.log).toContain("[app] #5: PR #9 already attempted against main abcdef1; skipping");
    expect(calls.launch.map((l) => l.args[2])).toEqual(["app-6-conflict"]);
    expect(calls.writeAttempts.at(-1)).toEqual({
      5: { pr: "9", mainSha: "abcdef123456" },
      6: { pr: "10", mainSha: "abcdef123456" },
    });
  });

  it("an unreadable issue skips that PR only; an unreadable main SHA ends the phase only", () => {
    let f = fakeIo({ prs: [conflictPr(9, 5), conflictPr(10, 6)], issueViews: { 6: openIssue } });
    pollRepo(repo(), ctx(), f.io);
    expect(f.calls.log).toContain("[app] #5: cannot read issue; skipping");
    expect(f.calls.launch.map((l) => l.args[2])).toEqual(["app-6-conflict"]);

    for (const data of [{ sha: null }, { fail: ["api"] }]) {
      f = fakeIo({ prs: [conflictPr(9, 5), conflictPr(10, 6)], issueViews: { 5: openIssue, 6: openIssue }, ...data });
      expect(() => pollRepo(repo(), ctx(), f.io)).not.toThrow();
      expect(f.calls.log.filter((l) => l.includes("main SHA"))).toEqual([
        "[app] cannot read main SHA; skipping conflict phase",
      ]);
      expect(f.calls.gh.filter((c) => c.startsWith("issue view"))).toHaveLength(1);
      expect(f.calls.launch).toEqual([]);
    }
  });

  it("aborts the repo before any launch when launched.json does not parse", () => {
    const { io, calls } = fakeIo({
      stateError: new SyntaxError("Unexpected token"),
      issues: [readyIssue(1)],
      prs: [conflictPr(9, 5)],
      issueViews: { 5: openIssue },
    });
    expect(() => pollRepo(repo(), ctx(), io)).toThrow(SyntaxError);
    expect(calls.launch).toEqual([]);
    expect(calls.gh).toEqual([]);
    expect(calls.writeState).toEqual([]);
  });

  it("reads conflicts.json only when a PR reaches the attempt check", () => {
    const attemptsError = new SyntaxError("Unexpected token");
    // No PR gets that far: an unparsable conflicts.json does not matter.
    let f = fakeIo({
      attemptsError,
      issues: [readyIssue(1)],
      prs: [{ ...conflictPr(9, 5), mergeable: "MERGEABLE" }, { ...conflictPr(10, 6), isCrossRepository: true }],
    });
    expect(() => pollRepo(repo(), ctx(), f.io)).not.toThrow();
    expect(f.calls.launch.map((l) => l.args[2])).toEqual(["app-1"]);

    // A conflicting PR that needs the attempt check aborts the repo before launching.
    f = fakeIo({ attemptsError, prs: [conflictPr(9, 5)], issueViews: { 5: openIssue } });
    expect(() => pollRepo(repo(), ctx(), f.io)).toThrow(SyntaxError);
    expect(f.calls.launch).toEqual([]);
  });

  describe("a done conflict session whose PR view", () => {
    const state = { "conflict-7": { name: "app-7-conflict", at: NOW - 3600, pr: "70", mainSha: "s" } };
    const sessions = [{ name: "app-7-conflict", state: "done" }];

    it("does not parse counts as resolved: no failure, entry dropped", () => {
      const { io, calls } = fakeIo({ state, prViewText: "not json" });
      pollRepo(repo(), ctx({ sessions }), io);
      expect(calls.ghRun).toEqual([]);
      expect(calls.log.some((l) => l.includes("agent-failed"))).toBe(false);
      expect(calls.writeState.at(-1)).toEqual({});
    });

    it("fails to load aborts the repo and keeps the entry", () => {
      const { io, calls } = fakeIo({ state, fail: ["pr view"] });
      expect(() => pollRepo(repo(), ctx({ sessions }), io)).toThrow(CommandError);
      expect(calls.writeState).toEqual([]);
      expect(calls.gh.some((c) => c.startsWith("issue list"))).toBe(false);
    });
  });
});
