// The container phase's repo steps on the fake SetupIo (fake-io.ts) and its docker world: the
// protect-main check, deploy keys, ~/.ssh/config, known_hosts, the browser step for a missing
// deploy key, the clones and the git identity.
//
// Report keywords these tests match on (case-insensitive): a failed protect-main check's to-do
// names "protect-main" and the repo; a missing git identity's to-do names "user.name" and
// "user.email".
import { describe, expect, it } from "vitest";
import { container, ENV_FILE } from "./container.ts";
import {
  FAKE_GIT_IDENTITY,
  FAKE_HOME,
  FAKE_META_KEYS,
  FAKE_REPO,
  fakeIo,
  parseDockerExec,
  parseGhApi,
  restrictUpdates,
} from "./fake-io.ts";
import type { FakeCall, FakeDocker, FakeWorld } from "./fake-io.ts";
import type { ServedRepo } from "./repos.ts";

const CLONE = "/clone";
const OTHER = "/work/example-other";
const OTHER_REPO = "example-owner/example-other";
const ENV_PATH = `${FAKE_HOME}/${ENV_FILE}`;
const SSH = "/home/node/.ssh";
const REPOS: ServedRepo[] = [
  { repo: FAKE_REPO, dir: CLONE },
  { repo: OTHER_REPO, dir: OTHER },
];

/** A Claude token in the env file and a gh login in the container, so no step prompts. */
function world(docker: FakeDocker = {}, overrides: FakeWorld = {}): FakeWorld {
  return {
    deployKeys: [FAKE_REPO, OTHER_REPO],
    files: { [ENV_PATH]: "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fake-token-for-tests\n" },
    ...overrides,
    docker: { ghLogin: "fine-grained", ...docker },
  };
}

function run(w: FakeWorld, repos: readonly ServedRepo[] = REPOS) {
  const fake = fakeIo(w);
  const result = container.run({ io: fake.io, dryRun: false, clone: CLONE, home: FAKE_HOME, repos });
  return { ...fake, result };
}

/** The command of every docker exec call, with its user. */
const execs = (calls: readonly FakeCall[]) =>
  calls.flatMap((c, index) => {
    const x = parseDockerExec(c);
    return x === undefined ? [] : [{ ...x, index }];
  });
const keygens = (calls: readonly FakeCall[]) =>
  execs(calls).filter((x) => x.command[0] === "ssh-keygen" && x.command.includes("-t"));
const keyPath = (command: readonly string[]) => command[command.indexOf("-f") + 1];

/** ~/.ssh/config's Host blocks: each alias and its options, keys lower-cased. */
function hostBlocks(config: string): { hosts: string[]; options: [string, string][] }[] {
  const blocks: { hosts: string[]; options: [string, string][] }[] = [];
  for (const raw of config.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^(\S+?)(?:\s*=\s*|\s+)(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    if (key === "host") blocks.push({ hosts: m[2]!.trim().split(/\s+/), options: [] });
    else blocks[blocks.length - 1]?.options.push([key, m[2]!.trim()]);
  }
  return blocks;
}

describe("container phase repo steps", () => {
  it("each repo's deploy key is generated in the container as node, and none on the host", () => {
    const { result, calls, docker, fileOps } = run(world());

    expect(result).toBe("ok");
    const generated = keygens(calls);
    expect(generated.map((x) => keyPath(x.command)).sort()).toEqual([`${SSH}/deploy-example-other`, `${SSH}/deploy-example-tools`]);
    expect(generated.every((x) => x.user === "node")).toBe(true);
    expect(docker.file(`${SSH}/deploy-example-tools`)).toBeDefined();
    expect(docker.file(`${SSH}/deploy-example-other`)).toBeDefined();
    expect(calls.some((c) => c.cmd === "ssh-keygen")).toBe(false);
    expect(fileOps.some((o) => o.path.startsWith(`${FAKE_HOME}/.ssh`) && o.op !== "readFile")).toBe(false);
  });

  it("an existing deploy key in the container is kept", () => {
    const existing = "-----BEGIN OPENSSH PRIVATE KEY-----\nFAKE-EXISTING-KEY-FOR-TESTS\n-----END OPENSSH PRIVATE KEY-----\n";
    const { result, calls, docker } = run(world({
      files: {
        [`${SSH}/deploy-example-tools`]: existing,
        [`${SSH}/deploy-example-tools.pub`]: { text: "ssh-ed25519 AAAAFAKEexisting deploy\n", mode: 0o644 },
      },
    }));

    expect(result).toBe("ok");
    expect(keygens(calls).map((x) => keyPath(x.command))).toEqual([`${SSH}/deploy-example-other`]);
    expect(docker.file(`${SSH}/deploy-example-tools`)).toBe(existing);
  });

  it("~/.ssh/config holds exactly one alias per repo, each naming only that repo's key, with IdentitiesOnly yes", () => {
    const stale = "Host github.com-example-tools\n  HostName github.com\n  IdentityFile ~/.ssh/id_ed25519\n";
    const { result, docker } = run(world({ files: { [`${SSH}/config`]: stale } }));

    expect(result).toBe("ok");
    const blocks = hostBlocks(docker.file(`${SSH}/config`) ?? "");
    expect(blocks.flatMap((b) => b.hosts).sort()).toEqual(["github.com-example-other", "github.com-example-tools"]);
    for (const block of blocks) {
      const name = block.hosts[0]!.slice("github.com-".length);
      const values = (key: string) => block.options.filter(([k]) => k === key).map(([, v]) => v);
      expect(block.hosts, name).toHaveLength(1);
      expect(values("hostname"), name).toEqual(["github.com"]);
      expect(values("identitiesonly").map((v) => v.toLowerCase()), name).toEqual(["yes"]);
      const files = values("identityfile");
      expect(files, name).toHaveLength(1);
      expect([`~/.ssh/deploy-${name}`, `${SSH}/deploy-${name}`], name).toContain(files[0]);
    }
  });

  it("known_hosts holds the host keys GitHub's meta returns", () => {
    const { result, calls, docker } = run(world());

    expect(result).toBe("ok");
    const lines = (docker.file(`${SSH}/known_hosts`) ?? "").split("\n").map((l) => l.trim());
    for (const key of FAKE_META_KEYS) {
      expect(lines.some((l) => l.split(/\s+/)[0]!.split(",").includes("github.com") && l.endsWith(key)), key).toBe(true);
    }
    const meta = execs(calls).filter((x) => x.command[0] === "curl" && x.command.includes("https://api.github.com/meta"));
    expect(meta.length).toBeGreaterThan(0);
    expect(meta.every((x) => x.user === "node")).toBe(true);
    expect(calls.some((c) => c.cmd === "curl")).toBe(false);
  });

  it("a failing ls-remote copies the public key, opens the new-deploy-key page, waits for Enter and checks again", () => {
    const { result, calls, prompts, docker } = run(world({}, { deployKeys: [OTHER_REPO] }));

    expect(result).toBe("ok");
    const lsRemotes = execs(calls).filter(
      (x) => x.command[0] === "git" && x.command.includes("ls-remote") && x.command.some((a) => a.startsWith("git@github.com-example-tools:")),
    );
    expect(lsRemotes.length).toBeGreaterThanOrEqual(2);
    const copy = calls.findIndex((c) => c.cmd === "pbcopy");
    const open = calls.findIndex((c) => c.cmd === "open" && c.args[0] === `https://github.com/${FAKE_REPO}/settings/keys/new`);
    expect(copy).toBeGreaterThan(lsRemotes[0]!.index);
    expect(open).toBeGreaterThan(copy);
    expect(lsRemotes[lsRemotes.length - 1]!.index).toBeGreaterThan(open);
    expect(calls[copy]!.input?.trim()).toBe(docker.file(`${SSH}/deploy-example-tools.pub`)?.trim());
    expect(prompts.some((p) => p.kind === "enter")).toBe(true);
    expect(docker.file("/home/node/example-tools/.git/config")).toBeDefined();
  });

  it("each repo is cloned through its alias into /home/node/<name>, and an existing clone is left alone", () => {
    const { result, calls, docker } = run(world({
      clones: { "/home/node/example-other": `git@github.com-example-other:${OTHER_REPO}.git` },
    }));

    expect(result).toBe("ok");
    const clones = execs(calls).filter((x) => x.command[0] === "git" && x.command.includes("clone"));
    expect(clones).toHaveLength(1);
    const clone = clones[0]!;
    expect(clone.user).toBe("node");
    expect(clone.command.some((a) => /^git@github\.com-example-tools:example-owner\/example-tools(\.git)?$/.test(a))).toBe(true);
    expect(docker.file("/home/node/example-tools/.git/config")).toMatch(/git@github\.com-example-tools:example-owner\/example-tools/);
    expect(docker.file("/home/node/example-other/.git/config")).toMatch(/git@github\.com-example-other:/);
  });

  it("two repos with the same name part stop the phase before any key is generated", () => {
    const { result, calls, reports } = run(world(), [
      { repo: "example-owner/tools", dir: CLONE },
      { repo: "other-owner/tools", dir: OTHER },
    ]);

    expect(result).toBe("stop");
    expect(reports.some((r) => r.status === "todo")).toBe(true);
    expect(keygens(calls)).toEqual([]);
  });

  it("a repo whose protect-main check fails stops the phase before its deploy key is generated", () => {
    const { result, calls, reports } = run(world({}, { rulesets: [restrictUpdates()] }), [{ repo: FAKE_REPO, dir: CLONE }]);

    expect(result).toBe("stop");
    expect(reports.some((r) => r.status === "todo" && /protect-main/i.test(r.text) && r.text.includes(FAKE_REPO))).toBe(true);
    expect(calls.some((c) => parseGhApi(c)?.endpoint === `repos/${FAKE_REPO}/rules/branches/main`)).toBe(true);
    expect(keygens(calls)).toEqual([]);
  });

  it("a container with no git identity gets the host's global user.name and user.email", () => {
    const { result, calls, docker } = run(world());

    expect(result).toBe("ok");
    expect(docker.gitConfig()["user.name"]).toBe(FAKE_GIT_IDENTITY["user.name"]);
    expect(docker.gitConfig()["user.email"]).toBe(FAKE_GIT_IDENTITY["user.email"]);
    const sets = execs(calls).filter((x) => x.command[0] === "git" && x.command.includes("config") && x.command.includes("user.name"));
    expect(sets.length).toBeGreaterThan(0);
    expect(sets.every((x) => x.user === "node")).toBe(true);
  });

  it("no git identity on the host stops the phase with a to-do naming user.name and user.email, before any clone", () => {
    const { result, calls, reports, docker } = run(world({}, { hostGit: {} }));

    expect(result).toBe("stop");
    const todos = reports.filter((r) => r.status === "todo").map((r) => r.text);
    expect(todos.some((t) => t.includes("user.name") && t.includes("user.email"))).toBe(true);
    expect(execs(calls).some((x) => x.command[0] === "git" && x.command.includes("clone"))).toBe(false);
    expect(docker.gitConfig()["user.name"]).toBeUndefined();
  });
});
