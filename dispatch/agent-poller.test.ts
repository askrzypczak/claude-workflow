// Tests for dispatch/agent-poller.sh. Run: npx vitest run dispatch/agent-poller
// Fake `gh` and `claude` binaries are put on PATH; per-repo fake data lives in <dir>/r/<owner>_<name>/.
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
import { delimiter, dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SCRIPT = join(import.meta.dirname, "agent-poller.sh");
const APP = {
  repo: "example-owner/example-app",
  sessionPrefix: "app",
  owner: "example-owner",
};

interface Repo {
  repo: string;
  sessionPrefix: string;
  owner: string;
  maxSessions?: unknown;
}
type Entry = Repo & { dir: string };

let dir: string;

const slug = (repo: string) => repo.replaceAll("/", "_");
const rdir = (repo: string) => join(dir, "r", slug(repo));
const state = (prefix: string) => join(dir, "state", "repos", prefix);
const readLines = (f: string) =>
  readFileSync(join(dir, f), "utf8").split("\n").filter(Boolean);
const readJson = (f: string) => JSON.parse(readFileSync(f, "utf8"));
// The shim puts fnm, Homebrew and /usr/local/bin before the inherited PATH (for launchd), and a
// CI runner can have an older node there. EXTRA_PATH comes first: the fake gh/claude (and any
// fake node) win, then the node running these tests.
const extraPath = () => [join(dir, "bin"), dirname(process.execPath)].join(delimiter);
// Every run gets a fake HOME.
const fakeHome = () => join(dir, "home");

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
  // Data is keyed off --repo (or the repos/<repo>/... path of `gh api`). Like real gh,
  // `pr list` and `pr view` return only the fields named by --json.
  writeFileSync(
    join(bin, "gh"),
    `#!/usr/bin/env bash
echo "$*" >>"${dir}/gh.log"
repo=""
if [ "$1" = "api" ]; then repo=$(echo "$2" | sed -E 's#^repos/([^/]+/[^/]+)/.*#\\1#')
else prev=""; for a in "$@"; do [ "$prev" = "--repo" ] && repo="$a"; prev="$a"; done; fi
fields=""; prev=""; for a in "$@"; do [ "$prev" = "--json" ] && fields="$a"; prev="$a"; done
pick() { node -e 'const f=process.argv[1].split(",");const d=JSON.parse(require("fs").readFileSync(0,"utf8"));const p=o=>Object.fromEntries(f.filter(k=>k in o).map(k=>[k,o[k]]));process.stdout.write(JSON.stringify(Array.isArray(d)?d.map(p):p(d)))' "$fields" <"$1"; }
rd="${dir}/r/\${repo//\\//_}"
[ -f "$rd/fail-all" ] && exit 1
if [ "$1 $2" = "issue view" ]; then if [ -f "$rd/fail-issue-$3" ]; then exit 1; fi; cat "$rd/issue.json"
elif [ "$1 $2" = "issue list" ]; then if [ -f "$rd/issues.json" ]; then cat "$rd/issues.json"; else echo '[]'; fi
elif [ "$1 $2" = "pr list" ]; then if [ -f "$rd/prs.json" ]; then pick "$rd/prs.json"; else echo '[]'; fi
elif [ "$1 $2" = "pr view" ]; then pick "$rd/pr.json"
elif [ "$1" = "api" ]; then if [ -f "$rd/api-fail" ]; then exit 1; fi; echo "{\\"sha\\":\\"$(cat "$rd/sha")\\"}"
fi
`,
  );
  // A fake curl: a host listed in <dir>/reach answers, any other is refused. By default the
  // firewall holds: api.github.com answers and example.com does not.
  writeFileSync(
    join(bin, "curl"),
    `#!/usr/bin/env bash
echo "$*" >>"${dir}/curl.log"
url=""; for a in "$@"; do case "$a" in http://* | https://*) url="$a" ;; esac; done
host="\${url#*://}"; host="\${host%%/*}"
if [ -n "$host" ] && grep -qxF "$host" "${dir}/reach"; then exit 0; fi
echo "curl: (7) Failed to connect to $host port 443 after 2 ms: Couldn't connect to server" >&2
exit 7
`,
  );
  chmodSync(join(bin, "claude"), 0o755);
  chmodSync(join(bin, "gh"), 0o755);
  chmodSync(join(bin, "curl"), 0o755);
  writeFileSync(join(dir, "reach"), "api.github.com\n");
  for (const f of ["gh.log", "claude.log", "claude.cwd.log", "curl.log"])
    writeFileSync(join(dir, f), "");
  writeFileSync(join(dir, "sessions.json"), "[]");
  mkdirSync(fakeHome());
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Writes the config (adding a real working dir per repo) and creates the fake data dirs.
function configure(repos: Repo[] = [APP]): Entry[] {
  const entries = repos.map((r) => {
    const work = join(dir, "work", r.sessionPrefix);
    mkdirSync(work, { recursive: true });
    mkdirSync(rdir(r.repo), { recursive: true });
    return { dir: work, ...r };
  });
  writeFileSync(join(dir, "repos.json"), JSON.stringify(entries));
  return entries;
}

interface ExecOpts {
  dry?: boolean;
  env?: Record<string, string>;
}

function exec({ dry = false, env = {} }: ExecOpts = {}) {
  return spawnSync("bash", [SCRIPT, ...(dry ? ["--dry-run"] : [])], {
    encoding: "utf8",
    env: {
      ...process.env,
      HOME: fakeHome(),
      EXTRA_PATH: extraPath(),
      STATE_DIR: join(dir, "state"),
      CLAUDE_WORKFLOW_CONFIG: join(dir, "repos.json"),
      CLAUDE_MAX_SESSIONS: "",
      ...env,
    },
  });
}

const gh = () => readLines("gh.log");

describe("agent-poller reconcile", () => {
  interface ReconcileOpts {
    state?: string;
    ageSec?: number;
    issueState?: string;
    labels?: string[];
  }

  function run(opts: ReconcileOpts) {
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
    expect(res.status, res.stdout + res.stderr).toBe(0);
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
      expect(r.failed).toBe(false);
      expect(r.commented).toBe(false);
      expect(r.kept).toBe(true);
    });
  }

  it("removes the entry without failure when done and needs-review", () => {
    const r = run({ state: "done", labels: ["needs-review"] });
    expect(r.failed).toBe(false);
    expect(r.kept).toBe(false);
  });

  it("removes the entry without failure when done and issue closed", () => {
    const r = run({ state: "done", issueState: "CLOSED", labels: [] });
    expect(r.failed).toBe(false);
    expect(r.kept).toBe(false);
  });

  it("fails a done session whose ticket was not handed off", () => {
    const r = run({ state: "done" });
    expect(r.failed).toBe(true);
    expect(r.commented).toBe(true);
    expect(r.kept).toBe(false);
  });

  for (const st of ["failed", "stopped"]) {
    it(`fails a ${st} session`, () => {
      const r = run({ state: st });
      expect(r.failed).toBe(true);
      expect(r.commented).toBe(true);
      expect(r.kept).toBe(false);
    });
  }

  it("fails a missing session older than 10 minutes", () => {
    const r = run({ ageSec: 700 });
    expect(r.failed).toBe(true);
    expect(r.kept).toBe(false);
  });

  it("keeps a missing session younger than 10 minutes", () => {
    const r = run({ ageSec: 60 });
    expect(r.failed).toBe(false);
    expect(r.kept).toBe(true);
  });

  it("logs the observed state, prefixed with the repo", () => {
    const out = run({ state: "waiting" }).stdout;
    expect(out).toMatch(/\[app\] #5: app-5 state=waiting/);
    expect(run({ ageSec: 60 }).stdout.includes("state=<none>")).toBe(true);
  });
});

describe("agent-poller conflict phase", () => {
  interface ConflictOpts {
    sessions?: { name: string; state: string }[];
    launched?: Record<string, unknown>;
    attempts?: Record<string, unknown>;
    sha?: string;
    branch?: string;
    mergeable?: string;
    crossRepo?: boolean;
    prAuthor?: string;
    extraPrs?: { number: number; headRefName: string }[];
    prViewState?: string;
    prViewMergeable?: string;
    failIssues?: number[];
    failApi?: boolean;
    issueState?: string;
    author?: string;
    labels?: string[];
    prLabels?: string[];
    dry?: boolean;
    status?: number;
  }

  function runConflict(opts: ConflictOpts) {
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
    const prRow = (p: Record<string, unknown>) => ({
      isCrossRepository: false,
      author: { login: "example-owner" },
      mergeable: "CONFLICTING",
      mergeStateStatus: "DIRTY",
      headRefOid: "head1",
      labels: [],
      statusCheckRollup: [],
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
          ...(opts.prLabels ? { labels: opts.prLabels.map((name) => ({ name })) } : {}),
        }),
        ...(opts.extraPrs ?? []).map(prRow),
      ]),
    );
    writeFileSync(
      join(repoDir, "pr.json"),
      JSON.stringify({
        state: opts.prViewState ?? "OPEN",
        mergeable: opts.prViewMergeable ?? "CONFLICTING",
        statusCheckRollup: [],
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
    expect(res.status, res.stdout + res.stderr).toBe(opts.status ?? 0);
    return {
      stdout: res.stdout,
      launches: readLines("claude.log"),
      calls: gh(),
      state: readJson(join(state("app"), "launched.json")),
      attempts: readJson(join(state("app"), "conflicts.json")),
    };
  }

  const CONFLICT_LAUNCH =
    "--bg --name app-5-conflict --model opus --effort xhigh --permission-mode auto /ticket-workflow:resolve-conflicts 5";

  it("launches resolve-conflicts for a CONFLICTING issue PR and records it", () => {
    const r = runConflict({});
    expect(r.launches).toStrictEqual([CONFLICT_LAUNCH]);
    expect(r.state["conflict-5"]).toMatchObject({
      name: "app-5-conflict",
      pr: "9",
      mainSha: "sha1",
    });
    expect(r.attempts["5"]).toStrictEqual({ pr: "9", mainSha: "sha1" });
  });

  for (const mergeable of ["UNKNOWN", "MERGEABLE"]) {
    it(`does not launch for ${mergeable}`, () => {
      const r = runConflict({ mergeable });
      expect(r.launches).toStrictEqual([]);
      if (mergeable === "UNKNOWN")
        expect(r.stdout.includes("retry next poll")).toBe(true);
    });
  }

  it("ignores branches that are not issue-N-*", () => {
    expect(runConflict({ branch: "feature-x" }).launches).toStrictEqual([]);
  });

  for (const st of ["working", "blocked"]) {
    it(`skips when the ticket session is ${st}`, () => {
      const r = runConflict({ sessions: [{ name: "app-5", state: st }] });
      expect(r.launches).toStrictEqual([]);
    });
  }

  for (const st of ["idle", "done"]) {
    it(`still launches when the ticket session is ${st}`, () => {
      const r = runConflict({ sessions: [{ name: "app-5", state: st }] });
      expect(r.launches.length).toBe(1);
    });
  }

  it("skips when a live conflict session exists", () => {
    const r = runConflict({
      sessions: [{ name: "app-5-conflict", state: "working" }],
    });
    expect(r.launches).toStrictEqual([]);
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
    expect(r.launches).toStrictEqual([]);
  });

  it("does not repeat an attempt against the same main SHA", () => {
    const r = runConflict({ attempts: { 5: { pr: "9", mainSha: "sha1" } } });
    expect(r.launches).toStrictEqual([]);
  });

  it("retries when main has moved", () => {
    const r = runConflict({
      attempts: { 5: { pr: "9", mainSha: "old" } },
      sha: "sha2",
    });
    expect(r.launches.length).toBe(1);
    expect(r.attempts["5"]).toStrictEqual({ pr: "9", mainSha: "sha2" });
  });

  it("skips a PR whose issue cannot be read and still launches later ones", () => {
    const r = runConflict({
      branch: "issue-7-gone",
      failIssues: [7],
      extraPrs: [{ number: 10, headRefName: "issue-5-thing" }],
    });
    expect(r.stdout.includes("#7: cannot read issue")).toBe(true);
    expect(r.launches).toStrictEqual([CONFLICT_LAUNCH]);
  });

  it("skips the phase without failing when main SHA cannot be read", () => {
    const r = runConflict({ failApi: true });
    expect(r.stdout.includes("cannot read main SHA")).toBe(true);
    expect(r.launches).toStrictEqual([]);
  });

  it("skips tickets that are not agent-ok", () => {
    expect(runConflict({ labels: ["needs-review"] }).launches).toStrictEqual([]);
  });

  it("skips tickets with agent-failed", () => {
    expect(runConflict({ labels: ["agent-ok", "agent-failed"] }).launches).toStrictEqual([]);
  });

  it("launches no conflict session for a PR labelled orchestrate-epic-run", () => {
    const r = runConflict({ labels: ["agent-ok"], prLabels: ["orchestrate-epic-run"] });
    expect(r.launches).toStrictEqual([]);
    expect(r.state).toStrictEqual({});
  });

  it("skips tickets by another author", () => {
    expect(runConflict({ author: "someone" }).launches).toStrictEqual([]);
  });

  it("skips a PR from a fork, even on an issue-N-* branch", () => {
    const r = runConflict({ crossRepo: true });
    expect(r.launches).toStrictEqual([]);
    expect(r.stdout.includes("#5: PR #9 is from a fork; skipping"), r.stdout).toBe(true);
    expect(r.state).toStrictEqual({});
    expect(r.attempts).toStrictEqual({});
  });

  it("never resolves a PR without isCrossRepository: the repo's poll fails", () => {
    const r = runConflict({ crossRepo: undefined, status: 1 });
    expect(r.launches).toStrictEqual([]);
    expect(r.stdout).toMatch(/\[app\] poll failed: gh pr list: \[0\]\.isCrossRepository/);
    expect(!r.calls.some((c) => c.startsWith("issue view")), r.calls.join("\n")).toBe(true);
    expect(r.attempts).toStrictEqual({});
  });

  it("skips a same-repo PR by another author", () => {
    const r = runConflict({ prAuthor: "someone" });
    expect(r.launches).toStrictEqual([]);
    expect(r.stdout.includes("#5: PR #9 author someone is not example-owner; skipping"), r.stdout).toBe(true);
  });

  it("does not read the issue for an untrusted PR", () => {
    const r = runConflict({ crossRepo: true });
    expect(!r.calls.some((c) => c.startsWith("issue view")), r.calls.join("\n")).toBe(true);
  });

  it("skips a closed ticket", () => {
    const r = runConflict({ issueState: "CLOSED" });
    expect(r.launches).toStrictEqual([]);
    expect(r.stdout.includes("#5: issue is not open"), r.stdout).toBe(true);
  });

  it("skips a fork PR and still launches for the owner's PR on the same ticket", () => {
    const r = runConflict({
      branch: "issue-5-fork",
      crossRepo: true,
      prAuthor: "someone",
      extraPrs: [{ number: 10, headRefName: "issue-5-thing" }],
    });
    expect(r.launches).toStrictEqual([CONFLICT_LAUNCH]);
    expect(r.state["conflict-5"].pr).toBe("10");
    expect(r.attempts["5"]).toStrictEqual({ pr: "10", mainSha: "sha1" });
  });

  it("dry-run logs the launch without launching or writing state", () => {
    const r = runConflict({ dry: true });
    expect(r.stdout.includes("[dry-run]")).toBe(true);
    expect(r.stdout.includes("resolve-conflicts 5")).toBe(true);
    expect(r.launches).toStrictEqual([]);
    expect(r.state).toStrictEqual({});
    expect(r.attempts).toStrictEqual({});
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
  interface ConflictReconcileOpts {
    sessions: { name: string; state: string }[];
    mergeable?: string;
    prViewState?: string;
    prViewMergeable?: string;
  }

  function runConflict(opts: ConflictReconcileOpts) {
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
          headRefOid: "head1",
          labels: [],
          statusCheckRollup: [],
        },
      ]),
    );
    writeFileSync(
      join(repoDir, "pr.json"),
      JSON.stringify({
        state: opts.prViewState ?? "OPEN",
        mergeable: opts.prViewMergeable ?? "CONFLICTING",
        statusCheckRollup: [],
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
    expect(res.status, res.stdout + res.stderr).toBe(0);
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
      expect(
        r.calls.includes(
          "issue edit 5 --repo example-owner/example-app --add-label agent-failed",
        ),
      ).toBe(true);
      expect(r.calls.some((c) => c.startsWith("pr comment 9"))).toBe(true);
      expect(r.calls.some((c) => c.startsWith("issue comment 5"))).toBe(true);
      expect(r.state).toStrictEqual({});
    });
  }

  it("fails a done session whose PR still conflicts", () => {
    const r = runConflict({
      sessions: [{ name: "app-5-conflict", state: "done" }],
    });
    expect(r.calls.some((c) => c.includes("agent-failed"))).toBe(true);
    expect(r.calls.some((c) => c.startsWith("pr comment 9"))).toBe(true);
    expect(r.state).toStrictEqual({});
  });

  it("cleans up a done session whose conflict is resolved", () => {
    const r = runConflict({
      sessions: [{ name: "app-5-conflict", state: "done" }],
      prViewMergeable: "MERGEABLE",
      mergeable: "MERGEABLE",
    });
    expect(!r.calls.some((c) => c.includes("agent-failed"))).toBe(true);
    expect(r.state).toStrictEqual({});
  });

  for (const prViewState of ["CLOSED", "MERGED"]) {
    it(`does not fail a done session whose PR is ${prViewState}`, () => {
      const r = runConflict({
        sessions: [{ name: "app-5-conflict", state: "done" }],
        prViewState,
        mergeable: "MERGEABLE",
      });
      expect(!r.calls.some((c) => c.includes("agent-failed"))).toBe(true);
      expect(r.state).toStrictEqual({});
    });
  }

  it("keeps a working conflict session", () => {
    const r = runConflict({
      sessions: [{ name: "app-5-conflict", state: "working" }],
    });
    expect(!r.calls.some((c) => c.includes("agent-failed"))).toBe(true);
    expect(r.state["conflict-5"]).toBeTruthy();
  });
});

describe("agent-poller CI phase", () => {
  const FAILED_RUN = { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "FAILURE" };
  const PASSED_RUN = { __typename: "CheckRun", name: "lint", status: "COMPLETED", conclusion: "SUCCESS" };
  const RED = [PASSED_RUN, FAILED_RUN];

  interface CiOpts {
    sessions?: { name: string; state: string }[];
    launched?: Record<string, unknown>;
    ciAttempts?: Record<string, unknown>;
    prViewChecks?: unknown[];
    dry?: boolean;
  }

  // A same-repo, owner-authored, MERGEABLE issue-5 PR (#9) at head1 with a failed check.
  function runCi(opts: CiOpts) {
    configure();
    const repoDir = rdir(APP.repo);
    writeFileSync(
      join(dir, "sessions.json"),
      JSON.stringify((opts.sessions ?? []).map((s) => ({ ...s, startedAt: 1 }))),
    );
    mkdirSync(state("app"), { recursive: true });
    writeFileSync(join(state("app"), "launched.json"), JSON.stringify(opts.launched ?? {}));
    if (opts.ciAttempts)
      writeFileSync(join(state("app"), "ci-attempts.json"), JSON.stringify(opts.ciAttempts));
    writeFileSync(join(repoDir, "sha"), "sha1");
    writeFileSync(
      join(repoDir, "prs.json"),
      JSON.stringify([
        {
          number: 9,
          headRefName: "issue-5-thing",
          headRefOid: "head1",
          isCrossRepository: false,
          author: { login: "example-owner" },
          mergeable: "MERGEABLE",
          mergeStateStatus: "UNSTABLE",
          labels: [],
          statusCheckRollup: RED,
        },
      ]),
    );
    writeFileSync(
      join(repoDir, "pr.json"),
      JSON.stringify({
        state: "OPEN",
        mergeable: "MERGEABLE",
        statusCheckRollup: opts.prViewChecks ?? RED,
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
    const res = exec({ dry: opts.dry });
    expect(res.status, res.stdout + res.stderr).toBe(0);
    const ciFile = join(state("app"), "ci-attempts.json");
    return {
      stdout: res.stdout,
      launches: readLines("claude.log"),
      calls: gh(),
      state: readJson(join(state("app"), "launched.json")),
      ciAttempts: existsSync(ciFile) ? readJson(ciFile) : undefined,
    };
  }

  it("launches `app-N-ci` for a red PR and writes `launched.json` and `ci-attempts.json` (AC1)", () => {
    const r = runCi({});
    expect(r.launches).toStrictEqual([
      "--bg --name app-5-ci --model opus --effort xhigh --permission-mode auto /ticket-workflow:fix-ci 5",
    ]);
    expect(r.state["ci-5"]).toMatchObject({ name: "app-5-ci", pr: "9" });
    expect(r.ciAttempts).toStrictEqual({ 9: { headSha: "head1", count: 1 } });
  });

  it("dry run logs the launch and writes no state (AC1)", () => {
    const r = runCi({ dry: true });
    expect(r.stdout, r.stdout).toMatch(/\[dry-run\] \(cd .* && claude --bg --name app-5-ci .*"\/ticket-workflow:fix-ci 5"\)/);
    expect(r.launches).toStrictEqual([]);
    expect(r.state).toStrictEqual({});
    expect(r.ciAttempts).toBeUndefined();
  });

  it("skips with a log while ticket N's session is working (AC2)", () => {
    const r = runCi({ sessions: [{ name: "app-5", state: "working" }] });
    expect(r.launches).toStrictEqual([]);
    expect(r.stdout, r.stdout).toMatch(/\[app\] #5: PR #9 .*app-5.*skipping/);
    expect(r.state).toStrictEqual({});
  });

  it("marks `agent-failed` and comments when a done ci session leaves CI red (AC3)", () => {
    const r = runCi({
      sessions: [{ name: "app-5-ci", state: "done" }],
      launched: {
        "ci-5": { name: "app-5-ci", at: Math.floor(Date.now() / 1000) - 3600, pr: "9" },
      },
      ciAttempts: { 9: { headSha: "head1", count: 1 } },
    });
    expect(r.calls, r.calls.join("\n")).toContain(
      "issue edit 5 --repo example-owner/example-app --add-label agent-failed",
    );
    expect(r.calls.some((c) => c.startsWith("pr comment 9"))).toBe(true);
    expect(r.calls.some((c) => c.startsWith("issue comment 5"))).toBe(true);
    expect(r.state).toStrictEqual({});
    expect(r.ciAttempts).toStrictEqual({ 9: { headSha: "head1", count: 1 } });
    expect(r.launches).toStrictEqual([]);
  });
});

describe("agent-poller multiple repos", () => {
  const A = { repo: "org/alpha", sessionPrefix: "a", owner: "me" };
  const B = { repo: "org/beta", sessionPrefix: "b", owner: "you" };

  const issue = (number: number, author: string, labels: string[]) => ({
    number,
    author: { login: author },
    labels: labels.map((name) => ({ name })),
  });
  const writeIssues = (repo: string, issues: unknown[]) =>
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
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(
      r.stdout.includes(
        `[dry-run] (cd ${ea.dir} && claude --bg --name a-3 --model opus --effort xhigh --permission-mode auto "/ticket-workflow:work-ticket 3")`,
      ),
      r.stdout,
    ).toBe(true);
    expect(
      r.stdout.includes(
        `[dry-run] (cd ${eb.dir} && claude --bg --name b-6 --model opus --effort xhigh --permission-mode auto "/ticket-workflow:work-ticket 6 auto")`,
      ),
      r.stdout,
    ).toBe(true);
    expect(r.stdout.match(/--bg --name/g)!.length).toBe(2);
    expect(readLines("claude.log").length).toBe(0);
    const calls = gh();
    for (const repo of [A.repo, B.repo])
      expect(calls.some((c) => c.startsWith(`issue list --repo ${repo} `)), `issue list for ${repo}`).toBe(true);
    expect(r.stdout.includes("[a] ")).toBe(true);
    expect(r.stdout.includes("[b] ")).toBe(true);
  });

  it("same ticket number in two repos gets distinct names and separate state", () => {
    const [ea, eb] = configure([A, B]);
    writeIssues(A.repo, [issue(5, "me", ["agent-ok", "ready"])]);
    writeIssues(B.repo, [issue(5, "you", ["agent-ok", "ready"])]);
    const r = exec();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readLines("claude.log").sort()).toStrictEqual([
      "--bg --name a-5 --model opus --effort xhigh --permission-mode auto /ticket-workflow:work-ticket 5",
      "--bg --name b-5 --model opus --effort xhigh --permission-mode auto /ticket-workflow:work-ticket 5",
    ]);
    const cwds = readLines("claude.cwd.log");
    expect(cwds.some((l) => l.startsWith(`${realpath(ea.dir)}|`) && l.includes("a-5"))).toBe(true);
    expect(cwds.some((l) => l.startsWith(`${realpath(eb.dir)}|`) && l.includes("b-5"))).toBe(true);
    const sa = readJson(join(state("a"), "launched.json"));
    const sb = readJson(join(state("b"), "launched.json"));
    expect(sa["5"].name).toBe("a-5");
    expect(sb["5"].name).toBe("b-5");
    expect(existsSync(join(state("a"), "conflicts.json"))).toBe(true);
    expect(existsSync(join(state("b"), "conflicts.json"))).toBe(true);
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
    expect(r.status, r.stdout + r.stderr).toBe(0);
    const calls = gh();
    expect(calls.some((c) => c.startsWith("issue edit 5 --repo org/alpha"))).toBe(true);
    expect(!calls.some((c) => c.startsWith("issue edit 5 --repo org/beta"))).toBe(true);
    expect(readJson(join(state("a"), "launched.json"))).toStrictEqual({});
    expect(readJson(join(state("b"), "launched.json"))["5"]).toBeTruthy();
  });

  it("one repo failing does not stop the others", () => {
    configure([A, B]);
    writeFileSync(join(rdir(A.repo), "fail-all"), "");
    writeIssues(B.repo, [issue(6, "you", ["agent-ok", "ready"])]);
    const r = exec();
    expect(r.status).not.toBe(0);
    expect(/\[a\] .*poll failed/.test(r.stdout), r.stdout).toBe(true);
    expect(readLines("claude.log")).toStrictEqual([
      "--bg --name b-6 --model opus --effort xhigh --permission-mode auto /ticket-workflow:work-ticket 6",
    ]);
    // errexit is active inside the failed repo: it stopped at the failing call.
    expect(!gh().some((c) => c.startsWith("pr list --repo org/alpha"))).toBe(true);
    expect(gh().some((c) => c.startsWith("pr list --repo org/beta"))).toBe(true);
  });
});

describe("agent-poller launch flags", () => {
  const A = { repo: "org/alpha", sessionPrefix: "a", owner: "me" };
  const ready = (number: number) => ({
    number,
    author: { login: "me" },
    labels: [{ name: "agent-ok" }, { name: "ready" }],
  });
  const writeIssues = (repo: string, issues: unknown[]) =>
    writeFileSync(join(rdir(repo), "issues.json"), JSON.stringify(issues));

  it("launches with exactly --model opus --effort xhigh --permission-mode auto, ignoring CLAUDE_BG_FLAGS and CLAUDE_ALLOW_BYPASS_PERMISSIONS", () => {
    configure([A]);
    writeIssues(A.repo, [ready(1)]);
    const r = exec({
      env: {
        CLAUDE_BG_FLAGS: "--dangerously-skip-permissions --permission-mode acceptEdits",
        CLAUDE_ALLOW_BYPASS_PERMISSIONS: "1",
      },
    });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readLines("claude.log")).toStrictEqual([
      "--bg --name a-1 --model opus --effort xhigh --permission-mode auto /ticket-workflow:work-ticket 1",
    ]);
  });

  it("logs the launch flags", () => {
    configure([A]);
    writeIssues(A.repo, [ready(1)]);
    const r = exec();
    expect(r.stdout).toMatch(/#1: launching a-1 \(flags: --model opus --effort xhigh --permission-mode auto\)/);
  });

  it("logs the launch flags on conflict launches too", () => {
    configure([A]);
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
          headRefOid: "head1",
          labels: [],
          statusCheckRollup: [],
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
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/launching a-5-conflict \(flags: --model opus --effort xhigh --permission-mode auto\)/);
  });
});

describe("agent-poller session cap", () => {
  const A = { repo: "org/alpha", sessionPrefix: "a", owner: "me" };
  const B = { repo: "org/beta", sessionPrefix: "b", owner: "me" };
  const ready = (number: number) => ({
    number,
    author: { login: "me" },
    labels: [{ name: "agent-ok" }, { name: "ready" }],
  });
  const writeIssues = (repo: string, issues: unknown[]) =>
    writeFileSync(join(rdir(repo), "issues.json"), JSON.stringify(issues));
  const launchedState = (prefix: string, names: string[]) => {
    mkdirSync(state(prefix), { recursive: true });
    const at = Math.floor(Date.now() / 1000) - 60;
    const o: Record<string, { name: string; at: number }> = {};
    for (const name of names) o[name.split("-")[1]] = { name, at };
    writeFileSync(join(state(prefix), "launched.json"), JSON.stringify(o));
  };
  const sessions = (list: [string, string][]) =>
    writeFileSync(
      join(dir, "sessions.json"),
      JSON.stringify(list.map(([name, st]) => ({ name, state: st, startedAt: 1 }))),
    );
  const tracked = (prefix: string) =>
    Object.keys(readJson(join(state(prefix), "launched.json")));

  it("defaults to 10 sessions: the 11th ready ticket is deferred", () => {
    configure([A]);
    writeIssues(A.repo, Array.from({ length: 11 }, (_, i) => ready(i + 1)));
    const r = exec();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readLines("claude.log").length).toBe(10);
    expect(r.stdout).toMatch(/deferred #11: at session cap/);
    expect(tracked("a").includes("11")).toBe(false);
  });

  it("CLAUDE_MAX_SESSIONS raises the default", () => {
    configure([A]);
    writeIssues(A.repo, Array.from({ length: 11 }, (_, i) => ready(i + 1)));
    const r = exec({ env: { CLAUDE_MAX_SESSIONS: "11" } });
    expect(readLines("claude.log").length).toBe(11);
    expect(r.stdout).not.toMatch(/deferred/);
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
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readLines("claude.log")).toStrictEqual([]);
    expect(r.stdout).toMatch(/\[a\] deferred #3: at session cap/);
    expect(tracked("a")).toStrictEqual(["1"]);

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
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readLines("claude.log")).toStrictEqual([
      "--bg --name a-3 --model opus --effort xhigh --permission-mode auto /ticket-workflow:work-ticket 3",
    ]);
    expect(tracked("a").sort()).toStrictEqual(["1", "3"]);
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
    expect(r.stdout).toMatch(/deferred #9: at session cap/);
    expect(readLines("claude.log")).toStrictEqual([]);
  });

  for (const st of ["done", "failed", "stopped", "working"]) {
    it(`another repo's ${st} session (not yet reconciled) ${st === "working" ? "counts toward" : "does not count toward"} the global cap`, () => {
      configure([A, B]);
      launchedState("b", ["b-1"]);
      sessions([["b-1", st]]);
      writeIssues(A.repo, [ready(2)]);
      const r = exec({ env: { CLAUDE_MAX_SESSIONS: "1" } });
      expect(readLines("claude.log").length).toBe(st === "working" ? 0 : 1);
      if (st === "working") expect(r.stdout).toMatch(/deferred #2/);
    });
  }

  it("stops launching within a run once the cap is reached", () => {
    configure([A, B]);
    writeIssues(A.repo, [ready(1), ready(2)]);
    writeIssues(B.repo, [ready(3)]);
    const r = exec({ env: { CLAUDE_MAX_SESSIONS: "2" } });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readLines("claude.log")).toStrictEqual([
      "--bg --name a-1 --model opus --effort xhigh --permission-mode auto /ticket-workflow:work-ticket 1",
      "--bg --name a-2 --model opus --effort xhigh --permission-mode auto /ticket-workflow:work-ticket 2",
    ]);
    expect(r.stdout).toMatch(/\[b\] deferred #3: at session cap/);
  });

  it("per-repo maxSessions caps only that repo", () => {
    configure([{ ...A, maxSessions: 1 }, B]);
    launchedState("a", ["a-1"]);
    sessions([["a-1", "working"]]);
    writeIssues(A.repo, [ready(2)]);
    writeIssues(B.repo, [ready(3), ready(4)]);
    const r = exec();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/\[a\] deferred #2: at session cap/);
    expect(readLines("claude.log")).toStrictEqual([
      "--bg --name b-3 --model opus --effort xhigh --permission-mode auto /ticket-workflow:work-ticket 3",
      "--bg --name b-4 --model opus --effort xhigh --permission-mode auto /ticket-workflow:work-ticket 4",
    ]);
  });

  it("per-repo maxSessions counts launches made earlier in the same run", () => {
    configure([{ ...A, maxSessions: 1 }]);
    writeIssues(A.repo, [ready(1), ready(2)]);
    const r = exec();
    expect(readLines("claude.log")).toStrictEqual([
      "--bg --name a-1 --model opus --effort xhigh --permission-mode auto /ticket-workflow:work-ticket 1",
    ]);
    expect(r.stdout).toMatch(/deferred #2: at session cap/);
  });

  it("accepts maxSessions written as 1.0 and still enforces it", () => {
    writeFileSync(join(dir, "x"), "");
    configure([{ ...A, maxSessions: 1 }]);
    // JSON.stringify turns 1 into "1", so write the float form into the config by hand.
    const cfg = readFileSync(join(dir, "repos.json"), "utf8").replace(
      '"maxSessions":1',
      '"maxSessions":1.0',
    );
    expect(cfg).toMatch(/1\.0/);
    writeFileSync(join(dir, "repos.json"), cfg);
    writeIssues(A.repo, [ready(1), ready(2)]);
    const r = exec();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readLines("claude.log").length).toBe(1);
    expect(r.stdout).toMatch(/deferred #2: at session cap/);
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
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readLines("claude.log")).toStrictEqual([
      "--bg --name a-3 --model opus --effort xhigh --permission-mode auto /ticket-workflow:work-ticket 3",
    ]);
  });

  it("dry run honours the cap with an in-memory count and writes no state", () => {
    configure([A]);
    writeIssues(A.repo, [ready(1), ready(2)]);
    const r = exec({ dry: true, env: { CLAUDE_MAX_SESSIONS: "1" } });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout.match(/\[dry-run\] \(cd/g)!.length).toBe(1);
    expect(r.stdout).toMatch(/deferred #2: at session cap/);
    expect(existsSync(state("a")), "a dry run writes no state files").toBe(false);
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
          headRefOid: "head1",
          labels: [],
          statusCheckRollup: [],
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
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/deferred #5: at session cap/);
    expect(readLines("claude.log")).toStrictEqual([]);
    expect(existsSync(join(state("a"), "conflicts.json")), "no attempt recorded").toBe(false);
    expect(tracked("a")).toStrictEqual(["7"]);

    r = exec({ env: { CLAUDE_MAX_SESSIONS: "2" } });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readLines("claude.log")).toStrictEqual([
      "--bg --name a-5-conflict --model opus --effort xhigh --permission-mode auto /ticket-workflow:resolve-conflicts 5",
    ]);
  });

  for (const v of ["0", "abc", "-1", "1.5", "01"]) {
    it(`aborts on invalid CLAUDE_MAX_SESSIONS=${v}`, () => {
      configure([A]);
      writeIssues(A.repo, [ready(1)]);
      const r = exec({ env: { CLAUDE_MAX_SESSIONS: v } });
      expect(r.status).not.toBe(0);
      expect(r.stdout).toMatch(/CLAUDE_MAX_SESSIONS=.* is not a positive integer/);
      expect(readLines("claude.log")).toStrictEqual([]);
    });
  }

  for (const bad of [0, -2, 1.5, "3", null, true]) {
    it(`rejects maxSessions=${JSON.stringify(bad)} in the config`, () => {
      configure([{ ...A, maxSessions: bad }]);
      const r = exec();
      expect(r.status).not.toBe(0);
      expect(r.stdout).toMatch(/\[0\]\.maxSessions: expected a positive integer/);
      expect(readLines("claude.log")).toStrictEqual([]);
    });
  }
});

describe("agent-poller firewall preflight", () => {
  const readyIssue = [{ number: 1, author: { login: APP.owner }, labels: [{ name: "agent-ok" }, { name: "ready" }] }];
  const reach = (...hosts: string[]) => writeFileSync(join(dir, "reach"), hosts.map((h) => `${h}\n`).join(""));

  it("refuses to launch, naming the URL, when https://example.com is reachable", () => {
    configure();
    writeFileSync(join(rdir(APP.repo), "issues.json"), JSON.stringify(readyIssue));
    reach("api.github.com", "example.com");
    const r = exec();
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toContain("https://example.com");
    expect(readLines("claude.log")).toStrictEqual([]);
  });

  it("refuses to launch, naming the URL, when https://api.github.com is not reachable", () => {
    configure();
    writeFileSync(join(rdir(APP.repo), "issues.json"), JSON.stringify(readyIssue));
    reach();
    const r = exec();
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toContain("https://api.github.com");
    expect(readLines("claude.log")).toStrictEqual([]);
  });

  it("a dry run logs that the firewall preflight passed", () => {
    configure();
    writeFileSync(join(rdir(APP.repo), "issues.json"), JSON.stringify(readyIssue));
    const r = exec({ dry: true });
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/firewall preflight passed/i);
    const urls = readLines("curl.log").join("\n");
    expect(urls).toContain("https://api.github.com");
    expect(urls).toContain("https://example.com");
  });
});

describe("agent-poller entrypoint", () => {
  it("logs and exits 1 when node is older than 24", () => {
    configure();
    // The fake bin dir is first on PATH, ahead of the runner's node, so this fake node wins.
    writeFileSync(
      join(dir, "bin", "node"),
      `#!/usr/bin/env bash\nif [ "$1" = "--version" ]; then echo v22.9.0; else echo 22; fi\n`,
    );
    chmodSync(join(dir, "bin", "node"), 0o755);
    const r = exec();
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toMatch(/node v22\.9\.0 at .*\/bin\/node is too old; the poller needs Node 24 or later; aborting/);
    expect(gh()).toStrictEqual([]);
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
        EXTRA_PATH: extraPath(),
        STATE_DIR: join(dir, "state"),
        CLAUDE_WORKFLOW_CONFIG: join(dir, "repos.json"),
      },
    });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toMatch(/dependencies are not installed in .*clone \(run npm ci there/);
    expect(gh()).toStrictEqual([]);
    expect(existsSync(join(dir, "state"))).toBe(false);
  });
});

describe("agent-poller failed tickets and broken state", () => {
  const A = { repo: "org/alpha", sessionPrefix: "a", owner: "me" };
  const B = { repo: "org/beta", sessionPrefix: "b", owner: "me" };
  const ready = (number: number) => ({
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
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(/\[dry-run\] gh issue edit 5 --repo org\/alpha --add-label agent-failed/);
    expect(r.stdout).toMatch(/#5: failed earlier in this poll; not relaunching/);
    expect(r.stdout).not.toMatch(/\[dry-run\] \(cd/);
    expect(readFileSync(join(state("a"), "launched.json"), "utf8")).toBe(launched);
  });

  it("a repo with unreadable state fails, and its listed live sessions still count toward the global cap", () => {
    configure([A, B]);
    mkdirSync(state("b"), { recursive: true });
    writeFileSync(join(state("b"), "launched.json"), "{corrupt");
    writeFileSync(join(dir, "sessions.json"), JSON.stringify([{ name: "b-1", state: "working", startedAt: 1 }]));
    writeFileSync(join(rdir(A.repo), "issues.json"), JSON.stringify([ready(2)]));
    const r = exec({ env: { CLAUDE_MAX_SESSIONS: "1" } });
    expect(r.status, r.stdout + r.stderr).toBe(1);
    expect(r.stdout).toMatch(/\[b\] poll failed: .*launched\.json: not valid JSON/);
    expect(r.stdout).toMatch(/\[a\] deferred #2: at session cap/);
    expect(readLines("claude.log")).toStrictEqual([]);
    expect(!gh().some((c) => c.includes("org/beta")), "nothing is read for the broken repo").toBe(true);
  });
});

describe("agent-poller run lock", () => {
  const lockWith = (pid: string | number) => {
    mkdirSync(join(dir, "state", "lock"), { recursive: true });
    writeFileSync(join(dir, "state", "lock", "pid"), `${pid}\n`);
  };
  const readyIssue = [{ number: 1, author: { login: APP.owner }, labels: [{ name: "agent-ok" }, { name: "ready" }] }];

  it("exits 0 without polling while another live run holds the lock", () => {
    configure();
    writeFileSync(join(rdir(APP.repo), "issues.json"), JSON.stringify(readyIssue));
    lockWith(process.pid); // this test process: alive
    const r = exec();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(r.stdout).toMatch(new RegExp(`another run is active \\(pid ${process.pid}\\); exiting`));
    expect(gh()).toStrictEqual([]);
    expect(readFileSync(join(dir, "state", "lock", "pid"), "utf8")).toBe(`${process.pid}\n`);
  });

  it("takes over a lock left by a process that is gone, and releases it after the run", () => {
    configure();
    writeFileSync(join(rdir(APP.repo), "issues.json"), JSON.stringify(readyIssue));
    const gone = spawnSync("bash", ["-c", "echo $$"], { encoding: "utf8" }).stdout.trim();
    lockWith(gone);
    const r = exec();
    expect(r.status, r.stdout + r.stderr).toBe(0);
    expect(readLines("claude.log").length).toBe(1);
    expect(existsSync(join(dir, "state", "lock"))).toBe(false);
  });
});

describe("agent-poller config validation", () => {
  const ok = { repo: "org/alpha", dir: "/tmp", sessionPrefix: "a", owner: "me" };

  function expectAbort(content: string | null, pattern: RegExp) {
    if (content !== null) writeFileSync(join(dir, "repos.json"), content);
    const r = exec();
    expect(r.status, r.stdout).not.toBe(0);
    expect(r.stdout).toMatch(pattern);
    expect(readLines("claude.log").length).toBe(0);
    expect(readLines("gh.log").length).toBe(0);
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
      const entry: Record<string, unknown> = { ...ok };
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
    expect(r.status).toBe(0);
  });
});

function realpath(p: string): string {
  return spawnSync("bash", ["-c", `cd ${JSON.stringify(p)} && pwd -P`], {
    encoding: "utf8",
  }).stdout.trim();
}
