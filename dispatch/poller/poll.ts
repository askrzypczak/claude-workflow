// One repo's poll: reconcile tracked sessions, launch ready tickets, resolve PR conflicts.
// Any throw aborts this repo only (main.ts logs it and moves on).
import {
  alreadyAttempted,
  atCap,
  conflictIssueEligible,
  conflictSessionGate,
  conflictStillOpen,
  epoch,
  handedOff,
  parseStateKey,
  prCandidate,
  reconcileDecision,
  sessionState,
  stateKeys,
  ticketLaunchDecision,
} from "./decide.ts";
import type { PollerIo } from "./io.ts";
import { field, isAbsent, jqRaw } from "./jq.ts";
import type {
  ConflictAttempts,
  IssueRow,
  IssueView,
  LaunchedEntry,
  LaunchedState,
  PrRow,
  PrView,
  RepoRun,
  RunContext,
} from "./types.ts";

/** Everything one repo's poll works with, passed explicitly to each phase and helper. */
export interface RepoPoll {
  repo: RepoRun;
  ctx: RunContext;
  io: PollerIo;
  /** Logs with this repo's `[prefix] `. */
  log: (message: string) => void;
}

/** Rows of a gh list result; anything that is not a JSON array yields no rows. */
function parseRows(text: string): unknown[] {
  try {
    const parsed: unknown = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** Parsed JSON, or {} when it does not parse (where jq's failure was swallowed in a test). */
function parseOrEmpty(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return {};
  }
}

/**
 * A tracked entry's launch time. Without a usable `at` the age is unknown, so the repo is
 * aborted rather than guessing (failing the ticket, or waiting on it forever).
 */
function entryTime(at: unknown, key: string): number {
  const t = epoch(at);
  if (t === undefined) throw new Error(`launched.json entry ${key} has no launch time (at)`);
  return t;
}

// --- Per-repo helpers. State writes are no-ops in dry-run. ------------------------

function setEntry(p: RepoPoll, state: LaunchedState, key: string, entry: LaunchedEntry): void {
  if (p.ctx.dry) return;
  state[key] = entry;
  p.io.writeState(p.repo.prefix, state);
}

function deleteEntry(p: RepoPoll, state: LaunchedState, key: string): void {
  if (p.ctx.dry) return;
  delete state[key];
  p.io.writeState(p.repo.prefix, state);
}

function setAttempt(
  p: RepoPoll,
  attempts: ConflictAttempts,
  n: string,
  pr: string,
  mainSha: string,
): void {
  if (p.ctx.dry) return;
  attempts[n] = { pr, mainSha };
  p.io.writeAttempts(p.repo.prefix, attempts);
}

/** A side-effect gh command, or its `[dry-run]` log line. */
function runGh(p: RepoPoll, args: string[]): void {
  if (p.ctx.dry) p.log(`[dry-run] gh ${args.join(" ")}`);
  else p.io.ghRun(args);
}

/** `|| true`: this step may fail without aborting the repo. */
function tolerate(fn: () => void): void {
  try {
    fn();
  } catch {
    // ignored on purpose
  }
}

function failIssue(p: RepoPoll, n: string, name: string, reason: string): void {
  const repo = p.repo.repo;
  p.log(`#${n}: ${reason} -> agent-failed`);
  tolerate(() =>
    runGh(p, ["issue", "edit", n, "--repo", repo, "--add-label", "agent-failed", "--remove-label", "in-progress"]),
  );
  runGh(p, [
    "issue", "comment", n, "--repo", repo, "--body",
    `Background session \`${name}\` ended without finishing: ${reason}. See \`claude logs ${name}\` or \`claude agents\`. To retry, remove \`agent-failed\` and add \`ready\`.`,
  ]);
}

function failConflict(p: RepoPoll, n: string, name: string, pr: string, reason: string): void {
  const repo = p.repo.repo;
  p.log(`#${n}: ${reason} (PR #${pr}) -> agent-failed`);
  const body = `Conflict-resolution session \`${name}\` ended without resolving the conflict on PR #${pr}: ${reason}. See \`claude logs ${name}\`. It will not be retried against the same main; remove \`agent-failed\` to allow a retry once main moves.`;
  tolerate(() => runGh(p, ["issue", "edit", n, "--repo", repo, "--add-label", "agent-failed"]));
  tolerate(() => runGh(p, ["pr", "comment", pr, "--repo", repo, "--body", body]));
  runGh(p, ["issue", "comment", n, "--repo", repo, "--body", body]);
}

function capReached(p: RepoPoll): boolean {
  let total = 0;
  for (const c of p.ctx.launches.values()) total += c;
  return atCap({
    repoMax: p.repo.maxSessions,
    repoLive: p.repo.repoLive,
    repoLaunches: p.ctx.launches.get(p.repo.prefix) ?? 0,
    globalLive: p.ctx.globalLive,
    totalLaunches: total,
    max: p.ctx.maxSessions,
  });
}

function flagsText(p: RepoPoll): string {
  return p.repo.flags.join(" ") || "<none>";
}

/** Starts `claude --bg` (or logs it in dry-run) and counts the launch either way. */
function startSession(p: RepoPoll, name: string, prompt: string): void {
  const { repo, ctx } = p;
  if (ctx.dry) {
    p.log(`[dry-run] (cd ${repo.dir} && claude --bg --name ${name} ${repo.flags.join(" ")} "${prompt}")`);
  } else {
    p.io.launch(repo.dir, ["--bg", "--name", name, ...repo.flags, prompt]);
  }
}

function noteLaunch(p: RepoPoll): void {
  p.ctx.launches.set(p.repo.prefix, (p.ctx.launches.get(p.repo.prefix) ?? 0) + 1);
}

// --- Phases --------------------------------------------------------------------------

/** Fails or clears sessions this poller launched earlier. */
export function reconcile(p: RepoPoll, state: LaunchedState): void {
  const { repo, ctx, io, log } = p;
  const now = io.now();
  for (const key of stateKeys(state)) {
    const { n, conflict } = parseStateKey(key);
    const entry = state[key];
    const pr = conflict ? jqRaw(field(entry, "pr")) : "";
    const name = jqRaw(field(entry, "name"));
    const age = now - entryTime(field(entry, "at"), key);
    const st = sessionState(ctx.sessions, name);
    log(`#${n}: ${name} state=${st || "<none>"}`);
    const fail = (reason: string) =>
      conflict ? failConflict(p, n, name, pr, reason) : failIssue(p, n, name, reason);

    const decision = reconcileDecision(st, age);
    if (decision.kind === "wait" || decision.kind === "leave") continue;
    if (decision.kind === "fail") {
      fail(decision.reason);
    } else if (conflict) {
      // A failing `gh pr view` aborts the repo; output that does not parse counts as
      // not OPEN+CONFLICTING, as the original jq test did.
      const view = parseOrEmpty(
        io.gh(["pr", "view", pr, "--repo", repo.repo, "--json", "state,mergeable"]),
      ) as PrView;
      if (conflictStillOpen(view)) fail("session finished but the conflict remains");
    } else {
      const issue = JSON.parse(
        io.gh(["issue", "view", n, "--repo", repo.repo, "--json", "state,labels"]),
      ) as IssueView;
      if (!handedOff(issue)) fail("session finished but the ticket was not handed off");
    }
    deleteEntry(p, state, key);
  }
}

/** Launches a session per ready ticket, up to the caps. */
export function launchTickets(p: RepoPoll, state: LaunchedState): void {
  const { repo, io, log } = p;
  const rows = parseRows(
    io.gh([
      "issue", "list", "--repo", repo.repo, "--state", "open", "--label", "agent-ok",
      "--limit", "50", "--json", "number,author,labels",
    ]),
  );
  for (const row of rows) {
    const d = ticketLaunchDecision(row as IssueRow, {
      owner: repo.owner,
      prefix: repo.prefix,
      launched: state,
    });
    if (d.kind === "skip") {
      if (d.log) log(d.log);
      continue;
    }
    if (capReached(p)) {
      log(`deferred #${d.n}: at session cap`);
      continue;
    }
    log(`#${d.n}: launching ${d.name} (flags: ${flagsText(p)})`);
    startSession(p, d.name, `/ticket-workflow:work-ticket ${d.arg}`);
    setEntry(p, state, d.n, { name: d.name, at: io.now() });
    noteLaunch(p);
  }
}

/**
 * Launches `<prefix>-N-conflict` for same-repo, owner-authored `issue-N-*` PRs that conflict
 * with main, at most once per main SHA. Detection is plain gh (no model tokens).
 */
export function resolveConflicts(p: RepoPoll, state: LaunchedState): void {
  const { repo, ctx, io, log } = p;
  const rows = parseRows(
    io.gh([
      "pr", "list", "--repo", repo.repo, "--state", "open", "--limit", "100", "--json",
      "number,headRefName,mergeable,mergeStateStatus,isCrossRepository,author",
    ]),
  );
  // Both read lazily: only a PR that reaches the attempt check needs them.
  let mainSha = "";
  let attempts: ConflictAttempts | undefined;
  for (const row of rows) {
    const c = prCandidate(row as PrRow, repo.owner);
    if (c.kind === "skip") {
      if (c.log) log(c.log);
      continue;
    }
    const { n, pr } = c;
    const gate = conflictSessionGate({
      n,
      pr,
      prefix: repo.prefix,
      sessions: ctx.sessions,
      launched: state,
    });
    if (gate.kind === "skip") {
      if (gate.log) log(gate.log);
      continue;
    }

    let issueText: string;
    try {
      issueText = io.gh(["issue", "view", n, "--repo", repo.repo, "--json", "author,labels,state"]);
    } catch {
      log(`#${n}: cannot read issue; skipping`);
      continue;
    }
    const eligible = conflictIssueEligible(parseOrEmpty(issueText) as IssueView, n, repo.owner);
    if (eligible.kind === "skip") {
      if (eligible.log) log(eligible.log);
      continue;
    }

    if (mainSha === "") {
      try {
        const sha = field(JSON.parse(io.gh(["api", `repos/${repo.repo}/commits/main`])), "sha");
        if (isAbsent(sha)) throw new Error("no sha");
        mainSha = jqRaw(sha);
      } catch {
        log("cannot read main SHA; skipping conflict phase");
        break;
      }
    }
    attempts ??= io.readAttempts(repo.prefix);
    if (alreadyAttempted(attempts, n, pr, mainSha)) {
      log(`#${n}: PR #${pr} already attempted against main ${mainSha.slice(0, 7)}; skipping`);
      continue;
    }

    if (capReached(p)) {
      log(`deferred #${n}: at session cap (conflict resolution for PR #${pr})`);
      continue;
    }
    const cname = `${repo.prefix}-${n}-conflict`;
    log(`#${n}: PR #${pr} conflicts with main; launching ${cname} (flags: ${flagsText(p)})`);
    startSession(p, cname, `/ticket-workflow:resolve-conflicts ${n}`);
    setEntry(p, state, `conflict-${n}`, { name: cname, at: io.now(), pr, mainSha });
    setAttempt(p, attempts, n, pr, mainSha);
    noteLaunch(p);
  }
}

/** Polls one repo. Its state files must exist (main.ts creates them, even in dry-run). */
export function pollRepo(repo: RepoRun, ctx: RunContext, io: PollerIo): void {
  const p: RepoPoll = { repo, ctx, io, log: (message) => io.log(`[${repo.prefix}] ${message}`) };
  const state = io.readState(repo.prefix);
  reconcile(p, state);
  launchTickets(p, state);
  resolveConflicts(p, state);
}
