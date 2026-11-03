// The credentials phase's protect-main step on the fake SetupIo (fake-io.ts): a served repo's
// default branch must carry a pull_request rule this login cannot bypass before restrict-updates
// (exempt for the admin role) is created or reset there. Under an admin login a missing one is
// created; an existing one is never changed.
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
import type { FakeCall, FakePrompt, FakeWorld } from "./fake-io.ts";
import type { RunResult } from "./io.ts";

const OTHER_REPO = "example-owner/example-app";

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

/** Ruleset POST, PUT, PATCH or DELETE and repo-setting PATCH calls on `repo`. */
const settingWrites = (calls: readonly FakeCall[], repo = FAKE_REPO) =>
  calls.filter((c) => {
    const a = parseGhApi(c);
    return (
      a !== undefined &&
      ((["POST", "PUT", "PATCH", "DELETE"].includes(a.method) && a.endpoint.startsWith(`repos/${repo}/rulesets`)) ||
        (a.method === "PATCH" && a.endpoint === `repos/${repo}`))
    );
  });

/** The name in a call's JSON body, if any. */
const bodyName = (c: FakeCall): string | undefined => {
  try {
    return (JSON.parse(c.input ?? "") as { name?: string }).name;
  } catch {
    return undefined;
  }
};

/** Whether a call creates the ruleset `name` on `repo`. */
const isCreate = (c: FakeCall, repo: string, name: string) => {
  const a = parseGhApi(c);
  return a !== undefined && a.method === "POST" && a.endpoint === `repos/${repo}/rulesets` && bodyName(c) === name;
};

/** Whether a call reads the rules on one of `repo`'s branches. */
const isBranchRead = (c: FakeCall, repo: string) => {
  const a = parseGhApi(c);
  return a !== undefined && a.method === "GET" && a.endpoint.startsWith(`repos/${repo}/rules/branches/`);
};

/** Whether a call turns a repo setting (auto-merge) on or off for `repo`. */
const isRepoPatch = (c: FakeCall, repo: string) => {
  const a = parseGhApi(c);
  return a !== undefined && a.method === "PATCH" && a.endpoint === `repos/${repo}`;
};

type Reports = readonly { status: string; text: string }[];

/** Whether a to-do names the repo and protect-main. */
const protectMainTodo = (reports: Reports, repo = FAKE_REPO) =>
  reports.some((r) => r.status === "todo" && r.text.includes(repo) && /protect-main/i.test(r.text));

const protectMainPass = (reports: Reports, repo = FAKE_REPO) =>
  reports.some((r) => r.status === "pass" && r.text.includes(repo) && /protect-main/i.test(r.text));

const tokenPrompts = (prompts: readonly FakePrompt[]) => prompts.filter((p) => p.kind === "confirm" || p.kind === "secret");

const requiredChecksNote = (text: string) => /status checks/i.test(text) && /\bCI\b/.test(text);

const json = (value: unknown): RunResult => ({ status: 0, stdout: `${JSON.stringify(value)}\n`, stderr: "" });

const REFUSED: RunResult = {
  status: 1,
  stdout: '{"message":"Validation Failed","errors":["Name must be unique"],"status":"422"}',
  stderr: "gh: Validation Failed (HTTP 422)",
};

const ADMIN_ALWAYS = { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" };
const ADMIN_PULL_REQUEST = { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "pull_request" };

describe("credentials phase protect-main step", () => {
  it("under an admin login a repo with no pull_request rule on its default branch gets protect-main created with deletion, non_fast_forward and a zero-approval pull_request rule on ~DEFAULT_BRANCH, active, with no bypass actors and no required_status_checks rule", () => {
    const { reports, calls } = run({ rulesets: [] });

    const creates = calls.filter((c) => isCreate(c, FAKE_REPO, "protect-main"));
    expect(creates).toHaveLength(1);
    const body = JSON.parse(creates[0]!.input!) as {
      target: string;
      enforcement: string;
      conditions: { ref_name: { include: string[]; exclude: string[] } };
      rules: { type: string; parameters?: Record<string, unknown> }[];
      bypass_actors: unknown[];
    };
    expect(body.target).toBe("branch");
    expect(body.enforcement).toBe("active");
    expect(body.conditions.ref_name.include).toEqual(["~DEFAULT_BRANCH"]);
    expect(body.conditions.ref_name.exclude).toEqual([]);
    expect(body.bypass_actors).toEqual([]);
    expect(body.rules.map((r) => r.type).sort()).toEqual(["deletion", "non_fast_forward", "pull_request"]);
    expect(body.rules.some((r) => r.type === "required_status_checks")).toBe(false);
    const pr = body.rules.find((r) => r.type === "pull_request")!;
    expect(pr.parameters?.required_approving_review_count).toBe(0);
    expect(reports.some((r) => r.status === "done" && r.text.includes(FAKE_REPO) && /protect-main/i.test(r.text))).toBe(true);
  });

  it("after creating protect-main the phase prints a note on adding required checks once the repo has CI", () => {
    const { reports, calls } = run({ rulesets: [] });

    expect(calls.some((c) => isCreate(c, FAKE_REPO, "protect-main"))).toBe(true);
    expect(reports.some((r) => r.status === "note" && requiredChecksNote(r.text))).toBe(true);
  });

  it("after creating protect-main the phase runs the protect-main check again and it passes", () => {
    const { reports, calls } = run({ rulesets: [] });

    const created = calls.findIndex((c) => isCreate(c, FAKE_REPO, "protect-main"));
    expect(created).toBeGreaterThanOrEqual(0);
    expect(calls.slice(created + 1).some((c) => isBranchRead(c, FAKE_REPO))).toBe(true);
    expect(protectMainPass(reports)).toBe(true);
    expect(protectMainTodo(reports)).toBe(false);
  });

  it("under an admin login restrict-updates is created only after the protect-main check run again after the create has passed", () => {
    const { result, reports, calls } = run({ rulesets: [] });

    const created = calls.findIndex((c) => isCreate(c, FAKE_REPO, "protect-main"));
    const reread = calls.findIndex((c, i) => i > created && isBranchRead(c, FAKE_REPO));
    const restrict = calls.findIndex((c) => isCreate(c, FAKE_REPO, "restrict-updates"));
    expect(created).toBeGreaterThanOrEqual(0);
    expect(reread).toBeGreaterThan(created);
    expect(restrict).toBeGreaterThan(reread);
    expect(protectMainPass(reports)).toBe(true);
    expect(result).toBe("ok");
  });

  it("when the protect-main check run again after the create does not pass, restrict-updates is not created and the phase stops before the token form", () => {
    const { result, reports, calls, prompts } = run({
      rulesets: [],
      allowAutoMerge: true,
      respond: (c) => (isBranchRead(c, FAKE_REPO) ? json([]) : undefined),
    });

    expect(calls.some((c) => isCreate(c, FAKE_REPO, "protect-main"))).toBe(true);
    expect(calls.filter((c) => isBranchRead(c, FAKE_REPO)).length).toBeGreaterThanOrEqual(2);
    expect(calls.some((c) => isCreate(c, FAKE_REPO, "restrict-updates"))).toBe(false);
    expect(calls.some((c) => isRepoPatch(c, FAKE_REPO))).toBe(false);
    expect(protectMainTodo(reports)).toBe(true);
    expect(result).toBe("stop");
    expect(tokenPrompts(prompts)).toEqual([]);
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

  it("under an admin login a protect-main whose bypass list holds a deploy key stops the phase before that repo's restrict-updates or auto-merge write", () => {
    const { result, reports, calls } = run({
      rulesets: [protectMain({ bypass_actors: [{ actor_id: null, actor_type: "DeployKey", bypass_mode: "always" }] })],
      allowAutoMerge: true,
    });

    expect(result).toBe("stop");
    expect(protectMainTodo(reports)).toBe(true);
    expect(settingWrites(calls)).toEqual([]);
  });

  it("under a login without admin rights (the fine-grained login, and a classic login without the admin role) a missing protect-main is a to-do naming the browser and gh auth login with an admin login, and no ruleset or repo-setting write runs", () => {
    const classicWithoutAdmin: FakeWorld = {
      respond: (c) => {
        const a = parseGhApi(c);
        if (a?.method !== "GET" || a.endpoint !== `repos/${FAKE_REPO}`) return undefined;
        return json({
          full_name: FAKE_REPO,
          default_branch: "main",
          permissions: { admin: false, maintain: true, push: true, triage: true, pull: true },
          allow_auto_merge: true,
        });
      },
    };
    const fineGrained: FakeWorld = { login: "fine-grained" };
    for (const world of [fineGrained, classicWithoutAdmin]) {
      const { result, reports, calls } = run({ ...world, rulesets: [restrictUpdates()], allowAutoMerge: true });

      expect(result).toBe("stop");
      const todo = reports.find((r) => r.status === "todo" && r.text.includes(FAKE_REPO) && /protect-main/i.test(r.text));
      expect(todo, "a protect-main to-do").toBeDefined();
      expect(todo!.text).toMatch(/browser|Settings > Rules/i);
      expect(todo!.text).toContain("gh auth login");
      expect(todo!.text).toMatch(/admin/i);
      expect(settingWrites(calls)).toEqual([]);
    }
  });

  it("under the fine-grained login a repo without protect-main is a to-do naming the repo and the phase stops before the token question", () => {
    const { result, reports, prompts } = run({ login: "fine-grained", rulesets: [restrictUpdates()] });

    expect(result).toBe("stop");
    expect(protectMainTodo(reports)).toBe(true);
    expect(tokenPrompts(prompts)).toEqual([]);
  });

  it("under an admin login GitHub refusing the protect-main create is a to-do naming the repo and quoting GitHub's answer, restrict-updates is not created, and the phase stops before the token form", () => {
    const { result, reports, calls, prompts } = run({
      rulesets: [],
      respond: (c) => (isCreate(c, FAKE_REPO, "protect-main") ? REFUSED : undefined),
    });

    expect(calls.some((c) => isCreate(c, FAKE_REPO, "protect-main"))).toBe(true);
    expect(
      reports.some((r) => r.status === "todo" && r.text.includes(FAKE_REPO) && r.text.includes("Validation Failed (HTTP 422)")),
    ).toBe(true);
    expect(calls.some((c) => isCreate(c, FAKE_REPO, "restrict-updates"))).toBe(false);
    expect(result).toBe("stop");
    expect(tokenPrompts(prompts)).toEqual([]);
  });

  it("a refused protect-main create on one served repo still goes on to create the next repo's protect-main, and the phase stops at the step's end", () => {
    const { result, reports, calls, prompts } = run(
      { rulesets: [], respond: (c) => (isCreate(c, FAKE_REPO, "protect-main") ? REFUSED : undefined) },
      false,
      [FAKE_REPO, OTHER_REPO],
    );

    expect(reports.some((r) => r.status === "todo" && r.text.includes(FAKE_REPO) && r.text.includes("HTTP 422"))).toBe(true);
    expect(calls.some((c) => isCreate(c, FAKE_REPO, "restrict-updates"))).toBe(false);
    expect(calls.some((c) => isCreate(c, OTHER_REPO, "protect-main"))).toBe(true);
    expect(result).toBe("stop");
    expect(tokenPrompts(prompts)).toEqual([]);
  });

  it("a refused restrict-updates create on one served repo still goes on to the next repo's ruleset step, and the phase stops at the step's end", () => {
    const { result, reports, calls, prompts } = run(
      { rulesets: [protectMain()], respond: (c) => (isCreate(c, FAKE_REPO, "restrict-updates") ? REFUSED : undefined) },
      false,
      [FAKE_REPO, OTHER_REPO],
    );

    expect(reports.some((r) => r.status === "todo" && r.text.includes(FAKE_REPO) && /restrict-updates/i.test(r.text))).toBe(true);
    expect(calls.some((c) => isBranchRead(c, OTHER_REPO))).toBe(true);
    expect(calls.some((c) => isCreate(c, OTHER_REPO, "restrict-updates"))).toBe(true);
    expect(result).toBe("stop");
    expect(tokenPrompts(prompts)).toEqual([]);
  });

  it("a refused auto-merge change on one served repo still goes on to the next repo's ruleset step, and the phase stops at the step's end", () => {
    const { result, reports, calls, prompts } = run(
      {
        rulesets: [protectMain(), restrictUpdates()],
        allowAutoMerge: true,
        respond: (c) => (isRepoPatch(c, FAKE_REPO) ? REFUSED : undefined),
      },
      false,
      [FAKE_REPO, OTHER_REPO],
    );

    expect(reports.some((r) => r.status === "todo" && r.text.includes(FAKE_REPO) && /auto-merge/i.test(r.text))).toBe(true);
    expect(calls.some((c) => isRepoPatch(c, OTHER_REPO))).toBe(true);
    expect(result).toBe("stop");
    expect(tokenPrompts(prompts)).toEqual([]);
  });

  it("under --dry-run under an admin login a repo without protect-main gets a would line for its create and the required-checks note, then the restrict-updates would line, and no write command runs", () => {
    const { result, reports, calls } = run({ rulesets: [] }, true);

    const create = reports.findIndex((r) => r.status === "would" && r.text.includes(FAKE_REPO) && /protect-main/i.test(r.text));
    const restrict = reports.findIndex((r) => r.status === "would" && r.text.includes(FAKE_REPO) && /restrict-updates/i.test(r.text));
    expect(create).toBeGreaterThanOrEqual(0);
    expect(reports.some((r) => requiredChecksNote(r.text))).toBe(true);
    expect(restrict).toBeGreaterThan(create);
    expect(protectMainTodo(reports)).toBe(false);
    expect(writeCalls(calls)).toEqual([]);
    expect(result).toBe("ok");
  });

  it("under --dry-run under an admin login a bypassable protect-main is a to-do and that repo gets no restrict-updates or auto-merge would line", () => {
    const { result, reports, calls } = run(
      { rulesets: [protectMain({ bypass_actors: [ADMIN_ALWAYS] })], allowAutoMerge: true },
      true,
    );

    expect(protectMainTodo(reports)).toBe(true);
    expect(
      reports.some(
        (r) => r.status === "would" && r.text.includes(FAKE_REPO) && (/restrict-updates/i.test(r.text) || /auto-merge/i.test(r.text)),
      ),
    ).toBe(false);
    expect(writeCalls(calls)).toEqual([]);
    expect(result).toBe("ok");
  });

  it("a repo with one bypassable and one unbypassable pull_request ruleset on its default branch passes the protect-main check", () => {
    const { result, reports } = run({
      rulesets: [
        protectMain({ id: 102, name: "pr-review-admin", bypass_actors: [ADMIN_PULL_REQUEST] }),
        protectMain(),
        restrictUpdates(),
      ],
    });

    expect(protectMainPass(reports)).toBe(true);
    expect(protectMainTodo(reports)).toBe(false);
    expect(result).toBe("ok");
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
});
