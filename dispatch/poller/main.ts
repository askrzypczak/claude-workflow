// Entry point, run by dispatch/agent-poller.sh: node dispatch/poller/main.ts [--dry-run]
// Validates the config, takes the lock, fetches sessions once, then polls each repo. A failure
// in one repo is logged and the others still run; the exit code is then 1.
import { parseArgs } from "node:util";
import { loadConfig, parseMaxSessions } from "./config.ts";
import type { RepoConfig } from "./config.ts";
import { liveByPrefix, liveCount } from "./decide.ts";
import { acquireLock, createIo, listSessions, loadState, log, releaseLock } from "./io.ts";
import { pollRepo } from "./poll.ts";
import type { Session } from "./schemas.ts";

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

interface RunOptions {
  stateDir: string;
  dryRun: boolean;
  maxSessions: number;
}

function pollAll(repos: RepoConfig[], opts: RunOptions): number {
  // Abort (rather than guess) if the session list cannot be read: a wrong empty answer
  // would relaunch everything.
  let sessions: Session[];
  try {
    sessions = listSessions();
  } catch (err) {
    log(`cannot read sessions (${message(err)}); aborting`);
    return 1;
  }

  // A repo whose state cannot be read fails below; for the caps, its live sessions are
  // counted from the session list by name instead.
  const now = Math.floor(Date.now() / 1000);
  const loaded = repos.map((entry) => {
    try {
      return { entry, state: loadState(opts.stateDir, entry.sessionPrefix) };
    } catch (error) {
      return { entry, error };
    }
  });
  const live = new Map<string, number>();
  for (const { entry, state } of loaded) {
    const count = state ? liveCount(state.launched, sessions, now) : liveByPrefix(sessions, entry.sessionPrefix);
    live.set(entry.sessionPrefix, count);
  }

  const io = createIo(opts.stateDir, opts.dryRun);
  const run = { sessions, maxSessions: opts.maxSessions, live };
  let failures = 0;
  for (const { entry, state, error } of loaded) {
    const repoLog = (m: string) => log(`[${entry.sessionPrefix}] ${m}`);
    try {
      if (!state) throw error;
      pollRepo(entry, state, run, io);
    } catch (err) {
      repoLog(`poll failed: ${message(err)}; continuing with the next repo`);
      failures++;
    }
  }
  log("done");
  return failures === 0 ? 0 : 1;
}

function main(): number {
  const { values } = parseArgs({ options: { "dry-run": { type: "boolean", default: false } } });
  const env = process.env;
  const home = env.HOME ?? "";
  const configPath = env.CLAUDE_WORKFLOW_CONFIG || `${home}/.config/claude-workflow/repos.json`;
  const stateDir = env.STATE_DIR || `${home}/.local/state/claude-workflow`;

  let repos: RepoConfig[];
  let maxSessions: number;
  try {
    maxSessions = parseMaxSessions(env.CLAUDE_MAX_SESSIONS);
    repos = loadConfig(configPath, home);
  } catch (err) {
    log(`${message(err)}; aborting`);
    return 1;
  }
  if (repos.length === 0) {
    log(`config ${configPath} has no repos; nothing to do`);
    return 0;
  }
  // No signal handlers: a signal ends the run at once, and the next run takes over the lock
  // its gone pid left behind.
  const lock = acquireLock(stateDir);
  if (!lock.acquired) {
    log(`another run is active (pid ${lock.pid}); exiting`);
    return 0;
  }
  try {
    return pollAll(repos, {
      stateDir,
      dryRun: values["dry-run"],
      maxSessions,
    });
  } finally {
    releaseLock(stateDir);
  }
}

process.exitCode = main();
