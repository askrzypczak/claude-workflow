// The setup script's side effects, behind one interface shared by every phase.
// Phases only see SetupIo, so tests can drive them with the fake in fake-io.ts.
import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  closeSync,
  constants,
  copyFileSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { listSessions } from "../poller/io.ts";
import type { Session } from "../poller/schemas.ts";

/**
 * How a step is reported, one line per step: `done`, `already` (already done), `would`
 * (dry run), `pass`, `fail`, `todo` (what the maintainer must do now; the phase stops)
 * and `note`.
 */
export type StepStatus = "done" | "already" | "would" | "pass" | "fail" | "todo" | "note";

export interface RunOptions {
  /** Added to the child's environment. */
  env?: Readonly<Record<string, string>>;
  /** Written to the child's stdin. */
  input?: string;
  /** The child's working directory. */
  cwd?: string;
}

export interface RunResult {
  status: number;
  stdout: string;
  stderr: string;
}

export interface SetupIo {
  /**
   * Runs a command and never throws on a non-zero exit. The child gets this process's
   * environment minus GH_TOKEN and GITHUB_TOKEN, plus `opts.env`.
   */
  run(cmd: string, args: readonly string[], opts?: RunOptions): RunResult;
  /** `claude agents --json --all`. */
  listSessions(): Session[];
  /** Reads a line from the terminal without echoing it. */
  readSecret(prompt: string): string;
  /** Asks a yes/no question; the default is No. */
  confirm(question: string): boolean;
  /** A file's text, or undefined when it does not exist. */
  readFile(path: string): string | undefined;
  /** This process's environment. */
  env(name: string): string | undefined;
  report(status: StepStatus, text: string): void;
  /** The names of a directory's entries; undefined when it does not exist. */
  listDir(path: string): string[] | undefined;
  /**
   * A regular file's first line without its newline, reading no byte past it (at most 256
   * bytes); undefined when the path is missing or not a regular file.
   */
  readFirstLine(path: string): string | undefined;
  /** Appends; creates the file with mode 0600 when missing. */
  appendFile(path: string, text: string): void;
  /** Copies; throws when `to` exists. */
  copyFile(from: string, to: string): void;
  /** Waits for Enter at the terminal; throws without a terminal, as `confirm` does. */
  waitForEnter(prompt: string): void;
  /** Replaces a file's text; creates it with mode 0600 when missing. */
  writeFile(path: string, text: string): void;
  /**
   * Starts `claude --bg --name <name> <flags> <prompt>` in `dir`, as the poller does, with
   * exactly `env` as the child's environment.
   */
  launch(dir: string, name: string, flags: readonly string[], prompt: string, env: Readonly<Record<string, string>>): void;
  /**
   * Polls a file until `done` holds for its text and returns that text; at the timeout, the
   * last text read, or undefined when the file never appeared.
   */
  waitForFile(path: string, done: (text: string) => boolean, timeoutMs: number): string | undefined;
  /** Removes a file; no error when it is missing. */
  removeFile(path: string): void;
}

const LABELS: Record<StepStatus, string> = {
  done: "done",
  already: "already done",
  would: "would",
  pass: "pass",
  fail: "fail",
  todo: "to do now",
  note: "note",
};

/** Variables that would override the stored gh login (and make `gh auth login` refuse). */
const TOKEN_VARS = ["GH_TOKEN", "GITHUB_TOKEN"];

function childEnv(extra: Readonly<Record<string, string>> | undefined): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const name of TOKEN_VARS) delete env[name];
  return { ...env, ...extra };
}

// `read` and `printf` are bash builtins: the line read never appears in a process's argv,
// and it comes back to node on the child's stdout pipe.
const READ_SECRET = [
  'IFS= read -rs -p "$1" value',
  "status=$?",
  "echo >&2",
  'if [ "$status" -ne 0 ]; then exit "$status"; fi',
  'printf "%s" "$value"',
].join("\n");
const READ_LINE = ['IFS= read -r -p "$1" value || exit', 'printf "%s" "$value"'].join("\n");

/** Reads one line from the terminal with bash `read`; "" on end of input. */
function readLine(script: string, prompt: string): string {
  if (!process.stdin.isTTY) {
    throw new Error("this step reads from the terminal: run dispatch/setup-agents.sh in a terminal");
  }
  const result = spawnSync("bash", ["-c", script, "setup-agents", prompt], {
    stdio: ["inherit", "pipe", "inherit"],
    encoding: "utf8",
  });
  return result.status === 0 ? result.stdout : "";
}

/** The most `readFirstLine` reads when no newline comes first. */
const FIRST_LINE_MAX = 256;
const NEWLINE = 0x0a;

/** A missing path, or a path through something that is not a directory. */
function isMissing(err: unknown): boolean {
  const code = (err as NodeJS.ErrnoException).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/** The real SetupIo: commands run with their output captured; reports go to stdout. */
export function createIo(): SetupIo {
  return {
    run(cmd, args, opts = {}) {
      const result = spawnSync(cmd, args, {
        env: childEnv(opts.env),
        cwd: opts.cwd,
        input: opts.input,
        stdio: [opts.input === undefined ? "ignore" : "pipe", "pipe", "pipe"],
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
      });
      if (result.error && result.status === null) {
        return { status: 127, stdout: result.stdout ?? "", stderr: result.error.message };
      }
      return { status: result.status ?? 1, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    },
    listSessions,
    readSecret: (prompt) => readLine(READ_SECRET, prompt),
    confirm: (question) => /^\s*y(es)?\s*$/i.test(readLine(READ_LINE, `${question} `)),
    readFile(path) {
      try {
        return readFileSync(path, "utf8");
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code;
        if (code === "ENOENT" || code === "ENOTDIR") return undefined;
        throw err;
      }
    },
    env: (name) => process.env[name],
    report(status, text) {
      console.log(`${LABELS[status]}: ${text}`);
    },
    listDir(path) {
      try {
        return readdirSync(path);
      } catch (err) {
        if (isMissing(err)) return undefined;
        throw err;
      }
    },
    readFirstLine(path) {
      let stat;
      try {
        stat = statSync(path);
      } catch (err) {
        if (isMissing(err)) return undefined;
        throw err;
      }
      // Only a regular file is opened, so a socket or a FIFO never blocks the read.
      if (!stat.isFile()) return undefined;
      const fd = openSync(path, "r");
      try {
        // One byte at a time, so nothing past the newline is ever read.
        const line: number[] = [];
        const byte = Buffer.alloc(1);
        while (line.length < FIRST_LINE_MAX && readSync(fd, byte, 0, 1, null) === 1 && byte[0] !== NEWLINE) {
          line.push(byte[0]!);
        }
        return Buffer.from(line).toString("utf8");
      } finally {
        closeSync(fd);
      }
    },
    appendFile(path, text) {
      appendFileSync(path, text, { mode: 0o600 });
    },
    copyFile(from, to) {
      copyFileSync(from, to, constants.COPYFILE_EXCL);
    },
    waitForEnter(prompt) {
      readLine(READ_LINE, `${prompt} `);
    },
    writeFile(path, text) {
      // The mode applies only when the file is created; an existing file keeps its own.
      writeFileSync(path, text, { mode: 0o600 });
    },
    launch() {
      throw new Error("not implemented");
    },
    waitForFile() {
      throw new Error("not implemented");
    },
    removeFile() {
      throw new Error("not implemented");
    },
  };
}
