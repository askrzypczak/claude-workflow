// The container phase's secrets on the fake SetupIo (fake-io.ts) and its docker world: the gh
// token for the container's login, the Claude token's env file, and the seeded ~/.claude.json.
import { describe, expect, it } from "vitest";
import { container, ENV_FILE, seedClaudeJson } from "./container.ts";
import { FAKE_HOME, FAKE_REPO, FAKE_TOKEN, fakeIo, parseDockerExec, parseGhApi } from "./fake-io.ts";
import type { FakeCall, FakeDocker, FakeWorld } from "./fake-io.ts";
import type { ServedRepo } from "./repos.ts";

const CLONE = "/clone";
const OTHER_REPO = "example-owner/example-other";
const ENV_PATH = `${FAKE_HOME}/${ENV_FILE}`;
const CLAUDE_TOKEN = "sk-ant-oat01-fake-token-for-tests";
const REPOS: ServedRepo[] = [
  { repo: FAKE_REPO },
  { repo: OTHER_REPO },
];

/** A Claude token in the env file and no gh login in the container. */
function world(docker: FakeDocker = {}, overrides: FakeWorld = {}): FakeWorld {
  return {
    deployKeys: [FAKE_REPO, OTHER_REPO],
    files: { [ENV_PATH]: `CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_TOKEN}\n` },
    ...overrides,
    docker,
  };
}

function run(w: FakeWorld) {
  const fake = fakeIo(w);
  const result = container.run({ io: fake.io, dryRun: false, clone: CLONE, home: FAKE_HOME, repos: REPOS });
  return { ...fake, result };
}

/** Whether a call carries `secret` in its arguments, its input or its environment. */
const carries = (c: FakeCall, secret: string) =>
  c.args.some((a) => a.includes(secret)) || (c.input ?? "").includes(secret) || Object.values(c.env).some((v) => v.includes(secret));
const isLogin = (c: FakeCall) => {
  const command = parseDockerExec(c)?.command ?? [];
  return command[0] === "gh" && command[1] === "auth" && command[2] === "login";
};
/** Whether a call carries `secret` in its environment. */
const inEnv = (c: FakeCall, secret: string) => Object.values(c.env).some((v) => v.includes(secret));
/** Every gh api request on a repo's git/refs. */
const refsRequests = (calls: readonly FakeCall[]) =>
  calls.filter((c) => (parseGhApi(c)?.endpoint ?? "").includes("/git/refs"));
/** Whether the call reads the token of the container's gh login. */
const isTokenRead = (c: FakeCall) => {
  const command = parseDockerExec(c)?.command ?? [];
  return command[0] === "gh" && command[1] === "auth" && command[2] === "token";
};
const isPluginCommand = (c: FakeCall) => {
  const command = parseDockerExec(c)?.command ?? [];
  return command[0] === "claude" && command[1] === "plugin";
};

describe("container phase secrets", () => {
  it("a pasted fine-grained token is logged in to the container with no git/refs request and no gh call carrying it in the environment", () => {
    const { result, calls, reports, docker } = run(world({}, { secret: FAKE_TOKEN }));

    expect(result).toBe("ok");
    expect(refsRequests(calls).map((c) => c.args.join(" "))).toEqual([]);
    expect(calls.filter((c) => c.cmd === "gh" && inEnv(c, FAKE_TOKEN)).map((c) => c.args.join(" "))).toEqual([]);
    expect(calls.filter(isLogin)).toHaveLength(1);
    expect(docker.login()).toBe("fine-grained");
    expect(reports.some((r) => r.status === "todo")).toBe(false);
    expect(reports.some((r) => r.text.includes(FAKE_TOKEN))).toBe(false);
  });

  it("a token that does not start github_pat_ is refused and never reaches the container", () => {
    const classic = "ghp_fakeClassicTokenForTests0000000000";
    const { result, calls, reports, docker } = run(world({}, { secret: classic }));

    expect(result).toBe("stop");
    expect(reports.some((r) => r.status === "todo")).toBe(true);
    expect(calls.some((c) => inEnv(c, classic))).toBe(false);
    expect(calls.filter((c) => c.cmd === "docker").some((c) => carries(c, classic))).toBe(false);
    expect(calls.some(isLogin)).toBe(false);
    expect(docker.login()).toBeUndefined();
  });

  it("a pasted token is logged in as node through stdin, never in an argument", () => {
    const { result, calls, reports, docker } = run(world({}, { secret: FAKE_TOKEN }));

    expect(result).toBe("ok");
    const logins = calls.filter(isLogin);
    expect(logins).toHaveLength(1);
    const login = parseDockerExec(logins[0]!)!;
    expect(login.user).toBe("node");
    expect(login.interactive).toBe(true);
    expect(login.command).toContain("--with-token");
    expect(logins[0]!.input).toContain(FAKE_TOKEN);
    expect(calls.some((c) => c.args.some((a) => a.includes(FAKE_TOKEN)))).toBe(false);
    expect(reports.some((r) => r.text.includes(FAKE_TOKEN))).toBe(false);
    expect(docker.login()).toBe("fine-grained");
  });

  it("a rerun with one stored fine-grained container login makes no git/refs request, reads no token and goes on to trust and the plugin", () => {
    const { result, calls, reports, prompts, docker } = run(world({ ghLogin: "fine-grained" }));

    expect(result).toBe("ok");
    expect(refsRequests(calls).map((c) => c.args.join(" "))).toEqual([]);
    expect(calls.filter(isTokenRead).map((c) => c.args.join(" "))).toEqual([]);
    expect(calls.some(isLogin)).toBe(false);
    expect(prompts.some((p) => p.kind === "secret")).toBe(false);
    expect(reports.some((r) => r.status === "todo")).toBe(false);
    expect(docker.file("/home/node/.claude.json")).toBeDefined();
    expect(calls.some(isPluginCommand)).toBe(true);
  });

  it("the Claude token goes to the env file as CLAUDE_CODE_OAUTH_TOKEN with mode 0600, and no report holds it", () => {
    const { result, files, modes, reports, calls, prompts } = run(
      world({ ghLogin: "fine-grained" }, { files: {}, secret: CLAUDE_TOKEN }),
    );

    expect(result).toBe("ok");
    expect(prompts.some((p) => p.kind === "secret")).toBe(true);
    expect(files[ENV_PATH]?.split("\n")).toContain(`CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_TOKEN}`);
    expect(modes[ENV_PATH]).toBe(0o600);
    expect(reports.some((r) => r.text.includes(CLAUDE_TOKEN))).toBe(false);
    expect(calls.some((c) => c.args.some((a) => a.includes(CLAUDE_TOKEN)))).toBe(false);
  });

  it("an existing env file with another mode is set to 0600", () => {
    const text = `CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_TOKEN}\n`;
    const { result, files, modes } = run(world({ ghLogin: "fine-grained" }, { modes: { [ENV_PATH]: 0o644 } }));

    expect(result).toBe("ok");
    expect(modes[ENV_PATH]).toBe(0o600);
    expect(files[ENV_PATH]).toBe(text);
  });

  it("~/.claude.json gains onboarding and trust for each clone dir and keeps other keys", () => {
    const before = {
      userID: "fake-user-id",
      projects: { "/home/node/elsewhere": { allowedTools: ["Bash(ls)"] } },
    };
    const { result, docker } = run(world({
      ghLogin: "fine-grained",
      files: { "/home/node/.claude.json": JSON.stringify(before) },
    }));

    expect(result).toBe("ok");
    const after = JSON.parse(docker.file("/home/node/.claude.json") ?? "{}") as {
      userID?: string;
      hasCompletedOnboarding?: boolean;
      projects?: Record<string, Record<string, unknown>>;
    };
    expect(after.userID).toBe("fake-user-id");
    expect(after.hasCompletedOnboarding).toBe(true);
    expect(after.projects?.["/home/node/elsewhere"]).toEqual({ allowedTools: ["Bash(ls)"] });
    for (const dir of ["/home/node/example-tools", "/home/node/example-other"]) {
      expect(after.projects?.[dir]?.hasTrustDialogAccepted, dir).toBe(true);
    }
  });

  it("seedClaudeJson throws on text that is not a JSON object", () => {
    const dirs = ["/home/node/example-tools"];
    const seeded = JSON.parse(seedClaudeJson('{"userID":"fake-user-id"}', dirs)) as Record<string, unknown>;
    expect(seeded.userID).toBe("fake-user-id");
    expect(seeded.hasCompletedOnboarding).toBe(true);
    expect(JSON.parse(seedClaudeJson(undefined, dirs))).toMatchObject({ hasCompletedOnboarding: true });

    for (const text of ["[]", "null", "42", '"text"', "{ not json"]) {
      expect(() => seedClaudeJson(text, dirs), text).toThrow();
    }
  });
});
