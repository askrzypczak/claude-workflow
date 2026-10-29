// The ssh phase's single steps on the fake SetupIo (fake-io.ts): the effective-config check,
// the marketplace switch, the appended alias block, the reported config lines and ssh-agent.
import { describe, expect, it } from "vitest";
import { FAKE_HOME, FAKE_REPO, fakeIo } from "./fake-io.ts";
import type { FakeCall, FakeWorld } from "./fake-io.ts";
import type { SetupContext } from "./main.ts";
import { ssh } from "./ssh.ts";

const SSH_DIR = `${FAKE_HOME}/.ssh`;
const CONFIG = `${SSH_DIR}/config`;
const CLONE = "/clone";
const ACCOUNT_KEY = `${SSH_DIR}/id_ed25519`;
const MARKETPLACE = `${FAKE_HOME}/.claude/plugins/marketplaces/askrzypczak-plugins`;
const MARKETPLACE_HTTPS = "https://github.com/askrzypczak/claude-workflow.git";
const ALIAS = "github.com-example-tools";

/** Nothing set up yet for the one served repo; the account key is loaded and has a passphrase. */
function firstRun(overrides: FakeWorld = {}, config = "Host example.org\n  User someone\n"): FakeWorld {
  return {
    files: {
      [ACCOUNT_KEY]: "-----BEGIN OPENSSH PRIVATE KEY-----\nFAKE-KEY-BODY-FOR-TESTS\n-----END OPENSSH PRIVATE KEY-----\n",
      [`${ACCOUNT_KEY}.pub`]: "ssh-ed25519 AAAAFAKEaccount account\n",
      [CONFIG]: config,
      [`${SSH_DIR}/known_hosts`]: "github.com ssh-ed25519 AAAAFAKEKNOWNHOST\n",
    },
    remotes: { [CLONE]: `git@github.com:${FAKE_REPO}.git`, [MARKETPLACE]: MARKETPLACE_HTTPS },
    agentKeys: [ACCOUNT_KEY],
    passphrase: [ACCOUNT_KEY],
    ...overrides,
  };
}

function run(world: FakeWorld) {
  const fake = fakeIo(world);
  const ctx: SetupContext = { io: fake.io, dryRun: false, clone: CLONE, home: FAKE_HOME, repos: [{ repo: FAKE_REPO, dir: CLONE }] };
  return { ...fake, result: ssh.run(ctx) };
}

/** `ssh -G` for the alias prints `stdout`; everything else follows the fake's script. */
const sshG = (stdout: string): FakeWorld["respond"] => (call) =>
  call.cmd === "ssh" && call.args.includes("-G") && call.args.includes(ALIAS)
    ? { status: 0, stdout: `hostname github.com\nuser git\n${stdout}`, stderr: "" }
    : undefined;

const isLsRemote = (call: FakeCall) => call.cmd === "git" && call.args[0] === "ls-remote";
const isSetUrl = (call: FakeCall, dir: string) =>
  call.cmd === "git" && call.args[0] === "-C" && call.args[1] === dir && call.args.includes("set-url");

describe("ssh phase steps", () => {
  it("an alias whose ssh -G shows identitiesonly no stops the phase with a to-do naming identitiesonly, before git ls-remote and with origin unchanged", () => {
    const { result, calls, reports } = run(
      firstRun({ respond: sshG("identitiesonly no\nidentityfile ~/.ssh/deploy-example-tools\n") }),
    );

    expect(result).toBe("stop");
    expect(reports.some((r) => r.status === "todo" && /identitiesonly/i.test(r.text))).toBe(true);
    expect(calls.filter(isLsRemote)).toEqual([]);
    expect(calls.filter((c) => isSetUrl(c, CLONE))).toEqual([]);
  });

  it("an alias whose ssh -G shows the deploy key by its absolute path passes the check and goes on to git ls-remote", () => {
    const { result, calls, reports } = run(
      firstRun({ respond: sshG(`identitiesonly yes\nidentityfile ${SSH_DIR}/deploy-example-tools\n`) }),
    );

    expect(result).toBe("ok");
    expect(reports.filter((r) => r.status === "todo")).toEqual([]);
    expect(calls.some(isLsRemote)).toBe(true);
    expect(calls.filter((c) => isSetUrl(c, CLONE))).toHaveLength(1);
  });

  it("switches the marketplace clone's origin from SSH to HTTPS once", () => {
    const { result, calls } = run(
      firstRun({ remotes: { [CLONE]: `git@github.com:${FAKE_REPO}.git`, [MARKETPLACE]: "git@github.com:askrzypczak/claude-workflow.git" } }),
    );

    expect(result).toBe("ok");
    const switches = calls.filter((c) => isSetUrl(c, MARKETPLACE));
    expect(switches).toHaveLength(1);
    expect(switches[0]!.args.slice(2)).toEqual(["remote", "set-url", "origin", MARKETPLACE_HTTPS]);
  });

  it("starts the appended alias block on a new line when ~/.ssh/config does not end in one", () => {
    const { files } = run(firstRun({}, "Host example.org\n  User someone"));

    expect(files[CONFIG]).toMatch(/someone\n\n?Host github\.com-example-tools\n/);
    expect(files[CONFIG]).not.toContain("someoneHost");
  });

  it("reports each UseKeychain and AddKeysToAgent line of ~/.ssh/config by line number and leaves the lines in place", () => {
    const original = "Host *\n  UseKeychain yes\n  AddKeysToAgent yes\n";
    const { files, reports } = run(firstRun({}, original));

    const notes = reports.filter((r) => r.status === "note").map((r) => r.text);
    expect(notes.some((t) => /\bline 2\b/.test(t) && t.includes("UseKeychain")), notes.join("\n")).toBe(true);
    expect(notes.some((t) => /\bline 3\b/.test(t) && t.includes("AddKeysToAgent")), notes.join("\n")).toBe(true);
    expect(files[CONFIG]!.startsWith(original)).toBe(true);
  });

  it("when ssh-add rejects --apple-use-keychain, names /usr/bin/ssh-add for removing the stored passphrase", () => {
    const { reports } = run(
      firstRun({
        respond: (call) =>
          call.cmd === "ssh-add" && call.args.includes("--apple-use-keychain")
            ? { status: 1, stdout: "", stderr: "ssh-add: illegal option -- -\n" }
            : undefined,
      }),
    );

    expect(
      reports.some(
        (r) => r.status === "note" && r.text.includes(`/usr/bin/ssh-add -d --apple-use-keychain ${ACCOUNT_KEY}`),
      ),
    ).toBe(true);
    expect(reports.filter((r) => r.status === "done" && r.text.includes("ssh-add") && /passphrase/i.test(r.text))).toEqual([]);
  });
});
