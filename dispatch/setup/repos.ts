// The repos setup serves: this clone's repo first, then the dispatch config's repos.
import { statSync } from "node:fs";
import { parseConfig } from "../poller/config.ts";
import type { SetupIo } from "./io.ts";

export interface ServedRepo {
  /** owner/name */
  repo: string;
  /** The local checkout. */
  dir: string;
}

const REMOTES = [
  /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/,
  // `github.com-<alias>` is an SSH host alias for a per-repo deploy key.
  /^git@github\.com(?:-[A-Za-z0-9._-]+)?:([^/]+)\/([^/]+?)(?:\.git)?$/,
];

/** owner/name from a github.com remote URL, or undefined for any other remote. */
export function parseRemote(url: string): string | undefined {
  for (const pattern of REMOTES) {
    const m = pattern.exec(url);
    if (m) return `${m[1]}/${m[2]}`;
  }
  return undefined;
}

const isDir = (dir: string) => statSync(dir, { throwIfNoEntry: false })?.isDirectory() ?? false;

/**
 * This clone's repo (from its `origin` remote), then the repos in the dispatch config,
 * once each. A missing config file adds none, with a note; an invalid one throws.
 */
export function servedRepos(
  io: SetupIo,
  opts: { clone: string; configPath: string; home: string },
): ServedRepo[] {
  const origin = io.run("git", ["-C", opts.clone, "remote", "get-url", "origin"]);
  if (origin.status !== 0) {
    throw new Error(`cannot read the origin remote of ${opts.clone}: ${origin.stderr.trim() || `exit ${origin.status}`}`);
  }
  const url = origin.stdout.trim();
  const own = parseRemote(url);
  if (own === undefined) throw new Error(`origin remote '${url}' of ${opts.clone} is not a github.com repo`);
  const repos: ServedRepo[] = [{ repo: own, dir: opts.clone }];

  const text = io.readFile(opts.configPath);
  if (text === undefined) {
    io.report("note", `no dispatch config at ${opts.configPath}: serving only ${own}`);
    return repos;
  }
  const config = parseConfig(text, { path: opts.configPath, home: opts.home, dirExists: isDir });
  for (const entry of config) {
    if (!repos.some((r) => r.repo.toLowerCase() === entry.repo.toLowerCase())) {
      repos.push({ repo: entry.repo, dir: entry.dir });
    }
  }
  return repos;
}
