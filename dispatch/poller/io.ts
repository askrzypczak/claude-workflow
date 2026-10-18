// The poller's side effects behind one interface, so the poll logic can run against a fake.
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { constants } from "node:os";
import { join } from "node:path";
import type { ConflictAttempts, LaunchedState } from "./types.ts";

/** What one repo's poll needs. Every method may throw; a throw aborts that repo. */
export interface PollerIo {
  /** Runs `gh` and returns its stdout (stderr is passed through). Throws on a non-zero exit. */
  gh(args: string[]): string;
  /** Runs a side-effect `gh` command (label, comment) with output passed through. */
  ghRun(args: string[]): void;
  /** Runs `claude <args>` in `cwd` with output passed through. */
  launch(cwd: string, args: string[]): void;
  readState(prefix: string): LaunchedState;
  writeState(prefix: string, state: LaunchedState): void;
  readAttempts(prefix: string): ConflictAttempts;
  writeAttempts(prefix: string, attempts: ConflictAttempts): void;
  /** Epoch seconds. */
  now(): number;
  /** Writes one timestamped line to stdout. */
  log(message: string): void;
}

export type LockResult = { kind: "acquired" } | { kind: "busy"; pid: string };

/** The rest of the real system, used by main.ts before and around the repo loop. */
export interface SystemIo extends PollerIo {
  /** Config file text, or null when it is missing or unreadable. */
  readConfig(path: string): string | null;
  dirExists(dir: string): boolean;
  /** Output of `claude agents --json --all`; throws if the command fails. */
  claudeAgents(): string;
  acquireLock(): LockResult;
  releaseLock(): void;
  /** Creates repos/<prefix>/ and empty `{}` state files (also in dry-run). */
  ensureRepoState(prefix: string): void;
  /** launched.json for live counting: {} when missing or unparsable. */
  readStateForCount(prefix: string): Record<string, unknown>;
}

/** A command that failed; `status` is the exit status the shell would have reported. */
export class CommandError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.name = "CommandError";
    this.status = status;
  }
}

/** `YYYY-MM-DD HH:MM:SS` in local time, like `date '+%F %T'`. */
export function timestamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}

/**
 * Synchronous write to a file descriptor. process.stdout is asynchronous on pipes, which
 * would reorder log lines against child output and drop them on exit.
 */
export function writeFd(fd: number, text: string): void {
  let buf = Buffer.from(text);
  while (buf.length > 0) {
    try {
      buf = buf.subarray(writeSync(fd, buf));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EAGAIN") throw err;
    }
  }
}

function run(
  cmd: string,
  args: string[],
  opts: { capture: boolean; cwd?: string },
): string {
  if (opts.cwd !== undefined && !existsSync(opts.cwd)) {
    throw new CommandError(`cd ${opts.cwd}: no such directory`, 1);
  }
  const res = spawnSync(cmd, args, {
    cwd: opts.cwd,
    encoding: "utf8",
    stdio: opts.capture ? ["inherit", "pipe", "inherit"] : "inherit",
    maxBuffer: 256 * 1024 * 1024,
  });
  if (res.error) {
    const notFound = (res.error as NodeJS.ErrnoException).code === "ENOENT";
    throw new CommandError(`${cmd}: ${res.error.message}`, notFound ? 127 : 1);
  }
  if (res.status !== 0) {
    const sig = res.signal ? constants.signals[res.signal] : undefined;
    const status = res.status ?? (sig !== undefined ? 128 + sig : 1);
    throw new CommandError(`${cmd} ${args.join(" ")} exited ${status}`, status);
  }
  return res.stdout ?? "";
}

function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(tmp, file);
}

export function realIo(stateDir: string): SystemIo {
  const repoDir = (prefix: string) => join(stateDir, "repos", prefix);
  const launchedFile = (prefix: string) => join(repoDir(prefix), "launched.json");
  const attemptsFile = (prefix: string) => join(repoDir(prefix), "conflicts.json");
  const lockDir = join(stateDir, "lock");

  const pidAlive = (pid: string): boolean => {
    if (!/^-?[0-9]+$/.test(pid)) return false;
    try {
      process.kill(Number(pid), 0);
      return true;
    } catch {
      return false;
    }
  };

  return {
    gh: (args) => run("gh", args, { capture: true }),
    ghRun: (args) => {
      run("gh", args, { capture: false });
    },
    launch: (cwd, args) => {
      run("claude", args, { capture: false, cwd });
    },
    readState: (prefix) =>
      JSON.parse(readFileSync(launchedFile(prefix), "utf8")) as LaunchedState,
    writeState: (prefix, state) => writeJson(launchedFile(prefix), state),
    readAttempts: (prefix) =>
      JSON.parse(readFileSync(attemptsFile(prefix), "utf8")) as ConflictAttempts,
    writeAttempts: (prefix, attempts) => writeJson(attemptsFile(prefix), attempts),
    now: () => Math.floor(Date.now() / 1000),
    log: (message) => writeFd(1, `${timestamp(new Date())} ${message}\n`),

    readConfig: (path) => {
      try {
        return readFileSync(path, "utf8");
      } catch (err) {
        // A directory is "readable" to `[ -r ]`; it then fails the JSON check.
        if ((err as NodeJS.ErrnoException).code === "EISDIR") return "";
        return null;
      }
    },
    dirExists: (dir) => {
      try {
        return statSync(dir).isDirectory();
      } catch {
        return false;
      }
    },
    claudeAgents: () => run("claude", ["agents", "--json", "--all"], { capture: true }),
    acquireLock: () => {
      mkdirSync(stateDir, { recursive: true });
      try {
        mkdirSync(lockDir);
      } catch {
        let pid = "";
        try {
          pid = readFileSync(join(lockDir, "pid"), "utf8").replace(/\n+$/, "");
        } catch {
          pid = "";
        }
        if (pid !== "" && pidAlive(pid)) return { kind: "busy", pid };
        rmSync(lockDir, { recursive: true, force: true });
        mkdirSync(lockDir);
      }
      writeFileSync(join(lockDir, "pid"), `${process.pid}\n`);
      return { kind: "acquired" };
    },
    releaseLock: () => rmSync(lockDir, { recursive: true, force: true }),
    ensureRepoState: (prefix) => {
      mkdirSync(repoDir(prefix), { recursive: true });
      for (const file of [launchedFile(prefix), attemptsFile(prefix)]) {
        if (!existsSync(file)) writeFileSync(file, "{}\n");
      }
    },
    readStateForCount: (prefix) => {
      try {
        const parsed: unknown = JSON.parse(readFileSync(launchedFile(prefix), "utf8"));
        return parsed !== null && typeof parsed === "object"
          ? (parsed as Record<string, unknown>)
          : {};
      } catch {
        return {};
      }
    },
  };
}
