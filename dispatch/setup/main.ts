// Entry point, run by dispatch/setup-agents.sh: node dispatch/setup/main.ts [phase] [--dry-run]
// [--rebuild] [--add-repo owner/name]
// A live run first reads what it can without a change and, when anything is missing, lists it
// all by repo and stops before any change; otherwise it runs the phases in order and stops at
// the first one that needs the maintainer. --dry-run ends with that list.
import { realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { check } from "./check.ts";
import { container } from "./container.ts";
import { credentials, dispatchPaused } from "./credentials.ts";
import { host } from "./host.ts";
import { createIo } from "./io.ts";
import type { SetupIo } from "./io.ts";
import { servedRepos } from "./repos.ts";
import type { ServedRepo } from "./repos.ts";
import { findingLines, findings, preflight, recordingIo } from "./preflight.ts";
import type { Report } from "./preflight.ts";

type PhaseResult = "ok" | "stop";

export interface SetupContext {
  io: SetupIo;
  dryRun: boolean;
  clone: string;
  home: string;
  repos: readonly ServedRepo[];
  /** --rebuild: container rebuilds the image with --pull --no-cache and replaces the container. */
  rebuild?: boolean;
  /** A full run (no phase argument): only then may the check phase resume dispatch. */
  fullRun?: boolean;
}

export interface Phase {
  name: string;
  run(ctx: SetupContext): PhaseResult;
}

/** The phases, in the order a full run takes them. */
const PHASES: readonly Phase[] = [credentials, host, container, check];

const USAGE = `Usage: dispatch/setup-agents.sh [${PHASES.map((p) => p.name).join("|")}] [--dry-run] [--rebuild]
       [--add-repo owner/name]
  First reads what it can without a change and, when anything is missing, lists it all by
  repo and stops before any change. With no phase, then runs every phase in order and stops at
  the first that needs the maintainer; when every phase passes, the last one (check) resumes
  dispatch. A single phase never does.
  --dry-run   run the reads and print what each step would do, then that list; change nothing.
  --rebuild   container: rebuild the image with --pull --no-cache and replace the container,
              keeping its home volume; it refuses while a session is live.
  --add-repo  add owner/name to the dispatch config (created when missing), then run as usual;
              a repo listed already is left as it is.`;

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** The phases argv selects and its flags, or undefined on a usage error. */
function parse(
  argv: readonly string[],
): { phases: readonly Phase[]; full: boolean; dryRun: boolean; rebuild: boolean; addRepo: string | undefined } | undefined {
  let parsed;
  try {
    parsed = parseArgs({
      args: [...argv],
      options: {
        "dry-run": { type: "boolean", default: false },
        rebuild: { type: "boolean", default: false },
        "add-repo": { type: "string" },
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
  return {
    phases,
    full: name === undefined,
    dryRun: values["dry-run"],
    rebuild: values.rebuild,
    addRepo: values["add-repo"],
  };
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
  const pausedLine = () => {
    try {
      if (dispatchPaused(base.io, base.clone)) {
        console.log("Dispatch stays paused until a full run of dispatch/setup-agents.sh passes every phase, or until dispatch/install-launchd.sh resume.");
      }
    } catch {
      // The status read failed: the stop line above stands alone.
    }
  };
  try {
    const served = (io: SetupIo, dryRun: boolean) =>
      servedRepos(io, { clone: base.clone, configPath: base.configPath, addRepo: args.addRepo, dryRun });
    const context = (repos: readonly ServedRepo[]): SetupContext => ({
      io: base.io,
      dryRun: args.dryRun,
      rebuild: args.rebuild,
      fullRun: args.full,
      clone: base.clone,
      home: base.home,
      repos,
    });
    if (!args.dryRun) {
      const found = preflight(args.phases, context(served(recordingIo(base.io, [], false), true)));
      for (const line of findingLines(found, "Preflight")) console.log(line);
      if (found.todo.length > 0) {
        console.log("Stopped before any change: do the to-dos above, then rerun dispatch/setup-agents.sh.");
        pausedLine();
        return 1;
      }
    }
    const ctx = context(served(base.io, args.dryRun));
    const byPhase = new Map<string, Report[]>();
    const summary = () => {
      if (!args.dryRun) return;
      for (const line of findingLines(findings(byPhase, ctx.repos), "Dry run summary")) console.log(line);
    };
    for (const phase of args.phases) {
      console.log(`--- ${phase.name}${args.dryRun ? " (dry run)" : ""} ---`);
      const reports: Report[] = [];
      byPhase.set(phase.name, reports);
      const io = args.dryRun ? recordingIo(base.io, reports, true) : base.io;
      if (phase.run({ ...ctx, io }) === "stop") {
        console.log(`Stopped in ${phase.name}: do the to-dos above, then rerun dispatch/setup-agents.sh.`);
        pausedLine();
        summary();
        return 1;
      }
    }
    summary();
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
