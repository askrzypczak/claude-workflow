// Entry point, run by dispatch/setup-agents.sh: node dispatch/setup/main.ts [phase] [--dry-run] [--no-managed]
// Runs the phases in order and stops at the first one that needs the maintainer.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { check } from "./check.ts";
import { credentials } from "./credentials.ts";
import { createIo } from "./io.ts";
import type { SetupIo } from "./io.ts";
import { servedRepos } from "./repos.ts";
import type { ServedRepo } from "./repos.ts";
import { MANAGED_SETTINGS, sandbox } from "./sandbox.ts";
import { ssh } from "./ssh.ts";

export type PhaseResult = "ok" | "stop";

export interface SetupContext {
  io: SetupIo;
  dryRun: boolean;
  clone: string;
  home: string;
  repos: readonly ServedRepo[];
  /** --no-managed: skip the managed settings copy. */
  noManaged?: boolean;
  /** A full run (no phase argument): only then may the check phase resume dispatch. */
  fullRun?: boolean;
}

export interface Phase {
  name: string;
  run(ctx: SetupContext): PhaseResult;
}

/** The phases, in the order a full run takes them. */
const PHASES: readonly Phase[] = [credentials, ssh, sandbox, check];

const USAGE = `Usage: dispatch/setup-agents.sh [${PHASES.map((p) => p.name).join("|")}] [--dry-run] [--no-managed]
  With no phase, runs every phase in order and stops at the first that needs the maintainer;
  when every phase passes, the last one (check) resumes dispatch. A single phase never does.
  --dry-run  run the reads and print what each step would do; change nothing.
  --no-managed  sandbox: skip the managed settings copy (${MANAGED_SETTINGS}, written with sudo).`;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The phases argv selects and its flags, or undefined on a usage error. */
function parse(
  argv: readonly string[],
): { phases: readonly Phase[]; full: boolean; dryRun: boolean; noManaged: boolean } | undefined {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        "dry-run": { type: "boolean", default: false },
        "no-managed": { type: "boolean", default: false },
      },
      allowPositionals: true,
      strict: true,
    });
  } catch {
    return undefined;
  }
  const { positionals, values } = parsed;
  if (positionals.length > 1) return undefined;
  const name = positionals[0];
  const phases = name === undefined ? PHASES : PHASES.filter((p) => p.name === name);
  if (phases.length === 0) return undefined;
  return { phases, full: name === undefined, dryRun: values["dry-run"], noManaged: values["no-managed"] };
}

/** 0 when every phase passed, 1 when one stopped or failed, 2 on a usage error. */
export function runSetup(
  argv: readonly string[],
  base: { io: SetupIo; clone: string; home: string; configPath: string },
): number {
  const args = parse(argv);
  if (args === undefined) {
    console.error(USAGE);
    return 2;
  }
  try {
    const repos = servedRepos(base.io, base);
    const ctx: SetupContext = {
      io: base.io,
      dryRun: args.dryRun,
      noManaged: args.noManaged,
      fullRun: args.full,
      clone: base.clone,
      home: base.home,
      repos,
    };
    for (const phase of args.phases) {
      console.log(`--- ${phase.name}${args.dryRun ? " (dry run)" : ""} ---`);
      if (phase.run(ctx) === "stop") {
        console.log(`Stopped in ${phase.name}: do the to-dos above, then rerun dispatch/setup-agents.sh.`);
        return 1;
      }
    }
  } catch (err) {
    console.error(`setup-agents: ${message(err)}`);
    return 1;
  }
  return 0;
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
