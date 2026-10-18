// Tests for dispatch/agent-poller.sh. Run: node --test dispatch/
// Fake `gh` and `claude` binaries are put on PATH; per-repo fake data lives in <dir>/r/<owner>_<name>/.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
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
    assert.equal(res.status, 0, res.stdout + res.stderr);
    return {
      stdout: res.stdout,
      launches: readLines("claude.log"),
      calls: gh(),
      state: readJson(join(state("app"), "launched.json")),
      attempts: readJson(join(state("app"), "conflicts.json")),
    };
  }

  const CONFLICT_LAUNCH =
    "--bg --name app-5-conflict /ticket-workflow:resolve-conflicts 5";

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

  it("treats a PR without isCrossRepository as a fork", () => {
    const r = runConflict({ crossRepo: undefined });
    assert.deepEqual(r.launches, []);
    assert.ok(r.stdout.includes("is from a fork"), r.stdout);
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
        `[dry-run] (cd ${ea.dir} && claude --bg --name a-3  "/ticket-workflow:work-ticket 3")`,
      ),
      r.stdout,
    );
    assert.ok(
      r.stdout.includes(
        `[dry-run] (cd ${eb.dir} && claude --bg --name b-6  "/ticket-workflow:work-ticket 6 auto")`,
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
      "--bg --name a-5 /ticket-workflow:work-ticket 5",
      "--bg --name b-5 /ticket-workflow:work-ticket 5",
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
      "--bg --name b-6 /ticket-workflow:work-ticket 6",
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
      "--bg --name a-1 --permission-mode plan --model opus /ticket-workflow:work-ticket 1",
      "--bg --name b-2 --permission-mode plan /ticket-workflow:work-ticket 2",
    ]);
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
    expectAbort("{not json", /not a JSON array/);
  });

  it("aborts when the config is not an array", () => {
    expectAbort(JSON.stringify({ repo: "x/y" }), /not a JSON array/);
  });

  for (const field of ["repo", "dir", "sessionPrefix", "owner"]) {
    it(`aborts when ${field} is missing`, () => {
      const entry = { ...ok };
      delete entry[field];
      expectAbort(JSON.stringify([entry]), /needs string repo/);
    });
  }

  it("aborts on an unsafe sessionPrefix", () => {
    expectAbort(
      JSON.stringify([{ ...ok, sessionPrefix: "../x" }]),
      /needs string repo/,
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
