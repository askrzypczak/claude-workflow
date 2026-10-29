// The credentials phase: pause dispatch, the restrict-updates ruleset, the fine-grained
// token, the pre-swap test, the login swap, the stray-token scan and the after-swap checks.
// docs/agent-credentials.md gives the reasons; this file carries them out.
import { join } from "node:path";
import { z } from "zod";
import { ENDED } from "../poller/decide.ts";
import { timestamp } from "../poller/io.ts";
import { parseJson } from "../poller/schemas.ts";
import type { RunOptions, RunResult, StepStatus } from "./io.ts";
import type { Phase, SetupContext } from "./main.ts";

const HOST = "github.com";
const LAUNCHD = "dispatch/install-launchd.sh";
const FINE_GRAINED = "github_pat_";
const RULESET = "restrict-updates";

/** The Repository admin role, which may bypass only by merging a pull request. */
const ADMIN_BYPASS = { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "pull_request" };

/** The ruleset that stops a workflow's GITHUB_TOKEN from updating the default branch. */
const RESTRICT_UPDATES = {
  name: RULESET,
  target: "branch",
  enforcement: "active",
  conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
  rules: [{ type: "update" }],
  bypass_actors: [ADMIN_BYPASS],
};

/** The token's six permissions, as the token form's URL parameters name them. */
const TOKEN_PERMISSIONS = {
  metadata: "read",
  contents: "read",
  actions: "read",
  statuses: "read",
  issues: "write",
  pull_requests: "write",
};

/** Labels the workflow acts on; the pre-swap test never adds one. */
const WORKFLOW_LABELS = new Set([
  "ready", "in-progress", "blocked", "needs-review", "agent-ok", "skip-plan", "agent-failed",
  "orchestrate-epic-run",
]);

const TOKEN_VARS = ["GH_TOKEN", "GITHUB_TOKEN"];
const STARTUP_FILES = [".zshenv", ".zprofile", ".zshrc", ".zlogin", ".bash_profile", ".bashrc", ".profile"];
/** The poller's LaunchAgent under the home directory, named by LABEL in dispatch/install-launchd.sh. */
const POLLER_PLIST = "Library/LaunchAgents/com.askrzypczak.claude-workflow-poller.plist";
const RELOGIN = "run gh auth login --hostname github.com --with-token, paste the token, press Enter and then Ctrl-D";

const Account = z.object({ login: z.string(), active: z.boolean().optional(), token: z.string().optional() });
type Account = z.infer<typeof Account>;
const AuthStatus = z.object({ hosts: z.record(z.string(), z.array(Account)) });
const RepoInfo = z.object({
  permissions: z.object({ admin: z.boolean().optional() }).optional(),
  allow_auto_merge: z.boolean().optional(),
});
const RulesetList = z.array(z.object({ id: z.number(), name: z.string() }));
const Rule = z.object({ type: z.string(), parameters: z.record(z.string(), z.unknown()).nullish() });
const BypassActor = z.object({
  actor_id: z.number().nullish(),
  actor_type: z.string(),
  bypass_mode: z.string().optional(),
});
const Ruleset = z.object({
  id: z.number(),
  target: z.string().nullish(),
  enforcement: z.string(),
  conditions: z
    .object({
      ref_name: z
        .object({ include: z.array(z.string()).optional(), exclude: z.array(z.string()).optional() })
        .optional(),
    })
    .nullish(),
  rules: z.array(Rule).optional(),
  bypass_actors: z.array(BypassActor).optional(),
  current_user_can_bypass: z.string().optional(),
});
type Ruleset = z.infer<typeof Ruleset>;
const Named = z.array(z.object({ name: z.string() }));
const RollupEntry = z.object({ __typename: z.string().optional(), name: z.string().nullish() });
const PrList = z.array(
  z.object({
    number: z.number(),
    mergeable: z.string().optional(),
    labels: Named.optional(),
    statusCheckRollup: z.array(RollupEntry).optional(),
  }),
);
const IssueList = z.array(z.object({ number: z.number(), labels: Named.optional() }));
const RunList = z.array(z.object({ databaseId: z.number() }));

/** One pass of the phase: the context, plus the reporter that keeps the token out of every line. */
interface Pass extends SetupContext {
  /** The pasted token once read; replaced in every reported line. */
  secret: string;
  say(status: StepStatus, text: string): void;
}

/** The first line of stderr, else of stdout, else the exit status. */
function answer(result: RunResult): string {
  const first = (text: string) => text.split("\n").map((l) => l.trim()).find((l) => l !== "");
  return first(result.stderr) ?? first(result.stdout) ?? `exit ${result.status}`;
}

/** A refused API write: gh's error line and the response body GitHub sent with it. */
function apiAnswer(result: RunResult): string {
  const body = result.stdout.trim().replace(/\s+/g, " ").slice(0, 500);
  const line = answer({ ...result, stdout: "" });
  return body === "" ? line : `${line}: ${body}`;
}

/** A read-only gh command's JSON; throws when the command failed. */
function parseRead<T extends z.ZodType>(schema: T, args: string[], result: RunResult): z.output<T> {
  const what = `gh ${args.join(" ")}`;
  if (result.status !== 0) throw new Error(`${what} failed: ${answer(result)}`);
  return parseJson(schema, result.stdout, what);
}

/** Runs a read-only gh command and parses its JSON; throws when it fails. */
function ghJson<T extends z.ZodType>(p: Pass, schema: T, args: string[]): z.output<T> {
  return parseRead(schema, args, p.io.run("gh", args));
}

/** The github.com accounts gh has stored. */
function accounts(p: Pass): Account[] {
  const result = p.io.run("gh", ["auth", "status", "--json", "hosts"]);
  try {
    return parseJson(AuthStatus, result.stdout, "gh auth status --json hosts").hosts[HOST] ?? [];
  } catch (err) {
    if (result.status !== 0) throw new Error(`gh auth status failed: ${answer(result)}`);
    throw err;
  }
}

// `gh auth status` masks the token unless asked for `--show-token`, keeping its prefix up to the
// last underscore (confirmed in gh 2.102.0's help), so a fine-grained token still reads `github_pat_`.
const isFineGrained = (account: Account) => account.token?.startsWith(FINE_GRAINED) ?? false;
const hasTestCheckRun = (rollup: readonly z.infer<typeof RollupEntry>[]) =>
  rollup.some((e) => e.__typename === "CheckRun" && e.name === "test");
const isUpdateRule = (rule: z.infer<typeof Rule>) =>
  rule.type === "update" && rule.parameters?.update_allows_fetch_and_merge !== true;
const isAdminBypass = (actor: z.infer<typeof BypassActor>) =>
  actor.actor_id === ADMIN_BYPASS.actor_id &&
  actor.actor_type === ADMIN_BYPASS.actor_type &&
  actor.bypass_mode === ADMIN_BYPASS.bypass_mode;

/** Step 1: pause dispatch, then refuse to go on while a session is live. */
function pauseDispatch(p: Pass): boolean {
  const script = join(p.clone, LAUNCHD);
  const status = p.io.run(script, ["status"]);
  if (status.status !== 0) throw new Error(`${LAUNCHD} status failed: ${answer(status)}`);
  const loaded = /^Loaded:\s*yes/m.test(status.stdout);
  const disabled = /^Disabled:\s*yes/m.test(status.stdout);
  if (disabled && !loaded) {
    p.say("already", "dispatch is paused");
  } else if (p.dryRun) {
    p.say("would", `pause dispatch: ${LAUNCHD} pause`);
  } else {
    const paused = p.io.run(script, ["pause"]);
    if (paused.status !== 0) {
      p.say("todo", `pausing dispatch failed (${answer(paused)}): run ${LAUNCHD} pause, then rerun`);
      return false;
    }
    p.say("done", `paused dispatch (${LAUNCHD} pause)`);
  }
  p.say("note", `dispatch stays paused until a full setup run passes every phase and resumes it, or until ${LAUNCHD} resume`);

  const live = p.io.listSessions().filter((s) => !ENDED.includes(s.state));
  for (const s of live) {
    p.say(
      "todo",
      s.name === undefined
        ? `an unnamed session is ${s.state}: stop it from claude agents`
        : `session ${s.name} is ${s.state}: stop it with claude stop ${s.name}`,
    );
  }
  if (live.length === 0) p.say("pass", "no live sessions in claude agents");
  return live.length === 0 || p.dryRun;
}

/** The restrict-updates ruleset as GitHub returns it to this login, or undefined when there is none. */
function readRuleset(p: Pass, repo: string): Ruleset | undefined {
  const found = ghJson(p, RulesetList, ["api", `repos/${repo}/rulesets`]).find((r) => r.name === RULESET);
  return found && ghJson(p, Ruleset, ["api", `repos/${repo}/rulesets/${found.id}`]);
}

function matchesWanted(r: Ruleset): boolean {
  const ref = r.conditions?.ref_name;
  const include = ref?.include ?? [];
  const rules = r.rules ?? [];
  const actors = r.bypass_actors ?? [];
  return (
    r.target === "branch" &&
    r.enforcement === "active" &&
    include.length === 1 &&
    include[0] === "~DEFAULT_BRANCH" &&
    (ref?.exclude ?? []).length === 0 &&
    rules.length === 1 &&
    isUpdateRule(rules[0]!) &&
    actors.length === 1 &&
    isAdminBypass(actors[0]!)
  );
}

/** Step 2 under an admin login: create restrict-updates, or put it back when it drifted. */
function ensureRuleset(p: Pass, repo: string, existing: Ruleset | undefined): boolean {
  const shape = "an update rule on the default branch; only the Repository admin role bypasses, for pull requests only";
  if (existing && matchesWanted(existing)) {
    p.say("already", `${repo}: ${RULESET} is in place (${shape})`);
    return true;
  }
  const verb = existing ? "reset" : "create";
  if (p.dryRun) {
    p.say("would", `${repo}: ${verb} the ${RULESET} ruleset (${shape})`);
    return true;
  }
  const endpoint = existing ? `repos/${repo}/rulesets/${existing.id}` : `repos/${repo}/rulesets`;
  const result = p.io.run("gh", ["api", "-X", existing ? "PUT" : "POST", endpoint, "--input", "-"], {
    input: JSON.stringify(RESTRICT_UPDATES),
  });
  if (result.status !== 0) {
    p.say(
      "todo",
      `${repo}: GitHub refused to ${verb} ${RULESET}: ${apiAnswer(result)}. See docs/agent-credentials.md, The Actions token: until the rule is in place, a workflow's token can still merge on this repo`,
    );
    return false;
  }
  p.say("done", `${repo}: ${existing ? "reset" : "created"} the ${RULESET} ruleset (${shape})`);
  return true;
}

/** Step 2 under an admin login: auto-merge off. */
function ensureAutoMergeOff(p: Pass, repo: string, allowAutoMerge: boolean | undefined): boolean {
  if (allowAutoMerge === false) {
    p.say("already", `${repo}: auto-merge is off`);
  } else if (allowAutoMerge === undefined) {
    p.say("note", `${repo}: auto-merge unchecked: GitHub did not return allow_auto_merge; check Settings > General in the browser`);
  } else if (p.dryRun) {
    p.say("would", `${repo}: turn auto-merge off`);
  } else {
    const result = p.io.run("gh", ["api", "-X", "PATCH", `repos/${repo}`, "-F", "allow_auto_merge=false"]);
    if (result.status !== 0) {
      p.say("todo", `${repo}: turning auto-merge off failed: ${apiAnswer(result)}; turn it off in the browser (Settings > General), then rerun`);
      return false;
    }
    p.say("done", `${repo}: turned auto-merge off`);
  }
  return true;
}

/**
 * The ruleset checks a login without admin rights can make: it exists, it is active, it holds
 * the update rule and this login may bypass it only by pull request. With `bypassList`, also
 * the bypass list when GitHub returns it.
 */
function checkRuleset(p: Pass, repo: string, r: Ruleset | undefined, prefix: string, bypassList: boolean): boolean {
  const fix = "fix it in the browser (Settings > Rules > Rulesets), then rerun";
  if (r === undefined) {
    p.say("todo", `${prefix}${repo}: there is no ${RULESET} ruleset: ${fix}`);
    return false;
  }
  let ok = true;
  const check = (passed: boolean, pass: string, fail: string) => {
    p.say(passed ? "pass" : "todo", `${prefix}${repo}: ${RULESET} ${passed ? pass : `${fail}: ${fix}`}`);
    ok &&= passed;
  };
  check(r.enforcement === "active", "enforcement is active", `enforcement is ${r.enforcement}, not active`);
  check((r.rules ?? []).some(isUpdateRule), "has the update rule", "has no update rule (Restrict updates)");
  const bypass = r.current_user_can_bypass ?? "not returned";
  check(
    bypass === "pull_requests_only",
    "bypass for this login is pull_requests_only",
    `bypass for this login is ${bypass}, not pull_requests_only`,
  );
  if (bypassList) {
    if (r.bypass_actors === undefined) {
      p.say(
        "note",
        `${prefix}${repo}: GitHub returns the bypass list of ${RULESET} only to logins that can edit it: in the browser, check it is the Repository admin role alone, For pull requests only, with nothing in Always allow`,
      );
    } else {
      check(
        r.bypass_actors.length === 1 && isAdminBypass(r.bypass_actors[0]!),
        "bypass list is the Repository admin role alone, for pull requests only",
        "bypass list is not the Repository admin role alone in pull_request mode",
      );
    }
  }
  return ok;
}

/** Step 2: per served repo, the ruleset and auto-merge; writes only under an admin login. */
function rulesetStep(p: Pass, active: Account | undefined): boolean {
  if (active === undefined) {
    p.say("todo", `gh has no ${HOST} login: run gh auth login, then rerun`);
    return p.dryRun;
  }
  const fineGrained = isFineGrained(active);
  p.say("note", `gh login: ${active.login}, with a ${fineGrained ? "fine-grained" : "classic"} token`);
  let ok = true;
  for (const { repo } of p.repos) {
    const args = ["api", `repos/${repo}`];
    const read = p.io.run("gh", args);
    if (fineGrained && read.status !== 0 && /HTTP 404/.test(read.stderr)) {
      p.say(
        "todo",
        `${repo}: the token cannot see this repo (HTTP 404): edit the token at https://${HOST}/settings/personal-access-tokens, select ${repo} under Repository access, then rerun`,
      );
      ok = false;
      continue;
    }
    const info = parseRead(RepoInfo, args, read);
    const ruleset = readRuleset(p, repo);
    if (!fineGrained && info.permissions?.admin === true) {
      if (!ensureRuleset(p, repo, ruleset) || !ensureAutoMergeOff(p, repo, info.allow_auto_merge)) return false;
      continue;
    }
    p.say(
      "note",
      `${repo}: this login has no admin rights here${fineGrained ? " (a fine-grained token never does)" : ""}, so nothing is changed and only the readable checks run`,
    );
    ok = checkRuleset(p, repo, ruleset, "", false) && ok;
    if (info.allow_auto_merge === undefined) {
      p.say("note", `${repo}: auto-merge unchecked: GitHub does not return allow_auto_merge to this login; check Settings > General in the browser`);
    } else if (info.allow_auto_merge) {
      p.say("todo", `${repo}: auto-merge is on: turn it off in the browser (Settings > General), then rerun`);
      ok = false;
    } else {
      p.say("pass", `${repo}: auto-merge is off`);
    }
  }
  return ok || p.dryRun;
}

/** The token form, pre-filled with everything GitHub's URL parameters allow. */
function tokenFormUrl(login: string | undefined): string {
  const params: Record<string, string> = {
    name: `claude-workflow-agents-${timestamp(new Date()).slice(0, 10)}`,
    description: "Agent sessions and the dispatch poller (claude-workflow); cannot merge",
    ...(login === undefined ? {} : { target_name: login }),
    ...TOKEN_PERMISSIONS,
  };
  const query = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
  return `https://github.com/settings/personal-access-tokens/new?${query.join("&")}`;
}

/** Step 3: open the pre-filled form and read the token; undefined under --dry-run or when none was pasted. */
function readToken(p: Pass, active: Account | undefined): string | undefined {
  const url = tokenFormUrl(active?.login);
  const select = p.repos.map((r) => r.repo).join(", ");
  if (p.dryRun) {
    p.say("would", `token: open the pre-filled token form ${url}`);
    p.say("would", `token: read the new token at a hidden prompt (in the form, select ${select})`);
    return undefined;
  }
  const opened = p.io.run("open", [url]);
  if (opened.status === 0) p.say("done", `token: opened the pre-filled token form ${url}`);
  else p.say("note", `token: could not open the browser (${answer(opened)}): open ${url}`);
  p.say("note", `token: in the form, under Repository access choose Only select repositories and select ${select}; choose an expiry; then Generate token and copy it`);
  const token = p.io.readSecret("Paste the new token (input hidden), then press Enter: ").trim();
  // Masked in later lines when it could be a token, that is 12 characters or more. A shorter
  // paste (a stray "y") is no secret, and masking it everywhere would garble the lines.
  if (token.length >= 12) p.secret = token;
  if (!token.startsWith(FINE_GRAINED)) {
    p.say("todo", "token: no fine-grained token was pasted (one starts github_pat_): rerun and paste the token the form generated");
    return undefined;
  }
  p.say("done", "token: read a fine-grained token (not shown)");
  return token;
}

interface Subject {
  repo: string;
  pr: number;
  issue: number;
  run: number;
  label: string;
}

/** What the pre-swap test works on, reported; a to-do when no served repo has all of it. */
function pickSubject(p: Pass): Subject | undefined {
  const subject = findSubject(p);
  if (subject === undefined) {
    p.say(
      "todo",
      "pre-swap test: no served repo has an open PR with a test check run, an open issue, a completed workflow run and a label that is neither on them nor one of the workflow's: open what is missing, then rerun",
    );
  } else {
    const { repo, pr, issue, run, label } = subject;
    p.say("note", `pre-swap test: it will use ${repo} PR #${pr}, issue #${issue}, run ${run} and label ${label}`);
  }
  return subject;
}

/** The first served repo with an open PR with a `test` check run, an open issue, a run and a free label. */
function findSubject(p: Pass): Subject | undefined {
  for (const { repo } of p.repos) {
    const prs = ghJson(p, PrList, [
      "pr", "list", "--repo", repo, "--state", "open", "--limit", "100", "--json", "number,labels,statusCheckRollup",
    ]);
    const pr = prs.find((x) => hasTestCheckRun(x.statusCheckRollup ?? []));
    if (pr === undefined) continue;
    const [issue] = ghJson(p, IssueList, [
      "issue", "list", "--repo", repo, "--state", "open", "--limit", "1", "--json", "number,labels",
    ]);
    // A completed run: an in-progress run has no log to read yet.
    const [run] = ghJson(p, RunList, [
      "run", "list", "--repo", repo, "--status", "completed", "--limit", "1", "--json", "databaseId",
    ]);
    if (issue === undefined || run === undefined) continue;
    const carried = new Set([...(pr.labels ?? []), ...(issue.labels ?? [])].map((l) => l.name.toLowerCase()));
    const label = ghJson(p, Named, ["label", "list", "--repo", repo, "--limit", "200", "--json", "name"])
      .map((l) => l.name)
      .find((name) => !WORKFLOW_LABELS.has(name.toLowerCase()) && !carried.has(name.toLowerCase()));
    if (label === undefined) continue;
    return { repo, pr: pr.number, issue: issue.number, run: run.databaseId, label };
  }
  return undefined;
}

/**
 * Step 4: one command per row of the permission table, with the token only as GH_TOKEN in the
 * child's environment, each judged by its output. The test comment and labels are removed.
 */
function preSwapTest(p: Pass, subject: Subject | undefined, token: string | undefined): boolean {
  if (subject === undefined || token === undefined) {
    p.say(
      "would",
      `pre-swap test: with the new token only in the child environment, run one command per permission against ${subject === undefined ? "a PR, issue and run (none found, above)" : "the PR, issue and run above"}, then delete the test comment and remove the label`,
    );
    return true;
  }
  const { repo, pr, issue, run, label } = subject;

  const asToken: RunOptions = { env: { GH_TOKEN: token } };
  const R = ["--repo", repo];
  const failed: string[] = [];
  const check = (name: string, args: string[], judge = (r: RunResult) => r.status === 0): RunResult => {
    const result = p.io.run("gh", args, asToken);
    const passed = judge(result);
    p.say(passed ? "pass" : "fail", `pre-swap: ${name}${passed ? "" : `: ${answer(result)}`}`);
    if (!passed) failed.push(name);
    return result;
  };
  /** Runs a cleanup command as the token, then as the current login; a note when both fail. */
  const cleanUp = (name: string, args: string[], byHand: string) => {
    if (check(name, args).status === 0) return;
    if (p.io.run("gh", args).status !== 0) p.say("note", `pre-swap: ${byHand}`);
  };
  const labelRoundTrip = (kind: "issue" | "pr", n: number) => {
    const edit = [kind, "edit", String(n), ...R];
    if (check(`gh ${kind} edit ${n} --add-label ${label}`, [...edit, "--add-label", label]).status !== 0) return;
    cleanUp(`gh ${kind} edit ${n} --remove-label ${label}`, [...edit, "--remove-label", label], `remove the label ${label} from ${repo} #${n} by hand`);
  };

  check(`gh issue view ${issue}`, ["issue", "view", String(issue), ...R, "--json", "number,state"]);
  check(`gh api repos/${repo}/issues/${issue}`, ["api", `repos/${repo}/issues/${issue}`, "--jq", ".author_association"]);
  const comment = check(`gh issue comment ${issue}`, [
    "issue", "comment", String(issue), ...R, "--body", "Token test by dispatch/setup-agents.sh; deleted right away.",
  ]);
  if (comment.status === 0) {
    const url = comment.stdout.trim();
    const id = /#issuecomment-(\d+)/.exec(url)?.[1];
    if (id === undefined) {
      p.say("note", `pre-swap: delete the test comment on ${repo} #${issue} by hand (${url})`);
    } else {
      cleanUp(
        "gh api -X DELETE (the test comment)",
        ["api", "-X", "DELETE", `repos/${repo}/issues/comments/${id}`],
        `delete the test comment by hand: ${url}`,
      );
    }
  }
  labelRoundTrip("issue", issue);
  check(`gh pr view ${pr} --json mergeable`, ["pr", "view", String(pr), ...R, "--json", "mergeable"]);
  check(`gh api repos/${repo}/pulls/${pr}`, ["api", `repos/${repo}/pulls/${pr}`, "--jq", ".author_association"]);
  check(`gh pr diff ${pr}`, ["pr", "diff", String(pr), ...R]);
  labelRoundTrip("pr", pr);
  check(`gh pr checks ${pr} (a test row)`, ["pr", "checks", String(pr), ...R], judgePrChecks);
  check(`gh pr view ${pr} --json statusCheckRollup (a test check run)`, [
    "pr", "view", String(pr), ...R, "--json", "statusCheckRollup",
  ], judgeRollup);
  check(`gh run view ${run} --log`, ["run", "view", String(run), ...R, "--log"]);
  check(`gh api repos/${repo}/commits/main`, ["api", `repos/${repo}/commits/main`, "--jq", ".sha"]);
  check("gh label list", ["label", "list", ...R, "--limit", "5"]);
  check(`gh api repos/${repo}/rulesets`, ["api", `repos/${repo}/rulesets`]);

  if (failed.length > 0) {
    p.say(
      "todo",
      `pre-swap test: ${failed.length} command(s) failed with the new token (above), so the login is not swapped and the current login stays; file a ticket with the failed commands and their output`,
    );
    return false;
  }
  p.say("pass", "pre-swap test: every command passed with the new token");
  return true;
}

/** Step 5: replace every stored github.com login with the token. */
function swapLogin(p: Pass, token: string | undefined): boolean {
  if (token === undefined) {
    p.say("would", "login swap: gh auth logout for each github.com account, then gh auth login --with-token with the new token on stdin");
    return true;
  }
  // Log out first, then log in. Both tokens belong to the same GitHub user, so logging in
  // first and then running `gh auth logout --user <login>` would remove the new login too.
  for (const account of accounts(p)) {
    const out = p.io.run("gh", ["auth", "logout", "--hostname", HOST, "--user", account.login]);
    if (out.status !== 0) {
      p.say("todo", `login swap: gh auth logout --hostname ${HOST} --user ${account.login} failed (${answer(out)}): run it, then ${RELOGIN}, then rerun`);
      return false;
    }
  }
  const login = p.io.run("gh", ["auth", "login", "--hostname", HOST, "--with-token"], { input: `${token}\n` });
  if (login.status !== 0) {
    p.say("todo", `login swap: gh auth login failed (${answer(login)}) and gh has no ${HOST} login now: ${RELOGIN}, then rerun`);
    return false;
  }
  p.say("done", `login swap: gh now uses the new fine-grained token for ${HOST}`);
  return true;
}

/** MCP servers that look like GitHub's: `github` in the name, command, args or url. */
function githubServers(servers: unknown): string[] {
  if (typeof servers !== "object" || servers === null) return [];
  return Object.entries(servers as Record<string, unknown>)
    .filter(([name, server]) => {
      const s = (typeof server === "object" && server !== null ? server : {}) as Record<string, unknown>;
      const args = Array.isArray(s.args) ? s.args : [];
      return [name, s.command, s.url, ...args].some((v) => typeof v === "string" && /github/i.test(v));
    })
    .map(([name]) => name);
}

/** Step 6: other GitHub tokens on the machine, reported by place, never by value; changes nothing. */
function scanStrayTokens(p: Pass): number {
  let found = 0;
  const todo = (text: string) => {
    p.say("todo", `stray token: ${text}`);
    found++;
  };

  for (const name of TOKEN_VARS) {
    if (p.io.env(name)) todo(`${name} is set in this shell (gh prefers it over the stored login): remove its export and open a new terminal`);
  }
  /** Each line of a text file that names GH_TOKEN or GITHUB_TOKEN, by line number only. */
  const lines = (shown: string, path: string, fix: string) => {
    (p.io.readFile(path)?.split("\n") ?? []).forEach((line, i) => {
      const named = TOKEN_VARS.filter((v) => new RegExp(`(?<![A-Za-z0-9_])${v}(?![A-Za-z0-9_])`).test(line));
      if (named.length > 0) todo(`${shown}:${i + 1} names ${named.join(" and ")}: ${fix}`);
    });
  };
  for (const file of STARTUP_FILES) lines(`~/${file}`, join(p.home, file), "remove that line by hand");
  lines(
    `~/${POLLER_PLIST}`,
    join(p.home, POLLER_PLIST),
    "remove that variable from the poller's EnvironmentVariables by hand (the poller's gh would use it over the stored login)",
  );

  const keychain = p.io.run("security", ["find-internet-password", "-s", HOST]);
  if (keychain.status === 0) {
    todo(
      `the macOS keychain holds a ${HOST} internet password (security find-internet-password -s ${HOST}): a token a git credential helper stored, or a password saved for the ${HOST} website; check which in Keychain Access, then delete it there`,
    );
  } else if (keychain.status !== 44) {
    p.say("note", `stray token: could not search the keychain (${answer(keychain)}): look for ${HOST} in Keychain Access`);
  }
  const credentials = p.io.readFile(join(p.home, ".git-credentials"))?.split("\n") ?? [];
  credentials.forEach((line, i) => {
    if (line.includes(HOST)) todo(`~/.git-credentials:${i + 1} stores a ${HOST} credential: remove that line by hand`);
  });

  /** A JSON file's top-level object, or undefined when it is missing (a note when it is not JSON). */
  const jsonObject = (path: string, shown: string): Record<string, unknown> | undefined => {
    const text = p.io.readFile(path);
    if (text === undefined) return undefined;
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      p.say("note", `stray token: ${shown} is not valid JSON: check it for GitHub tokens by hand`);
      return undefined;
    }
    return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
  };

  const settings = jsonObject(join(p.home, ".claude/settings.json"), "~/.claude/settings.json");
  const env = settings?.env;
  if (typeof env === "object" && env !== null) {
    for (const name of TOKEN_VARS.filter((v) => v in env)) {
      todo(`~/.claude/settings.json sets ${name} in its env block, which every Claude Code session gets: remove it by hand`);
    }
  }

  const mcp = (path: string, shown: string, scopes: (config: Record<string, unknown>) => [string, unknown][]) => {
    const config = jsonObject(path, shown);
    if (config === undefined) return;
    for (const [scope, servers] of scopes(config)) {
      for (const name of githubServers(servers)) {
        todo(`${shown}${scope}: MCP server ${name} looks like a GitHub server, which carries its own token: remove it by hand`);
      }
    }
  };
  mcp(join(p.home, ".claude.json"), "~/.claude.json", (config) => {
    const projects = typeof config.projects === "object" && config.projects !== null ? config.projects : {};
    return [
      ["", config.mcpServers],
      ...Object.entries(projects as Record<string, unknown>).map(([dir, project]): [string, unknown] => [
        ` (project ${dir})`,
        typeof project === "object" && project !== null ? (project as Record<string, unknown>).mcpServers : undefined,
      ]),
    ];
  });
  for (const { repo, dir } of p.repos) {
    mcp(join(dir, ".mcp.json"), `${repo}'s .mcp.json`, (config) => [["", config.mcpServers]]);
  }

  if (found === 0) p.say("pass", "stray-token scan: no other GitHub token found");
  return found;
}

/** Step 7: the wrong-sha merge on an open, mergeable PR must be refused with 403. */
function mergeProbe(p: Pass): boolean {
  let computing = false;
  for (const { repo } of p.repos) {
    const prs = ghJson(p, PrList, ["pr", "list", "--repo", repo, "--state", "open", "--limit", "100", "--json", "number,mergeable"]);
    const pr = prs.find((x) => x.mergeable === "MERGEABLE");
    if (pr === undefined) {
      computing ||= prs.some((x) => x.mergeable === "UNKNOWN");
      continue;
    }
    // A head sha that never matches, so GitHub never merges, whatever the token can do.
    const result = p.io.run("gh", [
      "api", "-X", "PUT", `repos/${repo}/pulls/${pr.number}/merge`, "-f", `sha=${"0".repeat(40)}`,
    ]);
    const code = /HTTP (\d{3})/.exec(result.stderr)?.[1];
    const where = `${repo} PR #${pr.number}`;
    if (result.status !== 0 && code === "403") {
      p.say("pass", `after-swap: a wrong-sha merge of ${where} was refused with 403: the token cannot merge`);
      return true;
    }
    if (result.status === 0 || code === "409") {
      p.say(
        "todo",
        `after-swap: a wrong-sha merge of ${where} got ${code ?? "a success"}: the token can merge. Log it out now (gh auth logout --hostname ${HOST}) and check its permissions: Contents must be read`,
      );
      return false;
    }
    p.say("todo", `after-swap: the wrong-sha merge of ${where} was inconclusive (${answer(result)}): rerun when an open PR is mergeable`);
    return false;
  }
  p.say(
    "todo",
    computing
      ? "after-swap: GitHub is still computing whether the open PRs can be merged (mergeable is UNKNOWN), so the wrong-sha merge has no PR yet: rerun in a minute"
      : "after-swap: no served repo has an open, mergeable PR for the wrong-sha merge: open one, or resolve an open PR's conflicts, then rerun",
  );
  return false;
}

/** Step 7: one fine-grained login, a refused merge, and each repo's ruleset read back. */
function afterSwapChecks(p: Pass): boolean {
  if (p.dryRun) {
    p.say(
      "would",
      `after-swap checks: gh auth status shows one ${HOST} login, with a fine-grained token; a wrong-sha merge on an open, mergeable PR is refused with 403; each served repo's ${RULESET} reads back as set`,
    );
    return true;
  }
  let ok = true;
  const stored = accounts(p);
  if (stored.length === 1 && isFineGrained(stored[0]!)) {
    p.say("pass", `after-swap: one ${HOST} login (${stored[0]!.login}), with a fine-grained token`);
  } else {
    const what = stored.map((a) => `${a.login} (${isFineGrained(a) ? "fine-grained" : "not fine-grained"})`).join(", ");
    p.say(
      "todo",
      `after-swap: gh auth status shows ${what || `no ${HOST} login`}, not one fine-grained login: log out the others with gh auth logout --hostname ${HOST} --user <login>, then rerun`,
    );
    ok = false;
  }
  ok = mergeProbe(p) && ok;
  for (const { repo } of p.repos) ok = checkRuleset(p, repo, readRuleset(p, repo), "after-swap: ", true) && ok;
  return ok;
}

export const credentials: Phase = {
  name: "credentials",
  run(ctx) {
    const p: Pass = {
      ...ctx,
      secret: "",
      say(status, text) {
        ctx.io.report(status, this.secret === "" ? text : text.split(this.secret).join("<token>"));
      },
    };

    if (!pauseDispatch(p)) return "stop";
    const stored = accounts(p);
    const active = stored.find((a) => a.active) ?? stored[0];
    if (!rulesetStep(p, active)) return "stop";

    const swapped = active !== undefined && isFineGrained(active);
    if (swapped && p.dryRun) {
      p.say("would", "token: ask whether to create a new token and swap it in (default No, which skips the token, the pre-swap test and the login swap)");
    }
    if (swapped && !p.dryRun && !p.io.confirm("Create a new token and swap it in? [y/N]")) {
      p.say("already", "token: the fine-grained login is in place and no new token was wanted");
      p.say("already", "pre-swap test: not needed without a new token");
      p.say("already", "login swap: the fine-grained login stays");
    } else {
      // Picked before the token form: a missing PR, issue or run must not cost a generated token.
      const subject = pickSubject(p);
      if (subject === undefined && !p.dryRun) return "stop";
      const token = readToken(p, active);
      if (token === undefined && !p.dryRun) return "stop";
      if (!preSwapTest(p, subject, token)) return "stop";
      if (!swapLogin(p, token)) return "stop";
    }

    // Stray tokens do not stop the phase before the after-swap checks, only at its end.
    const strays = scanStrayTokens(p);
    const checked = afterSwapChecks(p);
    p.say("note", `optional: revoke the old "GitHub CLI" authorization at https://${HOST}/settings/applications (gh auth logout does not revoke a token)`);
    return (strays === 0 && checked) || p.dryRun ? "ok" : "stop";
  },
};

/** `gh pr checks`: exit 0, 1 or 8 and an output row whose first tab-separated field is `test`. */
export function judgePrChecks(result: RunResult): boolean {
  return (
    [0, 1, 8].includes(result.status) &&
    result.stdout.split("\n").some((line) => line.split("\t")[0]?.trim() === "test")
  );
}

/** `gh pr view --json statusCheckRollup`: exit 0 and a CheckRun named `test` in the rollup. */
export function judgeRollup(result: RunResult): boolean {
  if (result.status !== 0) return false;
  let data: unknown;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    return false;
  }
  const parsed = z.object({ statusCheckRollup: z.array(RollupEntry) }).safeParse(data);
  return parsed.success && hasTestCheckRun(parsed.data.statusCheckRollup);
}
