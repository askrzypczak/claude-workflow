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

function run(world: FakeWorld, dryRun = false) {
  const fake = fakeIo(world);
  const result = credentials.run({
    io: fake.io,
    dryRun,
    clone: "/clone",
    home: "/home/example",
    repos: [{ repo: FAKE_REPO, dir: "/clone" }],
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

  it("open PRs whose mergeability GitHub is still computing make the merge probe a to-do to rerun, not to open a PR", () => {
    const { result, reports, calls } = run({
      login: "fine-grained",
      respond: (c) =>
        isGh(c, "pr", "list")
          ? { status: 0, stdout: JSON.stringify([{ number: 7, mergeable: "UNKNOWN" }]), stderr: "" }
          : undefined,
    });

    expect(result).toBe("stop");
    expect(calls.filter(isMergeProbe)).toEqual([]);
    expect(reports.some((r) => r.status === "todo" && r.text.includes("UNKNOWN"))).toBe(true);
  });

  it("a short paste at the token prompt is not masked in the lines that follow", () => {
    const empty = run({ secret: "" });
    const short = run({ secret: "e" });

    expect(short.result).toBe("stop");
    expect(short.reports).toEqual(empty.reports);
  });

  it("an inconclusive wrong-sha merge stops the phase", () => {
    const { result } = run({
      login: "fine-grained",
      respond: (c) =>
        isMergeProbe(c) ? { status: 1, stdout: "", stderr: "gh: Pull Request is not mergeable (HTTP 405)" } : undefined,
    });

    expect(result).toBe("stop");
  });

  it("a wrong-sha merge answered with 409 stops the phase with a to-do", () => {
    const { result, reports } = run({
      login: "fine-grained",
      respond: (c) =>
        isMergeProbe(c) ? { status: 1, stdout: "", stderr: "gh: Head branch was modified. (HTTP 409)" } : undefined,
    });

    expect(result).toBe("stop");
    expect(reports.some((r) => r.status === "todo")).toBe(true);
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
});
