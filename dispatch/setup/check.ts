// The check phase: judges the sandbox settings, then launches a probe session the way the
// poller launches ticket sessions and reads what it could and could not do. Only a full run
// where everything passes resumes dispatch.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { LAUNCH_FLAGS } from "../poller/config.ts";
import type { RunResult } from "./io.ts";
import type { Phase, SetupContext } from "./main.ts";
import { judgeSandbox } from "./sandbox.ts";
import type { SandboxJudgement } from "./sandbox.ts";
import { backupStamp } from "./ssh.ts";

const LAUNCHD = "dispatch/install-launchd.sh";
const PROBE_SCRIPT = "dispatch/setup/sandbox-probe.sh";
const FIX_DOCS = "docs/sandboxing.md, section Checks";

/** The prefix of every probe result line; the END line closes the result. */
const PREFIX = "SANDBOX-PROBE";
const END = `${PREFIX} END`;
const RESULT_LINE = /^SANDBOX-PROBE (PASS|FAIL) (.*)$/;

const WAIT_MINUTES = 15;
const WAIT = `${WAIT_MINUTES} minutes`;

/** The plist template dispatch/install-launchd.sh fills in. */
const PLIST = new URL("../launchd/com.askrzypczak.claude-workflow-poller.plist", import.meta.url);
const PLIST_PATH = /<key>PATH<\/key>\s*<string>([^<]*)<\/string>/;

/** The first line of stderr, else of stdout, else the exit status. */
function answer(result: RunResult): string {
  const first = (text: string) => text.split("\n").map((l) => l.trim()).find((l) => l !== "");
  return first(result.stderr) ?? first(result.stdout) ?? `exit ${result.status}`;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** `value` as one single-quoted shell word. */
const shellQuote = (value: string) => `'${value.replaceAll("'", `'\\''`)}'`;

/** The environment the poller's sessions get when launchd runs dispatch/agent-poller.sh. */
export function pollerEnv(home: string): { HOME: string; PATH: string } {
  // Read on each call, not at load, so a module that only imports this one never reads it.
  const launchdPath = PLIST_PATH.exec(readFileSync(PLIST, "utf8"))?.[1];
  if (launchdPath === undefined) {
    throw new Error(`${fileURLToPath(PLIST)} sets no PATH in its EnvironmentVariables`);
  }
  // What dispatch/agent-poller.sh puts before the PATH launchd gives it (no EXTRA_PATH there).
  const prefix = [
    `${home}/.local/share/fnm/aliases/default/bin`,
    `${home}/.local/bin`,
    "/opt/homebrew/bin",
    "/usr/local/bin",
    "/usr/bin",
    "/bin",
  ];
  return { HOME: home, PATH: [...prefix, launchdPath.replaceAll("__HOME__", home)].join(":") };
}

/** The probe's items, in the order the probe script and then the session write them. */
export function probeItems(keys: readonly string[]): string[] {
  return [
    "home-write",
    "network",
    ...keys.map((key) => `key ${key}`),
    "ssh-config",
    "gh",
    "read-tool",
    "git-fetch",
    "git-push",
    "browser-tools",
  ];
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

/** The settings judged as the poller's preflight judges them; false when they fail. */
function staticChecks(ctx: SetupContext, judgement: SandboxJudgement): boolean {
  const { file, keys, missing } = judgement;
  if (missing.length === 0) {
    const denied = keys.length === 0 ? "no private key in ~/.ssh to deny" : `denies ${keys.join(", ")}`;
    ctx.io.report("pass", `${file} holds every sandbox setting the sandbox phase generates and ${denied}`);
    return true;
  }
  for (const line of missing) ctx.io.report("fail", `sandbox settings: ${line}`);
  ctx.io.report(
    "todo",
    `${file} does not hold the sandbox settings (the failures above), and the poller refuses to launch until it does: rerun dispatch/setup-agents.sh sandbox, then dispatch/setup-agents.sh check${ctx.dryRun ? "" : "; no probe session was started"}`,
  );
  return false;
}

/** What the probe session is told to do: plain text, one step per line, one argv string. */
function probePrompt(p: { clone: string; home: string; result: string; repo: string; keys: readonly string[] }): string {
  const script = join(p.clone, PROBE_SCRIPT);
  const command = ["bash", ...[script, p.result, p.repo, ...p.keys].map(shellQuote)].join(" ");
  const firstRun = join(p.home, "Library", "Application Support", "Google", "Chrome", "First Run");
  const result = shellQuote(p.result);
  return [
    "You are the sandbox probe session started by dispatch/setup-agents.sh check.",
    "Do only the steps below, in order, without asking anything, then stop.",
    `Append each result line with one Bash call of the form printf '%s\\n' '<line>' >> ${result} with the line in single quotes and no single quote or line break inside it; never use the Write or Edit tool for this.`,
    `Step 1: run this command as one Bash call, exactly as written: ${command}`,
    `Step 2: use the Read tool on the file ${firstRun}. If a permission rule refused the read, append ${PREFIX} PASS read-tool: <how it was refused>. Otherwise (it was read, or it failed for another reason) append ${PREFIX} FAIL read-tool: <what happened>.`,
    `Step 3: run git fetch origin as its own Bash call with nothing else in it (no cd, no pipe, no redirection, no second command). If it exits 0, append ${PREFIX} PASS git-fetch: exit 0. Otherwise append ${PREFIX} FAIL git-fetch: <its first error line>.`,
    `Step 4: the same for git push --dry-run origin HEAD:refs/heads/sandbox-probe, as its own Bash call with nothing else in it: append ${PREFIX} PASS git-push: exit 0, or ${PREFIX} FAIL git-push: <its first error line>.`,
    `Step 5: if you have no browser tools (no Claude in Chrome tools, no mcp__claude-in-chrome__ tools, and no other tool that drives a web browser), append ${PREFIX} PASS browser-tools: none. Otherwise append ${PREFIX} FAIL browser-tools: <their names>.`,
    `Step 6: append ${END}.`,
    `Do not create commits, branches or tags, and do not create or change any file other than ${p.result}. Do not run any command besides the ones above. Never read or print a private key, or any other file under ~/.ssh: the commands above only test them.`,
  ].join("\n");
}

/** Stops the probe session, then removes its result file, so the session cannot write it again. */
function cleanUp(ctx: SetupContext, name: string, result: string): void {
  const stopped = ctx.io.run("claude", ["stop", name]);
  if (stopped.status === 0) {
    ctx.io.report("done", `stopped the probe session ${name} (claude stop ${name})`);
  } else {
    ctx.io.report("note", `claude stop ${name} failed (${answer(stopped)}): if the probe session ${name} still runs, stop it from claude agents`);
  }
  try {
    ctx.io.removeFile(result);
  } catch (err) {
    ctx.io.report("note", `removing the probe result ${result} failed (${message(err)}): remove it by hand`);
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
    `the sandbox probe failed: claude logs ${name} prints what the session did (claude attach ${name} reopens it). Fix the cause (${FIX_DOCS}), then rerun dispatch/setup-agents.sh check; dispatch was not resumed`,
  );
  return false;
}

/** Starts the probe session in the first served repo's dir and judges its result. */
function probe(ctx: SetupContext, keys: readonly string[]): boolean {
  const served = ctx.repos[0];
  if (served === undefined) throw new Error("no served repo to start the probe session in");
  const { dir, repo } = served;
  const name = `sandbox-probe-${backupStamp(new Date())}`;
  const result = `${dir}/.${name}.txt`;
  const env = pollerEnv(ctx.home);
  const items = probeItems(keys);
  const command = `claude --bg --name ${name} ${LAUNCH_FLAGS.join(" ")} <the probe prompt>`;
  const how = `${command} in ${dir}, with only HOME=${env.HOME} and PATH=${env.PATH} in its environment, as the poller's sessions get them under launchd`;

  if (ctx.dryRun) {
    ctx.io.report(
      "would",
      `start the probe session ${name}: ${how}; wait up to ${WAIT} for ${result} to end with ${END}; judge ${items.join(", ")}; then run claude stop ${name} and remove ${result}`,
    );
    return true;
  }

  const prompt = probePrompt({ clone: ctx.clone, home: ctx.home, result, repo, keys });
  try {
    ctx.io.launch(dir, name, LAUNCH_FLAGS, prompt, env);
  } catch (err) {
    ctx.io.report(
      "todo",
      `starting the probe session ${name} failed (${message(err)}): check that claude --bg starts a session in ${dir} (a directory claude has not been run in once must be trusted first), then rerun`,
    );
    return false;
  }
  ctx.io.report("done", `started the probe session ${name}: ${how}`);
  ctx.io.report("note", `waiting up to ${WAIT} for the probe result in ${result}`);
  let text: string | undefined;
  try {
    text = ctx.io.waitForFile(result, isFinished, WAIT_MINUTES * 60 * 1000);
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
      `resume dispatch if the settings and every probe item pass: ${LAUNCHD} status, then ${LAUNCHD} resume unless the poller is not installed or already running`,
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
    const judgement = judgeSandbox(ctx.io, ctx.home);
    // Under a dry run the failures are listed and the phase goes on to list the rest.
    if (!staticChecks(ctx, judgement) && !ctx.dryRun) return "stop";
    if (!probe(ctx, judgement.keys)) return "stop";
    return resume(ctx) ? "ok" : "stop";
  },
};
