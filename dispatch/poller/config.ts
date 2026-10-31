// The repos config and the environment settings, validated before anything runs.
// Every check throws an Error whose message is the log line (main.ts adds "; aborting").
import { readFileSync, statSync } from "node:fs";
import { z } from "zod";
import { parseJson } from "./schemas.ts";

/**
 * Every dispatched session starts on opus at xhigh effort, in auto permission mode: a session
 * signed in with a setup token starts in manual mode otherwise, and stops at its first Bash call.
 */
export const LAUNCH_FLAGS = ["--model", "opus", "--effort", "xhigh", "--permission-mode", "auto"];

const text = (error: string) => z.string({ error }).min(1, error);

const RepoEntry = z.object(
  {
    repo: text("expected a non-empty string").regex(
      /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/,
      "not of the form owner/name",
    ),
    dir: text("expected a non-empty string"),
    sessionPrefix: text("expected a non-empty string").regex(
      /^[A-Za-z0-9_-]+$/,
      "expected only letters, digits, _ and -",
    ),
    owner: text("expected a non-empty string"),
    maxSessions: z
      .int({ error: "expected a positive integer" })
      .min(1, "expected a positive integer")
      .optional(),
  },
  { error: "expected an object" },
);
const ReposConfig = z.array(RepoEntry, { error: "not a JSON array" });

/** One validated config entry; `dir` has `~` expanded. */
export type RepoConfig = z.infer<typeof RepoEntry>;

/** `~` and `~/...` relative to home; anything else unchanged. */
export function expandHome(dir: string, home: string): string {
  if (dir === "~") return home;
  return dir.startsWith("~/") ? `${home}/${dir.slice(2)}` : dir;
}

/**
 * Validates the config text: entry shapes, then unique session prefixes (compared
 * case-insensitively, as they name state dirs), then that every `dir` exists.
 */
export function parseConfig(
  json: string,
  opts: { path: string; home: string; dirExists: (dir: string) => boolean },
): RepoConfig[] {
  const where = `config ${opts.path}`;
  const repos = parseJson(ReposConfig, json, where);
  const seen = new Set<string>();
  for (const { sessionPrefix } of repos) {
    const key = sessionPrefix.toLowerCase();
    if (seen.has(key)) {
      throw new Error(`${where}: duplicate sessionPrefix '${key}' (compared case-insensitively)`);
    }
    seen.add(key);
  }
  return repos.map((entry) => {
    const dir = expandHome(entry.dir, opts.home);
    if (!opts.dirExists(dir)) {
      throw new Error(`${where}: dir '${dir}' (repo ${entry.repo}) does not exist`);
    }
    return { ...entry, dir };
  });
}

/** Reads and validates the config file. */
export function loadConfig(path: string, home: string): RepoConfig[] {
  let json: string;
  try {
    json = readFileSync(path, "utf8");
  } catch {
    throw new Error(`config ${path} missing or unreadable`);
  }
  const dirExists = (dir: string) => statSync(dir, { throwIfNoEntry: false })?.isDirectory() ?? false;
  return parseConfig(json, { path, home, dirExists });
}

/** CLAUDE_MAX_SESSIONS: unset or empty means 10, otherwise a positive integer. */
export function parseMaxSessions(raw: string | undefined): number {
  const value = raw || "10";
  if (!/^[1-9][0-9]*$/.test(value)) {
    throw new Error(`CLAUDE_MAX_SESSIONS='${value}' is not a positive integer`);
  }
  return Number(value);
}
