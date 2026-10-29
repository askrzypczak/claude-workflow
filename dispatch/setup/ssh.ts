// The ssh phase: a deploy key and an SSH host alias per served repo, origin switched to the
// alias once it reaches the repo, and the account key unloaded from ssh-agent.
// docs/sandboxing.md (Deploy keys) gives the reasons; this file carries them out.
import { basename, join } from "node:path";
import { timestamp } from "../poller/io.ts";
import type { RunResult, SetupIo } from "./io.ts";
import type { Phase, SetupContext } from "./main.ts";
import type { ServedRepo } from "./repos.ts";

/** The marketplace clone under the home directory, and the HTTPS remote it moves to. */
const MARKETPLACE = ".claude/plugins/marketplaces/askrzypczak-plugins";
const MARKETPLACE_URL = "https://github.com/askrzypczak/claude-workflow.git";

/** A PEM private-key header: OpenSSH, RSA, EC, DSA, PKCS#8 and encrypted PKCS#8. */
const PRIVATE_KEY_HEADER = /^-----BEGIN (?:[A-Z0-9]+ )*PRIVATE KEY-----$/;

/**
 * Absolute paths of the files directly in `sshDir` whose first line is a PEM private-key
 * header, sorted.
 */
export function findPrivateKeys(io: Pick<SetupIo, "listDir" | "readFirstLine">, sshDir: string): string[] {
  return (io.listDir(sshDir) ?? [])
    .map((name) => join(sshDir, name))
    .filter((path) => PRIVATE_KEY_HEADER.test(io.readFirstLine(path)?.trimEnd() ?? ""))
    .sort();
}

/** One pass of the phase. */
interface Pass extends SetupContext {
  sshDir: string;
  /** ~/.ssh/config */
  config: string;
  /** Whether this run has taken its one backup of ~/.ssh/config, or found no file to back up. */
  backedUp: boolean;
}

/** One served repo and the names the phase gives its key and alias. */
interface Target extends ServedRepo {
  /** The repo part of owner/name. */
  name: string;
  /** The deploy key's private key file. */
  key: string;
  /** The SSH host alias, `github.com-<name>`. */
  host: string;
  /** origin through the alias. */
  url: string;
}

/** How a step ended: `ok`, `pending` (dry run: its input does not exist yet) or `stop`. */
type Step = "ok" | "pending" | "stop";

/** The first line of stderr, else of stdout, else the exit status. */
function answer(result: RunResult): string {
  const first = (text: string) => text.split("\n").map((l) => l.trim()).find((l) => l !== "");
  return first(result.stderr) ?? first(result.stdout) ?? `exit ${result.status}`;
}

const message = (err: unknown) => (err instanceof Error ? err.message : String(err));
const repoName = (repo: string) => repo.slice(repo.indexOf("/") + 1);
const plural = (n: number, one: string, many: string) => (n === 1 ? one : many);

/** A config line's keyword (lower case) and arguments, without a trailing comment. */
function directive(line: string): { keyword: string; args: string[] } | undefined {
  const m = /^\s*([A-Za-z][A-Za-z0-9]*)(?:\s*=\s*|\s+)(.*)$/.exec(line);
  if (!m) return undefined;
  const words = m[2]!.trim().split(/\s+/).filter((w) => w !== "");
  const comment = words.findIndex((w) => w.startsWith("#"));
  return { keyword: m[1]!.toLowerCase(), args: comment < 0 ? words : words.slice(0, comment) };
}

/** Whether the config text has a `Host` line naming `host` (ssh matches host names in lower case). */
function hasHostLine(text: string, host: string): boolean {
  return text.split("\n").some((line) => {
    const d = directive(line);
    return d?.keyword === "host" && d.args.some((a) => a.toLowerCase() === host.toLowerCase());
  });
}

/** The alias block docs/sandboxing.md describes. */
const aliasBlock = (t: Target) =>
  [`Host ${t.host}`, "  HostName github.com", "  User git", `  IdentityFile ~/.ssh/deploy-${t.name}`, "  IdentitiesOnly yes", ""].join("\n");

/** `YYYYMMDD-HHMMSS`, local time. */
const backupStamp = (d: Date) => timestamp(d).replace(/[-:]/g, "").replace(" ", "-");

/** The deploy key and the alias are named by the repo part, so two repos must not share it. */
function distinctNames(p: Pass): boolean {
  const byName = new Map<string, string[]>();
  for (const { repo } of p.repos) {
    const name = repoName(repo).toLowerCase();
    byName.set(name, [...(byName.get(name) ?? []), repo]);
  }
  const shared = [...byName.values()].filter((repos) => repos.length > 1);
  for (const repos of shared) {
    p.io.report(
      "todo",
      `${repos.join(", ")} share the repo name ${repoName(repos[0]!)}, which names the deploy key file and the host alias: serve only one of them (remove the others from the dispatch config), then rerun`,
    );
  }
  return shared.length === 0 || p.dryRun;
}

function keyStep(p: Pass, t: Target): Step {
  if ((p.io.listDir(p.sshDir) ?? []).includes(basename(t.key))) {
    p.io.report("already", `${t.repo}: deploy key ${t.key} exists`);
    return "ok";
  }
  if (p.dryRun) {
    p.io.report("would", `${t.repo}: generate deploy key ${t.key} (ssh-keygen -t ed25519 -N "" -f ${t.key})`);
    return "pending";
  }
  const made = p.io.run("ssh-keygen", ["-t", "ed25519", "-N", "", "-f", t.key]);
  if (made.status !== 0) {
    p.io.report("todo", `${t.repo}: generating deploy key ${t.key} failed (${answer(made)}): fix that, then rerun`);
    return "stop";
  }
  p.io.report("done", `${t.repo}: generated deploy key ${t.key}, with no passphrase`);
  return "ok";
}

/** Appends the alias block to ~/.ssh/config, after one backup per run; never rewrites a line. */
function aliasStep(p: Pass, t: Target): Step {
  const text = p.io.readFile(p.config);
  if (text !== undefined && hasHostLine(text, t.host)) {
    p.io.report("already", `${t.repo}: alias ${t.host} is in ${p.config}`);
    return "ok";
  }
  const backup = text !== undefined && !p.backedUp ? `${p.config}.bak-${backupStamp(new Date())}` : undefined;
  const backupNote = backup === undefined ? "" : `, after a backup to ${backup}`;
  p.backedUp = true;
  if (p.dryRun) {
    p.io.report("would", `${t.repo}: append alias ${t.host} to ${p.config}${backupNote}`);
    return "pending";
  }
  const block = aliasBlock(t);
  try {
    if (backup !== undefined) p.io.copyFile(p.config, backup);
    p.io.appendFile(p.config, text === undefined || text === "" || text.endsWith("\n") ? block : `\n${block}`);
  } catch (err) {
    p.io.report(
      "todo",
      `${t.repo}: adding alias ${t.host} to ${p.config} failed (${message(err)}): append the block by hand (${block.trim().split("\n").map((l) => l.trim()).join("; ")}), then rerun`,
    );
    return "stop";
  }
  p.io.report("done", `${t.repo}: appended alias ${t.host} to ${p.config}${backupNote}`);
  return "ok";
}

/** `ssh -G` must show the deploy key as the alias's only identity file, with identitiesonly yes. */
function effectiveConfigStep(p: Pass, t: Target): Step {
  const shown = p.io.run("ssh", ["-G", t.host]);
  if (shown.status !== 0) {
    p.io.report("todo", `${t.repo}: ssh -G ${t.host} failed (${answer(shown)}): fix ${p.config}, then rerun`);
    return p.dryRun ? "pending" : "stop";
  }
  const values = (keyword: string) =>
    shown.stdout
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.split(/\s+/)[0]?.toLowerCase() === keyword)
      .map((line) => line.slice(keyword.length).trim());
  const identities = values("identityfile");
  const only = values("identitiesonly")[0]?.toLowerCase();
  const deployKey = `~/.ssh/deploy-${t.name}`;
  const isDeployKey = (file: string) => file === deployKey || file === t.key;
  const others = identities.filter((file) => !isDeployKey(file));
  const listed = identities.some(isDeployKey);
  if (others.length === 0 && listed && only === "yes") {
    p.io.report("pass", `${t.repo}: ssh -G ${t.host} offers only ${deployKey}, with identitiesonly yes`);
    return "ok";
  }

  const problems: string[] = [];
  if (others.length > 0) problems.push(`it also lists ${others.join(", ")}`);
  if (!listed) problems.push(`it does not list ${deployKey}`);
  if (only !== "yes") problems.push(`identitiesonly is ${only ?? "not set"}`);
  const fix =
    others.length > 0
      ? `move the IdentityFile ${plural(others.length, "line", "lines")} for ${others.join(", ")} out of the block that also matches ${t.host} (such as Host *) into a Host block naming only the hosts that need ${plural(others.length, "it", "them")}`
      : only !== "yes"
        ? `narrow the Host line of the earlier block that sets IdentitiesOnly ${only ?? "no"} (such as Host *) so it no longer matches ${t.host}`
        : `make the Host ${t.host} block in ${p.config} read IdentityFile ${deployKey}`;
  p.io.report(
    "todo",
    `${t.repo}: ssh -G ${t.host} must list ${deployKey} as its only identity file, with identitiesonly yes, but ${problems.join(" and ")}, so ssh would offer ${identities.join(", ") || "no key file"}. Fix: ${fix}; the script edits no existing line. Then rerun`,
  );
  return p.dryRun ? "pending" : "stop";
}

/**
 * `git ls-remote` through the alias; when it fails, the paste flow: the public key on the
 * clipboard, the repo's new-deploy-key page in the browser, Enter, and the check again.
 */
function reachStep(p: Pass, t: Target, ready: boolean): Step {
  const page = `https://github.com/${t.repo}/settings/keys/new`;
  const pub = `${t.key}.pub`;
  const pasteFlow = `copy ${pub}, open ${page}, paste it as the key with "Allow write access" ticked, wait for Enter, then check git ls-remote ${t.url} again`;
  if (!ready) {
    p.io.report("would", `${t.repo}: check git ls-remote ${t.url}; if it fails, ${pasteFlow}`);
    return "pending";
  }
  const lsRemote = () => p.io.run("git", ["ls-remote", t.url]);
  const first = lsRemote();
  if (first.status === 0) {
    p.io.report("already", `${t.repo}: GitHub has the deploy key: git ls-remote ${t.url} works`);
    return "ok";
  }
  if (p.dryRun) {
    p.io.report("would", `${t.repo}: git ls-remote ${t.url} fails (${answer(first)}): ${pasteFlow}`);
    return "pending";
  }

  const text = p.io.readFile(pub);
  if (text === undefined) {
    p.io.report("todo", `${t.repo}: ${pub} is missing: recreate it with ssh-keygen -y -f ${t.key} > ${pub}, then rerun`);
    return "stop";
  }
  const copied = p.io.run("pbcopy", [], { input: text });
  if (copied.status !== 0) {
    p.io.report("note", `could not copy the key (${answer(copied)}): copy the contents of ${pub} by hand`);
  }
  const opened = p.io.run("open", [page]);
  if (opened.status !== 0) {
    p.io.report("note", `could not open the browser (${answer(opened)}): go to ${page}`);
  }
  p.io.report(
    "note",
    `${t.repo}: GitHub does not have the deploy key yet (git ls-remote: ${answer(first)}). On ${page}, paste the copied key from ${pub} as the key, give it any title, tick "Allow write access" and click "Add key"`,
  );
  p.io.waitForEnter(`Press Enter once the key is added to ${t.repo}.`);
  const second = lsRemote();
  if (second.status === 0) {
    p.io.report("done", `${t.repo}: deploy key added: git ls-remote ${t.url} works`);
    return "ok";
  }
  p.io.report(
    "todo",
    `${t.repo}: git ls-remote ${t.url} still fails (${answer(second)}): add ${pub} on ${page} with "Allow write access", then rerun`,
  );
  return "stop";
}

/** origin through the alias; only after git ls-remote through it worked, except as a dry-run `would`. */
function remoteStep(p: Pass, t: Target): Step {
  const read = p.io.run("git", ["-C", t.dir, "remote", "get-url", "origin"]);
  if (read.status !== 0) throw new Error(`cannot read the origin remote of ${t.dir}: ${answer(read)}`);
  const current = read.stdout.trim();
  if (current === t.url || current === t.url.replace(/\.git$/, "")) {
    p.io.report("already", `${t.repo}: origin in ${t.dir} uses alias ${t.host} (${current})`);
    return "ok";
  }
  if (p.dryRun) {
    p.io.report("would", `${t.repo}: switch origin in ${t.dir} from ${current} to ${t.url}, once git ls-remote through it works`);
    return "pending";
  }
  const set = p.io.run("git", ["-C", t.dir, "remote", "set-url", "origin", t.url]);
  if (set.status !== 0) {
    p.io.report(
      "todo",
      `${t.repo}: switching origin in ${t.dir} failed (${answer(set)}): run git -C ${t.dir} remote set-url origin ${t.url}, then rerun`,
    );
    return "stop";
  }
  p.io.report("done", `${t.repo}: switched origin in ${t.dir} from ${current} to ${t.url}`);
  return "ok";
}

/** Key, alias, effective config, reach and remote for one repo; false when the phase stops. */
function deployKeyFor(p: Pass, served: ServedRepo): boolean {
  const name = repoName(served.repo);
  const t: Target = {
    ...served,
    name,
    key: join(p.sshDir, `deploy-${name}`),
    host: `github.com-${name}`,
    url: `git@github.com-${name}:${served.repo}.git`,
  };
  const key = keyStep(p, t);
  if (key === "stop") return false;
  const alias = aliasStep(p, t);
  if (alias === "stop") return false;
  let config: Step = "pending";
  if (key === "ok" && alias === "ok") {
    config = effectiveConfigStep(p, t);
    if (config === "stop") return false;
  } else {
    p.io.report("would", `${t.repo}: check that ssh -G ${t.host} lists only ~/.ssh/deploy-${name}, with identitiesonly yes`);
  }
  const reach = reachStep(p, t, config === "ok");
  if (reach === "stop") return false;
  return remoteStep(p, t) !== "stop";
}

/** The marketplace clone moves to HTTPS: the repo is public. */
function marketplaceStep(p: Pass): boolean {
  const dir = join(p.home, MARKETPLACE);
  const read = p.io.run("git", ["-C", dir, "remote", "get-url", "origin"]);
  if (read.status !== 0) {
    p.io.report("note", `marketplace clone: none at ${dir} (${answer(read)}), so nothing to switch`);
    return true;
  }
  const current = read.stdout.trim();
  if (current === MARKETPLACE_URL || current === MARKETPLACE_URL.replace(/\.git$/, "")) {
    p.io.report("already", `marketplace clone: origin in ${dir} uses HTTPS (${current})`);
    return true;
  }
  if (p.dryRun) {
    p.io.report("would", `marketplace clone: switch origin in ${dir} from ${current} to ${MARKETPLACE_URL}`);
    return true;
  }
  const set = p.io.run("git", ["-C", dir, "remote", "set-url", "origin", MARKETPLACE_URL]);
  if (set.status !== 0) {
    p.io.report(
      "todo",
      `marketplace clone: switching origin failed (${answer(set)}): run git -C ${dir} remote set-url origin ${MARKETPLACE_URL}, then rerun`,
    );
    return false;
  }
  p.io.report("done", `marketplace clone: switched origin in ${dir} from ${current} to ${MARKETPLACE_URL}`);
  return true;
}

/** Unloads the account keys from ssh-agent, only when it holds keys, so a re-run writes nothing. */
function unloadAgent(p: Pass, keys: readonly string[]): boolean {
  const listed = p.io.run("ssh-add", ["-l"]);
  if (listed.status === 1) {
    p.io.report("already", "ssh-agent holds no key");
    return true;
  }
  if (listed.status !== 0) {
    p.io.report("note", `ssh-agent: none to unload from (${answer(listed)})`);
    return true;
  }
  const how = `ssh-add -d --apple-use-keychain for ${keys.join(", ")}, then ssh-add -D`;
  if (p.dryRun) {
    p.io.report("would", `ssh-agent: run ${how}`);
    return true;
  }
  for (const key of keys) {
    const removed = p.io.run("ssh-add", ["-d", "--apple-use-keychain", key]);
    if (removed.status !== 0) {
      // Either the key was not loaded, the state wanted, or this ssh-add rejected the option,
      // as a non-macOS build earlier on PATH (Homebrew OpenSSH) does.
      p.io.report(
        "note",
        `ssh-add -d --apple-use-keychain ${key} failed (${answer(removed)}): the key was not loaded, or, if the option was rejected, the ssh-add on PATH is not macOS's and a passphrase stored in the keychain may remain; to remove it, run /usr/bin/ssh-add -d --apple-use-keychain ${key}`,
      );
    }
  }
  const all = p.io.run("ssh-add", ["-D"]);
  if (all.status !== 0) {
    p.io.report("todo", `unloading ssh-agent failed (${answer(all)}): run ssh-add -D, then rerun`);
    return false;
  }
  p.io.report("done", `ssh-agent: ran ${how}`);
  return true;
}

/** Reports the lines that could load an account key again, without editing them. */
function reportLoadingLines(p: Pass): void {
  const lines = (p.io.readFile(p.config) ?? "").split("\n");
  lines.forEach((line, i) => {
    const d = directive(line);
    if (d === undefined || d.args[0]?.toLowerCase() === "no") return;
    const why =
      d.keyword === "usekeychain"
        ? "lets ssh unlock a key with its passphrase from the keychain, without asking"
        : d.keyword === "addkeystoagent"
          ? "loads a key into ssh-agent when ssh uses it"
          : undefined;
    if (why === undefined) return;
    p.io.report(
      "note",
      `${p.config} line ${i + 1} (${line.trim()}) ${why}, which could make an account key usable again: keep such a line only in a Host block that never uses an account key (the script does not edit it)`,
    );
  });
}

/** A key with no passphrase opens every repo the account can push to, for any excluded git command. */
function checkPassphrases(p: Pass, keys: readonly string[]): boolean {
  let ok = true;
  for (const key of keys) {
    const tried = p.io.run("ssh-keygen", ["-y", "-P", "", "-f", key]);
    if (tried.status === 0) {
      p.io.report(
        "todo",
        `account key ${key} has no passphrase, so any excluded git command could push with it: add one with ssh-keygen -p -f ${key}, or delete the key (rm ${key} ${key}.pub) once nothing needs it; the script deletes no key. Then rerun`,
      );
      ok = false;
    } else if (/passphrase/i.test(tried.stderr)) {
      p.io.report("pass", `account key ${key} has a passphrase`);
    } else {
      p.io.report("todo", `checking account key ${key} for a passphrase failed (${answer(tried)}): fix that, then rerun`);
      ok = false;
    }
  }
  return ok;
}

/**
 * The account keys are every private key in ~/.ssh but the deploy keys: git fetch, pull and
 * push run outside the sandbox and can use any key file. Every check runs, so all the to-dos
 * show at once.
 */
function accountKeyStep(p: Pass): boolean {
  const keys = findPrivateKeys(p.io, p.sshDir).filter((key) => !basename(key).startsWith("deploy-"));
  if (keys.length === 0) {
    p.io.report("already", `account key: no private key in ${p.sshDir} besides the deploy keys`);
    return true;
  }
  const unloaded = unloadAgent(p, keys);
  reportLoadingLines(p);
  const protectedKeys = checkPassphrases(p, keys);
  return (unloaded && protectedKeys) || p.dryRun;
}

export const ssh: Phase = {
  name: "ssh",
  run(ctx) {
    const sshDir = join(ctx.home, ".ssh");
    const p: Pass = { ...ctx, sshDir, config: join(sshDir, "config"), backedUp: false };
    if (!distinctNames(p)) return "stop";
    for (const served of p.repos) {
      if (!deployKeyFor(p, served)) return "stop";
    }
    if (!marketplaceStep(p)) return "stop";
    // Only now, with every remote working through its deploy key, can the maintainer lose the account key.
    return accountKeyStep(p) ? "ok" : "stop";
  },
};
