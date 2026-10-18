// Entry point, run by dispatch/agent-poller.sh: node dispatch/poller/main.ts [--dry-run]
// Validates the config, takes the lock, fetches sessions once, then polls each repo.
// A failure in one repo is logged and the others still run; the exit code is then 1.
import { combinedFlags, expandHome, parseMaxSessions, validateConfig } from "./config.ts";
import { hasBypassFlag, liveCount } from "./decide.ts";
import { CommandError, realIo, writeFd } from "./io.ts";
import type { SystemIo } from "./io.ts";
import { pollRepo } from "./poll.ts";
import type { RepoConfig, RepoRun, RunContext } from "./types.ts";

type Env = Record<string, string | undefined>;

function repoRun(entry: RepoConfig, env: Env, home: string): Omit<RepoRun, "repoLive"> {
  return {
    repo: entry.repo,
    dir: expandHome(entry.dir, home),
    prefix: entry.sessionPrefix,
    owner: entry.owner,
    flags: combinedFlags(env.CLAUDE_BG_FLAGS || "", entry.bgFlags),
    ...(entry.maxSessions !== undefined ? { maxSessions: entry.maxSessions } : {}),
  };
}

/** Exit status of a failed repo poll: the failing command's, else 1. */
function failureStatus(err: unknown): number {
  if (err instanceof CommandError) return err.status;
  // Not a command failure (the command has already printed its own error): show it.
  writeFd(2, `poller: ${err instanceof Error ? err.message : String(err)}\n`);
  return 1;
}

/** Everything after the lock is held. */
function pollAll(
  repos: RepoConfig[],
  opts: { dry: boolean; maxSessions: number; env: Env; home: string },
  io: SystemIo,
): number {
  // Abort (rather than guess) if we cannot read the session list: a wrong empty
  // answer would relaunch everything. Fetched once and shared by all repos.
  let agentsText: string;
  try {
    agentsText = io.claudeAgents();
  } catch {
    io.log("claude agents --json failed; aborting");
    return 1;
  }
  let sessions: unknown;
  try {
    sessions = JSON.parse(agentsText);
  } catch {
    sessions = undefined;
  }
  if (!Array.isArray(sessions)) {
    io.log("unexpected agents output; aborting");
    return 1;
  }

  let globalLive = 0;
  for (const entry of repos) {
    globalLive += liveCount(io.readStateForCount(entry.sessionPrefix), sessions, io.now());
  }
  const ctx: RunContext = {
    dry: opts.dry,
    maxSessions: opts.maxSessions,
    globalLive,
    sessions,
    launches: new Map(),
  };

  let failures = 0;
  for (const entry of repos) {
    const run = repoRun(entry, opts.env, opts.home);
    const log = (message: string) => io.log(`[${run.prefix}] ${message}`);
    if (opts.env.CLAUDE_ALLOW_BYPASS_PERMISSIONS !== "1" && hasBypassFlag(run.flags)) {
      log(
        `refusing bypass flags (${run.flags.join(" ")}); set CLAUDE_ALLOW_BYPASS_PERMISSIONS=1 to allow; skipping this repo`,
      );
      failures++;
      continue;
    }
    io.ensureRepoState(run.prefix);
    const repoLive = liveCount(io.readStateForCount(run.prefix), sessions, io.now());
    try {
      pollRepo({ ...run, repoLive }, ctx, io);
    } catch (err) {
      log(`poll failed (exit ${failureStatus(err)}); continuing with the next repo`);
      failures++;
    }
  }

  io.log("done");
  return failures === 0 ? 0 : 1;
}

function main(argv: string[], env: Env): number {
  const home = env.HOME ?? "";
  const configPath = env.CLAUDE_WORKFLOW_CONFIG || `${home}/.config/claude-workflow/repos.json`;
  const stateDir = env.STATE_DIR || `${home}/.local/state/claude-workflow`;
  const dry = argv[0] === "--dry-run";
  const io = realIo(stateDir);

  const max = parseMaxSessions(env.CLAUDE_MAX_SESSIONS);
  if (!max.ok) {
    io.log(max.message);
    return 1;
  }
  const config = validateConfig(io.readConfig(configPath), {
    path: configPath,
    home,
    dirExists: io.dirExists,
  });
  if (!config.ok) {
    io.log(config.message);
    return config.exitCode;
  }

  const lock = io.acquireLock();
  if (lock.kind === "busy") {
    io.log(`another run is active (pid ${lock.pid}); exiting`);
    return 0;
  }
  const onSignal = (signal: NodeJS.Signals, code: number) => {
    process.on(signal, () => {
      io.releaseLock();
      process.exit(code);
    });
  };
  onSignal("SIGINT", 130);
  onSignal("SIGTERM", 143);
  onSignal("SIGHUP", 129);
  try {
    return pollAll(config.repos, { dry, maxSessions: max.value, env, home }, io);
  } finally {
    io.releaseLock();
  }
}

process.exitCode = main(process.argv.slice(2), process.env);
