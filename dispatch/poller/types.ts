// Shapes shared by the poller modules. Data read from gh, claude and the state files is
// untrusted JSON, so fields that come from outside are typed `unknown` and read via jq.ts.

/** One validated entry of the repos config. */
export interface RepoConfig {
  repo: string;
  dir: string;
  sessionPrefix: string;
  owner: string;
  /** "" when absent (null and false count as absent, like jq `//`). */
  bgFlags: string;
  maxSessions?: number;
}

/** A value in launched.json: `{"<N>": {name, at}, "conflict-<N>": {name, at, pr, mainSha}}`. */
export interface LaunchedEntry {
  name: string;
  at: number;
  pr?: string;
  mainSha?: string;
}
export type LaunchedState = Record<string, LaunchedEntry>;

/** conflicts.json: `{"<N>": {pr, mainSha}}`, the last conflict attempt per ticket. */
export interface ConflictAttempt {
  pr: string;
  mainSha: string;
}
export type ConflictAttempts = Record<string, ConflictAttempt>;

/** An element of `claude agents --json --all`. */
export interface Session {
  name?: unknown;
  state?: unknown;
  startedAt?: unknown;
}

export interface Author {
  login?: unknown;
}
export interface Label {
  name?: unknown;
}

/** A row of `gh issue list --json number,author,labels`. */
export interface IssueRow {
  number?: unknown;
  author?: Author | null;
  labels?: Label[] | null;
}

/** `gh issue view --json state,labels` (reconcile) or `--json author,labels,state` (conflicts). */
export interface IssueView {
  state?: unknown;
  author?: Author | null;
  labels?: Label[] | null;
}

/** A row of `gh pr list --json number,headRefName,mergeable,mergeStateStatus,isCrossRepository,author`. */
export interface PrRow {
  number?: unknown;
  headRefName?: unknown;
  mergeable?: unknown;
  mergeStateStatus?: unknown;
  isCrossRepository?: unknown;
  author?: Author | null;
}

/** `gh pr view --json state,mergeable`. */
export interface PrView {
  state?: unknown;
  mergeable?: unknown;
}

/** Everything one repo's poll needs, resolved from its config entry. */
export interface RepoRun {
  repo: string;
  /** `dir` with `~` expanded. */
  dir: string;
  prefix: string;
  owner: string;
  /** Default flags + CLAUDE_BG_FLAGS + the repo's bgFlags, split on whitespace. */
  flags: string[];
  maxSessions?: number;
  /** Live sessions in this repo's launched.json, read before the poll. */
  repoLive: number;
}

/** Shared by every repo in one run. `launches` is the only field the poll changes. */
export interface RunContext {
  dry: boolean;
  maxSessions: number;
  /** Live sessions across all configured repos, read once before the repo loop. */
  globalLive: number;
  sessions: readonly unknown[];
  /** Launches made this run, per session prefix (dry-run launches count too). */
  launches: Map<string, number>;
}
