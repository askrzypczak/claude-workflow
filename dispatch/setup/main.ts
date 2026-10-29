// Entry point, run by dispatch/setup-agents.sh: node dispatch/setup/main.ts [phase] [--dry-run]
// Runs the phases in order and stops at the first one that needs the maintainer.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { credentials } from "./credentials.ts";
import { createIo } from "./io.ts";
import type { SetupIo } from "./io.ts";
import type { ServedRepo } from "./repos.ts";

export type PhaseResult = "ok" | "stop";

export interface SetupContext {
  io: SetupIo;
  dryRun: boolean;
  clone: string;
  home: string;
  repos: readonly ServedRepo[];
}

export interface Phase {
  name: string;
  run(ctx: SetupContext): PhaseResult;
}

/** The phases, in the order a full run takes them. */
const PHASES: readonly Phase[] = [credentials];

/** 0 when every phase passed, 1 when one stopped or failed, 2 on a usage error. */
export function runSetup(
  argv: readonly string[],
  base: { io: SetupIo; clone: string; home: string; configPath: string },
): number {
  throw new Error("not implemented");
}

const self = fileURLToPath(import.meta.url);

/** True when node was started on this file, so importing it runs nothing. */
function isEntry(): boolean {
  const arg = process.argv[1];
  if (arg === undefined) return false;
  try {
    return realpathSync(arg) === realpathSync(self);
  } catch {
    return false;
  }
}

if (isEntry()) {
  const home = homedir();
  process.exitCode = runSetup(process.argv.slice(2), {
    io: createIo(),
    clone: resolve(dirname(self), "../.."),
    home,
    configPath: process.env.CLAUDE_WORKFLOW_CONFIG || join(home, ".config/claude-workflow/repos.json"),
  });
}
