// A fake SetupIo for the setup phases' tests: `run` answers from a scripted, stateful world
// (gh, git, install-launchd.sh, security, open) with happy-path defaults a test overrides,
// and every call, report and prompt is recorded.
//
// The happy path: dispatch already paused, no live sessions, origin example-owner/example-tools,
// a classic admin login, `restrict-updates` in place and auto-merge off, an open mergeable PR
// with a `test` CheckRun, an open issue, a run, labels, every pre-swap command passing, the
// pasted token FAKE_TOKEN, a swap that leaves one fine-grained login, no stray tokens, and a
// wrong-sha merge probe refused with HTTP 403.
//
// The fake ignores `--json` field lists and `--jq`: JSON reads print the whole object.
// Commands it has no script for exit 127 with "unscripted" on stderr.
import type { Session } from "../poller/schemas.ts";
import type { RunOptions, RunResult, SetupIo, StepStatus } from "./io.ts";

export const FAKE_REPO = "example-owner/example-tools";
export const FAKE_LOGIN = "example-owner";
/** What `readSecret` returns unless the world says otherwise. */
export const FAKE_TOKEN = "github_pat_FAKE_TOKEN_FOR_TESTS";

export interface FakeCall {
  cmd: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  input: string | undefined;
}

export interface FakeReport {
  status: StepStatus;
  text: string;
}

export interface FakePrompt {
  kind: "secret" | "confirm";
  text: string;
}

/** A ruleset as `gh api repos/<repo>/rulesets/<id>` returns it to an admin. */
export interface FakeRuleset {
  id: number;
  name: string;
  target: string;
  enforcement: string;
  conditions?: unknown;
  rules?: unknown[];
  bypass_actors?: unknown[];
}

export interface FakeWorld {
  /** `install-launchd.sh status`: paused is installed, not loaded and disabled. Default paused. */
  dispatch?: "paused" | "running";
  /** `listSessions()`. Default none. */
  sessions?: Session[];
  /** `git remote get-url origin`. Default `git@github.com:example-owner/example-tools.git`. */
  origin?: string;
  /** The stored github.com login at the start. Default classic (an admin). */
  login?: "classic" | "fine-grained";
  /** Every repo's rulesets. Default `protect-main` and a matching `restrict-updates`. */
  rulesets?: FakeRuleset[];
  /** `allow_auto_merge` as an admin reads it. Default false. */
  allowAutoMerge?: boolean;
  /** What `readSecret` returns. Default FAKE_TOKEN. */
  secret?: string;
  /** What `confirm` returns. Default false (the No default). */
  confirm?: boolean;
  /** This process's environment for `io.env`. Default empty. */
  env?: Record<string, string>;
  /** Files by absolute path for `io.readFile`. Default none. */
  files?: Record<string, string>;
  /** `security find-internet-password -s github.com` finds an entry. Default false. */
  keychainHasGithub?: boolean;
  /** Calls for which this returns true exit 1 with "HTTP 500" on stderr. */
  fail?: (call: FakeCall) => boolean;
  /** First say on every call; undefined falls through to the scripted world. */
  respond?: (call: FakeCall) => RunResult | undefined;
}

/** `restrict-updates` as the credentials phase creates it, with an id. */
export function restrictUpdates(overrides: Partial<FakeRuleset> = {}): FakeRuleset {
  return {
    id: 101,
    name: "restrict-updates",
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [{ type: "update" }],
    bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "pull_request" }],
    ...overrides,
  };
}

/** Another ruleset on the repo, which the credentials phase must leave alone. */
export function protectMain(): FakeRuleset {
  return {
    id: 100,
    name: "protect-main",
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [{ type: "deletion" }, { type: "non_fast_forward" }, { type: "pull_request" }],
    bypass_actors: [],
  };
}

const VALUE_FLAGS = new Set([
  "-X", "--method", "-f", "--raw-field", "-F", "--field", "--input", "-q", "--jq",
  "-H", "--header", "-t", "--template", "--hostname", "--cache", "-p", "--preview",
]);
const BODY_FLAGS = new Set(["-f", "--raw-field", "-F", "--field", "--input"]);

/** A `gh api` call's method (upper case) and endpoint; undefined for anything else. */
export function parseGhApi(call: FakeCall): { method: string; endpoint: string } | undefined {
  if (call.cmd !== "gh" || call.args[0] !== "api") return undefined;
  let method: string | undefined;
  let endpoint = "";
  let hasBody = false;
  for (let i = 1; i < call.args.length; i++) {
    const arg = call.args[i]!;
    if (VALUE_FLAGS.has(arg)) {
      if (arg === "-X" || arg === "--method") method = call.args[i + 1]?.toUpperCase();
      if (BODY_FLAGS.has(arg)) hasBody = true;
      i++;
    } else if (arg.startsWith("--method=")) {
      method = arg.slice("--method=".length).toUpperCase();
    } else if (!arg.startsWith("-") && endpoint === "") {
      endpoint = arg.replace(/^\//, "");
    }
  }
  return { method: method ?? (hasBody ? "POST" : "GET"), endpoint };
}

/** The wrong-sha merge probe: a PUT on a PR's merge endpoint with sha forty zeros. */
export function isMergeProbe(call: FakeCall): boolean {
  const api = parseGhApi(call);
  return (
    api !== undefined &&
    api.method === "PUT" &&
    /\/pulls\/\d+\/merge$/.test(api.endpoint) &&
    call.args.some((a) => a === `sha=${"0".repeat(40)}`)
  );
}

/**
 * Whether a call changes state. This is the definition of "write command" the setup tests
 * use: `install-launchd.sh` pause or resume; `gh api` with a POST, PUT, PATCH or DELETE
 * (explicit, or implied by a body) except the wrong-sha merge probe; `gh issue comment`;
 * `gh issue edit`; `gh pr edit`; `gh auth logout`; `gh auth login`; and `open`.
 */
export function isWrite(call: FakeCall): boolean {
  const [a0, a1] = call.args;
  if (call.cmd.endsWith("install-launchd.sh")) return a0 === "pause" || a0 === "resume";
  if (call.cmd === "open") return true;
  if (call.cmd !== "gh") return false;
  const api = parseGhApi(call);
  if (api) return api.method !== "GET" && !isMergeProbe(call);
  return (
    (a0 === "issue" && (a1 === "comment" || a1 === "edit")) ||
    (a0 === "pr" && a1 === "edit") ||
    (a0 === "auth" && (a1 === "logout" || a1 === "login"))
  );
}

/** The write commands among `calls` (see isWrite). */
export function writeCalls(calls: readonly FakeCall[]): FakeCall[] {
  return calls.filter(isWrite);
}

const ok = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });
const json = (value: unknown): RunResult => ok(`${JSON.stringify(value)}\n`);
const failed = (stderr: string, status = 1): RunResult => ({ status, stdout: "", stderr });

const PR = 7;
const ISSUE = 12;
const RUN = 555;
const COMMENT_ID = 9001;
const ROLLUP = [
  { __typename: "CheckRun", name: "test", status: "COMPLETED", conclusion: "SUCCESS" },
];

interface Account {
  login: string;
  fineGrained: boolean;
}

function flagValue(args: readonly string[], flag: string): string | undefined {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : undefined;
}

/** A SetupIo over `world` that records every run, report and prompt. */
export function fakeIo(world: FakeWorld = {}) {
  const calls: FakeCall[] = [];
  const reports: FakeReport[] = [];
  const prompts: FakePrompt[] = [];

  let paused = (world.dispatch ?? "paused") === "paused";
  let accounts: Account[] = [{ login: FAKE_LOGIN, fineGrained: world.login === "fine-grained" }];
  let rulesets: FakeRuleset[] = structuredClone(world.rulesets ?? [protectMain(), restrictUpdates()]);
  let allowAutoMerge = world.allowAutoMerge ?? false;
  let nextRulesetId = 200;

  /** Whether the call authenticates as a fine-grained token (GH_TOKEN first, as gh does). */
  const fineGrained = (call: FakeCall) =>
    call.env.GH_TOKEN !== undefined
      ? call.env.GH_TOKEN.startsWith("github_pat_")
      : accounts.some((a) => a.fineGrained);

  const rulesetView = (r: FakeRuleset, call: FakeCall) => {
    const adminBypass = (r.bypass_actors ?? []).some(
      (b) =>
        typeof b === "object" && b !== null &&
        (b as Record<string, unknown>).actor_type === "RepositoryRole" &&
        (b as Record<string, unknown>).actor_id === 5,
    );
    const view: Record<string, unknown> = {
      ...r,
      source_type: "Repository",
      source: FAKE_REPO,
      node_id: `RRS_${r.id}`,
      current_user_can_bypass: adminBypass ? "pull_requests_only" : "never",
      created_at: "2026-10-01T00:00:00Z",
      updated_at: "2026-10-01T00:00:00Z",
    };
    // GitHub returns the bypass list only to callers who can edit the ruleset.
    if (fineGrained(call)) delete view.bypass_actors;
    return view;
  };

  const ghApi = (call: FakeCall, method: string, endpoint: string): RunResult => {
    const parts = endpoint.split("?")[0]!.split("/");
    if (parts[0] !== "repos" || parts.length < 3) return failed(`unscripted: gh api ${endpoint}`, 127);
    const repo = `${parts[1]}/${parts[2]}`;
    const rest = parts.slice(3);
    if (rest.length === 0) {
      if (method === "GET") {
        const fg = fineGrained(call);
        return json({
          full_name: repo,
          default_branch: "main",
          permissions: { admin: !fg, maintain: !fg, push: !fg, triage: true, pull: true },
          ...(fg ? {} : { allow_auto_merge: allowAutoMerge }),
        });
      }
      if (method === "PATCH") {
        if (fineGrained(call)) return failed("gh: Resource not accessible by personal access token (HTTP 403)");
        const field = call.args.find((a) => a.startsWith("allow_auto_merge="));
        if (field) allowAutoMerge = field.endsWith("=true");
        return json({ full_name: repo, allow_auto_merge: allowAutoMerge });
      }
    }
    if (rest[0] === "rulesets") {
      if (rest.length === 1 && method === "GET") {
        return json(rulesets.map((r) => ({
          id: r.id, name: r.name, target: r.target, enforcement: r.enforcement,
          source_type: "Repository", source: repo,
        })));
      }
      if (rest.length === 1 && method === "POST") {
        if (fineGrained(call)) return failed("gh: Resource not accessible by personal access token (HTTP 403)");
        const body = JSON.parse(call.input ?? "{}") as Omit<FakeRuleset, "id">;
        const created = { ...body, id: nextRulesetId++ };
        rulesets.push(created);
        return json(rulesetView(created, call));
      }
      const id = Number(rest[1]);
      const found = rulesets.find((r) => r.id === id);
      if (!found) return failed("gh: Not Found (HTTP 404)");
      if (method === "GET") return json(rulesetView(found, call));
      if (method === "PUT") {
        if (fineGrained(call)) return failed("gh: Resource not accessible by personal access token (HTTP 403)");
        const body = JSON.parse(call.input ?? "{}") as Omit<FakeRuleset, "id">;
        const updated = { ...body, id };
        rulesets = rulesets.map((r) => (r.id === id ? updated : r));
        return json(rulesetView(updated, call));
      }
    }
    if (rest[0] === "pulls" && rest[2] === "merge" && method === "PUT") {
      return failed("gh: Resource not accessible by personal access token (HTTP 403)");
    }
    if (rest[0] === "pulls" && method === "GET") return json({ number: Number(rest[1]), author_association: "OWNER" });
    if (rest[0] === "issues" && rest[1] === "comments" && method === "DELETE") return ok();
    if (rest[0] === "issues" && method === "GET") return json({ id: 1, number: Number(rest[1]), author_association: "OWNER" });
    if (rest[0] === "commits" && method === "GET") return json({ sha: "a".repeat(40) });
    return failed(`unscripted: gh api -X ${method} ${endpoint}`, 127);
  };

  const gh = (call: FakeCall): RunResult => {
    const api = parseGhApi(call);
    if (api) return ghApi(call, api.method, api.endpoint);
    const [a0, a1] = call.args;
    const repo = flagValue(call.args, "--repo") ?? flagValue(call.args, "-R") ?? FAKE_REPO;
    const sub = `${a0} ${a1}`;
    switch (sub) {
      case "auth status":
        return json({
          hosts: {
            "github.com": accounts.map((a, i) => ({
              state: "success",
              active: i === 0,
              host: "github.com",
              login: a.login,
              tokenSource: "keyring",
              token: a.fineGrained ? "github_pat_******" : "gho_******",
              gitProtocol: "ssh",
            })),
          },
        });
      case "auth logout": {
        const user = flagValue(call.args, "--user");
        accounts = accounts.filter((a) => user !== undefined && a.login !== user);
        return ok();
      }
      case "auth login": {
        const token = (call.input ?? "").trim();
        if (token === "") return failed("error validating token: missing token");
        accounts = [{ login: FAKE_LOGIN, fineGrained: token.startsWith("github_pat_") }];
        return ok();
      }
      case "pr list":
        return json([
          {
            number: PR,
            title: "Example change",
            headRefName: "example-branch",
            mergeable: "MERGEABLE",
            labels: [],
            statusCheckRollup: ROLLUP,
          },
        ]);
      case "pr view":
        return json({ number: PR, state: "OPEN", mergeable: "MERGEABLE", labels: [], statusCheckRollup: ROLLUP });
      case "pr checks":
        return ok(`test\tpass\t12s\thttps://github.com/${repo}/actions/runs/${RUN}/job/1\n`);
      case "pr diff":
        return ok("diff --git a/README.md b/README.md\n");
      case "pr edit":
        return ok(`https://github.com/${repo}/pull/${PR}\n`);
      case "issue list":
        return json([{ number: ISSUE, title: "Example issue", state: "OPEN", labels: [] }]);
      case "issue view":
        return json({ number: ISSUE, title: "Example issue", state: "OPEN", labels: [] });
      case "issue comment":
        return ok(`https://github.com/${repo}/issues/${call.args[2] ?? ISSUE}#issuecomment-${COMMENT_ID}\n`);
      case "issue edit":
        return ok(`https://github.com/${repo}/issues/${call.args[2] ?? ISSUE}\n`);
      case "run list":
        return json([{ databaseId: RUN, status: "completed", conclusion: "success", workflowName: "ci" }]);
      case "run view":
        return ok("test\tRun tests\t2026-10-01T00:00:00Z ok\n");
      case "label list":
        return json([
          { name: "bug" },
          { name: "documentation" },
          { name: "ready" },
          { name: "in-progress" },
          { name: "needs-review" },
          { name: "blocked" },
          { name: "agent-ok" },
        ]);
    }
    return failed(`unscripted: gh ${call.args.join(" ")}`, 127);
  };

  const scripted = (call: FakeCall): RunResult => {
    const [a0] = call.args;
    if (call.cmd.endsWith("install-launchd.sh")) {
      if (a0 === "status") {
        return ok(
          "Installed: yes (/home/example/Library/LaunchAgents/com.claude-workflow.poller.plist)\n" +
            `Loaded:    ${paused ? "no" : "yes"}\n` +
            `Disabled:  ${paused ? "yes" : "no"}\n`,
        );
      }
      if (a0 === "pause") {
        paused = true;
        return ok("Paused.\n");
      }
      if (a0 === "resume") {
        paused = false;
        return ok("Resumed.\n");
      }
    }
    if (call.cmd === "git" && call.args.includes("get-url")) {
      return ok(`${world.origin ?? `git@github.com:${FAKE_REPO}.git`}\n`);
    }
    if (call.cmd === "open") return ok();
    if (call.cmd === "security" && a0 === "find-internet-password") {
      return world.keychainHasGithub
        ? ok('keychain: "/home/example/Library/Keychains/login.keychain-db"\n    "srvr"<blob>="github.com"\n')
        : failed("security: The specified item could not be found in the keychain.", 44);
    }
    if (call.cmd === "gh") return gh(call);
    return failed(`unscripted: ${call.cmd} ${call.args.join(" ")}`, 127);
  };

  const io: SetupIo = {
    run(cmd: string, args: readonly string[], opts: RunOptions = {}): RunResult {
      const call: FakeCall = { cmd, args: [...args], env: { ...opts.env }, input: opts.input };
      calls.push(call);
      const answer = world.respond?.(call);
      if (answer) return answer;
      if (world.fail?.(call)) return failed("gh: Internal Server Error (HTTP 500)");
      return scripted(call);
    },
    listSessions: () => structuredClone(world.sessions ?? []),
    readSecret(prompt: string): string {
      prompts.push({ kind: "secret", text: prompt });
      return world.secret ?? FAKE_TOKEN;
    },
    confirm(question: string): boolean {
      prompts.push({ kind: "confirm", text: question });
      return world.confirm ?? false;
    },
    readFile: (path: string) => world.files?.[path],
    env: (name: string) => world.env?.[name],
    report(status: StepStatus, text: string): void {
      reports.push({ status, text });
    },
  };

  return { io, calls, reports, prompts };
}
