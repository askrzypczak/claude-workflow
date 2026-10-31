// The credentials phase's protect-main check on the fake SetupIo (fake-io.ts): a served repo's
// default branch must carry a pull_request rule this login cannot bypass before restrict-updates
// (exempt for the admin role) is created or reset there.
import { describe, expect, it } from "vitest";
import { credentials } from "./credentials.ts";
import {
  FAKE_REPO,
  FAKE_TOKEN,
  fakeIo,
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
    repos: [{ repo: FAKE_REPO }],
  });
  return { ...fake, result };
}

/** Ruleset POST or PUT and repo-setting PATCH calls on FAKE_REPO. */
const settingWrites = (calls: readonly FakeCall[]) =>
  calls.filter((c) => {
    const a = parseGhApi(c);
    return (
      a !== undefined &&
      ((["POST", "PUT"].includes(a.method) && a.endpoint.startsWith(`repos/${FAKE_REPO}/rulesets`)) ||
        (a.method === "PATCH" && a.endpoint === `repos/${FAKE_REPO}`))
    );
  });

/** Whether a to-do names the repo and protect-main. */
const protectMainTodo = (reports: readonly { status: string; text: string }[]) =>
  reports.some((r) => r.status === "todo" && r.text.includes(FAKE_REPO) && /protect-main/i.test(r.text));

const ADMIN_ALWAYS = { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" };
const ADMIN_PULL_REQUEST = { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "pull_request" };

describe("credentials phase protect-main check", () => {
  it("under an admin login a repo with no active pull_request ruleset on its default branch (none, or one not active) stops the phase with a protect-main to-do naming the repo, before that repo's restrict-updates or auto-merge write", () => {
    for (const rulesets of [[], [protectMain({ enforcement: "disabled" })]]) {
      const { result, reports, calls } = run({ rulesets, allowAutoMerge: true });

      expect(result).toBe("stop");
      expect(protectMainTodo(reports)).toBe(true);
      expect(settingWrites(calls)).toEqual([]);
    }
  });

  it("under an admin login a repo whose only pull_request ruleset on the default branch this login can bypass stops the phase before that repo's restrict-updates or auto-merge write", () => {
    const { result, reports, calls } = run({
      rulesets: [protectMain({ bypass_actors: [ADMIN_ALWAYS] })],
      allowAutoMerge: true,
    });

    expect(result).toBe("stop");
    expect(protectMainTodo(reports)).toBe(true);
    expect(settingWrites(calls)).toEqual([]);
  });

  it("a repo with one bypassable and one unbypassable pull_request ruleset on its default branch passes the protect-main check", () => {
    const { result, reports } = run({
      rulesets: [
        protectMain({ id: 102, name: "pr-review-admin", bypass_actors: [ADMIN_PULL_REQUEST] }),
        protectMain(),
        restrictUpdates(),
      ],
    });

    expect(reports.some((r) => r.status === "pass" && r.text.includes(FAKE_REPO) && /protect-main/i.test(r.text))).toBe(true);
    expect(protectMainTodo(reports)).toBe(false);
    expect(result).toBe("ok");
  });

  it("under the fine-grained login a repo without protect-main is a to-do naming the repo and the phase stops before the token question", () => {
    const { result, reports, prompts } = run({ login: "fine-grained", rulesets: [restrictUpdates()] });

    expect(result).toBe("stop");
    expect(protectMainTodo(reports)).toBe(true);
    expect(prompts.filter((p) => p.kind === "confirm" || p.kind === "secret")).toEqual([]);
  });

  it("under the fine-grained login a restrict-updates still in pull_request mode is a bypass to-do expecting exempt, and nothing is written", () => {
    const { result, reports, calls } = run({
      login: "fine-grained",
      rulesets: [protectMain(), restrictUpdates({ bypass_actors: [ADMIN_PULL_REQUEST] })],
    });

    expect(result).toBe("stop");
    expect(
      reports.some(
        (r) => r.status === "todo" && /restrict-updates/i.test(r.text) && /bypass/i.test(r.text) && /exempt/i.test(r.text),
      ),
    ).toBe(true);
    expect(settingWrites(calls)).toEqual([]);
  });

  it("under --dry-run a repo without protect-main is a to-do, the restrict-updates step is still listed as a would line, and no write command runs", () => {
    const { result, reports, calls } = run({ rulesets: [] }, true);

    expect(result).toBe("ok");
    expect(protectMainTodo(reports)).toBe(true);
    expect(reports.some((r) => r.status === "would" && /restrict-updates/i.test(r.text))).toBe(true);
    expect(writeCalls(calls)).toEqual([]);
  });

  it("under an admin login a protect-main whose bypass list holds a deploy key stops the phase before that repo's restrict-updates or auto-merge write", () => {
    const { result, reports, calls } = run({
      rulesets: [protectMain({ bypass_actors: [{ actor_id: null, actor_type: "DeployKey", bypass_mode: "always" }] })],
      allowAutoMerge: true,
    });

    expect(result).toBe("stop");
    expect(protectMainTodo(reports)).toBe(true);
    expect(settingWrites(calls)).toEqual([]);
  });

  it("the pre-swap test reads the default branch's rules with the new token", () => {
    const { calls } = run({});

    const reads = calls.filter((c) => {
      const a = parseGhApi(c);
      return a?.method === "GET" && a.endpoint === `repos/${FAKE_REPO}/rules/branches/main`;
    });
    expect(reads.some((c) => c.env.GH_TOKEN === FAKE_TOKEN)).toBe(true);
  });
});
