// The LaunchAgent's job, run by dispatch/launchd/job.sh: node dispatch/launchd/job.ts [--dry-run] | deps | halt
// It reaches the agent container only through dispatch/setup/docker.ts on SetupIo.
import type { SetupIo } from "../setup/io.ts";

export interface JobContext {
  io: SetupIo;
  /** The host clone of this repo. */
  clone: string;
  /** The host home directory. */
  home: string;
}

/** One poll: Colima and the container up and ready, the plugin updated, the config copied in, then the poller. */
export function poll(ctx: JobContext, opts: { dryRun: boolean }): number {
  void ctx;
  void opts;
  throw new Error("not implemented");
}

/** Install's step: the container's clone of this repo at the host clone's commit, with npm ci run there. */
export function deps(ctx: JobContext): number {
  void ctx;
  throw new Error("not implemented");
}

/** Pause's and uninstall's step: ends a poll running in the container and lists its live sessions. */
export function halt(ctx: JobContext): number {
  void ctx;
  throw new Error("not implemented");
}

/** `[--dry-run] | deps | halt`; 2 on a usage error. */
export function runJob(argv: readonly string[], ctx: JobContext): number {
  void argv;
  void ctx;
  throw new Error("not implemented");
}
