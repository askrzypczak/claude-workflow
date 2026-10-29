// The setup script's side effects, behind one interface shared by every phase.
// Phases only see SetupIo, so tests can drive them with the fake in fake-io.ts.
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
}

export function createIo(): SetupIo {
  throw new Error("not implemented");
}
