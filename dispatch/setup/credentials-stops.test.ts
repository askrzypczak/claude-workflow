// Where the credentials phase writes, where it stops, and where under --dry-run it goes on.
import { describe, expect, it } from "vitest";
import { credentials } from "./credentials.ts";
import {
  FAKE_REPO,
  FAKE_TOKEN,
  fakeIo,
  isMergeProbe,
  parseGhApi,
  protectMain,
  restrictUpdates,
  writeCalls,
} from "./fake-io.ts";
import type { FakeCall, FakeWorld } from "./fake-io.ts";

const OTHER_REPO = "example-owner/example-other";
const PROBE_REF = "refs/claude-workflow-probe/cannot-merge";
const ZERO_SHA = "0".repeat(40);

function run(world: FakeWorld, dryRun = false, repos: readonly string[] = [FAKE_REPO]) {
  const fake = fakeIo(world);
  const result = credentials.run({
    io: fake.io,
    dryRun,
    clone: "/clone",
    home: "/home/example",
    repos: repos.map((repo) => ({ repo })),
  });
  return { ...fake, result };
}

const isGh = (call: FakeCall, ...words: string[]) =>
  call.cmd === "gh" && words.every((w, i) => call.args[i] === w);

/** The repo read answered with 404, as GitHub answers a token without access to the repo. */
const repoNotFound = (c: FakeCall) => {
  const a = parseGhApi(c);
  return a?.method === "GET" && a.endpoint === `repos/${FAKE_REPO}`
    ? { status: 1, stdout: '{"message":"Not Found"}', stderr: "gh: Not Found (HTTP 404)" }
    : undefined;
};

/** `gh api` calls with this method on exactly this endpoint. */
const apiCalls = (calls: readonly FakeCall[], method: string, endpoint: string) =>
  calls.filter((c) => {
    const a = parseGhApi(c);
    return a?.method === method && a.endpoint === endpoint;
  });

describe("credentials phase writes", () => {
  it("pauses dispatch when the poller is running", () => {
    const { calls } = run({ dispatch: "running" });

    expect(calls.some((c) => c.cmd.endsWith("install-launchd.sh") && c.args[0] === "pause")).toBe(true);
  });

  it("turns auto-merge off with one PATCH of allow_auto_merge=false", () => {
    const { calls } = run({ allowAutoMerge: true });

    const patches = apiCalls(calls, "PATCH", `repos/${FAKE_REPO}`);
    expect(patches).toHaveLength(1);
    expect(patches[0]!.args).toContain("allow_auto_merge=false");
  });

  it("puts a drifted restrict-updates back with the body a missing one is created with", () => {
    const created = run({ rulesets: [protectMain()] }).calls;
    const [post] = apiCalls(created, "POST", `repos/${FAKE_REPO}/rulesets`);

    const { calls } = run({ rulesets: [protectMain(), restrictUpdates({ enforcement: "evaluate" })] });

    const puts = apiCalls(calls, "PUT", `repos/${FAKE_REPO}/rulesets/${restrictUpdates().id}`);
    expect(puts).toHaveLength(1);
    expect(JSON.parse(puts[0]!.input ?? "")).toEqual(JSON.parse(post!.input ?? ""));
  });

  it("under an admin login a restrict-updates still in pull_request mode is reset to exempt with one PUT", () => {
    const { calls } = run({
      rulesets: [
        protectMain(),
        restrictUpdates({ bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "pull_request" }] }),
      ],
    });

    const puts = apiCalls(calls, "PUT", `repos/${FAKE_REPO}/rulesets/${restrictUpdates().id}`);
    expect(puts).toHaveLength(1);
    const body = JSON.parse(puts[0]!.input ?? "") as Record<string, unknown>;
    expect(body.bypass_actors).toEqual([{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "exempt" }]);
  });

  it("deletes the pre-swap test comment by the id gh printed, as the new token", () => {
    const { calls } = run({
      respond: (c) =>
        isGh(c, "issue", "comment")
          ? { status: 0, stdout: `https://github.com/${FAKE_REPO}/issues/12#issuecomment-4242\n`, stderr: "" }
          : undefined,
    });

    const deletes = apiCalls(calls, "DELETE", `repos/${FAKE_REPO}/issues/comments/4242`);
    expect(deletes.some((c) => c.env.GH_TOKEN === FAKE_TOKEN)).toBe(true);
  });
});

describe("credentials phase stops", () => {
  it("a pasted token that is not fine-grained stops the phase before the pre-swap test and the swap", () => {
    const { result, calls } = run({ secret: "ghp_classic_example" });

    expect(result).toBe("stop");
    expect(calls.filter((c) => isGh(c, "auth", "login") || isGh(c, "auth", "logout"))).toEqual([]);
    expect(calls.filter((c) => c.env.GH_TOKEN !== undefined)).toEqual([]);
  });

  it("under the fine-grained login a missing restrict-updates is a to-do and stops before the token question", () => {
    const { result, reports, prompts } = run({ login: "fine-grained", rulesets: [protectMain()] });

    expect(result).toBe("stop");
    expect(reports.some((r) => r.status === "todo" && r.text.includes("restrict-updates"))).toBe(true);
    expect(prompts.filter((p) => p.kind === "confirm")).toEqual([]);
  });

  it("a missing pre-swap test subject stops the phase before the token form opens", () => {
    const { result, reports, calls, prompts } = run({
      respond: (c) => (isGh(c, "pr", "list") ? { status: 0, stdout: "[]\n", stderr: "" } : undefined),
    });

    expect(result).toBe("stop");
    expect(reports.some((r) => r.status === "todo")).toBe(true);
    expect(calls.some((c) => c.cmd === "open")).toBe(false);
    expect(prompts).toEqual([]);
  });

  it("under the fine-grained login a repo the token cannot see is a to-do naming the repo", () => {
    const { result, reports, prompts } = run({ login: "fine-grained", respond: repoNotFound });

    expect(result).toBe("stop");
    expect(reports.some((r) => r.status === "todo" && r.text.includes(FAKE_REPO))).toBe(true);
    expect(prompts).toEqual([]);
  });

  it("under a classic login a repo read that fails still throws", () => {
    expect(() => run({ respond: repoNotFound })).toThrow(Error);
  });

  it("a short paste at the token prompt is not masked in the lines that follow", () => {
    const empty = run({ secret: "" });
    const short = run({ secret: "e" });

    expect(short.result).toBe("stop");
    expect(short.reports).toEqual(empty.reports);
  });

  it("GitHub refusing the ruleset stops the phase with GitHub's answer, before the token form", () => {
    const { result, reports, prompts, calls } = run({
      rulesets: [protectMain()],
      respond: (c) =>
        parseGhApi(c)?.method === "POST"
          ? { status: 1, stdout: '{"message":"Validation Failed"}', stderr: "gh: Validation Failed (HTTP 422)" }
          : undefined,
    });

    expect(result).toBe("stop");
    expect(reports.some((r) => r.status === "todo" && r.text.includes("Validation Failed"))).toBe(true);
    expect(prompts).toEqual([]);
    expect(calls.some((c) => c.cmd === "open")).toBe(false);
  });

  it("under --dry-run a live session is a to-do and every later step is still listed", () => {
    const { result, reports, calls } = run({ sessions: [{ name: "tools-3", state: "running", startedAt: 1 }] }, true);

    expect(result).toBe("ok");
    expect(reports.some((r) => r.status === "todo" && r.text.includes("claude stop tools-3"))).toBe(true);
    expect(reports.some((r) => r.status === "would" && /after-swap/i.test(r.text))).toBe(true);
    expect(writeCalls(calls)).toEqual([]);
  });

  it("under --dry-run with the fine-grained login, a repo the token cannot see is skipped by the subject pick and the run does not throw", () => {
    const world: FakeWorld = {
      login: "fine-grained",
      respond: (c) =>
        repoNotFound(c) ??
        (isGh(c, "pr", "list") && c.args.includes(FAKE_REPO)
          ? { status: 1, stdout: "", stderr: `GraphQL: Could not resolve to a Repository with the name '${FAKE_REPO}'. (repository)` }
          : undefined),
    };
    let outcome: ReturnType<typeof run> | undefined;

    expect(() => {
      outcome = run(world, true);
    }).not.toThrow();

    expect(outcome!.result).toBe("ok");
    expect(outcome!.reports.some((r) => r.status === "todo" && r.text.includes(FAKE_REPO))).toBe(true);
    expect(outcome!.calls.filter((c) => isGh(c, "pr", "list"))).toEqual([]);
  });
});

/** The endpoint of every merge probe sent, in order. */
const probedEndpoints = (calls: readonly FakeCall[]) => calls.filter(isMergeProbe).map((c) => parseGhApi(c)!.endpoint);
const refsOf = (repo: string) => `repos/${repo}/git/refs`;
const failedWith = (stderr: string) => ({ status: 1, stdout: "", stderr });

describe("credentials phase merge probe", () => {
  it("the merge probe runs on every served repo as the login's token, and 403 on each passes", () => {
    const { result, calls, reports } = run({ login: "fine-grained" }, false, [FAKE_REPO, OTHER_REPO]);

    expect(result).toBe("ok");
    expect(probedEndpoints(calls)).toEqual([refsOf(FAKE_REPO), refsOf(OTHER_REPO)]);
    expect(calls.filter(isMergeProbe).every((c) => c.env.GH_TOKEN === undefined)).toBe(true);
    expect(reports.filter((r) => r.status === "todo")).toEqual([]);
  });

  it("a merge probe answered with 422 on one served repo stops the phase with a to-do that says the token can merge", () => {
    const { result, calls, reports } = run(
      {
        login: "fine-grained",
        respond: (c) =>
          isMergeProbe(c) && parseGhApi(c)!.endpoint === refsOf(OTHER_REPO)
            ? failedWith("gh: Object does not exist (HTTP 422)")
            : undefined,
      },
      false,
      [FAKE_REPO, OTHER_REPO],
    );

    expect(result).toBe("stop");
    expect(probedEndpoints(calls)).toEqual([refsOf(FAKE_REPO), refsOf(OTHER_REPO)]);
    expect(reports.some((r) => r.status === "todo" && /can merge/i.test(r.text))).toBe(true);
  });

  it("a merge probe that succeeds stops the phase with a to-do that says the token can merge", () => {
    const { result, reports } = run({
      login: "fine-grained",
      respond: (c) => (isMergeProbe(c) ? { status: 0, stdout: "{}", stderr: "" } : undefined),
    });

    expect(result).toBe("stop");
    expect(reports.some((r) => r.status === "todo" && /can merge/i.test(r.text))).toBe(true);
  });

  it("a merge probe answered with any other error stops the phase as inconclusive", () => {
    const { result, reports } = run({
      login: "fine-grained",
      respond: (c) => (isMergeProbe(c) ? failedWith("gh: Not Found (HTTP 404)") : undefined),
    });

    expect(result).toBe("stop");
    const todos = reports.filter((r) => r.status === "todo");
    expect(todos.some((r) => /inconclusive/i.test(r.text))).toBe(true);
    expect(todos.some((r) => /can merge/i.test(r.text))).toBe(false);
  });

  it("on a rerun with everything in place, the merge probe for refs/claude-workflow-probe/cannot-merge at the all-zero sha is the only gh api call that is not a GET", () => {
    const { result, calls } = run({ login: "fine-grained" }, false, [FAKE_REPO, OTHER_REPO]);

    expect(result).toBe("ok");
    const notGet = calls.filter((c) => {
      const a = parseGhApi(c);
      return a !== undefined && a.method !== "GET";
    });
    expect(notGet.map((c) => parseGhApi(c))).toEqual([
      { method: "POST", endpoint: refsOf(FAKE_REPO) },
      { method: "POST", endpoint: refsOf(OTHER_REPO) },
    ]);
    for (const c of notGet) {
      expect(c.args).toContain(`ref=${PROBE_REF}`);
      expect(c.args).toContain(`sha=${ZERO_SHA}`);
    }
  });
});
