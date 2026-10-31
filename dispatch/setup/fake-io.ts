// A fake SetupIo for the setup phases' tests: `run` answers from a scripted, stateful world
// (gh, git, install-launchd.sh, security, open) with happy-path defaults a test overrides,
// and every call, report and prompt is recorded.
//
// The happy path: dispatch already paused, no live sessions, origin example-owner/example-tools,
// a classic admin login, `protect-main` (active, with a pull_request rule and no bypass actors)
// and `restrict-updates` in exempt mode in place, auto-merge off, an open mergeable PR with a
// `test` CheckRun, an open issue, a run, labels, every pre-swap command passing, the
// pasted token FAKE_TOKEN, a swap that leaves one fine-grained login, no stray tokens, and a
// wrong-sha merge probe refused with HTTP 403.
//
// The ruleset model: a ruleset read gives `current_user_can_bypass` from the Repository admin
// role's bypass mode, for every login (always, pull_requests_only, exempt, or never when the role
// is not a bypass actor), and `bypass_actors` only to the admin login. `rules/branches/<branch>`
// returns the rules of every active branch ruleset whose include names `~DEFAULT_BRANCH`, `~ALL`
// or `refs/heads/<branch>`, each tagged with its ruleset's id and source.
//
// The ssh model lives under FAKE_HOME: `files` is a mutable in-memory file system (read by
// readFile, readFirstLine and listDir; written by appendFile, copyFile and the fake ssh-keygen),
// with scripted ssh-keygen, ssh-add, `ssh -G`, pbcopy, `git ls-remote` through a
// `github.com-<name>` alias, and `git -C <dir> remote get-url|set-url origin` per directory.
// By default GitHub holds no deploy key, the agent holds no key, and the maintainer pastes the
// copied key while the phase waits for Enter.
//
// The sandbox model: `claude plugin list --json` prints `plugins` (a mutable install list),
// `claude plugin marketplace update` succeeds, `claude plugin update <id> --scope <scope>`
// moves the named install to `pluginUpdate` (or leaves it as it is), and `sudo mkdir -p` and
// `sudo tee <path>` (which writes its stdin to `files`) succeed. `run` records `opts.cwd`.
//
// The check model: `launch` records each probe session in `launches` and starts nothing;
// `waitForFile` returns what `probe` gives for the latest launch (undefined by default: the
// session never wrote a result); `removeFile` deletes from `files`; `claude stop <name>`
// succeeds.
//
// The fake ignores `--json` field lists and `--jq`: JSON reads print the whole object.
// Commands it has no script for exit 127 with "unscripted" on stderr.
import type { Session } from "../poller/schemas.ts";
import type { RunOptions, RunResult, SetupIo, StepStatus } from "./io.ts";

export const FAKE_REPO = "example-owner/example-tools";
export const FAKE_LOGIN = "example-owner";
/** What `readSecret` returns unless the world says otherwise. */
export const FAKE_TOKEN = "github_pat_FAKE_TOKEN_FOR_TESTS";
/** The home the ssh model uses: keys and config live in `<FAKE_HOME>/.ssh`. */
export const FAKE_HOME = "/home/example";

export interface FakeCall {
  cmd: string;
  args: readonly string[];
  env: Readonly<Record<string, string>>;
  input: string | undefined;
  /** The working directory, when the call gave one. */
  cwd?: string;
}

export interface FakeReport {
  status: StepStatus;
  text: string;
}

export interface FakePrompt {
  kind: "secret" | "confirm" | "enter";
  text: string;
}

/** A file-system call on the fake: `path` is the file read or written (for copyFile, `from`). */
export interface FakeFileOp {
  op: "readFile" | "readFirstLine" | "listDir" | "appendFile" | "copyFile" | "writeFile" | "waitForFile" | "removeFile";
  path: string;
  to?: string;
  text?: string;
}

/** A session started with `launch`. */
export interface FakeLaunch {
  dir: string;
  name: string;
  flags: readonly string[];
  prompt: string;
  env: Readonly<Record<string, string>>;
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

/** An install as `claude plugin list --json` prints it. */
export interface FakePlugin {
  id: string;
  scope: string;
  installPath: string;
  version: string;
  projectPath?: string;
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
  /** Files by absolute path: the start of the fake's mutable file system. Default none. */
  files?: Record<string, string>;
  /** Repos (owner/name) whose deploy key GitHub already has. Default none. */
  deployKeys?: string[];
  /** The maintainer adds the copied key while the phase waits for Enter. Default true. */
  pastes?: boolean;
  /** `git -C <dir> remote get-url origin` by directory. Default `origin` for every directory. */
  remotes?: Record<string, string>;
  /** Key paths loaded in ssh-agent. Default none. */
  agentKeys?: string[];
  /** Key paths that have a passphrase. Default none. */
  passphrase?: string[];
  /** `security find-internet-password -s github.com` finds an entry. Default false. */
  keychainHasGithub?: boolean;
  /** What `claude plugin list --json` prints. Default none. */
  plugins?: FakePlugin[];
  /**
   * Where `claude plugin update <id> --scope <scope>` moves the install it names (for project
   * and local scope, the one whose projectPath is the call's cwd). Default: left unchanged.
   */
  pluginUpdate?: { installPath: string; version: string };
  /**
   * What `waitForFile` returns for the latest launch: the probe session's result text, or
   * undefined when the session never wrote one. Default undefined.
   */
  probe?: (launch: FakeLaunch) => string | undefined;
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
    bypass_actors: [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "exempt" }],
    ...overrides,
  };
}

/** Another ruleset on the repo, which the credentials phase must leave alone. */
export function protectMain(overrides: Partial<FakeRuleset> = {}): FakeRuleset {
  return {
    id: 100,
    name: "protect-main",
    target: "branch",
    enforcement: "active",
    conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } },
    rules: [{ type: "deletion" }, { type: "non_fast_forward" }, { type: "pull_request" }],
    bypass_actors: [],
    ...overrides,
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
 * `gh issue edit`; `gh pr edit`; `gh auth logout`; `gh auth login`; `open`; `ssh-keygen -t`
 * (generating a key); `pbcopy`; `ssh-add -d` or `-D`; `git ... remote set-url`; every `sudo`
 * call; `claude plugin marketplace update`; `claude plugin update`; and `claude stop`.
 */
export function isWrite(call: FakeCall): boolean {
  const [a0, a1] = call.args;
  if (call.cmd.endsWith("install-launchd.sh")) return a0 === "pause" || a0 === "resume";
  if (call.cmd === "open" || call.cmd === "pbcopy" || call.cmd === "sudo") return true;
  if (call.cmd === "claude") {
    const [, b1, b2] = call.args;
    if (a0 === "stop") return true;
    return a0 === "plugin" && (b1 === "update" || (b1 === "marketplace" && b2 === "update"));
  }
  if (call.cmd === "ssh-keygen") return call.args.includes("-t");
  if (call.cmd.endsWith("ssh-add")) return call.args.includes("-d") || call.args.includes("-D");
  if (call.cmd === "git") {
    const i = call.args.indexOf("remote");
    return i >= 0 && call.args[i + 1] === "set-url";
  }
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

/** The file writes among `ops`: appendFile, copyFile, writeFile and removeFile. */
export function fileWrites(ops: readonly FakeFileOp[]): FakeFileOp[] {
  return ops.filter(
    (o) => o.op === "appendFile" || o.op === "copyFile" || o.op === "writeFile" || o.op === "removeFile",
  );
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

  const fileOps: FakeFileOp[] = [];
  const files: Record<string, string> = { ...world.files };
  const remotes: Record<string, string> = { ...world.remotes };
  const githubKeys = new Set(world.deployKeys ?? []);
  let agentKeys = [...(world.agentKeys ?? [])];
  let clipboard: string | undefined;
  let lastOpen: string | undefined;
  const plugins: FakePlugin[] = structuredClone(world.plugins ?? []);
  const launches: FakeLaunch[] = [];

  /** Whether the call authenticates as a fine-grained token (GH_TOKEN first, as gh does). */
  const fineGrained = (call: FakeCall) =>
    call.env.GH_TOKEN !== undefined
      ? call.env.GH_TOKEN.startsWith("github_pat_")
      : accounts.some((a) => a.fineGrained);

  const rulesetView = (r: FakeRuleset, call: FakeCall) => {
    const admin = (r.bypass_actors ?? []).find(
      (b): b is Record<string, unknown> =>
        typeof b === "object" && b !== null &&
        (b as Record<string, unknown>).actor_type === "RepositoryRole" &&
        (b as Record<string, unknown>).actor_id === 5,
    );
    const canBypass =
      admin === undefined ? "never"
      : admin.bypass_mode === "always" ? "always"
      : admin.bypass_mode === "pull_request" ? "pull_requests_only"
      : admin.bypass_mode === "exempt" ? "exempt"
      : "never";
    const view: Record<string, unknown> = {
      ...r,
      source_type: "Repository",
      source: FAKE_REPO,
      node_id: `RRS_${r.id}`,
      current_user_can_bypass: canBypass,
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
    if (rest[0] === "rules" && rest[1] === "branches" && rest.length >= 3 && method === "GET") {
      const branch = rest.slice(2).join("/");
      const applies = (r: FakeRuleset) => {
        const include = (r.conditions as { ref_name?: { include?: string[] } } | undefined)?.ref_name?.include ?? [];
        return include.some((i) => i === "~DEFAULT_BRANCH" || i === "~ALL" || i === `refs/heads/${branch}`);
      };
      return json(
        rulesets
          .filter((r) => r.target === "branch" && r.enforcement === "active" && applies(r))
          .flatMap((r) =>
            (r.rules ?? []).map((rule) => ({
              ...(rule as Record<string, unknown>),
              ruleset_id: r.id,
              ruleset_source_type: "Repository",
              ruleset_source: repo,
            })),
          ),
      );
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

  const sshDir = `${FAKE_HOME}/.ssh`;
  const sshConfig = `${sshDir}/config`;
  const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
  const publicLine = (path: string) => `ssh-ed25519 AAAAFAKE${baseName(path)} ${baseName(path)}\n`;

  /** Whether ~/.ssh/config has a `Host` line naming `host`. */
  const hasHost = (host: string) =>
    (files[sshConfig] ?? "").split("\n").some((line) => {
      const words = line.trim().split(/\s+/);
      return words[0]?.toLowerCase() === "host" && words.slice(1).includes(host);
    });

  const sshKeygen = (call: FakeCall): RunResult => {
    const path = flagValue(call.args, "-f");
    if (path === undefined) return failed(`unscripted: ssh-keygen ${call.args.join(" ")}`, 127);
    if (call.args.includes("-t")) {
      if (files[path] !== undefined) return failed(`${path} already exists.`);
      files[path] =
        "-----BEGIN OPENSSH PRIVATE KEY-----\n" +
        `FAKE-KEY-BODY-FOR-TESTS-${baseName(path)}\n` +
        "-----END OPENSSH PRIVATE KEY-----\n";
      files[`${path}.pub`] = publicLine(path);
      return ok(`Your identification has been saved in ${path}\n`);
    }
    if (call.args.includes("-y")) {
      if (files[path] === undefined) return failed(`Load key "${path}": No such file or directory`, 255);
      if (world.passphrase?.includes(path)) {
        return failed(`Load key "${path}": incorrect passphrase supplied to decrypt private key`, 255);
      }
      return ok(files[`${path}.pub`] ?? publicLine(path));
    }
    return failed(`unscripted: ssh-keygen ${call.args.join(" ")}`, 127);
  };

  const sshAdd = (call: FakeCall): RunResult => {
    if (call.args.includes("-l")) {
      if (agentKeys.length === 0) return { status: 1, stdout: "The agent has no identities.\n", stderr: "" };
      return ok(agentKeys.map((k) => `256 SHA256:FAKE${baseName(k)} ${k} (ED25519)\n`).join(""));
    }
    if (call.args.includes("-D")) {
      agentKeys = [];
      return ok("All identities removed.\n");
    }
    if (call.args.includes("-d")) {
      const key = call.args[call.args.length - 1]!;
      if (!agentKeys.includes(key)) return failed(`Could not remove identity "${key}": agent refused operation`);
      agentKeys = agentKeys.filter((k) => k !== key);
      return ok(`Identity removed: ${key}\n`);
    }
    return failed(`unscripted: ssh-add ${call.args.join(" ")}`, 127);
  };

  const sshG = (call: FakeCall): RunResult => {
    const host = call.args[call.args.indexOf("-G") + 1] ?? "";
    const name = /^github\.com-(.+)$/.exec(host)?.[1];
    if (name !== undefined && hasHost(host)) {
      return ok(`hostname github.com\nuser git\nidentitiesonly yes\nidentityfile ~/.ssh/deploy-${name}\n`);
    }
    return ok(
      `hostname ${host}\nuser example\nidentitiesonly no\n` +
        "identityfile ~/.ssh/id_rsa\nidentityfile ~/.ssh/id_ecdsa\nidentityfile ~/.ssh/id_ed25519\n",
    );
  };

  const lsRemote = (call: FakeCall): RunResult => {
    const m = /^git@github\.com-([^:]+):([^/]+)\/(.+?)(?:\.git)?$/.exec(call.args[1] ?? "");
    const denied = failed(
      "git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.",
      128,
    );
    if (!m) return denied;
    const [, alias, owner, name] = m;
    const reaches =
      files[`${sshDir}/deploy-${alias}`] !== undefined &&
      hasHost(`github.com-${alias}`) &&
      githubKeys.has(`${owner}/${name}`);
    return reaches ? ok("0123456789abcdef0123456789abcdef01234567\tHEAD\n") : denied;
  };

  /** `git [-C <dir>] remote get-url|set-url origin [url]`, or undefined for other git calls. */
  const gitRemote = (call: FakeCall): RunResult | undefined => {
    const args = call.args;
    const dir = args[0] === "-C" ? args[1] : undefined;
    const i = args.indexOf("remote");
    if (i < 0) return undefined;
    const fallback = world.origin ?? `git@github.com:${FAKE_REPO}.git`;
    if (args[i + 1] === "get-url") {
      return ok(`${(dir !== undefined ? remotes[dir] : undefined) ?? fallback}\n`);
    }
    if (args[i + 1] === "set-url" && args[i + 2] === "origin" && args[i + 3] !== undefined) {
      if (dir !== undefined) remotes[dir] = args[i + 3]!;
      return ok();
    }
    return undefined;
  };

  const claude = (call: FakeCall): RunResult => {
    const [a0, a1, a2, a3] = call.args;
    if (a0 === "stop" && a1 !== undefined) return ok(`Stopped ${a1}\n`);
    if (a0 !== "plugin") return failed(`unscripted: claude ${call.args.join(" ")}`, 127);
    if (a1 === "list" && call.args.includes("--json")) return json(plugins);
    if (a1 === "marketplace" && a2 === "update" && a3 !== undefined) {
      return ok(`Successfully updated marketplace: ${a3}\n`);
    }
    if (a1 === "update" && a2 !== undefined) {
      const scope = flagValue(call.args, "--scope") ?? "user";
      const target = plugins.find(
        (p) => p.id === a2 && p.scope === scope && (scope === "user" || p.projectPath === call.cwd),
      );
      if (target && world.pluginUpdate) {
        target.installPath = world.pluginUpdate.installPath;
        target.version = world.pluginUpdate.version;
      }
      return ok(`Plugin "${a2}" updated.\n`);
    }
    return failed(`unscripted: claude ${call.args.join(" ")}`, 127);
  };

  const sudo = (call: FakeCall): RunResult => {
    const [a0, a1, a2] = call.args;
    if (a0 === "mkdir" && a1 === "-p" && a2 !== undefined) return ok();
    if (a0 === "tee" && a1 !== undefined) {
      const text = call.input ?? "";
      files[a1] = text;
      return ok(text);
    }
    return failed(`unscripted: sudo ${call.args.join(" ")}`, 127);
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
    if (call.cmd === "git") {
      if (a0 === "ls-remote") return lsRemote(call);
      const remote = gitRemote(call);
      if (remote) return remote;
    }
    if (call.cmd === "open") {
      lastOpen = a0;
      return ok();
    }
    if (call.cmd === "pbcopy") {
      clipboard = call.input ?? "";
      return ok();
    }
    if (call.cmd === "ssh-keygen") return sshKeygen(call);
    if (call.cmd.endsWith("ssh-add")) return sshAdd(call);
    if (call.cmd === "ssh" && call.args.includes("-G")) return sshG(call);
    if (call.cmd === "security" && a0 === "find-internet-password") {
      return world.keychainHasGithub
        ? ok('keychain: "/home/example/Library/Keychains/login.keychain-db"\n    "srvr"<blob>="github.com"\n')
        : failed("security: The specified item could not be found in the keychain.", 44);
    }
    if (call.cmd === "gh") return gh(call);
    if (call.cmd === "claude") return claude(call);
    if (call.cmd === "sudo") return sudo(call);
    return failed(`unscripted: ${call.cmd} ${call.args.join(" ")}`, 127);
  };

  const io: SetupIo = {
    run(cmd: string, args: readonly string[], opts: RunOptions = {}): RunResult {
      const call: FakeCall = { cmd, args: [...args], env: { ...opts.env }, input: opts.input };
      if (opts.cwd !== undefined) call.cwd = opts.cwd;
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
    readFile(path: string): string | undefined {
      fileOps.push({ op: "readFile", path });
      return files[path];
    },
    env: (name: string) => world.env?.[name],
    report(status: StepStatus, text: string): void {
      reports.push({ status, text });
    },
    listDir(path: string): string[] | undefined {
      fileOps.push({ op: "listDir", path });
      const prefix = `${path.replace(/\/+$/, "")}/`;
      const names = Object.keys(files)
        .filter((p) => p.startsWith(prefix) && p.length > prefix.length)
        .map((p) => p.slice(prefix.length).split("/")[0]!);
      return names.length === 0 ? undefined : [...new Set(names)];
    },
    readFirstLine(path: string): string | undefined {
      fileOps.push({ op: "readFirstLine", path });
      const text = files[path];
      if (text === undefined) return undefined;
      const end = text.indexOf("\n");
      return end < 0 ? text : text.slice(0, end);
    },
    appendFile(path: string, text: string): void {
      fileOps.push({ op: "appendFile", path, text });
      files[path] = (files[path] ?? "") + text;
    },
    copyFile(from: string, to: string): void {
      fileOps.push({ op: "copyFile", path: from, to });
      if (files[from] === undefined) throw new Error(`ENOENT: no such file or directory, copyfile '${from}'`);
      if (files[to] !== undefined) throw new Error(`EEXIST: file already exists, copyfile '${from}' -> '${to}'`);
      files[to] = files[from]!;
    },
    writeFile(path: string, text: string): void {
      fileOps.push({ op: "writeFile", path, text });
      files[path] = text;
    },
    waitForEnter(prompt: string): void {
      prompts.push({ kind: "enter", text: prompt });
      if (world.pastes === false || lastOpen === undefined) return;
      const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/settings\/keys\/new$/.exec(lastOpen);
      if (!m) return;
      const [, owner, name] = m;
      const pub = files[`${sshDir}/deploy-${name}.pub`];
      if (pub !== undefined && clipboard === pub) githubKeys.add(`${owner}/${name}`);
    },
    launch(dir, name, flags, prompt, env): void {
      launches.push({ dir, name, flags: [...flags], prompt, env: { ...env } });
    },
    waitForFile(path: string): string | undefined {
      fileOps.push({ op: "waitForFile", path });
      const last = launches[launches.length - 1];
      return last === undefined ? undefined : world.probe?.(last);
    },
    removeFile(path: string): void {
      fileOps.push({ op: "removeFile", path });
      delete files[path];
    },
  };

  return { io, calls, reports, prompts, fileOps, files, launches };
}
