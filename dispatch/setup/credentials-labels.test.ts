// The credentials phase's label step on the fake SetupIo (fake-io.ts): after each served repo's
// ruleset work, whatever its outcome, the phase runs the clone's setup-labels.sh for that repo.
// The script's own behaviour is tested in setup-labels.test.ts.
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { credentials } from "./credentials.ts";
import { FAKE_LOGIN, FAKE_REPO, fakeIo, parseGhApi, protectMain } from "./fake-io.ts";
import type { FakeCall, FakePrompt, FakeWorld } from "./fake-io.ts";
import type { RunResult } from "./io.ts";

const CLONE = "/clone";
const OTHER_REPO = "example-owner/example-app";
const SCRIPT = join(CLONE, "plugins/ticket-workflow/scripts/setup-labels.sh");

function run(world: FakeWorld, dryRun = false, repos: readonly string[] = [FAKE_REPO, OTHER_REPO]) {
  const fake = fakeIo(world);
  const result = credentials.run({
    io: fake.io,
    dryRun,
    clone: CLONE,
    home: "/home/example",
    repos: repos.map((repo) => ({ repo })),
  });
  return { ...fake, result };
}

const labelRuns = (calls: readonly FakeCall[]) =>
  calls.filter((c) => c.cmd.endsWith("setup-labels.sh")).map((c) => ({ cmd: c.cmd, args: [...c.args] }));

const tokenPrompts = (prompts: readonly FakePrompt[]) => prompts.filter((p) => p.kind === "confirm" || p.kind === "secret");

const isGh = (call: FakeCall, ...words: string[]) =>
  call.cmd === "gh" && words.every((w, i) => call.args[i] === w);

/**
 * The stored login's token is expired until `gh auth login` stores a new one: gh auth status
 * reports the account in error and every read fails with HTTP 401.
 */
function expiredWorld(): FakeWorld {
  let swapped = false;
  return {
    login: "fine-grained",
    respond(call): RunResult | undefined {
      if (call.cmd !== "gh" || swapped) return undefined;
      if (isGh(call, "auth", "login")) {
        swapped = true;
        return undefined;
      }
      if (isGh(call, "auth", "logout")) return undefined;
      if (isGh(call, "auth", "status")) {
        const account = {
          state: "error",
          error: "The token in keyring is invalid.",
          active: true,
          host: "github.com",
          login: FAKE_LOGIN,
          tokenSource: "keyring",
          gitProtocol: "ssh",
        };
        return { status: 0, stdout: `${JSON.stringify({ hosts: { "github.com": [account] } })}\n`, stderr: "" };
      }
      return parseGhApi(call)
        ? { status: 1, stdout: '{"message":"Bad credentials","status":"401"}', stderr: "gh: Bad credentials (HTTP 401)" }
        : { status: 1, stdout: "", stderr: "HTTP 401: Bad credentials (https://api.github.com/graphql)" };
    },
  };
}

const ADMIN_ALWAYS = { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" };

describe("credentials phase label step", () => {
  it("a live run under an admin login runs the clone's plugins/ticket-workflow/scripts/setup-labels.sh with the repo as its only argument, once for each served repo", () => {
    const { calls } = run({});

    expect(labelRuns(calls)).toEqual([
      { cmd: SCRIPT, args: [FAKE_REPO] },
      { cmd: SCRIPT, args: [OTHER_REPO] },
    ]);
  });

  it("a live run under the fine-grained login runs setup-labels.sh once for each served repo", () => {
    const { calls } = run({ login: "fine-grained" });

    expect(labelRuns(calls)).toEqual([
      { cmd: SCRIPT, args: [FAKE_REPO] },
      { cmd: SCRIPT, args: [OTHER_REPO] },
    ]);
  });

  it("a repo whose ruleset step is a to-do still gets its setup-labels.sh run", () => {
    const { result, reports, calls } = run({ rulesets: [protectMain({ bypass_actors: [ADMIN_ALWAYS] })] }, false, [FAKE_REPO]);

    expect(reports.some((r) => r.status === "todo" && r.text.includes(FAKE_REPO))).toBe(true);
    expect(labelRuns(calls)).toEqual([{ cmd: SCRIPT, args: [FAKE_REPO] }]);
    expect(result).toBe("stop");
  });

  it("a setup-labels.sh run that fails is a to-do naming the repo and quoting the script's answer, the next repo's run still happens, and the phase stops before the token form", () => {
    const refused = "setup-labels.sh: could not create label agent-ok (HTTP 403)";
    const { result, reports, calls, prompts } = run({
      respond: (c) =>
        c.cmd.endsWith("setup-labels.sh") && c.args[0] === FAKE_REPO
          ? { status: 1, stdout: "", stderr: `${refused}\nmore detail\n` }
          : undefined,
    });

    expect(reports.some((r) => r.status === "todo" && r.text.includes(FAKE_REPO) && r.text.includes(refused))).toBe(true);
    expect(labelRuns(calls)).toContainEqual({ cmd: SCRIPT, args: [OTHER_REPO] });
    expect(result).toBe("stop");
    expect(tokenPrompts(prompts)).toEqual([]);
  });

  it("with the stored token expired the phase makes no setup-labels.sh run", () => {
    const { calls, reports } = run(expiredWorld());

    expect(calls.some((c) => isGh(c, "auth", "login"))).toBe(true);
    expect(labelRuns(calls)).toEqual([]);
    for (const repo of [FAKE_REPO, OTHER_REPO]) {
      expect(
        reports.some((r) => r.status === "note" && r.text.includes(repo) && /labels/i.test(r.text)),
        `a skip note naming the labels for ${repo}`,
      ).toBe(true);
    }
  });

  it("under --dry-run each served repo gets a would line naming setup-labels.sh and the repo, and the script is not run", () => {
    const { reports, calls } = run({}, true);

    for (const repo of [FAKE_REPO, OTHER_REPO]) {
      expect(
        reports.some((r) => r.status === "would" && r.text.includes("setup-labels.sh") && r.text.includes(repo)),
        `a would line for ${repo}`,
      ).toBe(true);
    }
    expect(labelRuns(calls)).toEqual([]);
  });
});
