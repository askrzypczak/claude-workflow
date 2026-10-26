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

const ghLog = (): string[] => {
  try {
    return readFileSync(join(dir, "gh.log"), "utf8").split("\n").filter(Boolean);
  } catch {
    return [];
  }
};

const run = (...args: string[]) =>
  spawnSync("bash", [script, ...args], { cwd: epic, env, encoding: "utf8" });

const runStandard = () => run(EPIC, ISSUE, SLUG, PR);

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

describe("integrate-child.sh", () => {
  it("merges origin/issue-N-slug into epic-E as a two-parent merge commit with the standard message", () => {
    const childTip = git(child, "rev-parse", "HEAD");
    const r = runStandard();
    expect(r.status).toBe(0);
    expect(git(epic, "rev-parse", "--abbrev-ref", "HEAD")).toBe(EPIC_BRANCH);
    const parents = git(epic, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").slice(1);
    expect(parents).toHaveLength(2);
    expect(parents[1]).toBe(childTip);
    expect(git(epic, "log", "-1", "--format=%s")).toBe(
      `Merge PR #${PR} (${CHILD_BRANCH}) into ${EPIC_BRANCH}`,
    );
  });

  it("fetches origin first, so a child commit pushed after the epic clone is merged", () => {
    commitFile(child, "later.txt", "later\n", "later child commit");
    git(child, "push", "-q", "origin", CHILD_BRANCH);
    const lateTip = git(child, "rev-parse", "HEAD");
    const r = runStandard();
    expect(r.status).toBe(0);
    const parents = git(epic, "rev-list", "--parents", "-n", "1", "HEAD").split(" ").slice(1);
    expect(parents[1]).toBe(lateTip);
  });

  it("pushes epic-E so origin's epic-E matches the local merge commit", () => {
    const r = runStandard();
    expect(r.status).toBe(0);
    const local = git(epic, "rev-parse", "HEAD");
    expect(git(origin, "rev-parse", `refs/heads/${EPIC_BRANCH}`)).toBe(local);
    expect(git(origin, "rev-parse", "refs/heads/main")).not.toBe(local);
  });

  it("closes the child issue with a comment naming the PR and the merge commit", () => {
    const r = runStandard();
    expect(r.status).toBe(0);
    const merge = git(epic, "rev-parse", "HEAD");
    const closes = ghLog().filter((l) => l.startsWith("issue close"));
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

  it("on a conflict aborts the merge, lists the conflicting files, exits 1, pushes nothing and leaves the issue open", () => {
    commitFile(child, "shared.txt", "child side\n", "child edits shared");
    git(child, "push", "-q", "origin", CHILD_BRANCH);
    commitFile(epic, "shared.txt", "epic side\n", "epic edits shared");
    git(epic, "push", "-q", "origin", EPIC_BRANCH);
    const epicTip = git(epic, "rev-parse", "HEAD");
    const before = originRefs();

    const r = runStandard();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("shared.txt");
    expect(git(epic, "rev-parse", "HEAD")).toBe(epicTip);
    expect(git(epic, "status", "--porcelain")).toBe("");
    const mergeHead = spawnSync("git", ["rev-parse", "-q", "--verify", "MERGE_HEAD"], {
      cwd: epic,
      env,
    });
    expect(mergeHead.status).not.toBe(0);
    expect(originRefs()).toBe(before);
    expect(ghLog().some((l) => l.startsWith("issue close"))).toBe(false);
  });

  it("refuses with exit 2 unless HEAD is epic-E, so a run from main or master pushes nothing", () => {
    git(epic, "branch", "-q", "master", "origin/main");
    for (const branch of ["main", "master"]) {
      git(epic, "checkout", "-q", branch);
      const head = git(epic, "rev-parse", "HEAD");
      const before = originRefs();
      const r = runStandard();
      expect(r.status).toBe(2);
      expect(git(epic, "rev-parse", "HEAD")).toBe(head);
      expect(originRefs()).toBe(before);
    }
    expect(ghLog().some((l) => l.startsWith("issue close"))).toBe(false);
  });

  it("refuses with exit 2 when origin has no issue-N-slug branch, pushing nothing and leaving the issue open", () => {
    const head = git(epic, "rev-parse", "HEAD");
    const before = originRefs();
    const r = run(EPIC, ISSUE, "no-such-branch", PR);
    expect(r.status).toBe(2);
    expect(git(epic, "rev-parse", "HEAD")).toBe(head);
    expect(originRefs()).toBe(before);
    expect(ghLog().some((l) => l.startsWith("issue close"))).toBe(false);
  });

  it("rejects a wrong argument count, a non-numeric epic, issue or PR number, or a slug outside [a-z0-9-] with exit 2", () => {
    const before = originRefs();
    const head = git(epic, "rev-parse", "HEAD");
    const cases: string[][] = [
      [],
      [EPIC, ISSUE, SLUG],
      [EPIC, ISSUE, SLUG, PR, "extra"],
      ["x", ISSUE, SLUG, PR],
      ["0", ISSUE, SLUG, PR],
      [EPIC, "12a", SLUG, PR],
      [EPIC, "-12", SLUG, PR],
      [EPIC, ISSUE, SLUG, "pr"],
      [EPIC, ISSUE, "Add-Widget", PR],
      [EPIC, ISSUE, "add_widget", PR],
      [EPIC, ISSUE, "-add-widget", PR],
      [EPIC, ISSUE, "add widget", PR],
      [EPIC, ISSUE, "", PR],
    ];
    for (const args of cases) {
      const r = run(...args);
      expect(r.status, JSON.stringify(args)).toBe(2);
    }
    expect(git(epic, "rev-parse", "HEAD")).toBe(head);
    expect(originRefs()).toBe(before);
    expect(ghLog()).toEqual([]);
  });
});
