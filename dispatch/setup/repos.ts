// The repos setup serves: this clone's repo first, then the dispatch config's repos.
import { parseConfig } from "../poller/config.ts";
import { cloneDir, CONTAINER, CONTAINER_HOME } from "./docker.ts";
import type { SetupIo } from "./io.ts";

export interface ServedRepo {
  /** owner/name */
  repo: string;
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

/**
 * This clone's repo (from its `origin` remote), then the repos in the dispatch config,
 * once each. A missing config file adds none, with a note; an invalid one throws.
 * The poller runs in the agent container, so each config `dir` is a container path (`~` is
 * node's home there): it must be the repo's clone, cloneDir(repo). Nothing on the host is
 * read for it.
 */
export function servedRepos(
  io: SetupIo,
  opts: { clone: string; configPath: string },
): ServedRepo[] {
  const origin = io.run("git", ["-C", opts.clone, "remote", "get-url", "origin"]);
  if (origin.status !== 0) {
    throw new Error(`cannot read the origin remote of ${opts.clone}: ${origin.stderr.trim() || `exit ${origin.status}`}`);
  }
  const url = origin.stdout.trim();
  const own = parseRemote(url);
  if (own === undefined) throw new Error(`origin remote '${url}' of ${opts.clone} is not a github.com repo`);
  const repos: ServedRepo[] = [{ repo: own }];

  const text = io.readFile(opts.configPath);
  if (text === undefined) {
    io.report("note", `no dispatch config at ${opts.configPath}: serving only ${own}`);
    return repos;
  }
  const config = parseConfig(text, { path: opts.configPath, home: CONTAINER_HOME, dirExists: () => true });
  for (const entry of config) {
    const served = repos.find((r) => r.repo.toLowerCase() === entry.repo.toLowerCase());
    // A repo listed twice (in any case) is cloned once, under the name it was first served as.
    const clone = cloneDir(served?.repo ?? entry.repo);
    if (entry.dir !== clone) {
      throw new Error(
        `config ${opts.configPath}: dir '${entry.dir}' (repo ${entry.repo}) is not the container clone: the poller runs in ${CONTAINER}, so set it to "${clone}"`,
      );
    }
    if (served === undefined) repos.push({ repo: entry.repo });
  }
  return repos;
}
