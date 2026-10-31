// The agent container's exec seam: every call into the container is `io.run("docker", …)`.
// See dispatch/container/README.md for the run flags, the readiness line and the exec rules.
import type { Session } from "../poller/schemas.ts";
import type { RunResult, SetupIo } from "./io.ts";

export const IMAGE = "claude-workflow-agent";
export const CONTAINER = "claude-workflow-agent";
export const VOLUME = "claude-workflow-home";
export const CONTAINER_HOME = "/home/node";
/** What the entrypoint logs once the firewall is in place. */
export const READY_LINE = "entrypoint: firewall applied";
/** What the entrypoint logs when the firewall cannot be applied; the container then exits. */
export const FAILED_LINE = "entrypoint: firewall failed; not starting";

/** A served repo's clone in the container: /home/node/<name>. */
export function cloneDir(repo: string): string {
  throw new Error("not implemented");
}

/** `docker exec [-i] -u node [-w dir] claude-workflow-agent <args>`. */
export function nodeExec(io: SetupIo, args: readonly string[], opts?: { cwd?: string; input?: string }): RunResult {
  throw new Error("not implemented");
}

/** `docker exec [-w cwd] claude-workflow-agent claude <args>`: the image's wrapper drops to node. */
export function claudeExec(io: SetupIo, cwd: string | undefined, args: readonly string[]): RunResult {
  throw new Error("not implemented");
}

/** A file's text in the container, read as node; undefined when it does not exist. */
export function readInContainer(io: SetupIo, path: string): string | undefined {
  throw new Error("not implemented");
}

/** Replaces a file in the container as node, mode 0600 when created, the text on stdin. */
export function writeInContainer(io: SetupIo, path: string, text: string): RunResult {
  throw new Error("not implemented");
}

export type ContainerState =
  | { kind: "no-docker"; detail: string }
  | { kind: "absent" }
  | {
      kind: "stopped" | "running";
      image: string;
      label: string | undefined;
      startedAt: string;
      mounts: { type: string; name: string | undefined; source: string; destination: string }[];
    };

/** `docker info`, then `docker container inspect`. */
export function containerState(io: SetupIo): ContainerState {
  throw new Error("not implemented");
}

/** Waits for the latest start's readiness line; fails on the failure line or a stopped container. */
export function waitReady(io: SetupIo, timeoutMs: number): { ready: true } | { ready: false; detail: string } {
  throw new Error("not implemented");
}

/**
 * `claude agents --json --all` in the container; undefined when there is no docker or no running
 * container. Throws when the list cannot be read.
 */
export function containerSessions(io: SetupIo): Session[] | undefined {
  throw new Error("not implemented");
}
