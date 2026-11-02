// The repos setup serves: this clone's repo first, then the dispatch config's repos.
import { parseConfig } from "../poller/config.ts";
import { cloneDir, CONTAINER, CONTAINER_HOME } from "./docker.ts";
import type { SetupIo } from "./io.ts";
import { dirname } from "node:path";
import { z } from "zod";
import type { RepoConfig } from "../poller/config.ts";

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
 * With `addRepo`, the config first gets an entry for that repo, unless it already lists it
 * (then nothing changes). The entry's owner is the active github.com gh login, and a missing
 * file is created. With `dryRun`, nothing is written: the entry is reported instead, and the
 * repos served are those the config would have as written, so the run goes on as if it were.
 * The poller runs in the agent container, so each config `dir` is a container path (`~` is
 * node's home there): it must be the repo's clone, cloneDir(repo). Nothing on the host is
 * read for it.
 */
export function servedRepos(
  io: SetupIo,
  opts: { clone: string; configPath: string; addRepo?: string; dryRun?: boolean },
): ServedRepo[] {
  const origin = io.run("git", ["-C", opts.clone, "remote", "get-url", "origin"]);
  if (origin.status !== 0) {
    throw new Error(`cannot read the origin remote of ${opts.clone}: ${origin.stderr.trim() || `exit ${origin.status}`}`);
  }
  const url = origin.stdout.trim();
  const own = parseRemote(url);
  if (own === undefined) throw new Error(`origin remote '${url}' of ${opts.clone} is not a github.com repo`);

  const text = io.readFile(opts.configPath);
  if (opts.addRepo !== undefined) {
    return withAddRepo(io, { configPath: opts.configPath, addRepo: opts.addRepo, dryRun: opts.dryRun === true }, own, text);
  }
  if (text === undefined) {
    io.report("note", `no dispatch config at ${opts.configPath}: serving only ${own}`);
    return [{ repo: own }];
  }
  return servedFrom(parseConfig(text, { path: opts.configPath, home: CONTAINER_HOME, dirExists: () => true }), own, opts.configPath);
}

/** This clone's repo, then each config entry's repo once, each in its container clone. */
function servedFrom(config: readonly RepoConfig[], own: string, configPath: string): ServedRepo[] {
  const repos: ServedRepo[] = [{ repo: own }];
  for (const entry of config) {
    const served = repos.find((r) => r.repo.toLowerCase() === entry.repo.toLowerCase());
    // A repo listed twice (in any case) is cloned once, under the name it was first served as.
    const clone = cloneDir(served?.repo ?? entry.repo);
    if (entry.dir !== clone) {
      throw new Error(
        `config ${configPath}: dir '${entry.dir}' (repo ${entry.repo}) is not the container clone: the poller runs in ${CONTAINER}, so set it to "${clone}"`,
      );
    }
    if (served === undefined) repos.push({ repo: entry.repo });
  }
  return repos;
}

/**
 * The served repos once `addRepo` is in the config, which is written unless `dryRun`. The new
 * text is validated, with the entry added, before anything is written.
 */
function withAddRepo(
  io: SetupIo,
  opts: { configPath: string; addRepo: string; dryRun: boolean },
  own: string,
  text: string | undefined,
): ServedRepo[] {
  const { configPath, addRepo } = opts;
  if (!/^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/.test(addRepo)) throw new Error(`--add-repo ${addRepo}: not of the form owner/name`);
  const missing = text === undefined;
  const current = parseConfig(text ?? "[]", { path: configPath, home: CONTAINER_HOME, dirExists: () => true });
  if (current.some((e) => e.repo.toLowerCase() === addRepo.toLowerCase())) {
    io.report("already", `${addRepo} is in ${configPath} already; nothing changed`);
    return servedFrom(current, own, configPath);
  }

  const sessionPrefix = sessionPrefixFor(addRepo.slice(addRepo.indexOf("/") + 1));
  const clash = current.find((e) => e.sessionPrefix.toLowerCase() === sessionPrefix.toLowerCase());
  if (clash !== undefined) {
    throw new Error(
      `--add-repo ${addRepo}: sessionPrefix '${sessionPrefix}' is taken by ${clash.repo} in ${configPath}: add the entry by hand with another sessionPrefix`,
    );
  }

  const entry = { repo: addRepo, dir: cloneDir(addRepo), sessionPrefix, owner: activeLogin(io, addRepo) };
  // The existing entries are kept as the file has them: only the array is re-indented.
  const raw = missing ? [] : (JSON.parse(text) as unknown[]);
  const next = `${JSON.stringify([...raw, entry], null, 2)}\n`;
  const served = servedFrom(
    parseConfig(next, { path: configPath, home: CONTAINER_HOME, dirExists: () => true }),
    own,
    configPath,
  );

  const line = JSON.stringify(entry);
  if (opts.dryRun) {
    io.report("would", `add ${addRepo} to ${configPath}${missing ? " (creating it)" : ""}: ${line}`);
    return served;
  }
  if (missing) {
    const made = io.run("mkdir", ["-p", dirname(configPath)]);
    if (made.status !== 0) {
      throw new Error(
        `--add-repo ${addRepo}: mkdir -p ${dirname(configPath)} failed: ${made.stderr.trim() || `exit ${made.status}`}`,
      );
    }
  }
  io.writeFile(configPath, next);
  io.report("done", `added ${addRepo} to ${configPath}${missing ? " (created)" : ""}: ${line}`);
  return served;
}

/** A config sessionPrefix for a repo's name: each character outside [A-Za-z0-9_-] as -, then no leading -. */
function sessionPrefixFor(name: string): string {
  return name.replace(/[^A-Za-z0-9_-]/g, "-").replace(/^-+/, "");
}

const AuthStatus = z.object({
  hosts: z
    .record(z.string(), z.array(z.object({ login: z.string(), active: z.boolean().optional() })))
    .nullish(),
});

/**
 * The login of the active github.com account, which owns the repo's tickets. The call asks for
 * no token: gh's stored login is all that is read.
 */
function activeLogin(io: SetupIo, repo: string): string {
  const result = io.run("gh", ["auth", "status", "--json", "hosts"]);
  if (result.status !== 0) {
    throw new Error(
      `--add-repo ${repo}: gh auth status failed (${result.stderr.trim() || `exit ${result.status}`}): run gh auth login, then rerun`,
    );
  }
  let data: unknown;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    throw new Error(`--add-repo ${repo}: gh auth status did not print JSON`);
  }
  const parsed = AuthStatus.safeParse(data);
  if (!parsed.success) throw new Error(`--add-repo ${repo}: gh auth status did not print the accounts per host`);
  const account = (parsed.data.hosts?.["github.com"] ?? []).find((a) => a.active === true);
  if (account === undefined) {
    throw new Error(
      `--add-repo ${repo}: no active github.com gh login to take the owner from: run gh auth login, then rerun`,
    );
  }
  return account.login;
}
