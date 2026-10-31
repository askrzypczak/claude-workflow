// The agent container's exec seam: every call into the container is `io.run("docker", …)`.
// See dispatch/container/README.md for the run flags, the readiness line and the exec rules.
import { z } from "zod";
import { parseJson, Sessions } from "../poller/schemas.ts";
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

/** The label whose value decides whether the container is replaced. */
export const CONFIG_LABEL = "claude-workflow.config";

/** The first line of stderr, else of stdout, else the exit status. */
function answer(result: RunResult): string {
  const first = (text: string) => text.split("\n").map((l) => l.trim()).find((l) => l !== "");
  return first(result.stderr) ?? first(result.stdout) ?? `exit ${result.status}`;
}

/** A served repo's clone in the container: /home/node/<name>. */
export function cloneDir(repo: string): string {
  return `${CONTAINER_HOME}/${repo.slice(repo.indexOf("/") + 1)}`;
}

/** `colima <args>` that starts the VM the container runs in: no host directory is mounted. */
export const COLIMA_ARGS: readonly string[] = ["start", "--cpu", "4", "--memory", "4", "--disk", "40", "--mount", "none"];

/** `docker exec [-i] -u node [-w dir] [-e K=V]... claude-workflow-agent <args>`. */
export function nodeExec(
  io: SetupIo,
  args: readonly string[],
  opts: { cwd?: string; input?: string; env?: Readonly<Record<string, string>> } = {},
): RunResult {
  const flags = [
    ...(opts.input === undefined ? [] : ["-i"]),
    "-u",
    "node",
    ...(opts.cwd === undefined ? [] : ["-w", opts.cwd]),
  ];
  return io.run("docker", ["exec", ...flags, CONTAINER, ...args], opts.input === undefined ? {} : { input: opts.input });
}

/** `docker exec [-w cwd] claude-workflow-agent claude <args>`: the image's wrapper drops to node. */
export function claudeExec(io: SetupIo, cwd: string | undefined, args: readonly string[]): RunResult {
  return io.run("docker", ["exec", ...(cwd === undefined ? [] : ["-w", cwd]), CONTAINER, "claude", ...args]);
}

/** A file's text in the container, read as node; undefined when it does not exist. */
export function readInContainer(io: SetupIo, path: string): string | undefined {
  const read = nodeExec(io, ["cat", path]);
  if (read.status === 0) return read.stdout;
  if (/No such file or directory/.test(read.stderr)) return undefined;
  throw new Error(`reading ${path} in the container failed: ${answer(read)}`);
}

// The path is a positional argument and the text comes on stdin, so sh never parses either.
const REPLACE = 'umask 077 && cat > "$1.tmp" && mv -f "$1.tmp" "$1"';

/** Replaces a file in the container as node, mode 0600 when created, the text on stdin. */
export function writeInContainer(io: SetupIo, path: string, text: string): RunResult {
  return nodeExec(io, ["sh", "-c", REPLACE, "sh", path], { input: text });
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

const Inspect = z.array(
  z.object({
    Image: z.string(),
    Config: z.object({ Labels: z.record(z.string(), z.string()).nullish() }).nullish(),
    State: z.object({ Running: z.boolean(), StartedAt: z.string() }),
    Mounts: z
      .array(z.object({ Type: z.string(), Name: z.string().optional(), Source: z.string(), Destination: z.string() }))
      .nullish(),
  }),
);

/** `docker container inspect` alone, for a daemon already known to answer. */
function inspectContainer(io: SetupIo): Exclude<ContainerState, { kind: "no-docker" }> {
  const args = ["container", "inspect", CONTAINER];
  const result = io.run("docker", args);
  if (result.status !== 0) {
    if (/No such container/i.test(result.stderr)) return { kind: "absent" };
    throw new Error(`docker ${args.join(" ")} failed: ${answer(result)}`);
  }
  const [found] = parseJson(Inspect, result.stdout, `docker ${args.join(" ")}`);
  if (found === undefined) return { kind: "absent" };
  return {
    kind: found.State.Running ? "running" : "stopped",
    image: found.Image,
    label: found.Config?.Labels?.[CONFIG_LABEL],
    startedAt: found.State.StartedAt,
    mounts: (found.Mounts ?? []).map((m) => ({ type: m.Type, name: m.Name, source: m.Source, destination: m.Destination })),
  };
}

/** `docker info`, then `docker container inspect`. */
export function containerState(io: SetupIo): ContainerState {
  const info = io.run("docker", ["info", "--format", "{{.ServerVersion}}"]);
  if (info.status !== 0) return { kind: "no-docker", detail: answer(info) };
  return inspectContainer(io);
}

const hasLine = (text: string, line: string) => text.split("\n").some((l) => l.trim() === line);
const lastLine = (text: string) => text.split("\n").map((l) => l.trim()).filter((l) => l !== "").pop();

/** Waits for the latest start's readiness line; fails on the failure line or a stopped container. */
export function waitReady(io: SetupIo, timeoutMs: number): { ready: true } | { ready: false; detail: string } {
  const first = containerState(io);
  if (first.kind === "no-docker") return { ready: false, detail: `docker does not answer (${first.detail})` };
  if (first.kind === "absent") return { ready: false, detail: `there is no container ${CONTAINER}` };
  let startedAt = first.startedAt;
  let stopped = false;
  const read = () => {
    const now = inspectContainer(io);
    if (now.kind === "absent") throw new Error(`the container ${CONTAINER} went away while starting`);
    startedAt = now.startedAt;
    stopped = now.kind !== "running";
    // Only the latest start's lines: a line an earlier start logged never counts.
    const logs = io.run("docker", ["logs", "--since", now.startedAt, CONTAINER]);
    if (logs.status !== 0) throw new Error(`docker logs ${CONTAINER} failed: ${answer(logs)}`);
    return `${logs.stdout}\n${logs.stderr}`;
  };
  const done = (text: string) => stopped || hasLine(text, READY_LINE) || hasLine(text, FAILED_LINE);
  const text = io.poll(read, done, timeoutMs) ?? "";
  if (hasLine(text, FAILED_LINE)) return { ready: false, detail: FAILED_LINE };
  const last = lastLine(text);
  const tail = last === undefined ? "" : `; its last log line: ${last}`;
  if (stopped) return { ready: false, detail: `the container stopped (it started at ${startedAt})${tail}` };
  if (hasLine(text, READY_LINE)) return { ready: true };
  const minutes = Math.round(timeoutMs / 60_000);
  return { ready: false, detail: `no "${READY_LINE}" line within ${minutes} minute${minutes === 1 ? "" : "s"} of the start${tail}` };
}

/**
 * `claude agents --json --all` in the container; undefined when there is no docker or no running
 * container. Throws when the list cannot be read, or when the container has not logged its
 * readiness line yet: nothing runs in a started container before that line.
 */
export function containerSessions(io: SetupIo): Session[] | undefined {
  const state = containerState(io);
  if (state.kind !== "running") return undefined;
  const logs = io.run("docker", ["logs", "--since", state.startedAt, CONTAINER]);
  if (logs.status !== 0) throw new Error(`docker logs ${CONTAINER} failed: ${answer(logs)}`);
  if (!hasLine(`${logs.stdout}\n${logs.stderr}`, READY_LINE)) {
    throw new Error(
      `the container ${CONTAINER} is still starting: its latest start has no "${READY_LINE}" line yet, so its sessions cannot be listed; rerun in a minute`,
    );
  }
  const args = ["agents", "--json", "--all"];
  const listed = claudeExec(io, undefined, args);
  const what = `docker exec ${CONTAINER} claude ${args.join(" ")}`;
  if (listed.status !== 0) throw new Error(`${what} failed: ${answer(listed)}`);
  return parseJson(Sessions, listed.stdout, what);
}
