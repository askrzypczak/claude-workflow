// Pure startup checks: CLAUDE_MAX_SESSIONS, the repos config, and launch flags.
import { isAbsent } from "./jq.ts";
import type { RepoConfig } from "./types.ts";

export const DEFAULT_MAX_SESSIONS = "10";
/** Sessions start on sonnet at xhigh effort; a later --model / --effort overrides. */
export const DEFAULT_FLAGS = "--model sonnet --effort xhigh";

export type MaxSessionsResult =
  | { ok: true; value: number }
  | { ok: false; message: string };

/** Empty or unset means 10; anything but a positive integer without leading zeros is an error. */
export function parseMaxSessions(raw: string | undefined): MaxSessionsResult {
  const value = raw || DEFAULT_MAX_SESSIONS;
  if (!/^[1-9][0-9]*$/.test(value)) {
    return {
      ok: false,
      message: `CLAUDE_MAX_SESSIONS='${value}' is not a positive integer; aborting`,
    };
  }
  return { ok: true, value: Number(value) };
}

/** `~` and `~/...` relative to home; anything else unchanged. */
export function expandHome(dir: string, home: string): string {
  if (dir.startsWith("~/")) return `${home}/${dir.slice(2)}`;
  if (dir === "~") return home;
  return dir;
}

/** Word-splits like bash `read -r -a`: first line only, on spaces and tabs, no globbing. */
export function splitFlags(text: string): string[] {
  const firstLine = text.split("\n", 1)[0] ?? "";
  return firstLine.split(/[ \t]+/).filter((w) => w !== "");
}

/** Default flags, then CLAUDE_BG_FLAGS, then the repo's bgFlags. */
export function combinedFlags(envFlags: string, bgFlags: string): string[] {
  return [
    ...splitFlags(`${DEFAULT_FLAGS} ${envFlags}`),
    ...splitFlags(bgFlags),
  ];
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function badEntry(value: unknown): boolean {
  if (!isObject(value)) return true;
  const required = [value.repo, value.dir, value.sessionPrefix, value.owner];
  if (required.some((v) => typeof v !== "string" || v.length === 0)) {
    return true;
  }
  if (!/^[A-Za-z0-9_-]+$/.test(value.sessionPrefix as string)) return true;
  if (!isAbsent(value.bgFlags) && typeof value.bgFlags !== "string") {
    return true;
  }
  if (Object.hasOwn(value, "maxSessions")) {
    const m = value.maxSessions;
    if (typeof m !== "number" || m < 1 || m !== Math.floor(m)) return true;
  }
  return false;
}

/** The smallest prefix (lowercased, in sorted order) used more than once, if any. */
function duplicatePrefix(prefixes: string[]): string | undefined {
  const lowered = prefixes
    .map((p) => p.replace(/[A-Z]/g, (c) => c.toLowerCase()))
    .sort();
  for (let i = 0; i + 1 < lowered.length; i++) {
    if (lowered[i] === lowered[i + 1]) return lowered[i];
  }
  return undefined;
}

export type ConfigResult =
  | { ok: true; repos: RepoConfig[] }
  | { ok: false; message: string; exitCode: 0 | 1 };

/**
 * Validates the config text (null when the file is missing or unreadable). Checks run in a
 * fixed order and the first problem wins; an empty array is "nothing to do" (exit 0).
 */
export function validateConfig(
  text: string | null,
  opts: { path: string; home: string; dirExists: (dir: string) => boolean },
): ConfigResult {
  const path = opts.path;
  const abort = (message: string): ConfigResult => ({
    ok: false,
    message,
    exitCode: 1,
  });
  if (text === null) {
    return abort(`config ${path} missing or unreadable; aborting`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = undefined;
  }
  if (!Array.isArray(parsed)) {
    return abort(`config ${path} is not a JSON array; aborting`);
  }
  const bad = parsed.findIndex(badEntry);
  if (bad !== -1) {
    return abort(
      `config ${path}: entry ${bad} needs string repo, dir, sessionPrefix ([A-Za-z0-9_-]+), owner (and optional string bgFlags, positive integer maxSessions); aborting`,
    );
  }
  const entries = parsed as Record<string, unknown>[];
  const dup = duplicatePrefix(entries.map((e) => e.sessionPrefix as string));
  if (dup !== undefined) {
    return abort(
      `config ${path}: duplicate sessionPrefix '${dup}' (compared case-insensitively); aborting`,
    );
  }
  const repos: RepoConfig[] = [];
  for (const e of entries) {
    const repo = e.repo as string;
    if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(repo)) {
      return abort(
        `config ${path}: repo '${repo}' is not of the form owner/name; aborting`,
      );
    }
    const dir = expandHome(e.dir as string, opts.home);
    if (!opts.dirExists(dir)) {
      return abort(
        `config ${path}: dir '${dir}' (repo ${repo}) does not exist; aborting`,
      );
    }
    repos.push({
      repo,
      dir: e.dir as string,
      sessionPrefix: e.sessionPrefix as string,
      owner: e.owner as string,
      bgFlags: isAbsent(e.bgFlags) ? "" : (e.bgFlags as string),
      ...(Object.hasOwn(e, "maxSessions")
        ? { maxSessions: e.maxSessions as number }
        : {}),
    });
  }
  if (repos.length === 0) {
    return {
      ok: false,
      message: `config ${path} has no repos; nothing to do`,
      exitCode: 0,
    };
  }
  return { ok: true, repos };
}
