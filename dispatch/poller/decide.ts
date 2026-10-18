// Pure decisions: session state, caps, bypass flags, reconcile, ticket launch and conflict
// eligibility. Log lines are returned without the timestamp or `[prefix] `.
import {
  authorLogin,
  field,
  jqCompare,
  jqRaw,
  labelNames,
} from "./jq.ts";
import type {
  ConflictAttempts,
  IssueRow,
  IssueView,
  LaunchedState,
  PrRow,
  PrView,
} from "./types.ts";

/** An unlisted session younger than this may just not be listed yet. */
export const LISTING_GRACE_SEC = 600;

/**
 * A launch time from launched.json as epoch seconds: a number, or a string of digits (shell
 * arithmetic accepted both). Anything else is undefined.
 */
export function epoch(at: unknown): number | undefined {
  if (typeof at === "number") return at;
  if (typeof at === "string" && /^[0-9]+$/.test(at)) return Number(at);
  return undefined;
}

const ENDED = new Set(["done", "failed", "stopped"]);

/** State of the newest session (by startedAt) with that name, or "" if there is none. */
export function sessionState(sessions: readonly unknown[], name: string): string {
  const matching = sessions.filter((s) => field(s, "name") === name);
  if (matching.length === 0) return "";
  const newest = matching
    .map((s, i) => ({ s, i }))
    .sort(
      (a, b) =>
        jqCompare(field(a.s, "startedAt"), field(b.s, "startedAt")) || a.i - b.i,
    )
    .at(-1)?.s;
  const st = field(newest, "state");
  if (st === undefined || st === null || st === false) return "";
  return jqRaw(st);
}

/**
 * Entries whose session is not done/failed/stopped, plus unlisted entries younger than
 * the grace period (a missing `at` counts as 0, so those are not live).
 */
export function liveCount(
  state: Record<string, unknown>,
  sessions: readonly unknown[],
  now: number,
): number {
  let count = 0;
  for (const entry of Object.values(state)) {
    const name = field(entry, "name");
    if (typeof name !== "string" || name === "") continue;
    const at = field(entry, "at");
    const st = sessionState(sessions, name);
    if (ENDED.has(st)) continue;
    if (st === "") {
      if (now - (epoch(at) ?? 0) < LISTING_GRACE_SEC) count++;
      continue;
    }
    count++;
  }
  return count;
}

/** True when starting another session would hit the repo's or the global cap. */
export function atCap(opts: {
  repoMax?: number;
  repoLive: number;
  repoLaunches: number;
  globalLive: number;
  totalLaunches: number;
  max: number;
}): boolean {
  if (
    opts.repoMax !== undefined &&
    opts.repoLive + opts.repoLaunches >= opts.repoMax
  ) {
    return true;
  }
  return opts.globalLive + opts.totalLaunches >= opts.max;
}

/** True if any flag grants bypassPermissions. */
export function hasBypassFlag(flags: readonly string[]): boolean {
  let prev = "";
  for (const f of flags) {
    if (
      f === "--dangerously-skip-permissions" ||
      f === "--allow-dangerously-skip-permissions" ||
      f === "--permission-mode=bypassPermissions"
    ) {
      return true;
    }
    if (f === "bypassPermissions" && prev === "--permission-mode") return true;
    prev = f;
  }
  return false;
}

/** launched.json keys in plain string order (as jq `keys`), not JS integer-key order. */
export function stateKeys(state: Record<string, unknown>): string[] {
  return Object.keys(state).sort();
}

/** `conflict-N` -> ticket N of a conflict session; any other key is a ticket number. */
export function parseStateKey(key: string): { n: string; conflict: boolean } {
  if (key.startsWith("conflict-")) {
    return { n: key.slice("conflict-".length), conflict: true };
  }
  return { n: key, conflict: false };
}

export type ReconcileDecision =
  | { kind: "wait" }
  | { kind: "fail"; reason: string }
  | { kind: "check" }
  | { kind: "leave" };

/**
 * What to do with a tracked session given its state ("" when unlisted) and age in seconds.
 * "check" means it finished: look at the ticket or PR to see if it handed off.
 */
export function reconcileDecision(st: string, ageSec: number): ReconcileDecision {
  if (st === "") {
    return ageSec < LISTING_GRACE_SEC
      ? { kind: "wait" }
      : { kind: "fail", reason: "no session found" };
  }
  if (st === "failed" || st === "stopped") {
    return { kind: "fail", reason: `session ${st}` };
  }
  if (st === "done") return { kind: "check" };
  return { kind: "leave" };
}

/** A finished ticket session handed off if the issue is closed or labelled for a human. */
export function handedOff(issue: IssueView): boolean {
  if (jqRaw(field(issue, "state")) === "CLOSED") return true;
  const labels = labelNames(issue);
  return ["needs-review", "blocked", "agent-failed"].some((l) =>
    labels.includes(l),
  );
}

/** A finished conflict session failed if its PR is still open and conflicting. */
export function conflictStillOpen(pr: PrView): boolean {
  return (
    jqRaw(field(pr, "state")) === "OPEN" &&
    jqRaw(field(pr, "mergeable")) === "CONFLICTING"
  );
}

export type Skip = { kind: "skip"; log?: string };

export type TicketDecision =
  | Skip
  | { kind: "launch"; n: string; name: string; arg: string };

/** Whether an `agent-ok` issue row should get a session (before the cap check). */
export function ticketLaunchDecision(
  row: IssueRow,
  opts: { owner: string; prefix: string; launched: LaunchedState },
): TicketDecision {
  const n = jqRaw(field(row, "number"));
  const labels = labelNames(row);
  const has = (l: string) => labels.includes(l);
  if (has("in-progress") || has("blocked") || has("agent-failed")) {
    return { kind: "skip" };
  }
  if (!has("ready")) return { kind: "skip" };
  const author = authorLogin(row);
  if (author !== opts.owner) {
    return {
      kind: "skip",
      log: `#${n}: author ${author} is not ${opts.owner}; skipping`,
    };
  }
  if (Object.hasOwn(opts.launched, n)) return { kind: "skip" };
  return {
    kind: "launch",
    n,
    name: `${opts.prefix}-${n}`,
    arg: has("skip-plan") ? `${n} auto` : n,
  };
}

export type PrCandidate = Skip | { kind: "candidate"; n: string; pr: string };

/** First conflict filter: an `issue-N-*` branch, same repo, by the owner, CONFLICTING. */
export function prCandidate(row: PrRow, owner: string): PrCandidate {
  const pr = jqRaw(field(row, "number"));
  const branch = field(row, "headRefName");
  const match =
    typeof branch === "string" ? /^issue-([0-9]+)-/.exec(branch) : null;
  if (!match) return { kind: "skip" };
  const n = match[1] as string;
  // Anyone can open a PR from a fork and name its branch issue-N-*: only same-repo PRs
  // by the owner are resolved. A missing isCrossRepository counts as a fork.
  if (field(row, "isCrossRepository") !== false) {
    return { kind: "skip", log: `#${n}: PR #${pr} is from a fork; skipping` };
  }
  const prAuthor = authorLogin(row);
  if (prAuthor !== owner) {
    return {
      kind: "skip",
      log: `#${n}: PR #${pr} author ${prAuthor} is not ${owner}; skipping`,
    };
  }
  const mergeable = jqRaw(field(row, "mergeable"));
  if (mergeable === "UNKNOWN") {
    return {
      kind: "skip",
      log: `#${n}: PR #${pr} mergeability unknown; retry next poll`,
    };
  }
  if (mergeable !== "CONFLICTING") return { kind: "skip" };
  return { kind: "candidate", n, pr };
}

/** Session gating: the ticket session owns the branch while active; one conflict session at a time. */
export function conflictSessionGate(opts: {
  n: string;
  pr: string;
  prefix: string;
  sessions: readonly unknown[];
  launched: LaunchedState;
}): Skip | { kind: "ok" } {
  const ticket = `${opts.prefix}-${opts.n}`;
  const ticketState = sessionState(opts.sessions, ticket);
  if (ticketState === "working" || ticketState === "blocked") {
    return {
      kind: "skip",
      log: `#${opts.n}: PR #${opts.pr} conflicts but ${ticket} is active; skipping`,
    };
  }
  const conflictState = sessionState(opts.sessions, `${ticket}-conflict`);
  if (conflictState !== "" && !ENDED.has(conflictState)) return { kind: "skip" };
  if (Object.hasOwn(opts.launched, `conflict-${opts.n}`)) return { kind: "skip" };
  return { kind: "ok" };
}

/** The ticket behind a conflicting PR must be open, agent-ok, not agent-failed, by the owner. */
export function conflictIssueEligible(
  issue: IssueView,
  n: string,
  owner: string,
): Skip | { kind: "ok" } {
  if (jqRaw(field(issue, "state")) !== "OPEN") {
    return {
      kind: "skip",
      log: `#${n}: issue is not open; skipping conflict resolution`,
    };
  }
  const labels = labelNames(issue);
  if (!labels.includes("agent-ok")) return { kind: "skip" };
  if (labels.includes("agent-failed")) return { kind: "skip" };
  if (authorLogin(issue) !== owner) {
    return {
      kind: "skip",
      log: `#${n}: author is not ${owner}; skipping conflict resolution`,
    };
  }
  return { kind: "ok" };
}

/** True if this PR was already tried against this main SHA (compared as strings). */
export function alreadyAttempted(
  attempts: ConflictAttempts,
  n: string,
  pr: string,
  mainSha: string,
): boolean {
  const last = Object.hasOwn(attempts, n) ? attempts[n] : undefined;
  return field(last, "pr") === pr && field(last, "mainSha") === mainSha;
}
