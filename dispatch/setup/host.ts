// The host phase: merges host-settings.json (CLAUDE_CODE_ENABLE_CFC=0 and the deny rules) into
// ~/.claude/settings.json, after a backup. Needs no docker.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { z } from "zod";
import { timestamp } from "../poller/io.ts";
import { parseJson } from "../poller/schemas.ts";
import type { Phase, SetupContext } from "./main.ts";

/** Where macOS Claude Code reads managed settings from; the old sandbox phase wrote it. */
const MANAGED_SETTINGS = "/Library/Application Support/ClaudeCode/managed-settings.json";

const TEMPLATE_PATH = "dispatch/setup/host-settings.json";
/** The settings as loaded; hostSettings copies them and never changes them. */
const TEMPLATE = parseJson(
  z.record(z.string(), z.unknown()),
  readFileSync(new URL("./host-settings.json", import.meta.url), "utf8"),
  TEMPLATE_PATH,
);

type JsonObject = Record<string, unknown>;

const isObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));

/** `YYYYMMDD-HHMMSS`, local time: the suffix of a backup file's `.bak-` name. */
const backupStamp = (d: Date) => timestamp(d).replace(/[-:]/g, "").replace(" ", "-");

/** The settings this phase merges, from host-settings.json. */
export function hostSettings(): Record<string, unknown> {
  return structuredClone(TEMPLATE);
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
 * `wanted` merged into `current`: objects key by key, arrays as a union by deep equality
 * (existing items first), any other value replaced by the wanted one. Each change goes to
 * `changes`, named by its dotted path.
 */
function merge(current: unknown, wanted: unknown, path: string, changes: string[]): unknown {
  if (isObject(current) && isObject(wanted)) {
    const merged: JsonObject = { ...current };
    for (const [key, value] of Object.entries(wanted)) {
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
  if (Array.isArray(current) && Array.isArray(wanted)) {
    const merged = [...current];
    const added: string[] = [];
    for (const item of wanted) {
      if (merged.some((m) => isDeepStrictEqual(m, item))) continue;
      merged.push(item);
      added.push(JSON.stringify(item));
    }
    if (added.length > 0) changes.push(`added to ${path}: ${added.join(", ")}`);
    return merged;
  }
  if (!isDeepStrictEqual(current, wanted)) {
    changes.push(`changed ${path}: ${JSON.stringify(current)} -> ${JSON.stringify(wanted)}`);
  }
  return wanted;
}

/** Merges host-settings.json into ~/.claude/settings.json, after a backup; the settings, or undefined on a stop. */
function settingsStep(ctx: SetupContext, file: string): JsonObject | undefined {
  const text = ctx.io.readFile(file);
  let current: JsonObject = {};
  if (text !== undefined) {
    const parsed = parseObject(text);
    if ("problem" in parsed) {
      ctx.io.report("todo", `${file} ${parsed.problem}: fix the file, then rerun; nothing was written to it`);
      return undefined;
    }
    current = parsed.value;
  }

  const changes: string[] = [];
  const merged = merge(current, hostSettings(), "", changes) as JsonObject;
  if (changes.length === 0) {
    ctx.io.report("already", `${file} has CLAUDE_CODE_ENABLE_CFC=0 and every deny rule of ${TEMPLATE_PATH}`);
    return current;
  }
  const backup = text === undefined ? undefined : `${file}.bak-${backupStamp(new Date())}`;
  const backupNote = backup === undefined ? "" : `, after a backup to ${backup}`;
  const list = changes.join("; ");
  if (ctx.dryRun) {
    ctx.io.report("would", `merge ${TEMPLATE_PATH} into ${file}${backupNote}: ${list}`);
    return current;
  }
  try {
    if (backup !== undefined) ctx.io.copyFile(file, backup);
    ctx.io.writeFile(file, `${JSON.stringify(merged, null, 2)}\n`);
  } catch (err) {
    ctx.io.report("todo", `writing ${file} failed (${message(err)}): fix that, then rerun`);
    return undefined;
  }
  ctx.io.report("done", `merged ${TEMPLATE_PATH} into ${file}${backupNote}: ${list}`);
  return merged;
}

/** Notes, and changes nothing, for what the removed sandbox phase left behind. */
function leftoverNotes(ctx: SetupContext, file: string, settings: JsonObject): void {
  const why = "agent sessions now run in the agent container, so the host needs no sandbox";
  if (Object.hasOwn(settings, "sandbox")) {
    ctx.io.report(
      "note",
      `${file} still holds a sandbox block, which sandboxes your own sessions on this machine (${why}). The phase leaves it as it is; to remove it: tmp=$(mktemp) && jq 'del(.sandbox)' "${file}" > "$tmp" && mv "$tmp" "${file}"`,
    );
  }
  let managed: string | undefined;
  try {
    managed = ctx.io.readFile(MANAGED_SETTINGS);
  } catch (err) {
    ctx.io.report("note", `could not read ${MANAGED_SETTINGS} (${message(err)}): check by hand whether it exists`);
    return;
  }
  if (managed !== undefined) {
    ctx.io.report(
      "note",
      `${MANAGED_SETTINGS} exists: managed settings override your own in every session on this machine (${why}). The phase leaves it as it is; to remove it: sudo rm "${MANAGED_SETTINGS}"`,
    );
  }
}

export const host: Phase = {
  name: "host",
  run(ctx) {
    const file = join(ctx.home, ".claude", "settings.json");
    const settings = settingsStep(ctx, file);
    if (settings === undefined) return ctx.dryRun ? "ok" : "stop";
    leftoverNotes(ctx, file, settings);
    return "ok";
  },
};
