import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("./integrate-child.sh", import.meta.url));

const EPIC = "7";
const ISSUE = "12";
const SLUG = "add-widget";
const PR = "34";
const EPIC_BRANCH = `epic-${EPIC}`;
const CHILD_BRANCH = `issue-${ISSUE}-${SLUG}`;

let dir: string;
let origin: string;
let child: string;
let epic: string;
let bin: string;
let env: NodeJS.ProcessEnv;

const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", args, { cwd, env, encoding: "utf8" }).trim();

const commitFile = (cwd: string, file: string, content: string, msg: string) => {
  writeFileSync(join(cwd, file), content);
  git(cwd, "add", file);
  git(cwd, "commit", "-q", "-m", msg);
};

const originRefs = () => git(origin, "for-each-ref", "--format=%(refname) %(objectname)");

const epicRefs = () => git(epic, "for-each-ref", "--format=%(refname) %(objectname)");

const ghLog = (): string[] => {
  try {
    return readFileSync(join(dir, "gh.log"), "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

const closeCalls = () => ghLog().filter((l) => l.startsWith("issue close"));

const run = (...args: string[]) =>
  spawnSync("bash", [script, ...args], { cwd: epic, env, encoding: "utf8" });

const runMerge = () => run("merge", EPIC, ISSUE, SLUG, PR);
const runClose = () => run("close", EPIC, ISSUE, SLUG, PR);

// Stands in for the orchestrator's own push of epic-E after a merge.
const pushEpic = () => git(epic, "push", "-q", "origin", EPIC_BRANCH);

const parentsOfHead = () =>
  git(epic, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").slice(1);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "integrate-child-"));
  origin = join(dir, "origin.git");
  child = join(dir, "child");
  epic = join(dir, "epic");
  bin = join(dir, "bin");
  const seed = join(dir, "seed");
  mkdirSync(bin);
  env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH ?? ""}`,
    GIT_AUTHOR_NAME: "Test",
    GIT_AUTHOR_EMAIL: "test@example.com",
    GIT_COMMITTER_NAME: "Test",
    GIT_COMMITTER_EMAIL: "test@example.com",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_NOSYSTEM: "1",
  };
  // Fake gh: logs its arguments, one call per line.
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env bash\necho "$*" >>"${join(dir, "gh.log")}"\n`,
  );
  chmodSync(join(bin, "gh"), 0o755);

  git(dir, "init", "-q", "--bare", "-b", "main", origin);
  git(dir, "init", "-q", "-b", "main", seed);
  commitFile(seed, "shared.txt", "base\n", "initial");
  git(seed, "remote", "add", "origin", origin);
  git(seed, "push", "-q", "origin", "main");
  git(seed, "push", "-q", "origin", `main:${EPIC_BRANCH}`);

  git(dir, "clone", "-q", origin, child);
  git(child, "checkout", "-q", "-b", CHILD_BRANCH, `origin/${EPIC_BRANCH}`);
  commitFile(child, "widget.txt", "widget\n", "add widget");
  git(child, "push", "-q", "origin", CHILD_BRANCH);

  git(dir, "clone", "-q", origin, epic);
  git(epic, "checkout", "-q", EPIC_BRANCH);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("integrate-child.sh merge", () => {
  it("merges origin/issue-N-slug into epic-E as a two-parent merge commit with the standard message", () => {
    const childTip = git(child, "rev-parse", "HEAD");
    const r = runMerge();
    expect(r.status).toBe(0);
    expect(git(epic, "rev-parse", "--abbrev-ref", "HEAD")).toBe(EPIC_BRANCH);
    const parents = parentsOfHead();
    expect(parents).toHaveLength(2);
    expect(parents[1]).toBe(childTip);
    expect(git(epic, "log", "-1", "--format=%s")).toBe(
      `Merge ${CHILD_BRANCH} into ${EPIC_BRANCH} (#${ISSUE}, PR #${PR})`,
    );
  });

  it("runs no fetch: a child commit pushed to origin after the last fetch is not merged", () => {
    const knownTip = git(child, "rev-parse", "HEAD");
    const trackingBefore = git(epic, "rev-parse", `refs/remotes/origin/${CHILD_BRANCH}`);
    commitFile(child, "later.txt", "later\n", "later child commit");
    git(child, "push", "-q", "origin", CHILD_BRANCH);
    const lateTip = git(child, "rev-parse", "HEAD");
    expect(lateTip).not.toBe(knownTip);

    const r = runMerge();
    expect(r.status).toBe(0);
    const parents = parentsOfHead();
    expect(parents).toHaveLength(2);
    expect(parents[1]).toBe(knownTip);
    expect(git(epic, "rev-parse", `refs/remotes/origin/${CHILD_BRANCH}`)).toBe(trackingBefore);
  });

  it("on a conflict aborts the merge, lists the conflicting files, exits 1 and leaves epic-E and the issue as they were", () => {
    commitFile(child, "shared.txt", "child side\n", "child edits shared");
    git(child, "push", "-q", "origin", CHILD_BRANCH);
    commitFile(epic, "shared.txt", "epic side\n", "epic edits shared");
    pushEpic();
    git(epic, "fetch", "-q", "origin");
    const epicTip = git(epic, "rev-parse", "HEAD");
    const refsBefore = epicRefs();

    const r = runMerge();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("shared.txt");
    expect(git(epic, "rev-parse", "--abbrev-ref", "HEAD")).toBe(EPIC_BRANCH);
    expect(git(epic, "rev-parse", "HEAD")).toBe(epicTip);
    expect(epicRefs()).toBe(refsBefore);
    expect(git(epic, "status", "--porcelain")).toBe("");
    const mergeHead = spawnSync("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], {
      cwd: epic,
      env,
    });
    expect(mergeHead.status).not.toBe(0);
    expect(closeCalls()).toEqual([]);
  });

  it("refuses with exit 2 when origin has no issue-N-slug branch, leaving epic-E and the issue as they were", () => {
    const head = git(epic, "rev-parse", "HEAD");
    const refsBefore = epicRefs();
    const r = run("merge", EPIC, ISSUE, "no-such-branch", PR);
    expect(r.status).toBe(2);
    expect(git(epic, "rev-parse", "--abbrev-ref", "HEAD")).toBe(EPIC_BRANCH);
    expect(git(epic, "rev-parse", "HEAD")).toBe(head);
    expect(epicRefs()).toBe(refsBefore);
    expect(git(epic, "status", "--porcelain")).toBe("");
    expect(closeCalls()).toEqual([]);
  });
});

describe("integrate-child.sh close", () => {
  it("after epic-E is pushed, closes the child issue with a comment naming the PR and the merge commit", () => {
    expect(runMerge().status).toBe(0);
    const merge = git(epic, "rev-parse", "HEAD");
    pushEpic();

    const r = runClose();
    expect(r.status).toBe(0);
    const closes = closeCalls();
    expect(closes).toHaveLength(1);
    const m = closes[0].match(
      new RegExp(
        `^issue close ${ISSUE} --comment Integrated into \`${EPIC_BRANCH}\` by PR #${PR} \\(merge ([0-9a-f]+)\\)\\.$`,
      ),
    );
    expect(m).not.toBeNull();
    const short = m![1];
    expect(short.length).toBeGreaterThanOrEqual(7);
    expect(merge.startsWith(short)).toBe(true);
  });

  it("before epic-E is pushed, refuses with exit 2 and leaves the issue open", () => {
    expect(runMerge().status).toBe(0);
    const r = runClose();
    expect(r.status).toBe(2);
    expect(closeCalls()).toEqual([]);
  });

  it("exits 3 when closing the issue fails", () => {
    expect(runMerge().status).toBe(0);
    pushEpic();
    writeFileSync(join(bin, "gh"), "#!/usr/bin/env bash\nexit 1\n");
    const r = runClose();
    expect(r.status).toBe(3);
  });
});

describe("integrate-child.sh merge and close", () => {
  it("neither merge nor close pushes: origin's refs are unchanged by either", () => {
    const beforeMerge = originRefs();
    expect(runMerge().status).toBe(0);
    expect(originRefs()).toBe(beforeMerge);

    pushEpic();
    const beforeClose = originRefs();
    expect(runClose().status).toBe(0);
    expect(originRefs()).toBe(beforeClose);
  });

  it("merge and close refuse with exit 2 unless HEAD is epic-E, changing no ref and closing nothing", () => {
    expect(runMerge().status).toBe(0);
    pushEpic();
    git(epic, "branch", "-q", "master", "origin/main");
    for (const branch of ["main", "master"]) {
      git(epic, "checkout", "-q", branch);
      for (const sub of ["merge", "close"]) {
        const head = git(epic, "rev-parse", "HEAD");
        const refsBefore = epicRefs();
        const originBefore = originRefs();
        const r = run(sub, EPIC, ISSUE, SLUG, PR);
        expect(r.status, `${sub} on ${branch}`).toBe(2);
        expect(git(epic, "rev-parse", "--abbrev-ref", "HEAD")).toBe(branch);
        expect(git(epic, "rev-parse", "HEAD")).toBe(head);
        expect(epicRefs()).toBe(refsBefore);
        expect(originRefs()).toBe(originBefore);
      }
    }
    expect(closeCalls()).toEqual([]);
  });

  it("rejects a missing or unknown subcommand, a wrong argument count, a non-numeric epic, issue or PR number, or a slug outside [a-z0-9-] with exit 2", () => {
    const before = originRefs();
    const head = git(epic, "rev-parse", "HEAD");
    const refsBefore = epicRefs();
    const cases: string[][] = [
      [],
      ["merge"],
      ["close"],
      ["integrate", EPIC, ISSUE, SLUG, PR],
      [EPIC, ISSUE, SLUG, PR],
    ];
    for (const sub of ["merge", "close"]) {
      cases.push(
        [sub, EPIC, ISSUE, SLUG],
        [sub, EPIC, ISSUE, SLUG, PR, "extra"],
        [sub, "x", ISSUE, SLUG, PR],
        [sub, "0", ISSUE, SLUG, PR],
        [sub, "12a", ISSUE, SLUG, PR],
        [sub, "-12", ISSUE, SLUG, PR],
        [sub, EPIC, "x", SLUG, PR],
        [sub, EPIC, "0", SLUG, PR],
        [sub, EPIC, "12a", SLUG, PR],
        [sub, EPIC, "-12", SLUG, PR],
        [sub, EPIC, ISSUE, SLUG, "pr"],
        [sub, EPIC, ISSUE, SLUG, "0"],
        [sub, EPIC, ISSUE, SLUG, "12a"],
        [sub, EPIC, ISSUE, SLUG, "-12"],
        [sub, EPIC, ISSUE, "Add-Widget", PR],
        [sub, EPIC, ISSUE, "add_widget", PR],
        [sub, EPIC, ISSUE, "-add-widget", PR],
        [sub, EPIC, ISSUE, "add widget", PR],
        [sub, EPIC, ISSUE, "", PR],
      );
    }
    for (const args of cases) {
      const r = run(...args);
      expect(r.status, JSON.stringify(args)).toBe(2);
    }
    expect(git(epic, "rev-parse", "--abbrev-ref", "HEAD")).toBe(EPIC_BRANCH);
    expect(git(epic, "rev-parse", "HEAD")).toBe(head);
    expect(epicRefs()).toBe(refsBefore);
    expect(originRefs()).toBe(before);
    expect(ghLog()).toEqual([]);
  });
});
