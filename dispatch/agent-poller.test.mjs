// Tests for dispatch/agent-poller.sh. Run: node --test dispatch/
// Fake `gh` and `claude` binaries are put on PATH; per-repo fake data lives in <dir>/r/<owner>_<name>/.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

const SCRIPT = join(import.meta.dirname, "agent-poller.sh");
const APP = {
  repo: "example-owner/example-app",
  sessionPrefix: "app",
  owner: "example-owner",
};

let dir;

const slug = (repo) => repo.replaceAll("/", "_");
const rdir = (repo) => join(dir, "r", slug(repo));
const state = (prefix) => join(dir, "state", "repos", prefix);
const readLines = (f) =>
  readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean);
const readJson = (f) => JSON.parse(readFileSync(f, "utf8"));

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "poller-"));
  const bin = join(dir, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "claude"),
    `#!/usr/bin/env bash
if [ "$1" = "--bg" ]; then echo "$*" >>"${dir}/claude.log"; echo "$(pwd -P)|$*" >>"${dir}/claude.cwd.log"; else cat "${dir}/sessions.json"; fi
`,
  );
  // Data is keyed off --repo (or the repos/<repo>/... path of `gh api`).
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env bash
echo "$*" >>"${dir}/gh.log"
repo=""
if [ "$1" = "api" ]; then repo=$(echo "$2" | sed -E 's#^repos/([^/]+/[^/]+)/.*#\\1#')
else prev=""; for a in "$@"; do [ "$prev" = "--repo" ] && repo="$a"; prev="$a"; done; fi
rd="${dir}/r/\${repo//\\//_}"
[ -f "$rd/fail-all" ] && exit 1
if [ "$1 $2" = "issue view" ]; then if [ -f "$rd/fail-issue-$3" ]; then exit 1; fi; cat "$rd/issue.json"
elif [ "$1 $2" = "issue list" ]; then if [ -f "$rd/issues.json" ]; then cat "$rd/issues.json"; else echo '[]'; fi
elif [ "$1 $2" = "pr list" ]; then if [ -f "$rd/prs.json" ]; then cat "$rd/prs.json"; else echo '[]'; fi
elif [ "$1 $2" = "pr view" ]; then cat "$rd/pr.json"
elif [ "$1" = "api" ]; then if [ -f "$rd/api-fail" ]; then exit 1; fi; echo "{\\"sha\\":\\"$(cat "$rd/sha")\\"}"
fi
`,
  );
  chmodSync(join(bin, "claude"), 0o755);
  chmodSync(join(bin, "gh"), 0o755);
  for (const f of ["gh.log", "claude.log", "claude.cwd.log"])
    writeFileSync(join(dir, f), "");
  writeFileSync(join(dir, "sessions.json"), "[]");
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Writes the config (adding a real working dir per repo) and creates the fake data dirs.
function configure(repos = [APP]) {
  const entries = repos.map((r) => {
    const work = join(dir, "work", r.sessionPrefix);
    mkdirSync(work, { recursive: true });
    mkdirSync(rdir(r.repo), { recursive: true });
    return { dir: work, ...r };
  });
  writeFileSync(join(dir, "repos.json"), JSON.stringify(entries));
  return entries;
}

function exec({ dry = false, env = {} } = {}) {
  return spawnSync("bash", [SCRIPT, ...(dry ? ["--dry-run"] : [])], {
    encoding: "utf8",
    env: {
      ...process.env,
      EXTRA_PATH: join(dir, "bin"),
      STATE_DIR: join(dir, "state"),
      CLAUDE_WORKFLOW_CONFIG: join(dir, "repos.json"),
      CLAUDE_BG_FLAGS: "",
      CLAUDE_ALLOW_BYPASS_PERMISSIONS: "",
      CLAUDE_MAX_SESSIONS: "",
      ...env,
    },
  });
}

const gh = () => readLines("gh.log");

describe("agent-poller reconcile", () => {
  function run(opts) {
    configure();
    const repoDir = rdir(APP.repo);
    const sessions = opts.state
      ? [{ name: "app-5", state: opts.state, startedAt: 1 }]
      : [];
    writeFileSync(join(dir, "sessions.json"), JSON.stringify(sessions));
    const at = Math.floor(Date.now() / 1000) - (opts.ageSec ?? 3600);
    mkdirSync(state("app"), { recursive: true });
    writeFileSync(
      join(state("app"), "launched.json"),
      JSON.stringify({ 5: { name: "app-5", at } }),
    );
    writeFileSync(
      join(repoDir, "issue.json"),
      JSON.stringify({
        state: opts.issueState ?? "OPEN",
        labels: (opts.labels ?? ["in-progress"]).map((name) => ({ name })),
      }),
    );
    const res = exec();
    assert.equal(res.status, 0, res.stdout + res.stderr);
    const calls = gh();
    const launched = readJson(join(state("app"), "launched.json"));
    return {
      stdout: res.stdout,
      failed: calls.some((c) => c.includes("agent-failed")),
      commented: calls.some((c) => c.startsWith("issue comment 5")),
      kept: "5" in launched,
    };
  }

  for (const st of ["waiting", "idle", "something-new", "working", "blocked"]) {
    it(`keeps a session in state ${st} without failing it`, () => {
      const r = run({ state: st });
      assert.equal(r.failed, false);
      assert.equal(r.commented, false);
      assert.equal(r.kept, true);
    });
  }

  it("removes the entry without failure when done and needs-review", () => {
    const r = run({ state: "done", labels: ["needs-review"] });
    assert.equal(r.failed, false);
    assert.equal(r.kept, false);
  });

  it("removes the entry without failure when done and issue closed", () => {
    const r = run({ state: "done", issueState: "CLOSED", labels: [] });
    assert.equal(r.failed, false);
    assert.equal(r.kept, false);
  });

  it("fails a done session whose ticket was not handed off", () => {
    const r = run({ state: "done" });
    assert.equal(r.failed, true);
    assert.equal(r.commented, true);
    assert.equal(r.kept, false);
  });

  for (const st of ["failed", "stopped"]) {
    it(`fails a ${st} session`, () => {
      const r = run({ state: st });
      assert.equal(r.failed, true);
      assert.equal(r.commented, true);
      assert.equal(r.kept, false);
    });
  }

  it("fails a missing session older than 10 minutes", () => {
    const r = run({ ageSec: 700 });
    assert.equal(r.failed, true);
    assert.equal(r.kept, false);
  });

  it("keeps a missing session younger than 10 minutes", () => {
    const r = run({ ageSec: 60 });
    assert.equal(r.failed, false);
    assert.equal(r.kept, true);
  });

  it("logs the observed state, prefixed with the repo", () => {
    const out = run({ state: "waiting" }).stdout;
    assert.match(out, /\[app\] #5: app-5 state=waiting/);
    assert.ok(run({ ageSec: 60 }).stdout.includes("state=<none>"));
  });
});

describe("agent-poller conflict phase", () => {
  function runConflict(opts) {
    configure();
    const repoDir = rdir(APP.repo);
    writeFileSync(
      join(dir, "sessions.json"),
      JSON.stringify(
        (opts.sessions ?? []).map((s) => ({ ...s, startedAt: 1 })),
      ),
    );
    mkdirSync(state("app"), { recursive: true });
    writeFileSync(
      join(state("app"), "launched.json"),
      JSON.stringify(opts.launched ?? {}),
    );
    writeFileSync(
      join(state("app"), "conflicts.json"),
      JSON.stringify(opts.attempts ?? {}),
    );
    writeFileSync(join(repoDir, "sha"), opts.sha ?? "sha1");
    // Same-repo, owner-authored and conflicting unless the test says otherwise.
    const prRow = (p) => ({
      isCrossRepository: false,
      author: { login: "example-owner" },
      mergeable: "CONFLICTING",
      mergeStateStatus: "DIRTY",
      ...p,
    });
    writeFileSync(
      join(repoDir, "prs.json"),
      JSON.stringify([
        prRow({
          number: 9,
          headRefName: opts.branch ?? "issue-5-thing",
          mergeable: opts.mergeable ?? "CONFLICTING",
          // `crossRepo: undefined` drops the field from the JSON.
          ...("crossRepo" in opts ? { isCrossRepository: opts.crossRepo } : {}),
          ...(opts.prAuthor ? { author: { login: opts.prAuthor } } : {}),
        }),
        ...(opts.extraPrs ?? []).map(prRow),
      ]),
    );
    writeFileSync(
      join(repoDir, "pr.json"),
      JSON.stringify({
        state: opts.prViewState ?? "OPEN",
        mergeable: opts.prViewMergeable ?? "CONFLICTING",
      }),
    );
    for (const n of opts.failIssues ?? [])
      writeFileSync(join(repoDir, `fail-issue-${n}`), "");
    if (opts.failApi) writeFileSync(join(repoDir, "api-fail"), "");
    writeFileSync(
      join(repoDir, "issue.json"),
      JSON.stringify({
        state: opts.issueState ?? "OPEN",
        author: { login: opts.author ?? "example-owner" },
        labels: (opts.labels ?? ["agent-ok", "needs-review"]).map((name) => ({
          name,
        })),
      }),
    );
    const res = exec({ dry: opts.dry });
    assert.equal(res.status, opts.status ?? 0, res.stdout + res.stderr);
    return {
      stdout: res.stdout,
      launches: readLines("claude.log"),
      calls: gh(),
      state: readJson(join(state("app"), "launched.json")),
      attempts: readJson(join(state("app"), "conflicts.json")),
    };
  }

  const CONFLICT_LAUNCH =
    "--bg --name app-5-conflict --model sonnet --effort xhigh /ticket-workflow:resolve-conflicts 5";

  it("launches resolve-conflicts for a CONFLICTING issue PR and records it", () => {
    const r = runConflict({});
    assert.deepEqual(r.launches, [CONFLICT_LAUNCH]);
    assert.partialDeepStrictEqual(r.state["conflict-5"], {
      name: "app-5-conflict",
      pr: "9",
      mainSha: "sha1",
    });
    assert.deepEqual(r.attempts["5"], { pr: "9", mainSha: "sha1" });
  });

  for (const mergeable of ["UNKNOWN", "MERGEABLE"]) {
    it(`does not launch for ${mergeable}`, () => {
      const r = runConflict({ mergeable });
      assert.deepEqual(r.launches, []);
      if (mergeable === "UNKNOWN")
        assert.ok(r.stdout.includes("retry next poll"));
    });
  }

  it("ignores branches that are not issue-N-*", () => {
    assert.deepEqual(runConflict({ branch: "feature-x" }).launches, []);
  });

  for (const st of ["working", "blocked"]) {
    it(`skips when the ticket session is ${st}`, () => {
      const r = runConflict({ sessions: [{ name: "app-5", state: st }] });
      assert.deepEqual(r.launches, []);
    });
  }

  for (const st of ["idle", "done"]) {
    it(`still launches when the ticket session is ${st}`, () => {
      const r = runConflict({ sessions: [{ name: "app-5", state: st }] });
      assert.equal(r.launches.length, 1);
    });
  }

  it("skips when a live conflict session exists", () => {
    const r = runConflict({
      sessions: [{ name: "app-5-conflict", state: "working" }],
    });
    assert.deepEqual(r.launches, []);
  });

  it("skips when a conflict entry is already tracked", () => {
    const r = runConflict({
      launched: {
        "conflict-5": {
          name: "app-5-conflict",
          at: Math.floor(Date.now() / 1000),
          pr: "9",
          mainSha: "sha1",
        },
      },
    });
    assert.deepEqual(r.launches, []);
  });

  it("does not repeat an attempt against the same main SHA", () => {
    const r = runConflict({ attempts: { 5: { pr: "9", mainSha: "sha1" } } });
    assert.deepEqual(r.launches, []);
  });

  it("retries when main has moved", () => {
    const r = runConflict({
      attempts: { 5: { pr: "9", mainSha: "old" } },
      sha: "sha2",
    });
    assert.equal(r.launches.length, 1);
    assert.deepEqual(r.attempts["5"], { pr: "9", mainSha: "sha2" });
  });

  it("skips a PR whose issue cannot be read and still launches later ones", () => {
    const r = runConflict({
      branch: "issue-7-gone",
      failIssues: [7],
      extraPrs: [{ number: 10, headRefName: "issue-5-thing" }],
    });
    assert.ok(r.stdout.includes("#7: cannot read issue"));
    assert.deepEqual(r.launches, [CONFLICT_LAUNCH]);
  });

  it("skips the phase without failing when main SHA cannot be read", () => {
    const r = runConflict({ failApi: true });
    assert.ok(r.stdout.includes("cannot read main SHA"));
    assert.deepEqual(r.launches, []);
  });

  it("skips tickets that are not agent-ok", () => {
    assert.deepEqual(runConflict({ labels: ["needs-review"] }).launches, []);
  });

  it("skips tickets with agent-failed", () => {
    assert.deepEqual(
      runConflict({ labels: ["agent-ok", "agent-failed"] }).launches,
      [],
    );
  });

  it("skips tickets by another author", () => {
    assert.deepEqual(runConflict({ author: "someone" }).launches, []);
  });

  it("skips a PR from a fork, even on an issue-N-* branch", () => {
    const r = runConflict({ crossRepo: true });
    assert.deepEqual(r.launches, []);
    assert.ok(r.stdout.includes("#5: PR #9 is from a fork; skipping"), r.stdout);
    assert.deepEqual(r.state, {});
    assert.deepEqual(r.attempts, {});
  });

  it("never resolves a PR without isCrossRepository: the repo's poll fails", () => {
    const r = runConflict({ crossRepo: undefined, status: 1 });
    assert.deepEqual(r.launches, []);
    assert.match(r.stdout, /\[app\] poll failed: gh pr list: \[0\]\.isCrossRepository/);
    assert.ok(!r.calls.some((c) => c.startsWith("issue view")), r.calls.join("\n"));
    assert.deepEqual(r.attempts, {});
  });

  it("skips a same-repo PR by another author", () => {
    const r = runConflict({ prAuthor: "someone" });
    assert.deepEqual(r.launches, []);
    assert.ok(
      r.stdout.includes("#5: PR #9 author someone is not example-owner; skipping"),
      r.stdout,
    );
  });

  it("does not read the issue for an untrusted PR", () => {
    const r = runConflict({ crossRepo: true });
    assert.ok(!r.calls.some((c) => c.startsWith("issue view")), r.calls.join("\n"));
  });

  it("skips a closed ticket", () => {
    const r = runConflict({ issueState: "CLOSED" });
    assert.deepEqual(r.launches, []);
    assert.ok(r.stdout.includes("#5: issue is not open"), r.stdout);
  });

  it("skips a fork PR and still launches for the owner's PR on the same ticket", () => {
    const r = runConflict({
      branch: "issue-5-fork",
      crossRepo: true,
      prAuthor: "someone",
      extraPrs: [{ number: 10, headRefName: "issue-5-thing" }],
    });
    assert.deepEqual(r.launches, [CONFLICT_LAUNCH]);
    assert.equal(r.state["conflict-5"].pr, "10");
    assert.deepEqual(r.attempts["5"], { pr: "10", mainSha: "sha1" });
  });

  it("dry-run logs the launch without launching or writing state", () => {
    const r = runConflict({ dry: true });
    assert.ok(r.stdout.includes("[dry-run]"));
    assert.ok(r.stdout.includes("resolve-conflicts 5"));
    assert.deepEqual(r.launches, []);
    assert.deepEqual(r.state, {});
    assert.deepEqual(r.attempts, {});
  });
});

describe("agent-poller conflict reconcile", () => {
  const entry = {
    "conflict-5": {
      name: "app-5-conflict",
      at: Math.floor(Date.now() / 1000) - 3600,
      pr: "9",
      mainSha: "sha1",
    },
  };
  // PR is still CONFLICTING in these, but the attempt cap blocks a relaunch.
  const attempts = { 5: { pr: "9", mainSha: "sha1" } };

  // Reuses the conflict-phase setup through a fresh describe-local helper.
  function runConflict(opts) {
    configure();
    const repoDir = rdir(APP.repo);
    writeFileSync(
      join(dir, "sessions.json"),
      JSON.stringify(opts.sessions.map((s) => ({ ...s, startedAt: 1 }))),
    );
    mkdirSync(state("app"), { recursive: true });
    writeFileSync(
      join(state("app"), "launched.json"),
      JSON.stringify(entry),
    );
    writeFileSync(
      join(state("app"), "conflicts.json"),
      JSON.stringify(attempts),
    );
    writeFileSync(join(repoDir, "sha"), "sha1");
    writeFileSync(
      join(repoDir, "prs.json"),
      JSON.stringify([
        {
          number: 9,
          headRefName: "issue-5-thing",
          isCrossRepository: false,
          author: { login: "example-owner" },
          mergeable: opts.mergeable ?? "CONFLICTING",
          mergeStateStatus: "DIRTY",
        },
      ]),
    );
    writeFileSync(
      join(repoDir, "pr.json"),
      JSON.stringify({
        state: opts.prViewState ?? "OPEN",
        mergeable: opts.prViewMergeable ?? "CONFLICTING",
      }),
    );
    writeFileSync(
      join(repoDir, "issue.json"),
      JSON.stringify({
        state: "OPEN",
        author: { login: "example-owner" },
        labels: [{ name: "agent-ok" }, { name: "needs-review" }],
      }),
    );
    const res = exec();
    assert.equal(res.status, 0, res.stdout + res.stderr);
    return {
      calls: gh(),
      state: readJson(join(state("app"), "launched.json")),
    };
  }

  for (const st of ["failed", "stopped"]) {
    it(`fails a ${st} conflict session on the PR and issue`, () => {
      const r = runConflict({
        sessions: [{ name: "app-5-conflict", state: st }],
      });
      assert.ok(
        r.calls.includes(
          "issue edit 5 --repo example-owner/example-app --add-label agent-failed",
        ),
      );
      assert.ok(r.calls.some((c) => c.startsWith("pr comment 9")));
      assert.ok(r.calls.some((c) => c.startsWith("issue comment 5")));
      assert.deepEqual(r.state, {});
    });
  }

  it("fails a done session whose PR still conflicts", () => {
    const r = runConflict({
      sessions: [{ name: "app-5-conflict", state: "done" }],
    });
    assert.ok(r.calls.some((c) => c.includes("agent-failed")));
    assert.ok(r.calls.some((c) => c.startsWith("pr comment 9")));
    assert.deepEqual(r.state, {});
  });

  it("cleans up a done session whose conflict is resolved", () => {
    const r = runConflict({
      sessions: [{ name: "app-5-conflict", state: "done" }],
      prViewMergeable: "MERGEABLE",
      mergeable: "MERGEABLE",
    });
    assert.ok(!r.calls.some((c) => c.includes("agent-failed")));
    assert.deepEqual(r.state, {});
  });

  for (const prViewState of ["CLOSED", "MERGED"]) {
    it(`does not fail a done session whose PR is ${prViewState}`, () => {
      const r = runConflict({
        sessions: [{ name: "app-5-conflict", state: "done" }],
        prViewState,
        mergeable: "MERGEABLE",
      });
      assert.ok(!r.calls.some((c) => c.includes("agent-failed")));
      assert.deepEqual(r.state, {});
    });
  }

  it("keeps a working conflict session", () => {
    const r = runConflict({
      sessions: [{ name: "app-5-conflict", state: "working" }],
    });
    assert.ok(!r.calls.some((c) => c.includes("agent-failed")));
    assert.ok(r.state["conflict-5"]);
  });
});

describe("agent-poller multiple repos", () => {
  const A = { repo: "org/alpha", sessionPrefix: "a", owner: "me" };
  const B = { repo: "org/beta", sessionPrefix: "b", owner: "you" };

  const issue = (number, author, labels) => ({
    number,
    author: { login: author },
    labels: labels.map((name) => ({ name })),
  });
  const writeIssues = (repo, issues) =>
    writeFileSync(join(rdir(repo), "issues.json"), JSON.stringify(issues));

  it("dry-run picks the right tickets per repo", () => {
    const [ea, eb] = configure([A, B]);
    writeIssues(A.repo, [
      issue(3, "me", ["agent-ok", "ready"]),
      issue(4, "me", ["agent-ok"]), // not ready
      issue(8, "you", ["agent-ok", "ready"]), // wrong owner for alpha
    ]);
    writeIssues(B.repo, [
      issue(6, "you", ["agent-ok", "ready", "skip-plan"]),
      issue(7, "me", ["agent-ok", "ready"]), // wrong owner for beta
    ]);
    const r = exec({ dry: true });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(
      r.stdout.includes(
        `[dry-run] (cd ${ea.dir} && claude --bg --name a-3 --model sonnet --effort xhigh "/ticket-workflow:work-ticket 3")`,
      ),
      r.stdout,
    );
    assert.ok(
      r.stdout.includes(
        `[dry-run] (cd ${eb.dir} && claude --bg --name b-6 --model sonnet --effort xhigh "/ticket-workflow:work-ticket 6 auto")`,
      ),
      r.stdout,
    );
    assert.equal(r.stdout.match(/--bg --name/g).length, 2);
    assert.equal(readLines("claude.log").length, 0);
    const calls = gh();
    for (const repo of [A.repo, B.repo])
      assert.ok(
        calls.some((c) => c.startsWith(`issue list --repo ${repo} `)),
        `issue list for ${repo}`,
      );
    assert.ok(r.stdout.includes("[a] "));
    assert.ok(r.stdout.includes("[b] "));
  });

  it("same ticket number in two repos gets distinct names and separate state", () => {
    const [ea, eb] = configure([A, B]);
    writeIssues(A.repo, [issue(5, "me", ["agent-ok", "ready"])]);
    writeIssues(B.repo, [issue(5, "you", ["agent-ok", "ready"])]);
    const r = exec();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(readLines("claude.log").sort(), [
      "--bg --name a-5 --model sonnet --effort xhigh /ticket-workflow:work-ticket 5",
      "--bg --name b-5 --model sonnet --effort xhigh /ticket-workflow:work-ticket 5",
    ]);
    const cwds = readLines("claude.cwd.log");
    assert.ok(cwds.some((l) => l.startsWith(`${realpath(ea.dir)}|`) && l.includes("a-5")));
    assert.ok(cwds.some((l) => l.startsWith(`${realpath(eb.dir)}|`) && l.includes("b-5")));
    const sa = readJson(join(state("a"), "launched.json"));
    const sb = readJson(join(state("b"), "launched.json"));
    assert.equal(sa["5"].name, "a-5");
    assert.equal(sb["5"].name, "b-5");
    assert.ok(existsSync(join(state("a"), "conflicts.json")));
    assert.ok(existsSync(join(state("b"), "conflicts.json")));
  });

  it("reconciles each repo against its own state", () => {
    configure([A, B]);
    // Only a-5 exists as a failed session; b has its own #5 that is still working.
    writeFileSync(
      join(dir, "sessions.json"),
      JSON.stringify([
        { name: "a-5", state: "failed", startedAt: 1 },
        { name: "b-5", state: "working", startedAt: 1 },
      ]),
    );
    const at = Math.floor(Date.now() / 1000) - 3600;
    for (const [p, name] of [
      ["a", "a-5"],
      ["b", "b-5"],
    ]) {
      mkdirSync(state(p), { recursive: true });
      writeFileSync(
        join(state(p), "launched.json"),
        JSON.stringify({ 5: { name, at } }),
      );
    }
    const r = exec();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const calls = gh();
    assert.ok(calls.some((c) => c.startsWith("issue edit 5 --repo org/alpha")));
    assert.ok(!calls.some((c) => c.startsWith("issue edit 5 --repo org/beta")));
    assert.deepEqual(readJson(join(state("a"), "launched.json")), {});
    assert.ok(readJson(join(state("b"), "launched.json"))["5"]);
  });

  it("one repo failing does not stop the others", () => {
    configure([A, B]);
    writeFileSync(join(rdir(A.repo), "fail-all"), "");
    writeIssues(B.repo, [issue(6, "you", ["agent-ok", "ready"])]);
    const r = exec();
    assert.notEqual(r.status, 0);
    assert.ok(/\[a\] .*poll failed/.test(r.stdout), r.stdout);
    assert.deepEqual(readLines("claude.log"), [
      "--bg --name b-6 --model sonnet --effort xhigh /ticket-workflow:work-ticket 6",
    ]);
    // errexit is active inside the failed repo: it stopped at the failing call.
    assert.ok(!gh().some((c) => c.startsWith("pr list --repo org/alpha")));
    assert.ok(gh().some((c) => c.startsWith("pr list --repo org/beta")));
  });

  it("per-repo bgFlags are appended to CLAUDE_BG_FLAGS", () => {
    configure([{ ...A, bgFlags: "--model opus" }, B]);
    writeIssues(A.repo, [issue(1, "me", ["agent-ok", "ready"])]);
    writeIssues(B.repo, [issue(2, "you", ["agent-ok", "ready"])]);
    const r = exec({ env: { CLAUDE_BG_FLAGS: "--permission-mode plan" } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(readLines("claude.log").sort(), [
      "--bg --name a-1 --model sonnet --effort xhigh --permission-mode plan --model opus /ticket-workflow:work-ticket 1",
      "--bg --name b-2 --model sonnet --effort xhigh --permission-mode plan /ticket-workflow:work-ticket 2",
    ]);
  });
});

describe("agent-poller bypass-flag refusal", () => {
  const A = { repo: "org/alpha", sessionPrefix: "a", owner: "me" };
  const B = { repo: "org/beta", sessionPrefix: "b", owner: "me" };
  const ready = (number) => ({
    number,
    author: { login: "me" },
    labels: [{ name: "agent-ok" }, { name: "ready" }],
  });
  const writeIssues = (repo, issues) =>
    writeFileSync(join(rdir(repo), "issues.json"), JSON.stringify(issues));

  const BYPASS = [
    ["--dangerously-skip-permissions", "--dangerously-skip-permissions"],
    ["--allow-dangerously-skip-permissions", "--allow-dangerously-skip-permissions"],
    ["--permission-mode bypassPermissions", "--model opus --permission-mode bypassPermissions"],
    ["--permission-mode=bypassPermissions", "--permission-mode=bypassPermissions"],
  ];

  for (const [label, flags] of BYPASS) {
    it(`refuses ${label} in CLAUDE_BG_FLAGS, launching nothing`, () => {
      configure([A]);
      writeIssues(A.repo, [ready(1)]);
      const r = exec({ env: { CLAUDE_BG_FLAGS: flags } });
      assert.notEqual(r.status, 0);
      assert.match(r.stdout, /\[a\] refusing bypass flags/);
      assert.match(r.stdout, /CLAUDE_ALLOW_BYPASS_PERMISSIONS=1/);
      assert.deepEqual(readLines("claude.log"), []);
      assert.ok(!gh().some((c) => c.startsWith("issue list")));
    });

    it(`refuses ${label} in a repo's bgFlags; other repos still run`, () => {
      configure([{ ...A, bgFlags: flags }, B]);
      writeIssues(A.repo, [ready(1)]);
      writeIssues(B.repo, [ready(2)]);
      const r = exec();
      assert.notEqual(r.status, 0);
      assert.match(r.stdout, /\[a\] refusing bypass flags/);
      assert.deepEqual(readLines("claude.log"), [
        "--bg --name b-2 --model sonnet --effort xhigh /ticket-workflow:work-ticket 2",
      ]);
    });
  }

  it("allows bypass flags with CLAUDE_ALLOW_BYPASS_PERMISSIONS=1 and logs them", () => {
    configure([{ ...A, bgFlags: "--permission-mode bypassPermissions" }]);
    writeIssues(A.repo, [ready(1)]);
    const r = exec({
      env: {
        CLAUDE_ALLOW_BYPASS_PERMISSIONS: "1",
        CLAUDE_BG_FLAGS: "--dangerously-skip-permissions",
      },
    });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.doesNotMatch(r.stdout, /refusing/);
    assert.deepEqual(readLines("claude.log"), [
      "--bg --name a-1 --model sonnet --effort xhigh --dangerously-skip-permissions --permission-mode bypassPermissions /ticket-workflow:work-ticket 1",
    ]);
    assert.match(
      r.stdout,
      /#1: launching a-1 \(flags: --model sonnet --effort xhigh --dangerously-skip-permissions --permission-mode bypassPermissions\)/,
    );
  });

  it("only the exact opt-in value 1 allows them", () => {
    configure([A]);
    writeIssues(A.repo, [ready(1)]);
    const r = exec({
      env: {
        CLAUDE_ALLOW_BYPASS_PERMISSIONS: "true",
        CLAUDE_BG_FLAGS: "--dangerously-skip-permissions",
      },
    });
    assert.notEqual(r.status, 0);
    assert.deepEqual(readLines("claude.log"), []);
  });

  it("leaves other permission modes alone and logs the effective flags", () => {
    configure([{ ...A, bgFlags: "--permission-mode acceptEdits" }]);
    writeIssues(A.repo, [ready(1)]);
    const r = exec();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /#1: launching a-1 \(flags: --model sonnet --effort xhigh --permission-mode acceptEdits\)/);
    assert.equal(readLines("claude.log").length, 1);
  });

  it("logs the default model and effort when no flags are set", () => {
    configure([A]);
    writeIssues(A.repo, [ready(1)]);
    const r = exec();
    assert.match(r.stdout, /#1: launching a-1 \(flags: --model sonnet --effort xhigh\)/);
  });

  it("logs the effective flags on conflict launches too", () => {
    configure([{ ...A, bgFlags: "--model opus" }]);
    const rd = rdir(A.repo);
    writeFileSync(join(rd, "sha"), "sha1");
    writeFileSync(
      join(rd, "prs.json"),
      JSON.stringify([
        {
          number: 9,
          headRefName: "issue-5-x",
          isCrossRepository: false,
          author: { login: "me" },
          mergeable: "CONFLICTING",
          mergeStateStatus: "DIRTY",
        },
      ]),
    );
    writeFileSync(
      join(rd, "issue.json"),
      JSON.stringify({
        state: "OPEN",
        author: { login: "me" },
        labels: [{ name: "agent-ok" }],
      }),
    );
    const r = exec();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /launching a-5-conflict \(flags: --model sonnet --effort xhigh --model opus\)/);
  });
});

describe("agent-poller session cap", () => {
  const A = { repo: "org/alpha", sessionPrefix: "a", owner: "me" };
  const B = { repo: "org/beta", sessionPrefix: "b", owner: "me" };
  const ready = (number) => ({
    number,
    author: { login: "me" },
    labels: [{ name: "agent-ok" }, { name: "ready" }],
  });
  const writeIssues = (repo, issues) =>
    writeFileSync(join(rdir(repo), "issues.json"), JSON.stringify(issues));
  const launchedState = (prefix, names) => {
    mkdirSync(state(prefix), { recursive: true });
    const at = Math.floor(Date.now() / 1000) - 60;
    const o = {};
    for (const name of names) o[name.split("-")[1]] = { name, at };
    writeFileSync(join(state(prefix), "launched.json"), JSON.stringify(o));
  };
  const sessions = (list) =>
    writeFileSync(
      join(dir, "sessions.json"),
      JSON.stringify(list.map(([name, st]) => ({ name, state: st, startedAt: 1 }))),
    );
  const tracked = (prefix) =>
    Object.keys(readJson(join(state(prefix), "launched.json")));

  it("defaults to 10 sessions: the 11th ready ticket is deferred", () => {
    configure([A]);
    writeIssues(A.repo, Array.from({ length: 11 }, (_, i) => ready(i + 1)));
    const r = exec();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(readLines("claude.log").length, 10);
    assert.match(r.stdout, /deferred #11: at session cap/);
    assert.equal(tracked("a").includes("11"), false);
  });

  it("CLAUDE_MAX_SESSIONS raises the default", () => {
    configure([A]);
    writeIssues(A.repo, Array.from({ length: 11 }, (_, i) => ready(i + 1)));
    const r = exec({ env: { CLAUDE_MAX_SESSIONS: "11" } });
    assert.equal(readLines("claude.log").length, 11);
    assert.doesNotMatch(r.stdout, /deferred/);
  });

  it("global cap counts live sessions across repos; defers without recording, resumes once one ends", () => {
    configure([A, B]);
    launchedState("a", ["a-1"]);
    launchedState("b", ["b-2"]);
    sessions([
      ["a-1", "working"],
      ["b-2", "blocked"],
    ]);
    writeIssues(A.repo, [ready(3)]);
    const env = { CLAUDE_MAX_SESSIONS: "2" };
    let r = exec({ env });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(readLines("claude.log"), []);
    assert.match(r.stdout, /\[a\] deferred #3: at session cap/);
    assert.deepEqual(tracked("a"), ["1"]);

    // b-2 finishes (handed off); the deferred ticket launches on the next poll.
    sessions([
      ["a-1", "working"],
      ["b-2", "done"],
    ]);
    writeFileSync(
      join(rdir(B.repo), "issue.json"),
      JSON.stringify({ state: "OPEN", labels: [{ name: "needs-review" }] }),
    );
    r = exec({ env });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(readLines("claude.log"), [
      "--bg --name a-3 --model sonnet --effort xhigh /ticket-workflow:work-ticket 3",
    ]);
    assert.deepEqual(tracked("a").sort(), ["1", "3"]);
  });

  it("counts a just-launched session that is not listed yet; ignores done/failed/stopped", () => {
    configure([A]);
    launchedState("a", ["a-1", "a-2", "a-3", "a-4"]);
    sessions([
      ["a-2", "done"],
      ["a-3", "failed"],
      ["a-4", "stopped"],
    ]);
    writeIssues(A.repo, [ready(9)]);
    writeFileSync(
      join(rdir(A.repo), "issue.json"),
      JSON.stringify({ state: "OPEN", labels: [{ name: "needs-review" }] }),
    );
    // a-1 is unlisted (young) so it counts; the other three do not.
    const r = exec({ env: { CLAUDE_MAX_SESSIONS: "1" } });
    assert.match(r.stdout, /deferred #9: at session cap/);
    assert.deepEqual(readLines("claude.log"), []);
  });

  for (const st of ["done", "failed", "stopped", "working"]) {
    it(`another repo's ${st} session (not yet reconciled) ${st === "working" ? "counts toward" : "does not count toward"} the global cap`, () => {
      configure([A, B]);
      launchedState("b", ["b-1"]);
      sessions([["b-1", st]]);
      writeIssues(A.repo, [ready(2)]);
      const r = exec({ env: { CLAUDE_MAX_SESSIONS: "1" } });
      assert.equal(readLines("claude.log").length, st === "working" ? 0 : 1);
      if (st === "working") assert.match(r.stdout, /deferred #2/);
    });
  }

  it("stops launching within a run once the cap is reached", () => {
    configure([A, B]);
    writeIssues(A.repo, [ready(1), ready(2)]);
    writeIssues(B.repo, [ready(3)]);
    const r = exec({ env: { CLAUDE_MAX_SESSIONS: "2" } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(readLines("claude.log"), [
      "--bg --name a-1 --model sonnet --effort xhigh /ticket-workflow:work-ticket 1",
      "--bg --name a-2 --model sonnet --effort xhigh /ticket-workflow:work-ticket 2",
    ]);
    assert.match(r.stdout, /\[b\] deferred #3: at session cap/);
  });

  it("per-repo maxSessions caps only that repo", () => {
    configure([{ ...A, maxSessions: 1 }, B]);
    launchedState("a", ["a-1"]);
    sessions([["a-1", "working"]]);
    writeIssues(A.repo, [ready(2)]);
    writeIssues(B.repo, [ready(3), ready(4)]);
    const r = exec();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /\[a\] deferred #2: at session cap/);
    assert.deepEqual(readLines("claude.log"), [
      "--bg --name b-3 --model sonnet --effort xhigh /ticket-workflow:work-ticket 3",
      "--bg --name b-4 --model sonnet --effort xhigh /ticket-workflow:work-ticket 4",
    ]);
  });

  it("per-repo maxSessions counts launches made earlier in the same run", () => {
    configure([{ ...A, maxSessions: 1 }]);
    writeIssues(A.repo, [ready(1), ready(2)]);
    const r = exec();
    assert.deepEqual(readLines("claude.log"), [
      "--bg --name a-1 --model sonnet --effort xhigh /ticket-workflow:work-ticket 1",
    ]);
    assert.match(r.stdout, /deferred #2: at session cap/);
  });

  it("accepts maxSessions written as 1.0 and still enforces it", () => {
    writeFileSync(join(dir, "x"), "");
    configure([{ ...A, maxSessions: 1 }]);
    // JSON.stringify turns 1 into "1", so write the float form into the config by hand.
    const cfg = readFileSync(join(dir, "repos.json"), "utf8").replace(
      '"maxSessions":1',
      '"maxSessions":1.0',
    );
    assert.match(cfg, /1\.0/);
    writeFileSync(join(dir, "repos.json"), cfg);
    writeIssues(A.repo, [ready(1), ready(2)]);
    const r = exec();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(readLines("claude.log").length, 1);
    assert.match(r.stdout, /deferred #2: at session cap/);
  });

  it("does not count an unlisted entry older than 10 minutes as live", () => {
    configure([A, B]);
    mkdirSync(state("b"), { recursive: true });
    const old = Math.floor(Date.now() / 1000) - 3600;
    const young = Math.floor(Date.now() / 1000) - 60;
    writeFileSync(
      join(state("b"), "launched.json"),
      JSON.stringify({ 1: { name: "b-1", at: old }, 2: { name: "b-2", at: young } }),
    );
    writeIssues(A.repo, [ready(3)]);
    // b-1 is dead (unlisted, old): only b-2 counts, so cap 2 leaves room for one launch.
    const r = exec({ env: { CLAUDE_MAX_SESSIONS: "2" } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(readLines("claude.log"), [
      "--bg --name a-3 --model sonnet --effort xhigh /ticket-workflow:work-ticket 3",
    ]);
  });

  it("dry run honours the cap with an in-memory count and writes no state", () => {
    configure([A]);
    writeIssues(A.repo, [ready(1), ready(2)]);
    const r = exec({ dry: true, env: { CLAUDE_MAX_SESSIONS: "1" } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(r.stdout.match(/\[dry-run\] \(cd/g).length, 1);
    assert.match(r.stdout, /deferred #2: at session cap/);
    assert.equal(existsSync(state("a")), false, "a dry run writes no state files");
  });

  it("conflict launches respect the cap and are retried once there is room", () => {
    configure([A]);
    launchedState("a", ["a-7"]);
    sessions([["a-7", "working"]]);
    const rd = rdir(A.repo);
    writeFileSync(join(rd, "sha"), "sha1");
    writeFileSync(
      join(rd, "prs.json"),
      JSON.stringify([
        {
          number: 9,
          headRefName: "issue-5-x",
          isCrossRepository: false,
          author: { login: "me" },
          mergeable: "CONFLICTING",
          mergeStateStatus: "DIRTY",
        },
      ]),
    );
    writeFileSync(
      join(rd, "issue.json"),
      JSON.stringify({
        state: "OPEN",
        author: { login: "me" },
        labels: [{ name: "agent-ok" }],
      }),
    );
    let r = exec({ env: { CLAUDE_MAX_SESSIONS: "1" } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /deferred #5: at session cap/);
    assert.deepEqual(readLines("claude.log"), []);
    assert.equal(existsSync(join(state("a"), "conflicts.json")), false, "no attempt recorded");
    assert.deepEqual(tracked("a"), ["7"]);

    r = exec({ env: { CLAUDE_MAX_SESSIONS: "2" } });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(readLines("claude.log"), [
      "--bg --name a-5-conflict --model sonnet --effort xhigh /ticket-workflow:resolve-conflicts 5",
    ]);
  });

  for (const v of ["0", "abc", "-1", "1.5", "01"]) {
    it(`aborts on invalid CLAUDE_MAX_SESSIONS=${v}`, () => {
      configure([A]);
      writeIssues(A.repo, [ready(1)]);
      const r = exec({ env: { CLAUDE_MAX_SESSIONS: v } });
      assert.notEqual(r.status, 0);
      assert.match(r.stdout, /CLAUDE_MAX_SESSIONS=.* is not a positive integer/);
      assert.deepEqual(readLines("claude.log"), []);
    });
  }

  for (const bad of [0, -2, 1.5, "3", null, true]) {
    it(`rejects maxSessions=${JSON.stringify(bad)} in the config`, () => {
      configure([{ ...A, maxSessions: bad }]);
      const r = exec();
      assert.notEqual(r.status, 0);
      assert.match(r.stdout, /\[0\]\.maxSessions: expected a positive integer/);
      assert.deepEqual(readLines("claude.log"), []);
    });
  }
});

describe("agent-poller entrypoint", () => {
  it("logs and exits 1 when node is older than 24", () => {
    configure();
    // EXTRA_PATH comes first on PATH, so this fake node wins.
    writeFileSync(
      join(dir, "bin", "node"),
      `#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo v22.9.0; else echo 22; fi\n`,
    );
    chmodSync(join(dir, "bin", "node"), 0o755);
    const r = exec();
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /node v22\.9\.0 at .*\/bin\/node is too old; the poller needs Node 24 or later; aborting/);
    assert.deepEqual(gh(), []);
  });

  it("logs and exits 1 when the clone's dependencies are not installed", () => {
    configure();
    // A copy of the entrypoint in a clone without node_modules.
    const clone = join(dir, "clone");
    mkdirSync(join(clone, "dispatch"), { recursive: true });
    copyFileSync(SCRIPT, join(clone, "dispatch", "agent-poller.sh"));
    const r = spawnSync("bash", [join(clone, "dispatch", "agent-poller.sh")], {
      encoding: "utf8",
      env: {
        ...process.env,
        EXTRA_PATH: join(dir, "bin"),
        STATE_DIR: join(dir, "state"),
        CLAUDE_WORKFLOW_CONFIG: join(dir, "repos.json"),
      },
    });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /dependencies are not installed in .*clone \(run npm ci there/);
    assert.deepEqual(gh(), []);
    assert.equal(existsSync(join(dir, "state")), false);
  });
});

describe("agent-poller failed tickets and broken state", () => {
  const A = { repo: "org/alpha", sessionPrefix: "a", owner: "me" };
  const B = { repo: "org/beta", sessionPrefix: "b", owner: "me" };
  const ready = (number) => ({
    number,
    author: { login: "me" },
    labels: [{ name: "agent-ok" }, { name: "ready" }],
  });

  it("dry run does not preview a relaunch of a ticket it just failed", () => {
    configure([A]);
    writeFileSync(join(dir, "sessions.json"), JSON.stringify([{ name: "a-5", state: "failed", startedAt: 1 }]));
    mkdirSync(state("a"), { recursive: true });
    const launched = JSON.stringify({ 5: { name: "a-5", at: 1 } });
    writeFileSync(join(state("a"), "launched.json"), launched);
    // The issue still looks ready: in a dry run the agent-failed label is never applied.
    writeFileSync(join(rdir(A.repo), "issues.json"), JSON.stringify([ready(5)]));
    const r = exec({ dry: true });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /\[dry-run\] gh issue edit 5 --repo org\/alpha --add-label agent-failed/);
    assert.match(r.stdout, /#5: failed earlier in this poll; not relaunching/);
    assert.doesNotMatch(r.stdout, /\[dry-run\] \(cd/);
    assert.equal(readFileSync(join(state("a"), "launched.json"), "utf8"), launched);
  });

  it("a repo with unreadable state fails, and its listed live sessions still count toward the global cap", () => {
    configure([A, B]);
    mkdirSync(state("b"), { recursive: true });
    writeFileSync(join(state("b"), "launched.json"), "{corrupt");
    writeFileSync(join(dir, "sessions.json"), JSON.stringify([{ name: "b-1", state: "working", startedAt: 1 }]));
    writeFileSync(join(rdir(A.repo), "issues.json"), JSON.stringify([ready(2)]));
    const r = exec({ env: { CLAUDE_MAX_SESSIONS: "1" } });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /\[b\] poll failed: .*launched\.json: not valid JSON/);
    assert.match(r.stdout, /\[a\] deferred #2: at session cap/);
    assert.deepEqual(readLines("claude.log"), []);
    assert.ok(!gh().some((c) => c.includes("org/beta")), "nothing is read for the broken repo");
  });
});

describe("agent-poller run lock", () => {
  const lockWith = (pid) => {
    mkdirSync(join(dir, "state", "lock"), { recursive: true });
    writeFileSync(join(dir, "state", "lock", "pid"), `${pid}\n`);
  };
  const readyIssue = [{ number: 1, author: { login: APP.owner }, labels: [{ name: "agent-ok" }, { name: "ready" }] }];

  it("exits 0 without polling while another live run holds the lock", () => {
    configure();
    writeFileSync(join(rdir(APP.repo), "issues.json"), JSON.stringify(readyIssue));
    lockWith(process.pid); // this test process: alive
    const r = exec();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, new RegExp(`another run is active \\(pid ${process.pid}\\); exiting`));
    assert.deepEqual(gh(), []);
    assert.equal(readFileSync(join(dir, "state", "lock", "pid"), "utf8"), `${process.pid}\n`);
  });

  it("takes over a lock left by a process that is gone, and releases it after the run", () => {
    configure();
    writeFileSync(join(rdir(APP.repo), "issues.json"), JSON.stringify(readyIssue));
    const gone = spawnSync("bash", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim();
    lockWith(gone);
    const r = exec();
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(readLines("claude.log").length, 1);
    assert.equal(existsSync(join(dir, "state", "lock")), false);
  });
});

describe("agent-poller config validation", () => {
  const ok = { repo: "org/alpha", dir: "/tmp", sessionPrefix: "a", owner: "me" };

  function expectAbort(content, pattern) {
    if (content !== null) writeFileSync(join(dir, "repos.json"), content);
    const r = exec();
    assert.notEqual(r.status, 0, r.stdout);
    assert.match(r.stdout, pattern);
    assert.equal(readLines("claude.log").length, 0);
    assert.equal(readLines("gh.log").length, 0);
  }

  it("aborts on a missing config file", () => {
    expectAbort(null, /missing or unreadable/);
  });

  it("aborts on malformed JSON", () => {
    expectAbort("{not json", /not valid JSON/);
  });

  it("aborts when the config is not an array", () => {
    expectAbort(JSON.stringify({ repo: "x/y" }), /not a JSON array/);
  });

  for (const field of ["repo", "dir", "sessionPrefix", "owner"]) {
    it(`aborts when ${field} is missing`, () => {
      const entry = { ...ok };
      delete entry[field];
      expectAbort(
        JSON.stringify([entry]),
        new RegExp(`\\[0\\]\\.${field}: expected a non-empty string`),
      );
    });
  }

  it("aborts on an unsafe sessionPrefix", () => {
    expectAbort(
      JSON.stringify([{ ...ok, sessionPrefix: "../x" }]),
      /\[0\]\.sessionPrefix: expected only letters, digits/,
    );
  });

  it("aborts on a duplicate sessionPrefix", () => {
    expectAbort(
      JSON.stringify([ok, { ...ok, repo: "org/beta" }]),
      /duplicate sessionPrefix 'a'/,
    );
  });

  it("rejects a sessionPrefix that differs only by case", () => {
    expectAbort(
      JSON.stringify([
        { ...ok, sessionPrefix: "cw" },
        { ...ok, repo: "org/beta", sessionPrefix: "CW" },
      ]),
      /duplicate sessionPrefix 'cw'/,
    );
  });

  for (const repo of ["alpha", "a/b/c", "org/", "/x", "or g/x"]) {
    it(`aborts on malformed repo '${repo}'`, () => {
      expectAbort(JSON.stringify([{ ...ok, repo }]), /not of the form owner\/name/);
    });
  }

  it("aborts when dir does not exist", () => {
    expectAbort(
      JSON.stringify([{ ...ok, dir: "/nonexistent-poller-dir" }]),
      /dir '\/nonexistent-poller-dir' .* does not exist/,
    );
  });

  it("expands ~ in dir when checking it exists", () => {
    expectAbort(
      JSON.stringify([{ ...ok, dir: "~/nonexistent-poller-dir-xyz" }]),
      /nonexistent-poller-dir-xyz.* does not exist/,
    );
  });

  it("accepts an empty array and does nothing", () => {
    writeFileSync(join(dir, "repos.json"), "[]");
    const r = exec();
    assert.equal(r.status, 0);
  });
});

function realpath(p) {
  return spawnSync("bash", ["-c", `cd ${JSON.stringify(p)} && pwd -P`], {
    encoding: "utf8",
  }).stdout.trim();
}
