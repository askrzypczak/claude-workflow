// Where the credentials phase writes, where it stops, and where under --dry-run it goes on.
import { describe, expect, it } from "vitest";
import { credentials } from "./credentials.ts";
import {
  FAKE_REPO,
  fakeIo,
  parseGhApi,
  protectMain,
  restrictUpdates,
  writeCalls,
} from "./fake-io.ts";
import type { FakeCall, FakeWorld } from "./fake-io.ts";

const OTHER_REPO = "example-owner/example-other";

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

  it("under an admin login and on a token rotation, the phase sends no gh issue comment, issue edit, pr edit or pr comment and no gh api call on issues/comments or git/refs", () => {
    const admin = run({});
    const rotation = run({ login: "fine-grained", confirm: true });

    for (const { calls, prompts } of [admin, rotation]) {
      expect(prompts.some((p) => p.kind === "secret")).toBe(true);
      for (const words of [["issue", "comment"], ["issue", "edit"], ["pr", "edit"], ["pr", "comment"]]) {
        expect(calls.filter((c) => isGh(c, ...words)), `gh ${words.join(" ")}`).toEqual([]);
      }
      const touched = calls.filter((c) => {
        const endpoint = parseGhApi(c)?.endpoint ?? "";
        return endpoint.includes("/issues/comments") || endpoint.includes("/git/refs");
      });
      expect(touched.map((c) => c.args.join(" "))).toEqual([]);
    }
  });
});

describe("credentials phase stops", () => {
  it("a pasted token that does not start github_pat_ stops the phase before any logout or login", () => {
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

  it("under --dry-run with the fine-grained login, a repo the token cannot see is a to-do naming the repo and the run does not throw", () => {
    const world: FakeWorld = { login: "fine-grained", respond: repoNotFound };
    let outcome: ReturnType<typeof run> | undefined;

    expect(() => {
      outcome = run(world, true);
    }).not.toThrow();

    expect(outcome!.result).toBe("ok");
    expect(outcome!.reports.some((r) => r.status === "todo" && r.text.includes(FAKE_REPO))).toBe(true);
  });

  it("on a rerun with everything in place, every gh api call the phase makes is a GET", () => {
    const { result, calls } = run({ login: "fine-grained" }, false, [FAKE_REPO, OTHER_REPO]);

    expect(result).toBe("ok");
    const notGet = calls.filter((c) => {
      const a = parseGhApi(c);
      return a !== undefined && a.method !== "GET";
    });
    expect(notGet.map((c) => parseGhApi(c))).toEqual([]);
  });

  it("after the swap, a served repo the new token cannot see is a to-do naming the repo, not a thrown error, and the next repo is still read back", () => {
    let swapped = false;
    const world: FakeWorld = {
      respond(c) {
        if (isGh(c, "auth", "login")) {
          swapped = true;
          return undefined;
        }
        const a = parseGhApi(c);
        return swapped && a?.method === "GET" && a.endpoint === `repos/${FAKE_REPO}/rulesets`
          ? { status: 1, stdout: '{"message":"Not Found"}', stderr: "gh: Not Found (HTTP 404)" }
          : undefined;
      },
    };
    let outcome: ReturnType<typeof run> | undefined;

    expect(() => {
      outcome = run(world, false, [FAKE_REPO, OTHER_REPO]);
    }).not.toThrow();

    const { result, reports, calls } = outcome!;
    expect(result).toBe("stop");
    expect(
      reports.some(
        (r) =>
          r.status === "todo" &&
          r.text.includes(FAKE_REPO) &&
          r.text.includes("https://github.com/settings/personal-access-tokens"),
      ),
    ).toBe(true);
    const login = calls.findIndex((c) => isGh(c, "auth", "login"));
    expect(login).toBeGreaterThanOrEqual(0);
    expect(apiCalls(calls.slice(login + 1), "GET", `repos/${OTHER_REPO}/rulesets`).length).toBeGreaterThan(0);
  });
});
