// The check phase: checks the agent container directly through docker exec (firewall, keys,
// gh, mounts), then starts a probe session in it and reads what the session could and could
// not do. Only a full run where everything passes resumes dispatch.
import { join } from "node:path";
import { z } from "zod";
import { LAUNCH_FLAGS } from "../poller/config.ts";
import { ENDED } from "../poller/decide.ts";
import { timestamp } from "../poller/io.ts";
import type { Session } from "../poller/schemas.ts";
import {
  claudeExec,
  cloneDir,
  CONTAINER,
  CONTAINER_HOME,
  containerSessions,
  containerState,
  nodeExec,
  readInContainer,
  VOLUME,
  waitReady,
} from "./docker.ts";
import type { ContainerState } from "./docker.ts";
import type { RunResult } from "./io.ts";
import type { Phase, SetupContext } from "./main.ts";

const LAUNCHD = "dispatch/install-launchd.sh";

/** The prefix of every probe result line; the END line closes the result. */
const PREFIX = "SETUP-PROBE";
const END = `${PREFIX} END`;
const RESULT_LINE = /^SETUP-PROBE (PASS|FAIL) (.*)$/;

const WAIT_MINUTES = 15;
const WAIT = `${WAIT_MINUTES} minutes`;
const READY_TIMEOUT_MS = 3 * 60 * 1000;
const SSH_DIR = `${CONTAINER_HOME}/.ssh`;
/** A PEM private-key header: OpenSSH, RSA, EC, DSA, PKCS#8 and encrypted PKCS#8. */
const PRIVATE_KEY_HEADER = "^-----BEGIN ([A-Z0-9]+ )*PRIVATE KEY-----$";

/** The first line of stderr, else of stdout, else the exit status. */
function answer(result: RunResult): string {
  const first = (text: string) => text.split("\n").map((l) => l.trim()).find((l) => l !== "");
  return first(result.stderr) ?? first(result.stdout) ?? `exit ${result.status}`;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const repoName = (repo: string) => repo.slice(repo.indexOf("/") + 1);

/** The JSON value of `text`, or undefined when it is not JSON. */
function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** `YYYYMMDD-HHMMSS`, local time: the probe session's name suffix. */
const stamp = (d: Date) => timestamp(d).replace(/[-:]/g, "").replace(" ", "-");

/** The probe session's items, in the order the session writes them. */
export function probeItems(): string[] {
  return ["git-fetch", "git-push", "browser-tools"];
}

/** One probe item's outcome. */
export interface ProbeVerdict {
  item: string;
  pass: boolean;
  detail: string;
}

/** Whether `text` holds the END line. */
const isFinished = (text: string) => text.split("\n").some((line) => line.trimEnd() === END);

/**
 * The probe result file's text judged item by item: an item passes only with a PASS line and
 * no FAIL line. `finished` is false without the END line.
 */
export function parseProbeResult(
  text: string | undefined,
  items: readonly string[],
): { finished: boolean; verdicts: ProbeVerdict[] } {
  const seen = new Map<string, { pass?: string; fail?: string }>();
  for (const line of (text ?? "").split("\n")) {
    const m = RESULT_LINE.exec(line.trimEnd());
    if (!m) continue;
    const status = m[1];
    const rest = m[2] ?? "";
    // Item names are compared exactly ("<item>:", then the end or a space), so a key path
    // holding a colon still names its item; the longest match wins.
    const item = items
      .filter((i) => rest === `${i}:` || rest.startsWith(`${i}: `))
      .reduce<string | undefined>((best, i) => (best === undefined || i.length > best.length ? i : best), undefined);
    if (item === undefined) continue;
    const detail = rest.slice(item.length + 1).trim();
    const entry = seen.get(item) ?? {};
    if (status === "FAIL") entry.fail ??= detail;
    else entry.pass ??= detail;
    seen.set(item, entry);
  }
  const verdicts = items.map((item): ProbeVerdict => {
    const entry = seen.get(item);
    if (entry?.fail !== undefined) return { item, pass: false, detail: entry.fail };
    if (entry?.pass !== undefined) return { item, pass: true, detail: entry.pass };
    return { item, pass: false, detail: "the result has no line for this item" };
  });
  return { finished: text !== undefined && isFinished(text), verdicts };
}

/** The container runs and logged its readiness line; a to-do otherwise. */
function containerReady(ctx: SetupContext, state: ContainerState): boolean {
  const fix =
    state.kind === "no-docker" ? `docker does not answer (${state.detail}): start Colima, then rerun dispatch/setup-agents.sh container`
    : state.kind === "absent" ? `there is no container ${CONTAINER}: run dispatch/setup-agents.sh container`
    : state.kind === "stopped" ? `the container ${CONTAINER} is stopped: run dispatch/setup-agents.sh container, which starts it`
    : undefined;
  if (fix !== undefined) {
    ctx.io.report("todo", `${fix}, then rerun dispatch/setup-agents.sh check; no probe session was started`);
    return false;
  }
  const ready = waitReady(ctx.io, READY_TIMEOUT_MS);
  if (!ready.ready) {
    ctx.io.report("todo", `the container ${CONTAINER} is not ready: ${ready.detail}. docker logs ${CONTAINER} shows its log; fix the cause, then rerun; no probe session was started`);
    return false;
  }
  ctx.io.report("pass", `the container ${CONTAINER} runs and is ready`);
  return true;
}

/** `curl` as node: api.github.com is reached and example.com refused. */
function firewallItem(ctx: SetupContext): boolean {
  const curl = (url: string) => nodeExec(ctx.io, ["curl", "-q", "-sS", "-o", "/dev/null", "--max-time", "15", url]);
  const github = curl("https://api.github.com/rate_limit");
  const other = curl("https://example.com");
  const problems: string[] = [];
  if (github.status !== 0) problems.push(`https://api.github.com was not reached (curl exit ${github.status}: ${answer(github)})`);
  if (other.status === 0) problems.push("https://example.com was reached");
  if (problems.length === 0) {
    ctx.io.report("pass", "firewall: as node, https://api.github.com is reached and https://example.com refused");
    return true;
  }
  ctx.io.report("fail", `firewall: ${problems.join("; ")}`);
  return false;
}

/** Every private key in ~/.ssh is a served repo's deploy key, and no ssh-agent is forwarded. */
function sshKeysItem(ctx: SetupContext): boolean {
  const wanted = new Set(ctx.repos.map((r) => `${SSH_DIR}/deploy-${repoName(r.repo)}`));
  const found = nodeExec(ctx.io, ["grep", "-rlE", "-e", PRIVATE_KEY_HEADER, SSH_DIR]);
  const problems: string[] = [];
  if (found.status !== 0 && found.status !== 1) {
    problems.push(`searching ${SSH_DIR} failed (${answer(found)})`);
  } else {
    const keys = found.stdout.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    const others = keys.filter((k) => !wanted.has(k));
    if (others.length > 0) problems.push(`private keys that are no served repo's deploy key: ${others.join(", ")}`);
  }
  const agent = nodeExec(ctx.io, ["printenv", "SSH_AUTH_SOCK"]);
  if (agent.status === 0 && agent.stdout.trim() !== "") problems.push(`SSH_AUTH_SOCK is set (${agent.stdout.trim()})`);
  if (problems.length === 0) {
    ctx.io.report("pass", `ssh-keys: the only private keys in ${SSH_DIR} are the deploy keys, and SSH_AUTH_SOCK is unset`);
    return true;
  }
  ctx.io.report("fail", `ssh-keys: ${problems.join("; ")}`);
  return false;
}

/** `gh repo view` in the first clone prints its repo. */
function ghItem(ctx: SetupContext, repo: string, dir: string): boolean {
  const viewed = nodeExec(ctx.io, ["gh", "repo", "view", "--json", "nameWithOwner"], { cwd: dir });
  let shown: string | undefined;
  if (viewed.status === 0) {
    const parsed = z.object({ nameWithOwner: z.string() }).safeParse(safeJson(viewed.stdout));
    shown = parsed.success ? parsed.data.nameWithOwner : viewed.stdout.trim();
  }
  if (shown?.toLowerCase() === repo.toLowerCase()) {
    ctx.io.report("pass", `gh: gh repo view in ${dir} prints ${repo}`);
    return true;
  }
  ctx.io.report("fail", `gh: gh repo view in ${dir} ${viewed.status === 0 ? `printed ${shown || "nothing"}, not ${repo}` : `failed (${answer(viewed)})`}`);
  return false;
}

/** The only mount is the home volume at /home/node: no bind mount, no Docker socket. */
function mountsItem(ctx: SetupContext, state: ContainerState): boolean {
  const mounts = state.kind === "running" || state.kind === "stopped" ? state.mounts : [];
  const isHome = (m: (typeof mounts)[number]) => m.type === "volume" && m.name === VOLUME && m.destination === CONTAINER_HOME;
  const others = mounts.filter((m) => !isHome(m));
  if (others.length === 0 && mounts.length === 1) {
    ctx.io.report("pass", `mounts: the only mount is the ${VOLUME} volume at ${CONTAINER_HOME}`);
    return true;
  }
  const shown = others.map((m) => `${m.type} ${m.source} at ${m.destination}${/docker\.sock/.test(`${m.source} ${m.destination}`) ? " (the Docker socket)" : ""}`);
  ctx.io.report(
    "fail",
    `mounts: ${mounts.length === 0 ? "no mount" : `the container mounts ${shown.length > 0 ? shown.join(", ") : `${mounts.length} copies of ${VOLUME}`}`}; it must mount only the ${VOLUME} volume at ${CONTAINER_HOME}: remove it (docker rm -f ${CONTAINER}) and rerun dispatch/setup-agents.sh container`,
  );
  return false;
}

/** What the probe session is told to do: plain text, one step per line, one argv string. */
function probePrompt(result: string): string {
  const quoted = `'${result}'`;
  return [
    "You are the setup probe session started by dispatch/setup-agents.sh check in the agent container.",
    "Do only the steps below, in order, without asking anything, then stop.",
    `Append each result line with one Bash call of the form printf '%s\\n' '<line>' >> ${quoted} with the line in single quotes and no single quote or line break inside it; never use the Write or Edit tool for this.`,
    `Step 1: run git fetch origin as its own Bash call with nothing else in it (no cd, no pipe, no redirection, no second command). If it exits 0, append ${PREFIX} PASS git-fetch: exit 0. Otherwise append ${PREFIX} FAIL git-fetch: <its first error line>.`,
    `Step 2: run git push --dry-run origin HEAD:refs/heads/setup-probe the same way, as its own Bash call with nothing else in it: append ${PREFIX} PASS git-push: exit 0, or ${PREFIX} FAIL git-push: <its first error line>.`,
    `Step 3: list your browser tools: Claude in Chrome tools (mcp__claude-in-chrome__ tools) and any other tool that drives a web browser. If you have no Claude in Chrome tool, append ${PREFIX} PASS browser-tools: <the other browser tools' names, or none>. Otherwise append ${PREFIX} FAIL browser-tools: <their names>.`,
    `Step 4: append ${END}.`,
    `Do not create commits, branches or tags, and do not create or change any file other than ${result}. Do not run any command besides the ones above. Never read or print a private key, or any other file under ~/.ssh.`,
  ].join("\n");
}

/** Stops the probe session by its id, found by its unique name, then removes its result file. */
function cleanUp(ctx: SetupContext, name: string, result: string): void {
  const how = `stop it from docker exec -it ${CONTAINER} claude agents`;
  let sessions: Session[] | undefined;
  try {
    sessions = containerSessions(ctx.io) ?? [];
  } catch (err) {
    ctx.io.report("note", `listing the container's sessions failed (${message(err)}): if the probe session ${name} still runs, ${how}`);
  }
  if (sessions !== undefined) {
    const session = sessions.find((s) => s.name === name);
    if (session?.id === undefined) {
      ctx.io.report("note", `the probe session ${name} is not in the container's claude agents list with an id, so it was not stopped: if it still runs, ${how}`);
    } else if (ENDED.includes(session.state)) {
      ctx.io.report("already", `the probe session ${name} (${session.id}) is ${session.state}`);
    } else {
      const stopped = claudeExec(ctx.io, undefined, ["stop", session.id]);
      if (stopped.status === 0) {
        ctx.io.report("done", `stopped the probe session ${name} (docker exec ${CONTAINER} claude stop ${session.id})`);
      } else {
        ctx.io.report("note", `claude stop ${session.id} failed (${answer(stopped)}): if the probe session ${name} still runs, ${how}`);
      }
    }
  }
  const removed = nodeExec(ctx.io, ["rm", "-f", result]);
  if (removed.status !== 0) {
    ctx.io.report("note", `removing the probe result ${result} failed (${answer(removed)}): remove it by hand (docker exec -u node ${CONTAINER} rm -f ${result})`);
  }
}

/** One report per probe item; false unless the session finished and every item passed. */
function judgeProbe(ctx: SetupContext, name: string, text: string | undefined, items: readonly string[]): boolean {
  const { finished, verdicts } = parseProbeResult(text, items);
  for (const v of verdicts) {
    ctx.io.report(v.pass ? "pass" : "fail", `probe ${v.item}: ${v.detail === "" ? "(no detail)" : v.detail}`);
  }
  if (!finished) {
    ctx.io.report(
      "fail",
      text === undefined
        ? `the probe session ${name} wrote no result within ${WAIT}`
        : `the probe session ${name} did not finish within ${WAIT} (its result has no ${END} line)`,
    );
  }
  if (finished && verdicts.every((v) => v.pass)) return true;
  ctx.io.report(
    "todo",
    `the probe failed: docker exec ${CONTAINER} claude logs ${name} prints what the session did. Fix the cause, then rerun dispatch/setup-agents.sh check; dispatch was not resumed`,
  );
  return false;
}

/** Starts the probe session in the first served repo's clone and judges its result. */
function probe(ctx: SetupContext, repo: string, dir: string): boolean {
  const name = `setup-probe-${stamp(new Date())}`;
  const result = `${dir}/.${name}.txt`;
  const flags = [...LAUNCH_FLAGS];
  const items = probeItems();
  const command = `docker exec -w ${dir} ${CONTAINER} claude --bg --name ${name} ${flags.join(" ")} <the probe prompt>`;

  if (ctx.dryRun) {
    ctx.io.report(
      "would",
      `start the probe session ${name} for ${repo}: ${command}; wait up to ${WAIT} for ${result} to end with ${END}; judge ${items.join(", ")}; then stop the session by its id from claude agents and remove ${result}`,
    );
    return true;
  }

  const started = claudeExec(ctx.io, dir, ["--bg", "--name", name, ...flags, probePrompt(result)]);
  if (started.status !== 0) {
    ctx.io.report("todo", `starting the probe session ${name} failed (${answer(started)}): rerun dispatch/setup-agents.sh container (it trusts ${dir}), then rerun`);
    return false;
  }
  ctx.io.report("done", `started the probe session ${name}: ${command}`);
  ctx.io.report("note", `waiting up to ${WAIT} for the probe result in ${result}`);
  let text: string | undefined;
  try {
    text = ctx.io.poll(() => readInContainer(ctx.io, result), isFinished, WAIT_MINUTES * 60 * 1000);
  } finally {
    cleanUp(ctx, name, result);
  }
  return judgeProbe(ctx, name, text, items);
}

/** In a full run, resumes dispatch; any other run leaves it as it is and says so. */
function resume(ctx: SetupContext): boolean {
  const script = join(ctx.clone, LAUNCHD);
  if (!ctx.fullRun) {
    ctx.io.report(
      "note",
      `a check-only run does not resume dispatch, so a paused poller stays paused: a full dispatch/setup-agents.sh run resumes it when every phase passes, or run ${LAUNCHD} resume`,
    );
    return true;
  }
  if (ctx.dryRun) {
    ctx.io.report(
      "would",
      `resume dispatch if every check and probe item passes: ${LAUNCHD} status, then ${LAUNCHD} resume unless the poller is not installed or already running`,
    );
    return true;
  }
  const status = ctx.io.run(script, ["status"]);
  if (status.status !== 0) {
    ctx.io.report("todo", `${LAUNCHD} status failed (${answer(status)}), so dispatch was not resumed: run ${LAUNCHD} resume`);
    return false;
  }
  const installed = /^Installed:\s*yes/m.test(status.stdout);
  const loaded = /^Loaded:\s*yes/m.test(status.stdout);
  const disabled = /^Disabled:\s*yes/m.test(status.stdout);
  if (!installed) {
    ctx.io.report("note", `the poller's LaunchAgent is not installed, so there is nothing to resume: install it with ${LAUNCHD}`);
    return true;
  }
  if (loaded && !disabled) {
    ctx.io.report("already", "dispatch is running");
    return true;
  }
  const resumed = ctx.io.run(script, ["resume"]);
  if (resumed.status !== 0) {
    ctx.io.report("todo", `resuming dispatch failed (${answer(resumed)}): run ${LAUNCHD} resume`);
    return false;
  }
  ctx.io.report("done", `resumed dispatch (${LAUNCHD} resume)`);
  return true;
}

export const check: Phase = {
  name: "check",
  run(ctx) {
    const served = ctx.repos[0];
    if (served === undefined) throw new Error("no served repo to start the probe session in");
    const dir = cloneDir(served.repo);
    const state = containerState(ctx.io);
    // Under a dry run the failures are listed and the phase goes on to list the rest.
    if (containerReady(ctx, state)) {
      // Every item runs, so all the failures show at once.
      const checks = [firewallItem(ctx), sshKeysItem(ctx), ghItem(ctx, served.repo, dir), mountsItem(ctx, state)];
      if (!checks.every(Boolean)) {
        ctx.io.report("todo", `the container checks failed (above): fix the cause, then rerun dispatch/setup-agents.sh check; no probe session was started and dispatch was not resumed`);
        if (!ctx.dryRun) return "stop";
      }
    } else if (!ctx.dryRun) {
      return "stop";
    }
    if (!probe(ctx, served.repo, dir)) return "stop";
    return resume(ctx) ? "ok" : "stop";
  },
};
