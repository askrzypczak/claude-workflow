// The credentials phase: pause dispatch; per served repo, protect-main (created under an admin
// login when missing, checked otherwise), the restrict-updates ruleset, auto-merge and the
// labels; the fine-grained token, the login swap, the stray-token scan and the after-swap checks.
// docs/agent-credentials.md gives the reasons; this file carries them out.
import { join } from "node:path";
import { z } from "zod";
import { ENDED } from "../poller/decide.ts";
import { timestamp } from "../poller/io.ts";
import { parseJson } from "../poller/schemas.ts";
import type { Session } from "../poller/schemas.ts";
import { cloneDir, CONTAINER, containerSessions, containerState, readInContainer } from "./docker.ts";
import type { RunResult, SetupIo, StepStatus } from "./io.ts";
import type { Phase, SetupContext } from "./main.ts";

const HOST = "github.com";
const LAUNCHD = "dispatch/install-launchd.sh";
const FINE_GRAINED = "github_pat_";
const RULESET = "restrict-updates";
/** The ruleset that requires a pull request on the default branch, with nothing bypassing it. */
const PROTECT_MAIN = "protect-main";
/** The clone's script that creates the workflow's labels a repo is missing. */
const LABELS_SCRIPT = "plugins/ticket-workflow/scripts/setup-labels.sh";
const RULESETS_FIX = "Settings > Rules > Rulesets";

/**
 * protect-main as the phase creates it: no required status checks, since a repo may have no CI
 * yet, and none of GitHub's pull request options beyond the rule itself.
 */
const PROTECT_MAIN_RULESET = {
  name: PROTECT_MAIN,
  target: "branch",
  enforcement: "active",
  conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
  rules: [
    { type: "deletion" },
    { type: "non_fast_forward" },
    {
      type: "pull_request",
      parameters: {
        required_approving_review_count: 0,
        dismiss_stale_reviews_on_push: false,
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_review_thread_resolution: false,
      },
    },
  ],
  bypass_actors: [],
};

/**
 * The Repository admin role, exempt from restrict-updates: GitHub skips the ruleset's rules for
 * that role, so a browser merge shows no bypass box. protect-main is then what refuses direct
 * updates to the default branch by the admin identity and by deploy keys with write access.
 */
const ADMIN_BYPASS = { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "exempt" };

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

const TOKEN_VARS = ["GH_TOKEN", "GITHUB_TOKEN"];
const STARTUP_FILES = [".zshenv", ".zprofile", ".zshrc", ".zlogin", ".bash_profile", ".bashrc", ".profile"];
/** The poller's LaunchAgent under the home directory, named by LABEL in dispatch/install-launchd.sh. */
const POLLER_PLIST = "Library/LaunchAgents/com.askrzypczak.claude-workflow-poller.plist";
const RELOGIN = "run gh auth login --hostname github.com --with-token, paste the token, press Enter and then Ctrl-D";

/** One stored account as `gh auth status --json hosts --show-token` prints it. */
const AuthEntry = z.object({
  login: z.string(),
  active: z.boolean().optional(),
  state: z.string().optional(),
  /** gh's reason for an "error" state; kept only when it is a string. */
  error: z.unknown().optional(),
  token: z.string().optional(),
});
/** `hosts` may be null when no login is stored (a nil map in gh's JSON); it reads as no accounts. */
const AuthStatus = z.object({ hosts: z.record(z.string(), z.array(AuthEntry)).nullish() });

/** A stored github.com login as the phase keeps it: whether its token is fine-grained, never the token. */
interface Account {
  login: string;
  active: boolean;
  /** gh's check of the token: "success", "timeout" or "error" (GitHub refused it). */
  state: string | undefined;
  /** gh's reason for an "error" state. */
  error: string | undefined;
  fineGrained: boolean;
}
const RepoInfo = z.object({
  default_branch: z.string(),
  permissions: z.object({ admin: z.boolean().optional() }).optional(),
  allow_auto_merge: z.boolean().optional(),
});
const RulesetList = z.array(z.object({ id: z.number(), name: z.string() }));
/** `rules/branches/<branch>`: the rules that apply to a branch, each with its ruleset's id. */
const BranchRules = z.array(z.object({ type: z.string(), ruleset_id: z.number() }));
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
function ghJson<T extends z.ZodType>(p: { io: SetupIo }, schema: T, args: string[]): z.output<T> {
  return parseRead(schema, args, p.io.run("gh", args));
}

/**
 * The github.com accounts gh has stored. `gh auth status --json` leaves the token out unless
 * asked with --show-token, so this read asks for it, keeps only whether it starts github_pat_
 * and drops the value at once. Its errors name the command and quote none of its output.
 */
function accounts(p: Pass): Account[] {
  const args = ["auth", "status", "--json", "hosts", "--show-token"];
  const what = `gh ${args.join(" ")}`;
  const result = p.io.run("gh", args);
  // With --json, gh exits 0 even when GitHub refuses a token; any other exit is a fatal error.
  if (result.status !== 0) throw new Error(`${what} failed: ${answer({ ...result, stdout: "" })}`);
  let data: unknown;
  try {
    data = JSON.parse(result.stdout);
  } catch {
    throw new Error(`${what}: the output is not valid JSON`);
  }
  const parsed = AuthStatus.safeParse(data);
  if (!parsed.success) throw new Error(`${what}: the output is not a list of accounts per host`);
  return ((parsed.data.hosts ?? {})[HOST] ?? []).map((a) => ({
    login: a.login,
    active: a.active ?? false,
    state: a.state,
    error: typeof a.error === "string" ? a.error : undefined,
    fineGrained: a.token?.startsWith(FINE_GRAINED) ?? false,
  }));
}

const isUpdateRule = (rule: z.infer<typeof Rule>) =>
  rule.type === "update" && rule.parameters?.update_allows_fetch_and_merge !== true;
const isAdminBypass = (actor: z.infer<typeof BypassActor>) =>
  actor.actor_id === ADMIN_BYPASS.actor_id &&
  actor.actor_type === ADMIN_BYPASS.actor_type &&
  actor.bypass_mode === ADMIN_BYPASS.bypass_mode;

/**
 * Step 1: pause dispatch, then refuse to go on while a session is live on the host or in the
 * agent container. With `opts.host` false, host sessions are not checked: what the container
 * phase changes never reaches them.
 */
export function quiesce(
  ctx: SetupContext,
  say: (status: StepStatus, text: string) => void,
  opts?: { host?: boolean },
): boolean {
  const p = { ...ctx, say };
  const script = join(p.clone, LAUNCHD);
  if (dispatchPaused(p.io, p.clone)) {
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

  const host = opts?.host !== false;
  const live = host ? p.io.listSessions().filter((s) => !ENDED.includes(s.state)) : [];
  for (const s of live) p.say("todo", stopTodo(s, "claude agents", "claude"));
  if (host && live.length === 0) p.say("pass", "no live sessions in claude agents");

  // Throws when the container's list cannot be read: a wrong empty answer would let a write
  // go ahead under a live session.
  const inContainer = containerSessions(p.io);
  const liveInContainer = (inContainer ?? []).filter((s) => !ENDED.includes(s.state));
  if (inContainer === undefined) {
    p.say("note", `docker does not answer or the agent container ${CONTAINER} is not running, so no container session can be live`);
  } else if (liveInContainer.length === 0) {
    p.say("pass", `no live sessions in the agent container ${CONTAINER}`);
  }
  const inDocker = `docker exec ${CONTAINER} claude`;
  for (const s of liveInContainer) p.say("todo", stopTodo(s, `${inDocker} agents`, inDocker, `in the agent container ${CONTAINER}`));
  return (live.length === 0 && liveInContainer.length === 0) || p.dryRun;
}

/** A live session's to-do: `claude stop <id>`, by name when the list gives no id. */
function stopTodo(s: Session, list: string, claude: string, where = ""): string {
  const at = where === "" ? "" : ` ${where}`;
  const handle = s.id ?? s.name;
  if (handle === undefined) return `an unnamed session${at} is ${s.state}: stop it from ${list}`;
  const shown = s.name === undefined ? `session ${handle}` : `session ${s.name}${s.id === undefined ? "" : ` (${s.id})`}`;
  return `${shown}${at} is ${s.state}: stop it with ${claude} stop ${handle}`;
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
  const shape = "an update rule on the default branch; only the Repository admin role bypasses it, in exempt mode";
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
 * the update rule and this login's bypass reads exempt. With `bypassList`, also the bypass
 * list when GitHub returns it.
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
  check(bypass === "exempt", "bypass for this login is exempt", `bypass for this login is ${bypass}, not exempt`);
  if (bypassList) {
    if (r.bypass_actors === undefined) {
      p.say(
        "note",
        `${prefix}${repo}: GitHub returns the bypass list of ${RULESET} only to logins that can edit it: in the browser, check it is the Repository admin role alone, in exempt mode`,
      );
    } else {
      check(
        r.bypass_actors.length === 1 && isAdminBypass(r.bypass_actors[0]!),
        "bypass list is the Repository admin role alone, in exempt mode",
        "bypass list is not the Repository admin role alone in exempt mode",
      );
    }
  }
  return ok;
}

type Say = (status: StepStatus, text: string) => void;

/** The rulesets whose pull_request rule applies to `branch`; GitHub returns only active rulesets' rules. */
function pullRequestRulesets(p: { io: SetupIo }, repo: string, branch: string): Ruleset[] {
  const ids = new Set(
    ghJson(p, BranchRules, ["api", `repos/${repo}/rules/branches/${branch}`])
      .filter((rule) => rule.type === "pull_request")
      .map((rule) => rule.ruleset_id),
  );
  return [...ids].map((id) => ghJson(p, Ruleset, ["api", `repos/${repo}/rulesets/${id}`]));
}

/**
 * Judges the pull_request rulesets on `branch`: one must read current_user_can_bypass never
 * and, where GitHub returns it, have an empty bypass list. `missing` is the to-do when there
 * is none at all.
 */
function judgeProtectMain(p: { say: Say }, repo: string, branch: string, rulesets: Ruleset[], missing: string): boolean {
  const todo = (text: string) => {
    p.say("todo", `${repo}: ${PROTECT_MAIN}: ${text}`);
    return false;
  };
  const browser = `fix it in the browser (${RULESETS_FIX}), then rerun`;
  if (rulesets.length === 0) return todo(missing);
  const binding = rulesets.filter((r) => r.current_user_can_bypass === "never");
  if (binding.length === 0) {
    const read = rulesets.map((r) => `ruleset ${r.id} reads ${r.current_user_can_bypass ?? "not returned"}`);
    return todo(
      `this login can bypass every active ruleset with a pull_request rule on ${branch} (current_user_can_bypass: ${read.join(", ")}; none reads never): ${browser}`,
    );
  }
  const empty = binding.some((r) => r.bypass_actors?.length === 0);
  const unlisted = binding.some((r) => r.bypass_actors === undefined);
  if (!empty && !unlisted) {
    const actors = new Set(binding.flatMap((r) => r.bypass_actors ?? []).map((a) => a.actor_type));
    return todo(
      `the bypass list is not empty (${[...actors].join(", ")}), so those actors can bypass the pull_request rule on ${branch}: ${browser}`,
    );
  }
  p.say(
    "pass",
    `${repo}: ${PROTECT_MAIN}: ${branch} has an active pull_request rule this login cannot bypass (current_user_can_bypass never)${empty ? ", and its bypass list is empty" : ""}`,
  );
  if (!empty) {
    p.say(
      "note",
      `${repo}: GitHub returns a ruleset's bypass list only to logins that can edit it: in the browser, check that ${PROTECT_MAIN} has no bypass actors`,
    );
  }
  return true;
}

/**
 * Step 2, before restrict-updates: some active ruleset on the default branch has a pull_request
 * rule, reads current_user_can_bypass never for this login and, where GitHub returns it, has an
 * empty bypass list. Reads only: a bypassable one is fixed in the browser, a missing one there
 * or by a rerun under an admin login.
 */
export function checkProtectMain(p: { io: SetupIo; say: Say }, repo: string, branch: string): boolean {
  return judgeProtectMain(
    p,
    repo,
    branch,
    pullRequestRulesets(p, repo, branch),
    `no active ruleset on ${branch} has a pull_request rule (Require a pull request before merging): create it in the browser (${RULESETS_FIX}) and rerun, or run gh auth login with an admin login and rerun dispatch/setup-agents.sh credentials, which creates it and then opens the token form for a new fine-grained token`,
  );
}

/**
 * Step 2 under an admin login: create protect-main when no active ruleset puts a pull_request
 * rule on the default branch, then check it again. An existing ruleset is only judged, never
 * changed.
 */
function ensureProtectMain(p: Pass, repo: string, branch: string): boolean {
  const existing = pullRequestRulesets(p, repo, branch);
  if (existing.length > 0) return judgeProtectMain(p, repo, branch, existing, "");
  const shape =
    "deletion, non_fast_forward and a pull_request rule with no required approvals on the default branch, active, with no bypass actors and no required status checks";
  const checksNote = `${repo}: ${PROTECT_MAIN} requires no status checks: once the repo has CI, add them in the browser (${RULESETS_FIX} > ${PROTECT_MAIN}, Require status checks to pass)`;
  if (p.dryRun) {
    p.say("would", `${repo}: create the ${PROTECT_MAIN} ruleset (${shape})`);
    p.say("note", checksNote);
    return true;
  }
  const result = p.io.run("gh", ["api", "-X", "POST", `repos/${repo}/rulesets`, "--input", "-"], {
    input: JSON.stringify(PROTECT_MAIN_RULESET),
  });
  if (result.status !== 0) {
    p.say(
      "todo",
      `${repo}: GitHub refused to create ${PROTECT_MAIN}: ${apiAnswer(result)}; create it in the browser (${RULESETS_FIX}), then rerun. ${RULESET} is not created here until ${PROTECT_MAIN} is in place`,
    );
    return false;
  }
  p.say("done", `${repo}: created the ${PROTECT_MAIN} ruleset (${shape})`);
  p.say("note", checksNote);
  return judgeProtectMain(
    p,
    repo,
    branch,
    pullRequestRulesets(p, repo, branch),
    `GitHub does not yet show the created ruleset's pull_request rule on ${branch}: check it in the browser (${RULESETS_FIX}), then rerun`,
  );
}

/** Step 2, per served repo under any login: the labels the workflow uses, created where missing. */
function labelsStep(p: Pass, repo: string): boolean {
  const command = `${LABELS_SCRIPT} ${repo}`;
  if (p.dryRun) {
    p.say("would", `${repo}: run ${command} (creates the missing labels; existing ones are left alone)`);
    return true;
  }
  const result = p.io.run(join(p.clone, LABELS_SCRIPT), [repo]);
  if (result.status !== 0) {
    p.say("todo", `${repo}: ${LABELS_SCRIPT} failed: ${answer(result)}; run ${command} from the clone to see why, then rerun`);
    return false;
  }
  p.say("done", `${repo}: ran ${command} (the missing labels are created)`);
  return true;
}

/**
 * Step 2: per served repo, protect-main, the ruleset and auto-merge, which change only under an
 * admin login, then the labels under any login. A repo's failure skips the rest of its ruleset
 * work and the loop goes on; the step fails at its end.
 */
function rulesetStep(p: Pass, active: Account | undefined): boolean {
  if (active === undefined) {
    p.say("todo", `gh has no ${HOST} login: run gh auth login, then rerun`);
    return p.dryRun;
  }
  const { fineGrained } = active;
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
    const admin = !fineGrained && info.permissions?.admin === true;
    if (!admin) {
      p.say(
        "note",
        `${repo}: this login has no admin rights here${fineGrained ? " (a fine-grained token never does)" : ""}, so no ruleset or setting is changed and only the readable checks run`,
      );
    }
    if (admin) {
      // With the admin role exempt from restrict-updates, protect-main must hold before
      // restrict-updates is created or reset. Under --dry-run the would lines still follow.
      const protectedMain = ensureProtectMain(p, repo, info.default_branch);
      ok = protectedMain && ok;
      if (protectedMain || p.dryRun) {
        ok = ensureRuleset(p, repo, readRuleset(p, repo)) && ensureAutoMergeOff(p, repo, info.allow_auto_merge) && ok;
      }
    } else {
      ok = checkProtectMain(p, repo, info.default_branch) && ok;
      ok = checkRuleset(p, repo, readRuleset(p, repo), "", false) && ok;
      if (info.allow_auto_merge === undefined) {
        p.say("note", `${repo}: auto-merge unchecked: GitHub does not return allow_auto_merge to this login; check Settings > General in the browser`);
      } else if (info.allow_auto_merge) {
        p.say("todo", `${repo}: auto-merge is on: turn it off in the browser (Settings > General), then rerun`);
        ok = false;
      } else {
        p.say("pass", `${repo}: auto-merge is off`);
      }
    }
    ok = labelsStep(p, repo) && ok;
  }
  return ok || p.dryRun;
}

/** Step 2 when GitHub refuses the stored login's token: nothing can be read or changed as it. */
function skipRulesetStep(p: Pass, active: Account): void {
  p.say("note", `gh login: ${active.login}, whose token GitHub refuses`);
  for (const { repo } of p.repos) {
    p.say(
      "note",
      `${repo}: the ${PROTECT_MAIN} check, the ${RULESET} and auto-merge step and the labels (${LABELS_SCRIPT}) are skipped because GitHub refuses the stored login's token${active.error ? ` (${active.error})` : ""}; ${RULESET} is read back after the swap and a rerun checks ${PROTECT_MAIN} and creates the labels; auto-merge is unchecked: check Settings > General in the browser`,
    );
  }
}

/** The token form, pre-filled with everything GitHub's URL parameters allow. */
export function tokenFormUrl(login: string | undefined, name: string): string {
  const params: Record<string, string> = {
    name,
    description: "Agent sessions and the dispatch poller (claude-workflow); cannot merge",
    ...(login === undefined ? {} : { target_name: login }),
    ...TOKEN_PERMISSIONS,
  };
  const query = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`);
  return `https://github.com/settings/personal-access-tokens/new?${query.join("&")}`;
}

/** Step 3: open the pre-filled form and read the token; undefined under --dry-run or when none was pasted. */
function readToken(p: Pass, active: Account | undefined): string | undefined {
  const url = tokenFormUrl(active?.login, `claude-workflow-agents-${timestamp(new Date()).slice(0, 10)}`);
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

/** Step 4: replace every stored github.com login with the token. */
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

/** Step 5: other GitHub tokens on the machine, reported by place, never by value; changes nothing. */
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
  const jsonObject = (text: string | undefined, shown: string): Record<string, unknown> | undefined => {
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

  const settings = jsonObject(p.io.readFile(join(p.home, ".claude/settings.json")), "~/.claude/settings.json");
  const env = settings?.env;
  if (typeof env === "object" && env !== null) {
    for (const name of TOKEN_VARS.filter((v) => v in env)) {
      todo(`~/.claude/settings.json sets ${name} in its env block, which every Claude Code session gets: remove it by hand`);
    }
  }

  const mcp = (text: string | undefined, shown: string, scopes: (config: Record<string, unknown>) => [string, unknown][]) => {
    const config = jsonObject(text, shown);
    if (config === undefined) return;
    for (const [scope, servers] of scopes(config)) {
      for (const name of githubServers(servers)) {
        todo(`${shown}${scope}: MCP server ${name} looks like a GitHub server, which carries its own token: remove it by hand`);
      }
    }
  };
  const servers = (config: Record<string, unknown>): [string, unknown][] => [["", config.mcpServers]];
  mcp(p.io.readFile(join(p.home, ".claude.json")), "~/.claude.json", (config) => {
    const projects = typeof config.projects === "object" && config.projects !== null ? config.projects : {};
    return [
      ["", config.mcpServers],
      ...Object.entries(projects as Record<string, unknown>).map(([dir, project]): [string, unknown] => [
        ` (project ${dir})`,
        typeof project === "object" && project !== null ? (project as Record<string, unknown>).mcpServers : undefined,
      ]),
    ];
  });
  // This clone's file on the host; every served repo's clone in the agent container, where the
  // unattended sessions load it. The config's dirs are container paths, never read on the host.
  const hostMcp = join(p.clone, ".mcp.json");
  mcp(p.io.readFile(hostMcp), `this clone's .mcp.json (${hostMcp})`, servers);
  // Quiesce, earlier in this phase, refuses a running container that has not logged its
  // readiness line, so a running container here is ready for an exec.
  const state = containerState(p.io);
  if (state.kind === "running") {
    for (const { repo } of p.repos) {
      const path = `${cloneDir(repo)}/.mcp.json`;
      const shown = `${repo}'s .mcp.json in the agent container (${path})`;
      let text: string | undefined;
      try {
        text = readInContainer(p.io, path);
      } catch (err) {
        p.say("note", `stray token: ${err instanceof Error ? err.message : String(err)}: check ${shown} for GitHub tokens by hand`);
        continue;
      }
      mcp(text, shown, servers);
    }
  } else {
    const why =
      state.kind === "no-docker" ? `docker does not answer (${state.detail})`
      : state.kind === "absent" ? `there is no container ${CONTAINER}`
      : `${CONTAINER} is stopped`;
    p.say(
      "note",
      `stray token: ${why}, so the .mcp.json files of ${p.repos.map((r) => r.repo).join(", ")} in the agent container were not scanned: rerun dispatch/setup-agents.sh once the container runs`,
    );
  }

  if (found === 0) p.say("pass", "stray-token scan: no other GitHub token found");
  return found;
}

/** True when install-launchd.sh status shows dispatch disabled and not loaded; throws when the status read fails. */
export function dispatchPaused(io: SetupIo, clone: string): boolean {
  const status = io.run(join(clone, LAUNCHD), ["status"]);
  if (status.status !== 0) throw new Error(`${LAUNCHD} status failed: ${answer(status)}`);
  const loaded = /^Loaded:\s*yes/m.test(status.stdout);
  const disabled = /^Disabled:\s*yes/m.test(status.stdout);
  return disabled && !loaded;
}

/**
 * Step 6: one stored login, whatever its token kind, and each served repo's ruleset
 * read back. A repo the new token cannot see (HTTP 404) is a to-do and the next repo is still read.
 */
function afterSwapChecks(p: Pass): boolean {
  if (p.dryRun) {
    p.say(
      "would",
      `after-swap checks: gh auth status shows one ${HOST} login; each served repo's ${RULESET} reads back as set`,
    );
    return true;
  }
  let ok = true;
  const stored = accounts(p);
  if (stored.length === 1) {
    const only = stored[0]!;
    p.say("pass", `after-swap: one ${HOST} login (${only.login}), with a ${only.fineGrained ? "fine-grained" : "classic"} token`);
  } else {
    const what = stored.map((a) => `${a.login} (${a.fineGrained ? "fine-grained" : "not fine-grained"})`).join(", ");
    p.say(
      "todo",
      `after-swap: gh auth status shows ${what || `no ${HOST} login`}, not one login: log out the others with gh auth logout --hostname ${HOST} --user <login>, then rerun`,
    );
    ok = false;
  }
  for (const { repo } of p.repos) {
    const args = ["api", `repos/${repo}/rulesets`];
    const read = p.io.run("gh", args);
    if (read.status !== 0 && /HTTP 404/.test(read.stderr)) {
      p.say(
        "todo",
        `after-swap: ${repo}: the token cannot see this repo (HTTP 404): edit the token at https://${HOST}/settings/personal-access-tokens, select ${repo} under Repository access, then rerun`,
      );
      ok = false;
      continue;
    }
    const found = parseRead(RulesetList, args, read).find((r) => r.name === RULESET);
    const ruleset = found && ghJson(p, Ruleset, ["api", `repos/${repo}/rulesets/${found.id}`]);
    ok = checkRuleset(p, repo, ruleset, "after-swap: ", true) && ok;
  }
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

    if (!quiesce(ctx, (status, text) => p.say(status, text))) return "stop";
    const stored = accounts(p);
    const active = stored.find((a) => a.active) ?? stored[0];
    // GitHub refuses the stored login's token (expired or revoked): nothing can run as that login.
    const expired = active?.state === "error";
    if (expired) skipRulesetStep(p, active);
    else if (!rulesetStep(p, active)) return "stop";

    const swapped = !expired && active !== undefined && active.fineGrained;
    if (swapped && p.dryRun) {
      p.say("would", "token: ask whether to create a new token and swap it in (default No, which skips the token and the login swap)");
    }
    if (swapped && !p.dryRun && !p.io.confirm("Create a new token and swap it in? [y/N]")) {
      p.say("already", "token: the fine-grained login is in place and no new token was wanted");
      p.say("already", "login swap: the fine-grained login stays");
    } else {
      const token = readToken(p, active);
      if (token === undefined && !p.dryRun) return "stop";
      if (!swapLogin(p, token)) return "stop";
    }

    // Stray tokens do not stop the phase before the after-swap checks, only at its end.
    const strays = scanStrayTokens(p);
    const checked = afterSwapChecks(p);
    p.say("note", `optional: revoke the old "GitHub CLI" authorization at https://${HOST}/settings/applications (gh auth logout does not revoke a token)`);
    return (strays === 0 && checked) || p.dryRun ? "ok" : "stop";
  },
};
