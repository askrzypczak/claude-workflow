// One repo's poll: reconcile the sessions it launched, launch ready tickets, resolve
// conflicting agent PRs, then fix agent PRs whose CI is red.
// Any throw aborts this repo only (main.ts logs it and moves on).
import type { RepoConfig } from "./config.ts";
import {
  alreadyAttempted,
  atCap,
  ciAttemptVerdict,
  ciRemains,
  ciVerdict,
  conflictRemains,
  conflictVerdict,
  handedOff,
  prIssueVerdict,
  reconcileAction,
  sessionState,
  ticketPrompt,
  ticketVerdict,
} from "./decide.ts";
import type { PollerIo } from "./io.ts";
import type { Issue, PrRow, RepoState, Session } from "./schemas.ts";

/** A configured repo with its combined launch flags. */
export type RepoRun = RepoConfig & { flags: string[] };

/** Shared by every repo in one run. */
export interface RunContext {
  sessions: Session[];
  maxSessions: number;
  /** Live sessions per session prefix: counted before the first repo, bumped by each launch (dry-run too). */
  live: Map<string, number>;
}

interface RepoPoll {
  repo: RepoRun;
  state: RepoState;
  run: RunContext;
  io: PollerIo;
  log: (message: string) => void;
  /**
   * Tickets reconcile failed in this poll. They are never relaunched in the same poll: the
   * agent-failed label may not have been applied (a failed edit, or a dry run).
   */
  failed: Set<number>;
}

export function pollRepo(repo: RepoRun, state: RepoState, run: RunContext, io: PollerIo): void {
  const log = (m: string) => io.log(`[${repo.sessionPrefix}] ${m}`);
  const p: RepoPoll = { repo, state, run, io, log, failed: new Set() };
  reconcile(p);
  launchTickets(p);
  const prs = io.listPrs(repo.repo);
  resolveConflicts(p, prs);
  fixCi(p, prs);
}

/** Fails or clears the sessions this poller launched earlier. */
function reconcile(p: RepoPoll): void {
  const { repo, state, io, log } = p;
  const now = io.now();
  for (const [key, entry] of Object.entries(state.launched)) {
    const kind = key.startsWith("conflict-") ? "conflict" : key.startsWith("ci-") ? "ci" : undefined;
    const n = Number(kind ? key.slice(kind.length + 1) : key);
    const pr = kind ? Number(entry.pr) : undefined;
    const st = sessionState(p.run.sessions, entry.name);
    log(`#${n}: ${entry.name} state=${st ?? "<none>"}`);

    const next = reconcileAction(st, now - entry.at);
    if (next.action === "keep") continue;
    const failure = next.action === "fail" ? next.reason : finishedFailure(p, n, kind, pr);
    if (failure !== undefined && kind !== undefined && pr !== undefined) {
      failPrSession(p, n, entry.name, pr, failure, kind);
    }
    else if (failure !== undefined) failTicket(p, n, entry.name, failure);
    delete state.launched[key];
    io.saveState(repo.sessionPrefix, state);
  }
}

/** Why a finished session failed (its ticket was not handed off, or its PR still conflicts or fails CI), if it did. */
function finishedFailure(
  p: RepoPoll,
  n: number,
  kind: "conflict" | "ci" | undefined,
  prNumber: number | undefined,
): string | undefined {
  if (kind !== undefined && prNumber !== undefined) {
    const pr = p.io.viewPr(p.repo.repo, prNumber);
    if (kind === "conflict") {
      return conflictRemains(pr) ? "session finished but the conflict remains" : undefined;
    }
    return ciRemains(pr) ? "session finished but CI is still failing" : undefined;
  }
  const issue = p.io.viewIssue(p.repo.repo, n);
  return handedOff(issue) ? undefined : "session finished but the ticket was not handed off";
}

/** Launches a session per ready ticket, up to the caps. */
function launchTickets(p: RepoPoll): void {
  const { repo, state, io, log } = p;
  for (const issue of io.listIssues(repo.repo)) {
    const verdict = ticketVerdict(issue, repo.owner, state.launched);
    if (!verdict.ok) {
      if (verdict.log) log(verdict.log);
      continue;
    }
    const n = issue.number;
    if (p.failed.has(n)) {
      log(`#${n}: failed earlier in this poll; not relaunching`);
      continue;
    }
    if (capReached(p)) {
      log(`deferred #${n}: at session cap`);
      continue;
    }
    const name = `${repo.sessionPrefix}-${n}`;
    log(`#${n}: launching ${name} (flags: ${flagsText(repo)})`);
    start(p, name, ticketPrompt(issue));
    state.launched[n] = { name, at: io.now() };
    io.saveState(repo.sessionPrefix, state);
  }
}

/**
 * Launches `<prefix>-N-conflict` for same-repo, owner-authored `issue-N-*` PRs that conflict
 * with main, at most once per main SHA. Detection is plain gh (no model tokens).
 */
function resolveConflicts(p: RepoPoll, prs: readonly PrRow[]): void {
  const { repo, state, io, log } = p;
  let mainSha: string | undefined; // read once, and only if a PR gets this far
  for (const pr of prs) {
    const verdict = conflictVerdict(pr, {
      owner: repo.owner,
      prefix: repo.sessionPrefix,
      sessions: p.run.sessions,
      launched: state.launched,
    });
    if (!verdict.ok) {
      if (verdict.log) log(verdict.log);
      continue;
    }
    const { n } = verdict;
    if (p.failed.has(n)) {
      log(`#${n}: failed earlier in this poll; skipping conflict resolution`);
      continue;
    }

    let issue: Issue;
    try {
      issue = io.viewIssue(repo.repo, n);
    } catch {
      log(`#${n}: cannot read issue; skipping`);
      continue;
    }
    const issueVerdict = prIssueVerdict(issue, n, repo.owner, "conflict resolution");
    if (!issueVerdict.ok) {
      if (issueVerdict.log) log(issueVerdict.log);
      continue;
    }

    try {
      mainSha ??= io.mainSha(repo.repo);
    } catch {
      log("cannot read main SHA; skipping conflict phase");
      return;
    }
    if (alreadyAttempted(state.attempts, n, pr.number, mainSha)) {
      log(`#${n}: PR #${pr.number} already attempted against main ${mainSha.slice(0, 7)}; skipping`);
      continue;
    }
    if (capReached(p)) {
      log(`deferred #${n}: at session cap (conflict resolution for PR #${pr.number})`);
      continue;
    }
    const name = `${repo.sessionPrefix}-${n}-conflict`;
    log(`#${n}: PR #${pr.number} conflicts with main; launching ${name} (flags: ${flagsText(repo)})`);
    start(p, name, `/ticket-workflow:resolve-conflicts ${n}`);
    state.launched[`conflict-${n}`] = { name, at: io.now(), pr: String(pr.number), mainSha };
    state.attempts[n] = { pr: String(pr.number), mainSha };
    io.saveState(repo.sessionPrefix, state);
  }
}

/**
 * Launches `<prefix>-N-ci` for same-repo, owner-authored `issue-N-*` PRs that are MERGEABLE
 * with red checks, once per head SHA and at most MAX_CI_ATTEMPTS per PR.
 */
function fixCi(p: RepoPoll, prs: readonly PrRow[]): void {
  const { repo, state, io, log } = p;
  for (const pr of prs) {
    const verdict = ciVerdict(pr, {
      owner: repo.owner,
      prefix: repo.sessionPrefix,
      sessions: p.run.sessions,
      launched: state.launched,
    });
    if (!verdict.ok) {
      if (verdict.log) log(verdict.log);
      continue;
    }
    const { n } = verdict;
    if (p.failed.has(n)) {
      log(`#${n}: failed earlier in this poll; skipping CI fix`);
      continue;
    }

    let issue: Issue;
    try {
      issue = io.viewIssue(repo.repo, n);
    } catch {
      log(`#${n}: cannot read issue; skipping`);
      continue;
    }
    const issueVerdict = prIssueVerdict(issue, n, repo.owner, "CI fix");
    if (!issueVerdict.ok) {
      if (issueVerdict.log) log(issueVerdict.log);
      continue;
    }

    const attempt = ciAttemptVerdict(state.ciAttempts, pr.number, pr.headRefOid);
    if (!attempt.ok) {
      if (attempt.log) log(attempt.log);
      continue;
    }
    if (capReached(p)) {
      log(`deferred #${n}: at session cap (CI fix for PR #${pr.number})`);
      continue;
    }
    const name = `${repo.sessionPrefix}-${n}-ci`;
    log(`#${n}: PR #${pr.number} has failing CI; launching ${name} (flags: ${flagsText(repo)})`);
    start(p, name, `/ticket-workflow:fix-ci ${n}`);
    state.launched[`ci-${n}`] = { name, at: io.now(), pr: String(pr.number) };
    state.ciAttempts[pr.number] = {
      headSha: pr.headRefOid,
      count: (state.ciAttempts[pr.number]?.count ?? 0) + 1,
    };
    io.saveState(repo.sessionPrefix, state);
  }
}

function capReached(p: RepoPoll): boolean {
  return atCap(p.run.live, p.repo.sessionPrefix, {
    repoMax: p.repo.maxSessions,
    globalMax: p.run.maxSessions,
  });
}

function start(p: RepoPoll, name: string, prompt: string): void {
  p.io.launch(p.repo.dir, name, p.repo.flags, prompt);
  p.run.live.set(p.repo.sessionPrefix, (p.run.live.get(p.repo.sessionPrefix) ?? 0) + 1);
}

function flagsText(repo: RepoRun): string {
  return repo.flags.join(" ") || "<none>";
}

/** A best-effort step: a failure is logged and the reconcile carries on. */
function tryTo(p: RepoPoll, what: string, step: () => void): void {
  try {
    step();
  } catch (err) {
    p.log(`could not ${what}: ${(err as Error).message}`);
  }
}

// The issue comment is the step that must succeed: if it throws, the entry stays tracked and
// the failure is reported again on the next poll.
function failTicket(p: RepoPoll, n: number, name: string, reason: string): void {
  const repo = p.repo.repo;
  p.failed.add(n);
  p.log(`#${n}: ${reason} -> agent-failed`);
  tryTo(p, `label #${n}`, () => p.io.editLabels(repo, n, ["agent-failed"], ["in-progress"]));
  p.io.commentOnIssue(
    repo,
    n,
    `Background session \`${name}\` ended without finishing: ${reason}. See \`claude logs ${name}\` or \`claude agents\`. To retry, remove \`agent-failed\` and add \`ready\`.`,
  );
}

function failPrSession(
  p: RepoPoll,
  n: number,
  name: string,
  pr: number,
  reason: string,
  kind: "conflict" | "ci",
): void {
  const repo = p.repo.repo;
  p.failed.add(n);
  p.log(`#${n}: ${reason} (PR #${pr}) -> agent-failed`);
  const body =
    kind === "conflict"
      ? `Conflict-resolution session \`${name}\` ended without resolving the conflict on PR #${pr}: ${reason}. See \`claude logs ${name}\`. It will not be retried against the same main; remove \`agent-failed\` to allow a retry once main moves.`
      : `CI-fix session \`${name}\` ended without getting CI green on PR #${pr}: ${reason}. See \`claude logs ${name}\`. It will not be retried against the same commit; remove \`agent-failed\` to allow a retry once the PR has a new commit.`;
  tryTo(p, `label #${n}`, () => p.io.editLabels(repo, n, ["agent-failed"], []));
  tryTo(p, `comment on PR #${pr}`, () => p.io.commentOnPr(repo, pr, body));
  p.io.commentOnIssue(repo, n, body);
}
