// Pure decisions: session states, caps, reconcile outcomes, and which tickets
// and PRs get a session. Skip log lines are returned without the timestamp or `[prefix] `.
import type { Attempts, Check, CiAttempts, Issue, IssueRow, Launched, PrRow, PrStatus, Session } from "./schemas.ts";

/** An unlisted session younger than this may just not be listed yet. */
const LISTING_GRACE_SEC = 600;

/** CI-fix sessions per PR, across head SHAs. */
const MAX_CI_ATTEMPTS = 2;

export const ENDED = ["done", "failed", "stopped"];
const HANDED_OFF = ["needs-review", "blocked", "agent-failed"];

/** Go ahead (with any extra data), or skip, with a log line when the skip is worth reporting. */
export type Verdict<T = object> = ({ ok: true } & T) | { ok: false; log?: string };

/** State of the newest listed session with this name, or undefined when none is listed. */
export function sessionState(sessions: readonly Session[], name: string): string | undefined {
  let newest: Session | undefined;
  for (const s of sessions) {
    if (s.name === name && (newest === undefined || s.startedAt >= newest.startedAt)) newest = s;
  }
  return newest?.state;
}

/** Tracked sessions still taking a slot: listed and not ended, or unlisted but launched within the grace period. */
export function liveCount(launched: Launched, sessions: readonly Session[], now: number): number {
  return Object.values(launched).filter(({ name, at }) => {
    const state = sessionState(sessions, name);
    return state === undefined ? now - at < LISTING_GRACE_SEC : !ENDED.includes(state);
  }).length;
}

/**
 * Listed sessions named `<prefix>-...` that have not ended: the live count for a repo whose
 * launched.json cannot be read. It may overcount (any session with that name), never under.
 */
export function liveByPrefix(sessions: readonly Session[], prefix: string): number {
  return sessions.filter((s) => s.name?.startsWith(`${prefix}-`) && !ENDED.includes(s.state)).length;
}

/** True when another session for `prefix` would exceed its repo cap or the global cap. */
export function atCap(
  live: ReadonlyMap<string, number>,
  prefix: string,
  caps: { repoMax?: number; globalMax: number },
): boolean {
  let total = 0;
  for (const count of live.values()) total += count;
  const repoLive = live.get(prefix) ?? 0;
  return (caps.repoMax !== undefined && repoLive >= caps.repoMax) || total >= caps.globalMax;
}

export type ReconcileAction =
  | { action: "keep" }
  | { action: "fail"; reason: string }
  | { action: "check" };

/** What to do with a tracked session; "check" means it finished: see whether it handed off. */
export function reconcileAction(state: string | undefined, ageSec: number): ReconcileAction {
  if (state === undefined) {
    return ageSec < LISTING_GRACE_SEC
      ? { action: "keep" }
      : { action: "fail", reason: "no session found" };
  }
  if (state === "failed" || state === "stopped") return { action: "fail", reason: `session ${state}` };
  if (state === "done") return { action: "check" };
  return { action: "keep" };
}

/** A finished ticket session handed off if the issue is closed or labelled for a human. */
export function handedOff(issue: Issue): boolean {
  return issue.state === "CLOSED" || issue.labels.some((l) => HANDED_OFF.includes(l));
}

/** A finished conflict session failed if its PR is still open and conflicting. */
export function conflictRemains(pr: PrStatus): boolean {
  return pr.state === "OPEN" && pr.mergeable === "CONFLICTING";
}

/** Whether an open `agent-ok` issue gets a ticket session (before the cap check). */
export function ticketVerdict(issue: IssueRow, owner: string, launched: Launched): Verdict {
  const has = (label: string) => issue.labels.includes(label);
  if (!has("ready") || has("in-progress") || has("blocked") || has("agent-failed") || has("orchestrate-epic-run")) {
    return { ok: false };
  }
  if (issue.author.login !== owner) {
    return { ok: false, log: `#${issue.number}: author ${issue.author.login} is not ${owner}; skipping` };
  }
  if (String(issue.number) in launched) return { ok: false };
  return { ok: true };
}

/** The work-ticket command for an issue; `skip-plan` adds `auto` (no plan sign-off). */
export function ticketPrompt(issue: IssueRow): string {
  const auto = issue.labels.includes("skip-plan") ? " auto" : "";
  return `/ticket-workflow:work-ticket ${issue.number}${auto}`;
}

/**
 * Whether a PR gets a conflict session, before its issue is read: an `issue-N-*` branch in
 * this repo (anyone can name a fork's branch that way), by the owner, CONFLICTING, while
 * ticket N's session is not active and no conflict session for N is live or tracked. A PR
 * labelled `orchestrate-epic-run` is skipped.
 */
export function conflictVerdict(
  pr: PrRow,
  opts: { owner: string; prefix: string; sessions: readonly Session[]; launched: Launched },
): Verdict<{ n: number }> {
  const match = /^issue-([0-9]+)-/.exec(pr.headRefName);
  if (!match) return { ok: false };
  const n = Number(match[1]);
  if (pr.labels.includes("orchestrate-epic-run")) return { ok: false };
  const at = `#${n}: PR #${pr.number}`;
  if (pr.isCrossRepository) return { ok: false, log: `${at} is from a fork; skipping` };
  if (pr.author.login !== opts.owner) {
    return { ok: false, log: `${at} author ${pr.author.login} is not ${opts.owner}; skipping` };
  }
  if (pr.mergeable === "UNKNOWN") return { ok: false, log: `${at} mergeability unknown; retry next poll` };
  if (pr.mergeable !== "CONFLICTING") return { ok: false };

  const ticket = `${opts.prefix}-${n}`;
  const ticketState = sessionState(opts.sessions, ticket);
  if (ticketState === "working" || ticketState === "blocked") {
    return { ok: false, log: `${at} conflicts but ${ticket} is active; skipping` };
  }
  const conflictState = sessionState(opts.sessions, `${ticket}-conflict`);
  if (conflictState !== undefined && !ENDED.includes(conflictState)) return { ok: false };
  if (`conflict-${n}` in opts.launched) return { ok: false };
  return { ok: true, n };
}

/** The ticket behind a PR session must be open, agent-ok, not agent-failed or orchestrate-epic-run, by the owner. */
export function prIssueVerdict(issue: Issue, n: number, owner: string, action: string): Verdict {
  if (issue.state !== "OPEN") return { ok: false, log: `#${n}: issue is not open; skipping ${action}` };
  if (
    !issue.labels.includes("agent-ok") ||
    issue.labels.includes("agent-failed") ||
    issue.labels.includes("orchestrate-epic-run")
  ) {
    return { ok: false };
  }
  if (issue.author?.login !== owner) {
    return { ok: false, log: `#${n}: author is not ${owner}; skipping ${action}` };
  }
  return { ok: true };
}

/** A PR's checks: red (a failed check, none pending), pending (any not finished), or ok. */
export function ciState(checks: readonly Check[]): "red" | "pending" | "ok" {
  const failed = ["FAILURE", "ERROR", "TIMED_OUT", "STARTUP_FAILURE"];
  let red = false;
  for (const c of checks) {
    if ((c.status != null && c.status !== "COMPLETED") || c.state === "PENDING" || c.state === "EXPECTED") {
      return "pending";
    }
    if (failed.includes(c.conclusion ?? "") || failed.includes(c.state ?? "")) red = true;
  }
  return red ? "red" : "ok";
}

/**
 * Whether a PR gets a CI-fix session, before its issue is read: an `issue-N-*` branch in this
 * repo, by the owner, MERGEABLE with red checks, while ticket N's session is not active and no
 * CI-fix or conflict session for N is live or tracked. A PR labelled `orchestrate-epic-run`
 * is skipped.
 */
export function ciVerdict(
  pr: PrRow,
  opts: { owner: string; prefix: string; sessions: readonly Session[]; launched: Launched },
): Verdict<{ n: number }> {
  const match = /^issue-([0-9]+)-/.exec(pr.headRefName);
  if (!match) return { ok: false };
  const n = Number(match[1]);
  if (pr.labels.includes("orchestrate-epic-run")) return { ok: false };
  const at = `#${n}: PR #${pr.number}`;
  if (pr.isCrossRepository) return { ok: false, log: `${at} is from a fork; skipping` };
  if (pr.author.login !== opts.owner) {
    return { ok: false, log: `${at} author ${pr.author.login} is not ${opts.owner}; skipping` };
  }
  if (pr.mergeable === "UNKNOWN") return { ok: false, log: `${at} mergeability unknown; retry next poll` };
  if (pr.mergeable !== "MERGEABLE") return { ok: false };
  if (ciState(pr.statusCheckRollup) !== "red") return { ok: false };

  const ticket = `${opts.prefix}-${n}`;
  const ticketState = sessionState(opts.sessions, ticket);
  if (ticketState === "working" || ticketState === "blocked") {
    return { ok: false, log: `${at} has failing CI but ${ticket} is active; skipping` };
  }
  const ci = `${ticket}-ci`;
  const ciSession = sessionState(opts.sessions, ci);
  if ((ciSession !== undefined && !ENDED.includes(ciSession)) || `ci-${n}` in opts.launched) {
    return { ok: false, log: `${at} has failing CI but ${ci} is already running; skipping` };
  }
  const conflictState = sessionState(opts.sessions, `${ticket}-conflict`);
  if (conflictState !== undefined && !ENDED.includes(conflictState)) return { ok: false };
  if (`conflict-${n}` in opts.launched) return { ok: false };
  return { ok: true, n };
}

/** Whether this PR may get another CI-fix attempt at this head SHA, within MAX_CI_ATTEMPTS. */
export function ciAttemptVerdict(attempts: CiAttempts, pr: number, headSha: string): Verdict {
  const last = attempts[String(pr)];
  if (last === undefined) return { ok: true };
  if (last.headSha === headSha) return { ok: false };
  if (last.count >= MAX_CI_ATTEMPTS) {
    return { ok: false, log: `PR #${pr}: ${last.count} CI-fix attempts already made; skipping` };
  }
  return { ok: true };
}

/** A finished CI-fix session failed if its PR is still open with red checks. */
export function ciRemains(pr: PrStatus): boolean {
  return pr.state === "OPEN" && ciState(pr.statusCheckRollup) === "red";
}

/** True if this PR was already tried against this main SHA. */
export function alreadyAttempted(attempts: Attempts, n: number, pr: number, mainSha: string): boolean {
  const last = attempts[String(n)];
  return last?.pr === String(pr) && last.mainSha === mainSha;
}
