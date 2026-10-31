// The credentials phase on the fake SetupIo (fake-io.ts).
//
// Report keywords these tests match on (case-insensitive), which the phase must use:
// - dry run, `would` lines: "pause" (pausing dispatch), "restrict-updates" (the ruleset),
//   "token" (the token form and prompt), "pre-swap" (the pre-swap test), "login" (the swap),
//   "after-swap" (the after-swap checks);
// - `already` lines: "restrict-updates" and "auto-merge";
// - the protect-main check: lines naming "protect-main" (and, for its to-dos, the repo); under
//   the fine-grained login, a `note` naming "protect-main", "bypass" and "browser";
// - readable ruleset checks: `pass` lines naming "enforcement" and "bypass" (with "exempt");
//   auto-merge left unchecked is a line naming "auto-merge" and "unchecked";
// - a live session's to-do names its fix, `claude stop <name>`;
// - stray-token to-dos name what was found: the variable, the file, "keychain".
import { describe, expect, it, vi } from "vitest";
import { credentials, judgePrChecks, judgeRollup } from "./credentials.ts";
import { FAKE_LOGIN, FAKE_REPO, FAKE_TOKEN, fakeIo, parseGhApi, protectMain, restrictUpdates, writeCalls } from "./fake-io.ts";
import type { FakeCall, FakeWorld } from "./fake-io.ts";
import type { RunResult } from "./io.ts";
import type { SetupContext } from "./main.ts";
import { runSetup } from "./main.ts";

const CLONE = "/clone";
const HOME = "/home/example";

function setup(world: FakeWorld = {}, dryRun = false) {
  const fake = fakeIo(world);
  const ctx: SetupContext = {
    io: fake.io,
    dryRun,
    clone: CLONE,
    home: HOME,
    repos: [{ repo: FAKE_REPO }],
  };
  return { ...fake, ctx };
}

const api = (call: FakeCall) => parseGhApi(call);
const isGh = (call: FakeCall, ...words: string[]) =>
  call.cmd === "gh" && words.every((w, i) => call.args[i] === w);

/** Ruleset and repo-setting writes: POST, PUT or PATCH on the repo or its rulesets. */
const settingWrites = (calls: readonly FakeCall[]) =>
  calls.filter((c) => {
    const a = api(c);
    return (
      a !== undefined &&
      ["POST", "PUT", "PATCH"].includes(a.method) &&
      (a.endpoint === `repos/${FAKE_REPO}` || a.endpoint.startsWith(`repos/${FAKE_REPO}/rulesets`))
    );
  });

describe("credentials phase", () => {
  it('runSetup(["credentials", "--dry-run"]) reports a would line for every step and a protect-main check line, and runs no write command', () => {
    const { io, calls, reports, prompts } = fakeIo({ dispatch: "running", rulesets: [protectMain()] });

    runSetup(["credentials", "--dry-run"], {
      io,
      clone: CLONE,
      home: HOME,
      configPath: "/nonexistent/repos.json",
    });

    expect(writeCalls(calls)).toEqual([]);
    expect(prompts.filter((p) => p.kind === "secret")).toEqual([]);
    const would = reports.filter((r) => r.status === "would").map((r) => r.text);
    for (const keyword of [/pause/i, /restrict-updates/i, /token/i, /pre-swap/i, /login/i, /after-swap/i]) {
      expect(would.some((t) => keyword.test(t)), `a would line matching ${keyword}`).toBe(true);
    }
    expect(reports.some((r) => r.status === "pass" && /protect-main/i.test(r.text) && r.text.includes(FAKE_REPO))).toBe(true);
  });

  it("a re-run under an admin login with restrict-updates in place and auto-merge off makes no ruleset or auto-merge write", () => {
    const { calls, reports, ctx } = setup({ rulesets: [protectMain(), restrictUpdates()], allowAutoMerge: false });

    credentials.run(ctx);

    expect(settingWrites(calls)).toEqual([]);
    const already = reports.filter((r) => r.status === "already").map((r) => r.text);
    expect(already.some((t) => /restrict-updates/i.test(t))).toBe(true);
    expect(already.some((t) => /auto-merge/i.test(t))).toBe(true);
  });

  it("with dispatch already paused, a re-run after the swap that declines a new token runs no write command", () => {
    const { calls, prompts, ctx } = setup({ dispatch: "paused", login: "fine-grained", confirm: false });

    const result = credentials.run(ctx);

    expect(result).toBe("ok");
    expect(prompts.some((p) => p.kind === "confirm")).toBe(true);
    expect(prompts.some((p) => p.kind === "secret")).toBe(false);
    expect(writeCalls(calls)).toEqual([]);
  });

  it("the token reaches gh only as GH_TOKEN or as gh auth login's stdin, never in argv, a reported line or a file-write effect", () => {
    const { calls, reports, ctx } = setup();

    const result = credentials.run(ctx);

    expect(result).toBe("ok");
    for (const call of calls) {
      expect(call.args.some((a) => a.includes(FAKE_TOKEN)), `${call.cmd} ${call.args.join(" ")}`).toBe(false);
      expect(call.cmd.includes(FAKE_TOKEN)).toBe(false);
      for (const [name, value] of Object.entries(call.env)) {
        if (value.includes(FAKE_TOKEN)) {
          expect(name).toBe("GH_TOKEN");
          expect(call.cmd).toBe("gh");
        }
      }
      if (call.input?.includes(FAKE_TOKEN)) {
        expect(isGh(call, "auth", "login")).toBe(true);
      }
    }
    expect(calls.some((c) => isGh(c, "auth", "login") && c.input?.trim() === FAKE_TOKEN)).toBe(true);
    expect(calls.some((c) => c.env.GH_TOKEN === FAKE_TOKEN)).toBe(true);
    for (const report of reports) expect(report.text).not.toContain(FAKE_TOKEN);
    const writers = ["tee", "cp", "mv", "dd", "install", "sh", "bash", "zsh"];
    expect(calls.filter((c) => writers.includes(c.cmd))).toEqual([]);
  });

  it("a failed pre-swap check stops the phase before gh auth logout or login", () => {
    const { calls, reports, ctx } = setup({
      fail: (c) => c.env.GH_TOKEN === FAKE_TOKEN && isGh(c, "run", "view"),
    });

    const result = credentials.run(ctx);

    expect(result).toBe("stop");
    expect(calls.some((c) => isGh(c, "run", "view") && c.env.GH_TOKEN === FAKE_TOKEN)).toBe(true);
    expect(calls.filter((c) => isGh(c, "auth", "logout") || isGh(c, "auth", "login"))).toEqual([]);
    expect(reports.some((r) => r.status === "todo")).toBe(true);
  });

  it("judgeRollup fails a rollup without a CheckRun named test", () => {
    const rollup = (entries: unknown[]) => ({
      status: 0,
      stdout: JSON.stringify({ statusCheckRollup: entries }),
      stderr: "",
    });

    expect(judgeRollup(rollup([]))).toBe(false);
    expect(
      judgeRollup(
        rollup([
          { __typename: "StatusContext", context: "test", state: "SUCCESS" },
          { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SUCCESS" },
        ]),
      ),
    ).toBe(false);
    expect(
      judgeRollup(rollup([{ __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" }])),
    ).toBe(true);
  });

  it("judgePrChecks passes exit 8 and exit 1 when a test row is listed", () => {
    const url = `https://github.com/${FAKE_REPO}/actions/runs/1/job/1`;

    expect(judgePrChecks({ status: 8, stdout: `test\tpending\t0\t${url}\n`, stderr: "" })).toBe(true);
    expect(
      judgePrChecks({ status: 1, stdout: `lint\tpass\t5s\t${url}\ntest\tfail\t12s\t${url}\n`, stderr: "" }),
    ).toBe(true);
    expect(judgePrChecks({ status: 1, stdout: `lint\tfail\t5s\t${url}\n`, stderr: "" })).toBe(false);
  });

  it("a missing ruleset is created as restrict-updates with only an update rule and the Repository admin role as the only bypass actor, in exempt mode", () => {
    const { calls, ctx } = setup({ rulesets: [protectMain()] });

    credentials.run(ctx);

    const posts = calls.filter((c) => {
      const a = api(c);
      return a?.method === "POST" && a.endpoint === `repos/${FAKE_REPO}/rulesets`;
    });
    expect(posts).toHaveLength(1);
    const body = JSON.parse(posts[0]!.input ?? "") as Record<string, unknown>;
    expect(body).toMatchObject({ name: "restrict-updates", target: "branch", enforcement: "active" });
    const conditions = body.conditions as { ref_name: { include: string[] } };
    expect(conditions.ref_name.include).toContain("~DEFAULT_BRANCH");
    expect(body.rules).toEqual([{ type: "update" }]);
    expect(body.bypass_actors).toEqual([{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "exempt" }]);
    const touchesOther = calls.filter((c) => {
      const a = api(c);
      return (
        a !== undefined &&
        a.method !== "GET" &&
        a.endpoint.startsWith(`repos/${FAKE_REPO}/rulesets/`) &&
        a.endpoint !== `repos/${FAKE_REPO}/rulesets/${restrictUpdates().id}`
      );
    });
    expect(touchesOther).toEqual([]);
  });

  it("a live session in claude agents stops the phase before any ruleset read", () => {
    const { calls, reports, ctx } = setup({
      sessions: [
        { name: "tools-12", state: "running", startedAt: 1 },
        { name: "tools-9", state: "done", startedAt: 1 },
      ],
    });

    const result = credentials.run(ctx);

    expect(result).toBe("stop");
    expect(calls.filter((c) => api(c)?.endpoint.startsWith(`repos/${FAKE_REPO}`))).toEqual([]);
    const todos = reports.filter((r) => r.status === "todo").map((r) => r.text);
    expect(todos.some((t) => t.includes("claude stop tools-12"))).toBe(true);
    expect(todos.some((t) => t.includes("tools-9"))).toBe(false);
  });

  it("the stray-token scan reports each token it finds without its value and runs no write command", () => {
    const values = ["ghp_ENVVALUE111", "ghp_ZSHRCVALUE222", "ghp_CREDVALUE333", "ghp_MCPVALUE444"];
    const { calls, reports, ctx } = setup({
      login: "fine-grained",
      confirm: false,
      env: { GH_TOKEN: values[0]! },
      files: {
        [`${HOME}/.zshrc`]: `alias ll='ls -l'\nexport GITHUB_TOKEN=${values[1]}\n`,
        [`${HOME}/.git-credentials`]: `https://example-owner:${values[2]}@github.com\n`,
        [`${HOME}/.claude.json`]: JSON.stringify({
          mcpServers: {
            github: {
              command: "npx",
              args: ["-y", "@modelcontextprotocol/server-github"],
              env: { GITHUB_PERSONAL_ACCESS_TOKEN: values[3] },
            },
          },
        }),
      },
      keychainHasGithub: true,
    });

    const result = credentials.run(ctx);

    expect(result).toBe("stop");
    expect(writeCalls(calls)).toEqual([]);
    const todos = reports.filter((r) => r.status === "todo").map((r) => r.text);
    expect(todos.some((t) => t.includes("GH_TOKEN"))).toBe(true);
    expect(todos.some((t) => t.includes(".zshrc") && t.includes("GITHUB_TOKEN"))).toBe(true);
    expect(todos.some((t) => t.includes(".git-credentials"))).toBe(true);
    expect(todos.some((t) => /keychain/i.test(t))).toBe(true);
    expect(todos.some((t) => t.includes(".claude.json"))).toBe(true);
    for (const report of reports) {
      for (const value of values) expect(report.text).not.toContain(value);
    }
    // The after-swap checks still run in the same pass.
    expect(calls.some((c) => api(c)?.method === "PUT" && /\/pulls\/\d+\/merge$/.test(api(c)!.endpoint))).toBe(true);
  });

  it("under the fine-grained login the ruleset step writes nothing and reports protect-main, enforcement, bypass as exempt and auto-merge as it could check them, with a note to check protect-main's bypass list in the browser", () => {
    const { calls, reports, ctx } = setup({
      login: "fine-grained",
      confirm: false,
      rulesets: [protectMain(), restrictUpdates()],
    });

    credentials.run(ctx);

    expect(settingWrites(calls)).toEqual([]);
    const passes = reports.filter((r) => r.status === "pass").map((r) => r.text);
    expect(passes.some((t) => /enforcement/i.test(t))).toBe(true);
    expect(passes.some((t) => /protect-main/i.test(t) && t.includes(FAKE_REPO))).toBe(true);
    expect(passes.some((t) => /bypass/i.test(t) && /exempt/i.test(t))).toBe(true);
    const notes = reports.filter((r) => r.status === "note").map((r) => r.text);
    expect(notes.some((t) => /protect-main/i.test(t) && /bypass/i.test(t) && /browser/i.test(t))).toBe(true);
    const autoMerge = reports.filter((r) => /auto-merge/i.test(r.text) && /unchecked/i.test(r.text));
    expect(autoMerge.length).toBeGreaterThan(0);
    for (const r of autoMerge) expect(["todo", "fail"]).not.toContain(r.status);
  });

  it("the phase tells a fine-grained login from a classic one when gh auth status --json gives the token only with --show-token", () => {
    const fine = setup({ login: "fine-grained", confirm: false, respond: realAuthStatus(STORED_FINE) });

    expect(credentials.run(fine.ctx)).toBe("ok");
    expect(fine.prompts.some((p) => p.kind === "confirm")).toBe(true);

    const classic = setup({ respond: realAuthStatus(STORED_CLASSIC) });
    credentials.run(classic.ctx);
    expect(classic.prompts.filter((p) => p.kind === "confirm")).toEqual([]);
    expect(classic.calls.some((c) => c.cmd === "open")).toBe(true);

    for (const calls of [fine.calls, classic.calls]) {
      const statuses = calls.filter((c) => isGh(c, "auth", "status"));
      expect(statuses.length).toBeGreaterThan(0);
      for (const c of statuses) expect(c.args).toContain("--show-token");
    }
  });

  it("with two stored accounts, the active one's token kind decides the path", () => {
    const twoAccounts = (c: FakeCall): RunResult | undefined => {
      if (!isGh(c, "auth", "status")) return undefined;
      const account = (login: string, active: boolean, token: string) => ({
        state: "success",
        active,
        host: "github.com",
        login,
        tokenSource: "keyring",
        gitProtocol: "ssh",
        ...(c.args.includes("--show-token") ? { token } : {}),
      });
      const hosts = {
        "github.com": [account("example-classic", false, STORED_CLASSIC), account(FAKE_LOGIN, true, STORED_FINE)],
      };
      return { status: 0, stdout: `${JSON.stringify({ hosts })}\n`, stderr: "" };
    };
    const { calls, prompts, ctx } = setup({
      rulesets: [protectMain(), restrictUpdates()],
      allowAutoMerge: false,
      confirm: false,
      respond: twoAccounts,
    });

    credentials.run(ctx);

    expect(prompts.some((p) => p.kind === "confirm" && /new token/i.test(p.text))).toBe(true);
    expect(calls.filter((c) => c.cmd === "open")).toEqual([]);
    expect(settingWrites(calls)).toEqual([]);
  });

  it("the stored token read with --show-token appears in no report, console line or thrown error, even when gh's output does not parse", () => {
    const normal = setup({ login: "fine-grained", confirm: false, respond: realAuthStatus(STORED_FINE) });
    credentials.run(normal.ctx);
    for (const r of normal.reports) expect(r.text).not.toContain(STORED_FINE);

    const broken = `{"hosts":{"github.com":[{"state":"success","active":true,"login":"${FAKE_LOGIN}","token":"${STORED_FINE}"`;
    const answers: RunResult[] = [
      { status: 1, stdout: `${STORED_FINE}\n`, stderr: "" },
      { status: 0, stdout: `${broken}\n`, stderr: "" },
      { status: 1, stdout: `${broken}\n`, stderr: "" },
    ];
    for (const answer of answers) {
      const log = vi.spyOn(console, "log").mockImplementation(() => {});
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      try {
        const { io, reports } = fakeIo({
          login: "fine-grained",
          confirm: false,
          respond: (c) => (isGh(c, "auth", "status") ? answer : undefined),
        });

        runSetup(["credentials"], { io, clone: CLONE, home: HOME, configPath: "/nonexistent/repos.json" });

        for (const r of reports) expect(r.text).not.toContain(STORED_FINE);
        for (const arg of [...log.mock.calls, ...error.mock.calls].flat()) {
          expect(String(arg)).not.toContain(STORED_FINE);
        }
      } finally {
        vi.restoreAllMocks();
      }
    }
  });
});

describe("credentials phase with gh reporting no hosts", () => {
  it("gh auth status with hosts null is the no-login to-do, not an error", () => {
    const { reports, ctx } = setup({
      respond: (c) => (isGh(c, "auth", "status") ? { status: 0, stdout: '{"hosts":null}\n', stderr: "" } : undefined),
    });

    let result: unknown;
    expect(() => {
      result = credentials.run(ctx);
    }).not.toThrow();

    expect(result).toBe("stop");
    expect(reports.some((r) => r.status === "todo" && r.text.includes("gh has no github.com login"))).toBe(true);
  });
});

const STORED_FINE = "github_pat_STORED_FOR_TESTS_ONLY";
const STORED_CLASSIC = "gho_STORED_FOR_TESTS_ONLY";

/**
 * `gh auth status --json hosts` as gh 2.102.0 prints it: the stored login, with its token only
 * when asked with --show-token. After `gh auth login`, the account holds the token logged in with.
 */
function realAuthStatus(stored: string) {
  let token = stored;
  return (c: FakeCall): RunResult | undefined => {
    if (isGh(c, "auth", "login")) {
      token = (c.input ?? "").trim();
      return undefined;
    }
    if (!isGh(c, "auth", "status")) return undefined;
    const account = {
      state: "success",
      active: true,
      host: "github.com",
      login: FAKE_LOGIN,
      tokenSource: "keyring",
      gitProtocol: "ssh",
      ...(c.args.includes("--show-token") ? { token } : {}),
    };
    return { status: 0, stdout: `${JSON.stringify({ hosts: { "github.com": [account] } })}\n`, stderr: "" };
  };
}
