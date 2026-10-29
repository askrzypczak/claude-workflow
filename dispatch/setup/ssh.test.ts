// The ssh phase on the fake SetupIo (fake-io.ts).
//
// Report keywords these tests match on (case-insensitive), which the phase must use:
// - `already` lines (re-run) and `would` lines (dry run): the key step names the key file,
//   "deploy-<name>"; the alias step names "alias" and "github.com-<name>"; the remote step
//   names "origin" and the repo, "<owner>/<name>";
// - dry run, `would` line for the paste flow: "paste";
// - a repo's to-do names the repo, "<owner>/<name>"; the duplicate-name to-do names both repos;
// - the effective-config to-do names the identity file ssh would also offer (its file name);
// - the account-key to-do names `ssh-keygen -p`, the key's path, and deleting it ("delete" or
//   `rm`).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FAKE_HOME, FAKE_REPO, fakeIo, fileWrites, parseGhApi, writeCalls } from "./fake-io.ts";
import type { FakeCall, FakeWorld } from "./fake-io.ts";
import type { SetupContext } from "./main.ts";
import { runSetup } from "./main.ts";
import type { ServedRepo } from "./repos.ts";
import { findPrivateKeys, ssh } from "./ssh.ts";

const HOME = FAKE_HOME;
const SSH_DIR = `${HOME}/.ssh`;
const CONFIG = `${SSH_DIR}/config`;
const CLONE = "/clone";
const APP = "example-owner/example-app";
const APP_DIR = "/work/example-app";
const MARKETPLACE = `${HOME}/.claude/plugins/marketplaces/askrzypczak-plugins`;
const MARKETPLACE_URL = "https://github.com/askrzypczak/claude-workflow.git";
const ACCOUNT_KEY = `${SSH_DIR}/id_ed25519`;

const TOOLS_REPO: ServedRepo = { repo: FAKE_REPO, dir: CLONE };
const APP_REPO: ServedRepo = { repo: APP, dir: APP_DIR };

const repoName = (repo: string) => repo.split("/")[1]!;
const aliasUrl = (repo: string) => `git@github.com-${repoName(repo)}:${repo}.git`;
const keysNewUrl = (repo: string) => `https://github.com/${repo}/settings/keys/new`;

const privateKey = (label: string, kind = "OPENSSH") =>
  `-----BEGIN ${kind} PRIVATE KEY-----\nFAKE-KEY-BODY-FOR-TESTS-${label}\n-----END ${kind} PRIVATE KEY-----\n`;
const publicKey = (label: string) => `ssh-ed25519 AAAAFAKE${label} ${label}\n`;
const aliasBlock = (name: string) =>
  `Host github.com-${name}\n  HostName github.com\n  User git\n  IdentityFile ~/.ssh/deploy-${name}\n  IdentitiesOnly yes\n`;

const EXISTING_CONFIG = "Host example.org\n  User someone\n";
const KNOWN_HOSTS = "github.com ssh-ed25519 AAAAFAKEKNOWNHOST\n";

/** Nothing set up yet: one account key, loaded in the agent and protected by a passphrase. */
function firstRunWorld(overrides: FakeWorld = {}): FakeWorld {
  return {
    files: {
      [ACCOUNT_KEY]: privateKey("account"),
      [`${ACCOUNT_KEY}.pub`]: publicKey("id_ed25519"),
      [CONFIG]: EXISTING_CONFIG,
      [`${SSH_DIR}/known_hosts`]: KNOWN_HOSTS,
    },
    remotes: {
      [CLONE]: `git@github.com:${FAKE_REPO}.git`,
      [APP_DIR]: `git@github.com:${APP}.git`,
      [MARKETPLACE]: MARKETPLACE_URL,
    },
    agentKeys: [ACCOUNT_KEY],
    passphrase: [ACCOUNT_KEY],
    ...overrides,
  };
}

/** Everything already in place for both repos; the agent is empty. */
function doneWorld(overrides: FakeWorld = {}): FakeWorld {
  const files: Record<string, string> = {
    [ACCOUNT_KEY]: privateKey("account"),
    [`${ACCOUNT_KEY}.pub`]: publicKey("id_ed25519"),
    [CONFIG]: `${EXISTING_CONFIG}\n${aliasBlock("example-tools")}\n${aliasBlock("example-app")}`,
    [`${SSH_DIR}/known_hosts`]: KNOWN_HOSTS,
  };
  for (const name of ["example-tools", "example-app"]) {
    files[`${SSH_DIR}/deploy-${name}`] = privateKey(name);
    files[`${SSH_DIR}/deploy-${name}.pub`] = publicKey(`deploy-${name}`);
  }
  return {
    files,
    remotes: { [CLONE]: aliasUrl(FAKE_REPO), [APP_DIR]: aliasUrl(APP), [MARKETPLACE]: MARKETPLACE_URL },
    deployKeys: [FAKE_REPO, APP],
    agentKeys: [],
    passphrase: [ACCOUNT_KEY],
    ...overrides,
  };
}

function setup(world: FakeWorld, repos: readonly ServedRepo[] = [TOOLS_REPO, APP_REPO], dryRun = false) {
  const fake = fakeIo(world);
  const ctx: SetupContext = { io: fake.io, dryRun, clone: CLONE, home: HOME, repos };
  return { ...fake, ctx };
}

const isLsRemote = (call: FakeCall, repo: string) =>
  call.cmd === "git" && call.args[0] === "ls-remote" && call.args.includes(aliasUrl(repo));
const isSetUrl = (call: FakeCall, dir: string) =>
  call.cmd === "git" && call.args[0] === "-C" && call.args[1] === dir && call.args.includes("set-url");
const isUnload = (call: FakeCall) =>
  call.cmd === "ssh-add" && (call.args.includes("-d") || call.args.includes("-D"));
const isOpen = (call: FakeCall, url: string) => call.cmd === "open" && call.args.includes(url);

describe("findPrivateKeys", () => {
  it("findPrivateKeys on a fake ~/.ssh holding two private keys, a .pub, config and known_hosts returns exactly the two keys and reads each file only through readFirstLine", () => {
    const { io, calls, fileOps } = fakeIo({
      files: {
        [`${SSH_DIR}/id_rsa`]: privateKey("rsa", "RSA"),
        [`${SSH_DIR}/id_ed25519`]: privateKey("ed25519"),
        [`${SSH_DIR}/id_ed25519.pub`]: publicKey("id_ed25519"),
        [CONFIG]: EXISTING_CONFIG,
        [`${SSH_DIR}/known_hosts`]: KNOWN_HOSTS,
      },
    });

    const keys = findPrivateKeys(io, SSH_DIR);

    expect(keys).toEqual([`${SSH_DIR}/id_ed25519`, `${SSH_DIR}/id_rsa`]);
    expect(calls).toEqual([]);
    expect(fileOps.filter((o) => o.op !== "listDir" && o.op !== "readFirstLine")).toEqual([]);
    expect(fileOps.filter((o) => o.op === "readFirstLine").map((o) => o.path).sort()).toEqual(
      [`${SSH_DIR}/id_ed25519`, `${SSH_DIR}/id_ed25519.pub`, `${SSH_DIR}/id_rsa`, CONFIG, `${SSH_DIR}/known_hosts`].sort(),
    );
  });
});

describe("ssh phase", () => {
  it("a re-run with the keys, aliases and remotes already in place runs no write command, writes no file and waits for no Enter", () => {
    const { calls, reports, prompts, fileOps, ctx } = setup(doneWorld());

    const result = ssh.run(ctx);

    expect(result).toBe("ok");
    expect(writeCalls(calls)).toEqual([]);
    expect(fileWrites(fileOps)).toEqual([]);
    expect(prompts).toEqual([]);
    const already = reports.filter((r) => r.status === "already").map((r) => r.text);
    for (const repo of [FAKE_REPO, APP]) {
      const name = repoName(repo);
      expect(already.some((t) => t.includes(`deploy-${name}`)), `key of ${repo}`).toBe(true);
      expect(already.some((t) => /alias/i.test(t) && t.includes(`github.com-${name}`)), `alias of ${repo}`).toBe(true);
      expect(already.some((t) => /origin/i.test(t) && t.includes(repo)), `origin of ${repo}`).toBe(true);
    }
  });

  it("when git ls-remote through the alias still fails after Enter, the phase stops with a to-do and origin is not switched", () => {
    const { calls, reports, prompts, ctx } = setup(firstRunWorld({ pastes: false }), [TOOLS_REPO]);

    const result = ssh.run(ctx);

    expect(result).toBe("stop");
    expect(prompts.some((p) => p.kind === "enter")).toBe(true);
    const openAt = calls.findIndex((c) => isOpen(c, keysNewUrl(FAKE_REPO)));
    expect(openAt).toBeGreaterThanOrEqual(0);
    expect(calls.slice(openAt).some((c) => isLsRemote(c, FAKE_REPO))).toBe(true);
    expect(reports.some((r) => r.status === "todo" && r.text.includes(FAKE_REPO))).toBe(true);
    expect(calls.filter((c) => isSetUrl(c, CLONE))).toEqual([]);
    expect(calls.filter(isUnload)).toEqual([]);
  });

  it("on a first run, origin is switched only after git ls-remote through the alias succeeds", () => {
    const { calls, ctx } = setup(firstRunWorld());

    const result = ssh.run(ctx);

    expect(result).toBe("ok");
    for (const { repo, dir } of [TOOLS_REPO, APP_REPO]) {
      const setAt = calls.findIndex((c) => isSetUrl(c, dir));
      expect(setAt, `set-url for ${repo}`).toBeGreaterThanOrEqual(0);
      expect(calls[setAt]!.args).toContain(aliasUrl(repo));
      expect(calls.filter((c) => isSetUrl(c, dir))).toHaveLength(1);
      // Before the paste the alias cannot reach the repo, so the check that passed is a later one.
      const openAt = calls.findIndex((c) => isOpen(c, keysNewUrl(repo)));
      expect(openAt, `open of ${repo}'s keys page`).toBeGreaterThanOrEqual(0);
      expect(openAt).toBeLessThan(setAt);
      expect(calls.slice(openAt + 1, setAt).some((c) => isLsRemote(c, repo)), `ls-remote of ${repo}`).toBe(true);
    }
  });

  it("~/.ssh/config is backed up and then only appended to, keeping its existing text", () => {
    const { fileOps, files, ctx } = setup(firstRunWorld());

    ssh.run(ctx);

    const copies = fileOps.filter((o) => o.op === "copyFile");
    expect(copies).toHaveLength(1);
    const backup = copies[0]!;
    expect(backup.path).toBe(CONFIG);
    expect(backup.to).toMatch(new RegExp(`^${CONFIG.replace(/[.]/g, "\\.")}\\.bak-\\d{8}-\\d{6}$`));
    expect(files[backup.to!]).toBe(EXISTING_CONFIG);
    const configWrites = fileWrites(fileOps).filter((o) => o.path === CONFIG || o.to === CONFIG);
    expect(configWrites.filter((o) => o.op !== "appendFile" && o !== backup)).toEqual([]);
    const firstAppend = fileOps.findIndex((o) => o.op === "appendFile" && o.path === CONFIG);
    expect(firstAppend).toBeGreaterThan(fileOps.indexOf(backup));
    expect(files[CONFIG]!.startsWith(EXISTING_CONFIG)).toBe(true);
    expect(files[CONFIG]).toContain("Host github.com-example-tools");
    expect(files[CONFIG]).toContain("Host github.com-example-app");
  });

  it("an account key with no passphrase stops the phase with a to-do naming ssh-keygen -p and deleting the key, and no key is deleted", () => {
    const { calls, reports, files, ctx } = setup(doneWorld({ passphrase: [] }));

    const result = ssh.run(ctx);

    expect(result).toBe("stop");
    const todos = reports.filter((r) => r.status === "todo").map((r) => r.text);
    expect(
      todos.some((t) => t.includes("ssh-keygen -p") && t.includes(ACCOUNT_KEY) && /delet|\brm\b/i.test(t)),
      todos.join("\n"),
    ).toBe(true);
    expect(files[ACCOUNT_KEY]).toBe(privateKey("account"));
    expect(files[`${ACCOUNT_KEY}.pub`]).toBe(publicKey("id_ed25519"));
    const deleters = ["rm", "unlink", "trash", "shred", "mv"];
    expect(calls.filter((c) => deleters.includes(c.cmd))).toEqual([]);
  });

  it("while a served repo's remote does not yet work through its deploy key, the account key is not unloaded from ssh-agent", () => {
    const { calls, reports, ctx } = setup(firstRunWorld({ pastes: false, deployKeys: [FAKE_REPO] }));

    const result = ssh.run(ctx);

    expect(result).toBe("stop");
    expect(reports.some((r) => r.status === "todo" && r.text.includes(APP))).toBe(true);
    expect(calls.some((c) => isLsRemote(c, APP))).toBe(true);
    expect(calls.filter(isUnload)).toEqual([]);
  });

  it("on a first run, ssh-add -d and ssh-add -D run only after every served repo's origin is switched", () => {
    const { calls, ctx } = setup(firstRunWorld());

    const result = ssh.run(ctx);

    expect(result).toBe("ok");
    const unloadDAt = calls.findIndex((c) => c.cmd === "ssh-add" && c.args.includes("-d") && c.args.includes(ACCOUNT_KEY));
    const unloadAllAt = calls.findIndex((c) => c.cmd === "ssh-add" && c.args.includes("-D"));
    expect(unloadDAt).toBeGreaterThanOrEqual(0);
    expect(unloadAllAt).toBeGreaterThanOrEqual(0);
    const firstUnload = calls.findIndex(isUnload);
    for (const dir of [CLONE, APP_DIR]) {
      const setAt = calls.findIndex((c) => isSetUrl(c, dir));
      expect(setAt, `set-url in ${dir}`).toBeGreaterThanOrEqual(0);
      expect(setAt).toBeLessThan(firstUnload);
    }
  });

  it("the ssh phase never calls gh repo deploy-key add", () => {
    const { calls, ctx } = setup(firstRunWorld());

    const result = ssh.run(ctx);

    expect(result).toBe("ok");
    for (const repo of [FAKE_REPO, APP]) {
      expect(calls.some((c) => isOpen(c, keysNewUrl(repo))), `open of ${repo}'s keys page`).toBe(true);
    }
    expect(calls.filter((c) => c.cmd === "gh" && c.args.includes("deploy-key"))).toEqual([]);
    expect(
      calls.filter((c) => {
        const api = parseGhApi(c);
        return api !== undefined && /\/keys(\/|$)/.test(api.endpoint);
      }),
    ).toEqual([]);
  });

  it("an alias whose ssh -G lists another identity file stops the phase with a to-do naming that file, before git ls-remote and with origin unchanged", () => {
    const { calls, reports, ctx } = setup(
      firstRunWorld({
        respond: (c) =>
          c.cmd === "ssh" && c.args.includes("-G") && c.args.includes("github.com-example-tools")
            ? {
                status: 0,
                stdout:
                  "hostname github.com\nuser git\nidentitiesonly yes\n" +
                  "identityfile ~/.ssh/id_work\nidentityfile ~/.ssh/deploy-example-tools\n",
                stderr: "",
              }
            : undefined,
      }),
      [TOOLS_REPO],
    );

    const result = ssh.run(ctx);

    expect(result).toBe("stop");
    expect(calls.some((c) => c.cmd === "ssh" && c.args.includes("-G"))).toBe(true);
    expect(reports.some((r) => r.status === "todo" && r.text.includes("id_work"))).toBe(true);
    expect(calls.filter((c) => c.cmd === "git" && c.args[0] === "ls-remote")).toEqual([]);
    expect(calls.filter((c) => isSetUrl(c, CLONE))).toEqual([]);
    expect(calls.filter(isUnload)).toEqual([]);
  });

  it("two served repos with the same repo name stop the phase with a to-do before any write", () => {
    const other: ServedRepo = { repo: "other-owner/example-tools", dir: "/work/other-tools" };
    const { calls, reports, prompts, fileOps, ctx } = setup(firstRunWorld(), [TOOLS_REPO, other]);

    const result = ssh.run(ctx);

    expect(result).toBe("stop");
    expect(
      reports.some((r) => r.status === "todo" && r.text.includes(FAKE_REPO) && r.text.includes(other.repo)),
    ).toBe(true);
    expect(writeCalls(calls)).toEqual([]);
    expect(fileWrites(fileOps)).toEqual([]);
    expect(prompts).toEqual([]);
  });

  describe("dry run", () => {
    beforeEach(() => {
      vi.spyOn(console, "log").mockImplementation(() => {});
      vi.spyOn(console, "error").mockImplementation(() => {});
    });
    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("ssh --dry-run on a first run runs no write command, writes no file and waits for no Enter", () => {
      const { io, calls, reports, prompts, fileOps } = fakeIo(firstRunWorld());

      const code = runSetup(["ssh", "--dry-run"], {
        io,
        clone: CLONE,
        home: HOME,
        configPath: "/nonexistent/repos.json",
      });

      expect(code).toBe(0);
      expect(writeCalls(calls)).toEqual([]);
      expect(fileWrites(fileOps)).toEqual([]);
      expect(prompts).toEqual([]);
      const would = reports.filter((r) => r.status === "would").map((r) => r.text);
      expect(would.some((t) => t.includes("deploy-example-tools")), "a would line for the key").toBe(true);
      expect(would.some((t) => /alias/i.test(t) && t.includes("github.com-example-tools")), "a would line for the alias").toBe(true);
      expect(would.some((t) => /paste/i.test(t)), "a would line for the paste").toBe(true);
      expect(would.some((t) => /origin/i.test(t) && t.includes(FAKE_REPO)), "a would line for the remote").toBe(true);
    });
  });
});
