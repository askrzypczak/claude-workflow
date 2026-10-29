// The sandbox phase: checks the installed ticket-workflow plugin knows `--no-track`, then
// merges the sandbox settings (docs/sandboxing.md, Settings) into ~/.claude/settings.json,
// denying every private key in ~/.ssh, and writes the managed settings copy through sudo.
import { readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { timestamp } from "../poller/io.ts";
import { parseJson } from "../poller/schemas.ts";
import type { RunOptions, RunResult } from "./io.ts";
import type { Phase, SetupContext } from "./main.ts";
import { findPrivateKeys } from "./ssh.ts";

/** Where macOS Claude Code reads managed settings from. */
export const MANAGED_SETTINGS = "/Library/Application Support/ClaudeCode/managed-settings.json";
const MANAGED_DIR = dirname(MANAGED_SETTINGS);

const MARKETPLACE = "askrzypczak-plugins";
const PLUGIN = `ticket-workflow@${MARKETPLACE}`;
/** The skill that creates branches; under the sandbox it must create them with --no-track. */
const SKILL = "skills/work-ticket/SKILL.md";
const NO_TRACK = "--no-track";

const TEMPLATE_PATH = "dispatch/setup/sandbox-settings.json";
/** The settings template as loaded; sandboxSettings copies it and never changes it. */
const TEMPLATE = parseJson(
  z.record(z.string(), z.unknown()),
  readFileSync(new URL("./sandbox-settings.json", import.meta.url), "utf8"),
  TEMPLATE_PATH,
);

/** `claude plugin list --json`: one entry per install. */
const PluginList = z.array(
  z.object({
    id: z.string(),
    scope: z.string(),
    installPath: z.string(),
    version: z.string().nullish(),
    projectPath: z.string().nullish(),
  }),
);
type Install = z.infer<typeof PluginList>[number];

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The first line of stderr, else of stdout, else the exit status. */
function answer(result: RunResult): string {
  const first = (text: string) => text.split("\n").map((l) => l.trim()).find((l) => l !== "");
  return first(result.stderr) ?? first(result.stdout) ?? `exit ${result.status}`;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** `YYYYMMDD-HHMMSS`, local time. */
const backupStamp = (d: Date) => timestamp(d).replace(/[-:]/g, "").replace(" ", "-");

/** A path under `home` written `~/...`, as settings name it; any other path as it is. */
function homePath(path: string, home: string): string {
  const rel = relative(home, path);
  return rel === "" || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel) ? path : `~/${rel}`;
}

/** `obj[key]` as an object, set to an empty one when it is not. */
function objectAt(obj: JsonObject, key: string): JsonObject {
  const value = obj[key];
  if (isObject(value)) return value;
  const created: JsonObject = {};
  obj[key] = created;
  return created;
}

/** `obj[key]` as an array, set to an empty one when it is not. */
function arrayAt(obj: JsonObject, key: string): unknown[] {
  const value = obj[key];
  if (Array.isArray(value)) return value;
  const created: unknown[] = [];
  obj[key] = created;
  return created;
}

/**
 * The settings template plus, for each key, its `credentials.files` deny entry and its
 * `Read` and `Edit` rules. Keys are absolute paths under `home`, written as `~/...`.
 */
export function sandboxSettings(keys: readonly string[], home: string): Record<string, unknown> {
  const settings = structuredClone(TEMPLATE);
  const files = arrayAt(objectAt(objectAt(settings, "sandbox"), "credentials"), "files");
  const deny = arrayAt(objectAt(settings, "permissions"), "deny");
  for (const key of keys) {
    const path = homePath(key, home);
    files.push({ path, mode: "deny" });
    deny.push(`Read(${path})`, `Edit(${path})`);
  }
  return settings;
}

/** One line per expected setting `settings` lacks; empty when it has them all. */
export function missingSandboxSettings(settings: unknown, keys: readonly string[], home: string): string[] {
  const root = isObject(settings) ? settings : {};
  const box = isObject(root.sandbox) ? root.sandbox : {};
  const credentials = isObject(box.credentials) ? box.credentials : {};
  const files = Array.isArray(credentials.files) ? credentials.files : [];
  const permissions = isObject(root.permissions) ? root.permissions : {};
  const deny = Array.isArray(permissions.deny) ? permissions.deny : [];

  const missing: string[] = [];
  const wanted: [string, boolean][] = [
    ["enabled", true],
    ["failIfUnavailable", true],
    ["allowUnsandboxedCommands", false],
  ];
  for (const [name, value] of wanted) {
    if (box[name] !== value) missing.push(`sandbox.${name} is not ${value}`);
  }
  for (const key of keys) {
    const path = homePath(key, home);
    if (!files.some((f) => isObject(f) && f.path === path && f.mode === "deny")) {
      missing.push(`sandbox.credentials.files has no deny entry for ${path}`);
    }
    for (const rule of [`Read(${path})`, `Edit(${path})`]) {
      if (!deny.includes(rule)) missing.push(`permissions.deny lacks ${rule}`);
    }
  }
  return missing;
}

/** A settings file's object, or what is wrong with its text. */
function parseObject(text: string): { value: JsonObject } | { problem: string } {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (err) {
    return { problem: `is not valid JSON (${message(err)})` };
  }
  if (isObject(value)) return { value };
  const kind = Array.isArray(value) ? "an array" : value === null ? "null" : `a ${typeof value}`;
  return { problem: `holds ${kind}, not a JSON object` };
}

const child = (path: string, key: string) => (path === "" ? key : `${path}.${key}`);

/**
 * `generated` merged into `current`: objects key by key, arrays as a union by deep equality
 * (existing items first), any other value replaced by the generated one. Each change goes to
 * `changes`, named by its dotted path.
 */
function merge(current: unknown, generated: unknown, path: string, changes: string[]): unknown {
  if (isObject(current) && isObject(generated)) {
    const merged: JsonObject = { ...current };
    for (const [key, value] of Object.entries(generated)) {
      const at = child(path, key);
      if (Object.hasOwn(current, key)) {
        merged[key] = merge(current[key], value, at, changes);
      } else {
        merged[key] = value;
        changes.push(`added ${at} = ${JSON.stringify(value)}`);
      }
    }
    return merged;
  }
  if (Array.isArray(current) && Array.isArray(generated)) {
    const merged = [...current];
    const added: string[] = [];
    for (const item of generated) {
      if (merged.some((m) => isDeepStrictEqual(m, item))) continue;
      merged.push(item);
      added.push(JSON.stringify(item));
    }
    if (added.length > 0) changes.push(`added to ${path}: ${added.join(", ")}`);
    return merged;
  }
  if (!isDeepStrictEqual(current, generated)) {
    changes.push(`changed ${path}: ${JSON.stringify(current)} -> ${JSON.stringify(generated)}`);
  }
  return generated;
}

/**
 * The entries of `current` that `generated` lacks, as dotted paths: keys, nested keys where
 * both sides are objects, and array items. A different value is not an extra.
 */
function extras(current: unknown, generated: unknown, path: string): string[] {
  if (isObject(current) && isObject(generated)) {
    return Object.entries(current).flatMap(([key, value]) => {
      const at = child(path, key);
      return Object.hasOwn(generated, key) ? extras(value, generated[key], at) : [at];
    });
  }
  if (Array.isArray(current) && Array.isArray(generated)) {
    return current
      .filter((item) => !generated.some((g) => isDeepStrictEqual(g, item)))
      .map((item) => `${path} item ${JSON.stringify(item)}`);
  }
  return [];
}

const LIST_ARGS = ["plugin", "list", "--json"];

/** The installs whose work-ticket skill sessions use: user scope, or a served repo's project. */
function checkedInstalls(ctx: SetupContext): Install[] {
  const listed = ctx.io.run("claude", LIST_ARGS);
  const what = `claude ${LIST_ARGS.join(" ")}`;
  if (listed.status !== 0) throw new Error(`${what} failed: ${answer(listed)}`);
  const served = new Set(ctx.repos.map((r) => resolve(r.dir)));
  return parseJson(PluginList, listed.stdout, what).filter(
    (i) => i.id === PLUGIN && (i.scope === "user" || (i.projectPath != null && served.has(resolve(i.projectPath)))),
  );
}

const hasNoTrack = (ctx: SetupContext, i: Install) =>
  ctx.io.readFile(join(i.installPath, SKILL))?.includes(NO_TRACK) ?? false;

const installText = (i: Install) =>
  `${i.scope} scope, version ${i.version ?? "unknown"}${i.projectPath == null ? "" : `, project ${i.projectPath}`}`;

/** Project and local installs are updated from their project's directory. */
const updateCwd = (i: Install) =>
  (i.scope === "project" || i.scope === "local") && i.projectPath != null ? i.projectPath : undefined;

const updateArgs = (i: Install) => ["plugin", "update", PLUGIN, "--scope", i.scope];

function updateCommand(i: Install): string {
  const cwd = updateCwd(i);
  const cmd = `claude ${updateArgs(i).join(" ")}`;
  return cwd === undefined ? cmd : `${cmd} (in ${cwd})`;
}

/** The marketplace and every stale install updated, then every checked skill knows --no-track. */
function pluginGate(ctx: SetupContext): boolean {
  const marketplaceArgs = ["plugin", "marketplace", "update", MARKETPLACE];
  const marketplaceCmd = `claude ${marketplaceArgs.join(" ")}`;
  if (ctx.dryRun) {
    ctx.io.report("would", `update the ${MARKETPLACE} marketplace (${marketplaceCmd})`);
  } else {
    const updated = ctx.io.run("claude", marketplaceArgs);
    if (updated.status === 0) {
      ctx.io.report("done", `updated the ${MARKETPLACE} marketplace (${marketplaceCmd})`);
    } else {
      ctx.io.report("note", `${marketplaceCmd} failed (${answer(updated)}); the skill check below decides`);
    }
  }

  let installs = checkedInstalls(ctx);
  let stale = installs.filter((i) => !hasNoTrack(ctx, i));
  if (stale.length > 0) {
    let ran = false;
    for (const i of stale) {
      if (ctx.dryRun) {
        ctx.io.report(
          "would",
          `${PLUGIN} (${installText(i)}): its work-ticket skill lacks ${NO_TRACK}, so run ${updateCommand(i)} and check again; if it still lacks ${NO_TRACK}, the phase stops before writing any settings`,
        );
        continue;
      }
      const cwd = updateCwd(i);
      const opts: RunOptions = cwd === undefined ? {} : { cwd };
      const updated = ctx.io.run("claude", updateArgs(i), opts);
      ran = true;
      if (updated.status === 0) ctx.io.report("done", `${PLUGIN} (${installText(i)}): ran ${updateCommand(i)}`);
      else ctx.io.report("note", `${updateCommand(i)} failed (${answer(updated)})`);
    }
    if (ran) {
      installs = checkedInstalls(ctx);
      stale = installs.filter((i) => !hasNoTrack(ctx, i));
    }
  }

  if (installs.length === 0) {
    const dirs = ctx.repos.map((r) => r.dir).join(", ");
    ctx.io.report(
      "todo",
      `no ${PLUGIN} install at user scope or in a served repo (${dirs}): agent sessions need its work-ticket skill, which creates branches with ${NO_TRACK}; install it with claude plugin install ${PLUGIN}, then rerun`,
    );
    return ctx.dryRun;
  }
  if (stale.length === 0) {
    ctx.io.report("pass", `${PLUGIN}: the work-ticket skill creates branches with ${NO_TRACK} (${installs.map(installText).join("; ")})`);
    return true;
  }
  if (ctx.dryRun) return true;
  for (const i of stale) {
    ctx.io.report(
      "todo",
      `${PLUGIN} (${installText(i)}): its work-ticket skill (${join(i.installPath, SKILL)}) still lacks ${NO_TRACK} after ${updateCommand(i)}, so sandboxed sessions would fail at branch creation: a branch that tracks a remote one writes .git/config, which the sandbox protects. The marketplace's main does not carry the ${NO_TRACK} skills yet: merge them to main first, then rerun. No settings were written`,
    );
  }
  return false;
}

/** The private keys in ~/.ssh, each to be denied. */
function keysStep(ctx: SetupContext): string[] {
  const sshDir = join(ctx.home, ".ssh");
  const keys = findPrivateKeys(ctx.io, sshDir);
  ctx.io.report(
    "note",
    keys.length === 0
      ? `no private key in ${sshDir}, so the settings deny no key file`
      : `private keys in ${sshDir}, each denied in the settings: ${keys.map((k) => homePath(k, ctx.home)).join(", ")}`,
  );
  return keys;
}

/** Merges `generated` into ~/.claude/settings.json, after a backup. */
function userSettingsStep(ctx: SetupContext, generated: JsonObject): boolean {
  const file = join(ctx.home, ".claude", "settings.json");
  const text = ctx.io.readFile(file);
  let current: JsonObject = {};
  if (text !== undefined) {
    const parsed = parseObject(text);
    if ("problem" in parsed) {
      ctx.io.report("todo", `${file} ${parsed.problem}: fix the file, then rerun; nothing was written to it`);
      return ctx.dryRun;
    }
    current = parsed.value;
  }

  const changes: string[] = [];
  const merged = merge(current, generated, "", changes);
  if (changes.length === 0) {
    ctx.io.report("already", `${file} has the sandbox settings and denies every key`);
    return true;
  }
  const backup = text === undefined ? undefined : `${file}.bak-${backupStamp(new Date())}`;
  const backupNote = backup === undefined ? "" : `, after a backup to ${backup}`;
  const list = changes.join("; ");
  if (ctx.dryRun) {
    ctx.io.report("would", `merge the sandbox settings into ${file}${backupNote}: ${list}`);
    return true;
  }
  try {
    if (backup !== undefined) ctx.io.copyFile(file, backup);
    ctx.io.writeFile(file, `${JSON.stringify(merged, null, 2)}\n`);
  } catch (err) {
    ctx.io.report("todo", `writing ${file} failed (${message(err)}): fix that, then rerun`);
    return false;
  }
  ctx.io.report("done", `merged the sandbox settings into ${file}${backupNote}: ${list}`);
  return true;
}

/** Writes `generated`, exactly, to the managed settings file through sudo when it differs. */
function managedStep(ctx: SetupContext, generated: JsonObject): boolean {
  if (ctx.noManaged) {
    ctx.io.report("note", `managed settings copy skipped (--no-managed): an existing ${MANAGED_SETTINGS} is left as it is`);
    return true;
  }
  const wanted = `${JSON.stringify(generated, null, 2)}\n`;
  const text = ctx.io.readFile(MANAGED_SETTINGS);
  if (text === wanted) {
    ctx.io.report("already", `managed settings copy ${MANAGED_SETTINGS} is up to date`);
    return true;
  }

  /** The changes to an existing file; undefined when it is created. */
  let changes: string[] | undefined;
  if (text !== undefined) {
    const parsed = parseObject(text);
    if ("problem" in parsed) {
      ctx.io.report(
        "todo",
        `managed settings copy ${MANAGED_SETTINGS} ${parsed.problem}: fix or remove the file, or rerun with --no-managed to leave it as it is; nothing was written to it`,
      );
      return ctx.dryRun;
    }
    const extra = extras(parsed.value, generated, "");
    if (extra.length > 0) {
      ctx.io.report(
        "todo",
        `managed settings copy ${MANAGED_SETTINGS} holds entries the generated settings lack, which writing the copy would drop: ${extra.join(", ")}. Remove them from the file and rerun, or rerun with --no-managed to leave the file as it is; nothing was written to it`,
      );
      return ctx.dryRun;
    }
    changes = [];
    merge(parsed.value, generated, "", changes);
  }
  const detail =
    changes === undefined ? "" : `: ${changes.length === 0 ? "same entries, in the generated order and layout" : changes.join("; ")}`;

  const commands = `sudo mkdir -p "${MANAGED_DIR}", then sudo tee "${MANAGED_SETTINGS}" with the settings on stdin`;
  if (ctx.dryRun) {
    const action = changes === undefined ? "create" : "update";
    ctx.io.report("would", `${action} the managed settings copy ${MANAGED_SETTINGS} (${commands}; sudo asks for the password)${detail}`);
    return true;
  }
  ctx.io.report("note", `writing the managed settings copy through sudo, which asks for the password on this terminal`);
  const fail = (step: string, result: RunResult) => {
    ctx.io.report(
      "todo",
      `${step} failed (${answer(result)}), so ${MANAGED_SETTINGS} was not written: check that sudo works in this terminal (sudo -v), then rerun, which runs ${commands}; or rerun with --no-managed to skip the copy`,
    );
    return false;
  };
  const made = ctx.io.run("sudo", ["mkdir", "-p", MANAGED_DIR]);
  if (made.status !== 0) return fail(`sudo mkdir -p "${MANAGED_DIR}"`, made);
  const written = ctx.io.run("sudo", ["tee", MANAGED_SETTINGS], { input: wanted });
  if (written.status !== 0) return fail(`sudo tee "${MANAGED_SETTINGS}"`, written);
  ctx.io.report("done", `${changes === undefined ? "created" : "updated"} the managed settings copy ${MANAGED_SETTINGS}${detail}`);
  return true;
}

export const sandbox: Phase = {
  name: "sandbox",
  run(ctx) {
    // A stale skill would make every sandboxed session fail at branch creation.
    if (!pluginGate(ctx)) return "stop";
    const generated = sandboxSettings(keysStep(ctx), ctx.home);
    if (!userSettingsStep(ctx, generated)) return "stop";
    return managedStep(ctx, generated) ? "ok" : "stop";
  },
};
