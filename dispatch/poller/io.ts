// The poller's side effects: gh, claude, state files, the run lock and the log.
// pollRepo only sees the PollerIo interface, so tests can drive it with a fake.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { z } from "zod";
import {
  Attempts,
  CiAttempts,
  Commit,
  Issue,
  IssueList,
  Launched,
  parseJson,
  PrList,
  PrStatus,
  Sessions,
} from "./schemas.ts";
import type { IssueRow, PrRow, RepoState, Session } from "./schemas.ts";

/** What one repo's poll needs. Reads and effects throw on failure. */
export interface PollerIo {
  /** Open `agent-ok` issues. */
  listIssues(repo: string): IssueRow[];
  /** Open PRs. */
  listPrs(repo: string): PrRow[];
  viewIssue(repo: string, n: number): Issue;
  viewPr(repo: string, pr: number): PrStatus;
  mainSha(repo: string): string;
  editLabels(repo: string, n: number, add: string[], remove: string[]): void;
  commentOnIssue(repo: string, n: number, body: string): void;
  commentOnPr(repo: string, pr: number, body: string): void;
  /** Starts `claude --bg --name <name> <flags> <prompt>` in `dir`. */
  launch(dir: string, name: string, flags: string[], prompt: string): void;
  saveState(prefix: string, state: RepoState): void;
  /** Epoch seconds. */
  now(): number;
  log(message: string): void;
}

/** `YYYY-MM-DD HH:MM:SS` in local time. */
export function timestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

export function log(message: string): void {
  console.log(`${timestamp(new Date())} ${message}`);
}

/** Runs a command and returns its stdout; stderr goes to the log. */
function output(cmd: string, args: string[]): string {
  return execFileSync(cmd, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
    maxBuffer: 64 * 1024 * 1024,
  });
}

/** Runs `gh` and parses its JSON output. */
function ghJson<T extends z.ZodType>(schema: T, args: string[]): z.output<T> {
  return parseJson(schema, output("gh", args), `gh ${args.slice(0, 2).join(" ")}`);
}

/** Whether `curl` reaches `url` (exit 0); its output is discarded. */
export function reachable(url: string): boolean {
  void url;
  throw new Error("not implemented");
}

/** `claude agents --json --all`, fetched once per run. */
export function listSessions(): Session[] {
  return parseJson(Sessions, output("claude", ["agents", "--json", "--all"]), "claude agents --json --all");
}

function stateFiles(stateDir: string, prefix: string) {
  const dir = join(stateDir, "repos", prefix);
  return {
    dir,
    launched: join(dir, "launched.json"),
    attempts: join(dir, "conflicts.json"),
    ciAttempts: join(dir, "ci-attempts.json"),
  };
}

/** A state file's text, or "{}" when it does not exist yet. */
function readStateFile(file: string): string {
  try {
    return readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return "{}";
    throw err;
  }
}

/** Reads a repo's state files; missing ones are empty. Writes nothing. */
export function loadState(stateDir: string, prefix: string): RepoState {
  const files = stateFiles(stateDir, prefix);
  return {
    launched: parseJson(Launched, readStateFile(files.launched), files.launched),
    attempts: parseJson(Attempts, readStateFile(files.attempts), files.attempts),
    ciAttempts: parseJson(CiAttempts, readStateFile(files.ciAttempts), files.ciAttempts),
  };
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(`${file}.tmp`, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(`${file}.tmp`, file);
}

/** The real PollerIo. With `dryRun`, effects are logged as `[dry-run] ...` and state is not written. */
export function createIo(stateDir: string, dryRun: boolean): PollerIo {
  const gh = (args: string[]) => {
    if (dryRun) log(`[dry-run] gh ${args.join(" ")}`);
    else execFileSync("gh", args, { stdio: ["ignore", "inherit", "inherit"] });
  };

  return {
    listIssues: (repo) =>
      ghJson(IssueList, [
        "issue", "list", "--repo", repo, "--state", "open", "--label", "agent-ok",
        "--limit", "50", "--json", "number,author,labels",
      ]),
    listPrs: (repo) =>
      ghJson(PrList, [
        "pr", "list", "--repo", repo, "--state", "open", "--limit", "100",
        "--json", "number,headRefName,headRefOid,mergeable,isCrossRepository,author,labels,statusCheckRollup",
      ]),
    viewIssue: (repo, n) =>
      ghJson(Issue, ["issue", "view", String(n), "--repo", repo, "--json", "author,labels,state"]),
    viewPr: (repo, pr) =>
      ghJson(PrStatus, ["pr", "view", String(pr), "--repo", repo, "--json", "state,mergeable,statusCheckRollup"]),
    mainSha: (repo) => ghJson(Commit, ["api", `repos/${repo}/commits/main`]).sha,

    editLabels: (repo, n, add, remove) =>
      gh([
        "issue", "edit", String(n), "--repo", repo,
        ...add.flatMap((l) => ["--add-label", l]),
        ...remove.flatMap((l) => ["--remove-label", l]),
      ]),
    commentOnIssue: (repo, n, body) => gh(["issue", "comment", String(n), "--repo", repo, "--body", body]),
    commentOnPr: (repo, pr, body) => gh(["pr", "comment", String(pr), "--repo", repo, "--body", body]),
    launch: (dir, name, flags, prompt) => {
      if (dryRun) {
        log(`[dry-run] (cd ${dir} && claude --bg --name ${name} ${flags.join(" ")} "${prompt}")`);
      } else {
        execFileSync("claude", ["--bg", "--name", name, ...flags, prompt], { cwd: dir, stdio: "inherit" });
      }
    },
    saveState: (prefix, state) => {
      if (dryRun) return;
      const files = stateFiles(stateDir, prefix);
      mkdirSync(files.dir, { recursive: true });
      writeJson(files.launched, state.launched);
      writeJson(files.attempts, state.attempts);
      writeJson(files.ciAttempts, state.ciAttempts);
    },
    now: () => Math.floor(Date.now() / 1000),
    log,
  };
}

/**
 * Takes the global run lock: a directory holding the owner's pid. A lock left by a process
 * that is gone is taken over. Returns the holder's pid when another run is active.
 */
export function acquireLock(stateDir: string): { acquired: true } | { acquired: false; pid: string } {
  const lockDir = join(stateDir, "lock");
  mkdirSync(stateDir, { recursive: true });
  try {
    mkdirSync(lockDir);
  } catch {
    const pidFile = join(lockDir, "pid");
    const pid = existsSync(pidFile) ? readFileSync(pidFile, "utf8").trim() : "";
    if (/^[0-9]+$/.test(pid) && processAlive(Number(pid))) return { acquired: false, pid };
    rmSync(lockDir, { recursive: true, force: true });
    mkdirSync(lockDir);
  }
  writeFileSync(join(lockDir, "pid"), `${process.pid}\n`);
  return { acquired: true };
}

export function releaseLock(stateDir: string): void {
  rmSync(join(stateDir, "lock"), { recursive: true, force: true });
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
