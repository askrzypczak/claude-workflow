// A fake SetupIo for the setup phases' tests: `run` answers from a scripted, stateful world
// (gh, git, install-launchd.sh, security, open, pbcopy, docker) with happy-path defaults a test
// overrides, and every call, report and prompt is recorded.
//
// The happy path: dispatch already paused, no live sessions, origin example-owner/example-tools,
// a classic admin login, `protect-main` (active, with a pull_request rule and no bypass actors)
// and `restrict-updates` in exempt mode in place, auto-merge off, an open mergeable PR with a
// `test` CheckRun, an open issue, a run, labels, every pre-swap command passing, the
// pasted token FAKE_TOKEN, a swap that leaves one fine-grained login, no stray tokens, and a
// merge probe (a ref create at the all-zero sha) refused with HTTP 403 (422 for a GH_TOKEN
// listed in `merges`).
//
// The ruleset model: a ruleset read gives `current_user_can_bypass` from the Repository admin
// role's bypass mode, for every login (always, pull_requests_only, exempt, or never when the role
// is not a bypass actor), and `bypass_actors` only to the admin login. `rules/branches/<branch>`
// returns the rules of every active branch ruleset whose include names `~DEFAULT_BRANCH`, `~ALL`
// or `refs/heads/<branch>`, each tagged with its ruleset's id and source.
//
// The host: `files` is a mutable in-memory file system (read by readFile, written by copyFile
// and writeFile), `git -C <dir> remote get-url origin` prints `origin`, and pbcopy keeps its
// stdin as the clipboard. By default GitHub holds no deploy key, and the maintainer adds the
// copied key while the phase waits for Enter after opening the repo's new-deploy-key page.
// `run` records `opts.cwd`.
//
// The host extras: `stat -f %Lp <path>` prints a file's mode from `modes` (0600 unless the world
// says otherwise; writeFile creates files 0600), `chmod <mode> <path>` sets it, `mkdir -p`
// succeeds, and `git config --global [--get] <key> [<value>]` reads and sets `hostGit`.
// `poll(read, done)` calls `read` up to three times, with no wait between, and returns the first
// text `done` accepts, else the last text read; each call is recorded in `polls`.
//
// The docker model (`world.docker`; without it, every docker call fails as an unreachable
// daemon does). Defaults: the daemon answers, no image, no volume, no container. State:
// - images by tag: `docker build -t <tag> …` tags the id `buildId` (read at each build, so a
//   test may change it between runs); `docker image inspect <tag>` prints `[{Id, RepoTags}]`.
// - volumes: `docker volume inspect|create|rm`. Each volume holds a node home: a file system with
//   modes, clones, node's global git config, the gh login, Claude's sessions, plugins and
//   marketplaces. `docker run` without the home volume at /home/node gets a fresh, empty home.
//   The world's files, clones, gitConfig, ghLogin, sessions, plugins and marketplaces seed the
//   claude-workflow-home volume.
// - one container, claude-workflow-agent: `docker run` (refused when one exists or the image or
//   env file is missing), `start`, `stop`, `rm [-f]`, `container inspect` / `inspect` (Id,
//   Image, Config.Labels, State.Status, State.Running, State.StartedAt and Mounts), and `logs
//   [--since <StartedAt>]`: each start logs `startLog`; a start whose log has the failure line
//   leaves the container exited. Ready lines go to stdout, failure lines to stderr.
// - `docker exec [-i] [-t] [-u user] [-w dir] [-e K=V] <container> <command…>` runs in the
//   running container: cat, test, grep, stat -c %a, install -d, mkdir, rm, printenv,
//   `sh -c '…cat > "$1.tmp"…' <$0> <path>` (writes stdin to the last argument,
//   mode 0600), ssh-keygen (-t creates a key, refusing an existing one), curl (only
//   `reach` hosts answer; /meta gives `metaKeys` as ssh_keys), git (ls-remote and clone through a
//   `github.com-<name>` alias reach GitHub only with ~/.ssh/deploy-<name>, an ssh config block for
//   the alias naming that key, a github.com line in known_hosts and the repo in `deployKeys`;
//   `-C <dir> remote get-url origin`; `config --global`; fetch), gh (auth status|login;
//   `auth token`, which prints the stored login's token only as node: FAKE_CONTAINER_TOKEN for a
//   seeded fine-grained login, else the token logged in with; repo view in a clone) and claude (agents --json --all; --bg --name <n> …, which starts a
//   session with a fresh id, records it in `launches` and writes `probe`'s text to
//   `<dir>/.<n>.txt`; stop <id>, by id only; plugin list|install|update and marketplace
//   list|add|update). Paths are taken literally: nothing expands `~`.
// The returned `docker` handle reads the state a phase left: the container, the current home's
// files and modes (the container's home, else the claude-workflow-home volume), its sessions
// (a live array a test may push to), gh login, git config, plugins and every `docker build`.
//
// The fake ignores `--json` field lists, `--jq` and `--format`: JSON reads print the whole
// object. Commands it has no script for exit 127 with "unscripted" on stderr.
import type { Session } from "../poller/schemas.ts";
import type { RunOptions, RunResult, SetupIo, StepStatus } from "./io.ts";

export const FAKE_REPO = "example-owner/example-tools";
export const FAKE_LOGIN = "example-owner";
/** What `readSecret` returns unless the world says otherwise. */
export const FAKE_TOKEN = "github_pat_FAKE_TOKEN_FOR_TESTS";
/** The home directory the tests give the phases. */
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
  op: "readFile" | "copyFile" | "writeFile";
  path: string;
  to?: string;
  text?: string;
}

/** A session started with `claude --bg` in the container. */
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

/** A container mount as `docker container inspect` reports it, lower-cased. */
export interface FakeMount {
  type: string;
  name?: string;
  source: string;
  destination: string;
}

/** A container that exists before the phase runs. */
export interface FakeContainerPreset {
  /** Default running. */
  state?: "running" | "stopped";
  /** The image id it runs. Default the id `docker build` gives (`buildId`). */
  image?: string;
  /** Its labels. Default none. */
  labels?: Record<string, string>;
  /** Default the claude-workflow-home volume at /home/node. */
  mounts?: FakeMount[];
  /** Its latest start's log lines. Default the readiness line. */
  log?: string[];
}

/** A file in the container's home: its text, or its text and mode (default 0600). */
export type FakeHomeFile = string | { text: string; mode: number };

/** The docker world (see the header). */
export interface FakeDocker {
  /** `docker info` answers. Default true. */
  reachable?: boolean;
  /** The image id each `docker build` gives. Default FAKE_IMAGE_ID. */
  buildId?: string;
  /** Whether the claude-workflow-home volume exists. Default: true when `container` is given. */
  volume?: boolean;
  /** The container before the phase runs. Default none. */
  container?: FakeContainerPreset;
  /** What each start by `docker run` or `docker start` logs. Default the readiness line. */
  startLog?: string[];
  /** Files in the home volume by absolute path under /home/node. Default none. */
  files?: Record<string, FakeHomeFile>;
  /** Clones in the home volume: directory to origin URL. Default none. */
  clones?: Record<string, string>;
  /** node's global git config. Default none. */
  gitConfig?: Record<string, string>;
  /** node's stored github.com login. Default none. */
  ghLogin?: "fine-grained" | "classic";
  /** `claude agents --json --all` in the container. Default none. */
  sessions?: Session[];
  /** Sessions started with `claude --bg` are left out of `claude agents`. Default false. */
  unlisted?: boolean;
  /** What `claude plugin list --json` prints in the container. Default none. */
  plugins?: FakePlugin[];
  /** Marketplace names `claude plugin marketplace list --json` prints. Default none. */
  marketplaces?: string[];
  /** Hosts curl reaches from the container. Default api.github.com and github.com. */
  reach?: string[];
  /** `ssh_keys` in GitHub's meta. Default FAKE_META_KEYS. */
  metaKeys?: string[];
  /** The container's environment, as printenv shows it. Default none (SSH_AUTH_SOCK unset). */
  env?: Record<string, string>;
  /** The result text a probe session writes; undefined when it writes none. Default undefined. */
  probe?: (launch: FakeLaunch) => string | undefined;
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
  /** `security find-internet-password -s github.com` finds an entry. Default false. */
  keychainHasGithub?: boolean;
  /** Host file modes by path. Default 0600. */
  modes?: Record<string, number>;
  /** The host's global git config. Default FAKE_GIT_IDENTITY. */
  hostGit?: Record<string, string>;
  /**
   * GH_TOKEN values whose merge probe GitHub answers with 422 (the token has Contents write, so
   * it can merge). Every other merge probe gets 403. Default none.
   */
  merges?: string[];
  /** The docker world. Default none: the docker daemon is unreachable. */
  docker?: FakeDocker;
  /** Calls for which this returns true exit 1 with "HTTP 500" on stderr. */
  fail?: (call: FakeCall) => boolean;
  /** First say on every call; undefined falls through to the scripted world. */
  respond?: (call: FakeCall) => RunResult | undefined;
}

/** The token of a container login the world seeds as `ghLogin: "fine-grained"`. */
export const FAKE_CONTAINER_TOKEN = "github_pat_FAKE_CONTAINER_TOKEN_FOR_TESTS";
/** The token of a container login the world seeds as `ghLogin: "classic"`. */
const FAKE_CONTAINER_CLASSIC_TOKEN = "gho_fakeContainerClassicTokenForTests";

/** The image id `docker build` gives unless the world says otherwise. */
const FAKE_IMAGE_ID = `sha256:${"1".repeat(64)}`;
/** GitHub's meta `ssh_keys` unless the world says otherwise. */
export const FAKE_META_KEYS = [
  "ssh-ed25519 AAAAC3FAKEMETAKEYFORTESTSed25519",
  "ecdsa-sha2-nistp256 AAAAE2FAKEMETAKEYFORTESTSecdsa",
  "ssh-rsa AAAAB3FAKEMETAKEYFORTESTSrsa",
];
/** The host's global git identity unless the world says otherwise. */
export const FAKE_GIT_IDENTITY: Readonly<Record<string, string>> = {
  "user.name": "Example Owner",
  "user.email": "example-owner@users.noreply.github.com",
};

/** A `docker exec` call taken apart: its options, the container and the command run in it. */
export interface FakeExec {
  user: string | undefined;
  workdir: string | undefined;
  interactive: boolean;
  env: string[];
  container: string;
  command: string[];
}

const EXEC_VALUE_FLAGS = new Set(["-u", "--user", "-w", "--workdir", "-e", "--env", "--env-file"]);

/** A `docker exec` call's parts; undefined for any other call. */
export function parseDockerExec(call: Pick<FakeCall, "cmd" | "args">): FakeExec | undefined {
  if (call.cmd !== "docker" || call.args[0] !== "exec") return undefined;
  const x: FakeExec = { user: undefined, workdir: undefined, interactive: false, env: [], container: "", command: [] };
  const set = (flag: string, value: string) => {
    if (flag === "-u" || flag === "--user") x.user = value;
    else if (flag === "-w" || flag === "--workdir") x.workdir = value;
    else if (flag === "-e" || flag === "--env") x.env.push(value);
  };
  for (let i = 1; i < call.args.length; i++) {
    const arg = call.args[i]!;
    if (!arg.startsWith("-")) {
      x.container = arg;
      x.command = call.args.slice(i + 1);
      return x;
    }
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq > 0) {
      set(arg.slice(0, eq), arg.slice(eq + 1));
    } else if (EXEC_VALUE_FLAGS.has(arg)) {
      set(arg, call.args[i + 1] ?? "");
      i++;
    } else if (/^-[a-zA-Z]+$/.test(arg)) {
      // Combined short flags: -i, -t, -it, -d.
      if (arg.includes("i")) x.interactive = true;
    } else if (arg === "--interactive") {
      x.interactive = true;
    }
  }
  return undefined;
}

/** Whether `git config` arguments set or unset a value (rather than read one). */
function isGitConfigWrite(args: readonly string[]): boolean {
  const writes = ["--unset", "--unset-all", "--add", "--replace-all", "--remove-section", "--rename-section"];
  if (args.some((a) => writes.includes(a))) return true;
  if (args.some((a) => a === "--get" || a === "--get-all" || a === "-l" || a === "--list")) return false;
  const positional = args.filter((a, i) => !a.startsWith("-") && args[i - 1] !== "--file" && args[i - 1] !== "-f");
  return positional.length >= 2;
}

/** Strips git's leading `-C <dir>` and `-c <k=v>` options; returns the dir and the rest. */
function gitArgs(args: readonly string[]): { dir: string | undefined; rest: string[] } {
  let dir: string | undefined;
  let i = 0;
  while (i < args.length && (args[i] === "-C" || args[i] === "-c")) {
    if (args[i] === "-C") dir = args[i + 1];
    i += 2;
  }
  return { dir, rest: args.slice(i) };
}

/** Whether a claude call (its arguments) changes state. */
function isClaudeWrite(args: readonly string[]): boolean {
  const [a0, a1, a2] = args;
  if (a0 === "stop" || args.includes("--bg")) return true;
  if (a0 !== "plugin") return false;
  if (a1 === "marketplace") return a2 === "add" || a2 === "update" || a2 === "remove";
  return a1 === "install" || a1 === "update" || a1 === "uninstall" || a1 === "enable" || a1 === "disable";
}

const EXEC_WRITE_COMMANDS = new Set(["install", "mkdir", "chmod", "chown", "rm", "rmdir", "mv", "cp", "tee", "touch", "ln"]);

/** Whether a command run in the container changes state. */
function isExecWrite(command: readonly string[]): boolean {
  const [c, ...rest] = command;
  if (c === undefined) return false;
  if (EXEC_WRITE_COMMANDS.has(c)) return true;
  if (c === "sh" || c === "bash") {
    const script = rest[rest.indexOf("-c") + 1] ?? "";
    return /(^|[^0-9&>])>(?!&)|\b(mv|rm|install|mkdir|chmod|tee|touch|cp)\b/.test(script);
  }
  if (c === "ssh-keygen") return rest.includes("-t");
  if (c === "git") {
    const { rest: g } = gitArgs(rest);
    if (g[0] === "clone" || g[0] === "init" || g[0] === "commit") return true;
    if (g[0] === "push") return !g.includes("--dry-run") && !g.includes("-n");
    if (g[0] === "remote") return g[1] === "add" || g[1] === "set-url" || g[1] === "remove";
    if (g[0] === "config") return isGitConfigWrite(g.slice(1));
    return false;
  }
  if (c === "gh") return rest[0] === "auth" && (rest[1] === "login" || rest[1] === "logout" || rest[1] === "setup-git");
  if (c === "claude") return isClaudeWrite(rest);
  return false;
}

const DOCKER_WRITES = new Set([
  "build", "run", "create", "start", "stop", "restart", "rm", "kill", "pull", "cp", "rename", "update",
  "pause", "unpause", "tag", "rmi",
]);

/** Whether a docker call (its arguments) changes state. */
function isDockerWrite(args: readonly string[]): boolean {
  const [a0, a1] = args;
  if (a0 === "exec") {
    const x = parseDockerExec({ cmd: "docker", args });
    return x !== undefined && isExecWrite(x.command);
  }
  if (a0 === "container") return isDockerWrite(args.slice(1));
  if (a0 === "volume") return a1 === "create" || a1 === "rm" || a1 === "remove" || a1 === "prune";
  if (a0 === "image") return a1 === "build" || a1 === "rm" || a1 === "prune" || a1 === "pull" || a1 === "tag";
  return DOCKER_WRITES.has(a0 ?? "");
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

/** The ref the merge probe asks GitHub to create. */
const PROBE_REF = "refs/claude-workflow-probe/cannot-merge";

/**
 * The merge probe: a POST on a repo's `git/refs` endpoint creating PROBE_REF at sha forty zeros,
 * which GitHub never creates, whatever the token can do.
 */
export function isMergeProbe(call: FakeCall): boolean {
  const api = parseGhApi(call);
  return (
    api !== undefined &&
    api.method === "POST" &&
    /^repos\/[^/]+\/[^/]+\/git\/refs$/.test(api.endpoint) &&
    call.args.some((a) => a === `ref=${PROBE_REF}`) &&
    call.args.some((a) => a === `sha=${"0".repeat(40)}`)
  );
}

/**
 * Whether a call changes state. This is the definition of "write command" the setup tests
 * use: `install-launchd.sh` pause or resume; `gh api` with a POST, PUT, PATCH or DELETE
 * (explicit, or implied by a body) except the merge probe; `gh issue comment`;
 * `gh issue edit`; `gh pr edit`; `gh auth logout`; `gh auth login`; `open`; `pbcopy`;
 * `git ... remote set-url`; `git config` setting a value; `chmod`; `mkdir`; and every docker
 * call that changes state: build, run, create, start, stop, restart, rm, kill, volume create or rm, and a
 * `docker exec` whose command writes (install, mkdir, chmod, rm, mv, cp, tee, touch, a `sh -c`
 * redirect, `ssh-keygen -t`, git clone or config set, gh auth login or logout, and the claude
 * writes: stopping or starting a session, or installing, updating or removing a plugin or
 * marketplace).
 */
function isWrite(call: FakeCall): boolean {
  const [a0, a1] = call.args;
  if (call.cmd.endsWith("install-launchd.sh")) return a0 === "pause" || a0 === "resume";
  if (call.cmd === "open" || call.cmd === "pbcopy") return true;
  if (call.cmd === "chmod" || call.cmd === "mkdir") return true;
  if (call.cmd === "docker") return isDockerWrite(call.args);
  if (call.cmd === "git") {
    const i = call.args.indexOf("remote");
    if (i >= 0 && call.args[i + 1] === "set-url") return true;
    const { rest } = gitArgs(call.args);
    return rest[0] === "config" && isGitConfigWrite(rest.slice(1));
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

/** The file writes among `ops`: copyFile and writeFile. */
export function fileWrites(ops: readonly FakeFileOp[]): FakeFileOp[] {
  return ops.filter((o) => o.op === "copyFile" || o.op === "writeFile");
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

// ---- The docker world ----

const DOCKER_NAME = "claude-workflow-agent";
const HOME_VOLUME = "claude-workflow-home";
const NODE_HOME = "/home/node";
const READY = "entrypoint: firewall applied";
const NOT_STARTING = "entrypoint: firewall failed; not starting";
const UNREACHABLE = "Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?";

/** The container as a test reads it after a run. */
export interface FakeContainerView {
  state: "running" | "stopped";
  image: string;
  labels: Readonly<Record<string, string>>;
  mounts: readonly FakeMount[];
  startedAt: string;
  /** Its environment from `--env-file` and `-e`. */
  env: Readonly<Record<string, string>>;
}

/** What a test reads of the docker world after a run. */
export interface FakeDockerHandle {
  /** The container, or undefined when there is none. */
  container(): FakeContainerView | undefined;
  /** A file's text in the current home (the container's, else the claude-workflow-home volume's). */
  file(path: string): string | undefined;
  /** A file's mode in the current home. */
  mode(path: string): number | undefined;
  /** The current home's Claude sessions: a live array a test may push to. */
  sessions(): Session[];
  /** The current home's gh login. */
  login(): "fine-grained" | "classic" | undefined;
  /** The current home's global git config. */
  gitConfig(): Readonly<Record<string, string>>;
  /** The current home's plugin installs. */
  plugins(): readonly FakePlugin[];
  /** The arguments of every `docker build`. */
  builds: string[][];
}

interface HomeFile {
  text: string;
  mode: number;
}

/** A node home: what a volume (or a container's anonymous home) holds. */
interface Home {
  files: Map<string, HomeFile>;
  dirs: Map<string, number>;
  clones: Map<string, string>;
  git: Record<string, string>;
  login: "fine-grained" | "classic" | undefined;
  /** The stored login's token, which `gh auth token` prints. */
  token: string | undefined;
  sessions: Session[];
  plugins: FakePlugin[];
  marketplaces: string[];
}

interface Container {
  id: string;
  image: string;
  labels: Record<string, string>;
  mounts: FakeMount[];
  running: boolean;
  startedAt: string;
  /** The latest start's log lines. */
  log: string[];
  /** Every start's log lines. */
  history: string[];
  home: Home;
  env: Record<string, string>;
}

const RUN_VALUE_FLAGS = new Set([
  "--name", "-v", "--volume", "--mount", "--env-file", "-e", "--env", "--label", "-l", "--cap-add", "--cap-drop",
  "--security-opt", "--restart", "--network", "--net", "-u", "--user", "-w", "--workdir", "--entrypoint",
  "--hostname", "-h", "--memory", "-m", "--cpus", "--pull", "--platform", "--add-host", "--dns", "--tmpfs",
  "--device", "--log-driver", "--log-opt",
]);

/** A `docker run` call's options (in order, `--flag=value` split), and its image and command. */
function parseRun(args: readonly string[]): { opts: [string, string][]; image: string | undefined; command: string[] } {
  const opts: [string, string][] = [];
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (!arg.startsWith("-")) return { opts, image: arg, command: args.slice(i + 1) };
    const eq = arg.indexOf("=");
    if (arg.startsWith("--") && eq > 0) opts.push([arg.slice(0, eq), arg.slice(eq + 1)]);
    else if (RUN_VALUE_FLAGS.has(arg)) {
      opts.push([arg, args[i + 1] ?? ""]);
      i++;
    } else opts.push([arg, ""]);
  }
  return { opts, image: undefined, command: [] };
}

/** One `--mount` value: `type=volume,source=x,target=/y`. */
function parseMountFlag(value: string): FakeMount {
  const fields = Object.fromEntries(value.split(",").map((kv) => {
    const eq = kv.indexOf("=");
    return eq < 0 ? [kv, ""] : [kv.slice(0, eq), kv.slice(eq + 1)];
  }));
  const type = fields.type ?? "volume";
  const source = fields.source ?? fields.src ?? "";
  const destination = fields.target ?? fields.destination ?? fields.dst ?? "";
  return type === "volume"
    ? { type, name: source, source: `/var/lib/docker/volumes/${source}/_data`, destination }
    : { type, source, destination };
}

/** One `-v` value: `name:/dest[:opts]` (a volume) or `/src:/dest[:opts]` (a bind). */
function parseVolumeFlag(value: string): FakeMount {
  const [source = "", destination = ""] = value.split(":");
  return source.startsWith("/") || source.startsWith(".") || source.startsWith("~")
    ? { type: "bind", source, destination }
    : { type: "volume", name: source, source: `/var/lib/docker/volumes/${source}/_data`, destination };
}

const homeMount = (): FakeMount => ({
  type: "volume",
  name: HOME_VOLUME,
  source: `/var/lib/docker/volumes/${HOME_VOLUME}/_data`,
  destination: NODE_HOME,
});

/** owner/name from a clone's origin URL (an alias form included). */
function originRepo(url: string): string | undefined {
  const m =
    /^(?:ssh:\/\/)?git@[^:/]+[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url) ??
    /^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url);
  return m ? `${m[1]}/${m[2]}` : undefined;
}

/** The ssh config blocks that apply to `host`: their HostName and IdentityFile values. */
function sshOptions(config: string, host: string): { hostname: string | undefined; identityFiles: string[] } {
  let applies = false;
  let hostname: string | undefined;
  const identityFiles: string[] = [];
  for (const raw of config.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.startsWith("#")) continue;
    const m = /^(\S+?)(?:\s*=\s*|\s+)(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.trim();
    if (key === "host") {
      applies = value.split(/\s+/).some((h) => h === host || h === "*");
    } else if (applies && key === "hostname") {
      hostname ??= value;
    } else if (applies && key === "identityfile") {
      identityFiles.push(value.replace(/^~\//, `${NODE_HOME}/`));
    }
  }
  return { hostname, identityFiles };
}

function newHome(seed: FakeDocker = {}): Home {
  const home: Home = {
    files: new Map(),
    dirs: new Map(),
    clones: new Map(),
    git: { ...seed.gitConfig },
    login: seed.ghLogin,
    token:
      seed.ghLogin === "fine-grained" ? FAKE_CONTAINER_TOKEN
      : seed.ghLogin === "classic" ? FAKE_CONTAINER_CLASSIC_TOKEN
      : undefined,
    sessions: structuredClone(seed.sessions ?? []),
    plugins: structuredClone(seed.plugins ?? []),
    marketplaces: [...(seed.marketplaces ?? [])],
  };
  for (const [path, file] of Object.entries(seed.files ?? {})) {
    home.files.set(path, typeof file === "string" ? { text: file, mode: 0o600 } : { ...file });
  }
  for (const [dir, url] of Object.entries(seed.clones ?? {})) addClone(home, dir, url);
  return home;
}

function addClone(home: Home, dir: string, url: string): void {
  home.clones.set(dir, url);
  home.dirs.set(dir, 0o755);
  home.dirs.set(`${dir}/.git`, 0o755);
  home.files.set(`${dir}/.git/config`, { text: `[remote "origin"]\n\turl = ${url}\n`, mode: 0o644 });
}

const parentOf = (path: string) => path.slice(0, Math.max(path.lastIndexOf("/"), 0)) || "/";

function isDir(home: Home, path: string): boolean {
  if (path === "/" || path === "/home" || path === NODE_HOME || home.dirs.has(path)) return true;
  const prefix = `${path}/`;
  return [...home.files.keys(), ...home.dirs.keys()].some((p) => p.startsWith(prefix));
}

/** Every file and directory under `dir`, with its depth below it (1 for a child). */
function entriesUnder(home: Home, dir: string): { path: string; depth: number; kind: "f" | "d" }[] {
  const prefix = dir === "/" ? "/" : `${dir}/`;
  const seen = new Map<string, "f" | "d">();
  const add = (path: string, kind: "f" | "d") => {
    // Every directory between `dir` and the path is an entry too.
    let p = parentOf(path);
    while (p.startsWith(prefix)) {
      if (!seen.has(p)) seen.set(p, "d");
      p = parentOf(p);
    }
    seen.set(path, kind);
  };
  for (const p of home.files.keys()) if (p.startsWith(prefix)) add(p, "f");
  for (const p of home.dirs.keys()) if (p.startsWith(prefix)) add(p, "d");
  return [...seen.entries()]
    .map(([path, kind]) => ({ path, kind, depth: path.slice(prefix.length).split("/").length }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

/** The docker world over `world.docker`, with the host state it reads and changes. */
function createDocker(
  world: FakeWorld,
  host: { files: Record<string, string>; githubKeys: Set<string>; launches: FakeLaunch[] },
) {
  const seed = world.docker ?? {};
  const images = new Map<string, string>();
  const volumes = new Map<string, Home>();
  const builds: string[][] = [];
  let stampCount = 0;
  let sessionCount = 0;
  let containerCount = 0;
  const stamp = () => `2026-10-31T10:00:${String(stampCount++).padStart(2, "0")}.000000000Z`;

  if (seed.volume ?? seed.container !== undefined) volumes.set(HOME_VOLUME, newHome(seed));
  /** The claude-workflow-home volume's home, made from the seed if the volume does not exist yet. */
  const seededHome = () => {
    const home = volumes.get(HOME_VOLUME) ?? pendingHome ?? newHome(seed);
    if (!volumes.has(HOME_VOLUME)) pendingHome = home;
    return home;
  };
  // The seed waits here until `docker volume create` or `docker run` makes the volume.
  let pendingHome: Home | undefined;

  let container: Container | undefined;
  if (seed.container !== undefined) {
    const preset = seed.container;
    const image = preset.image ?? seed.buildId ?? FAKE_IMAGE_ID;
    images.set(DOCKER_NAME, image);
    const mounts = structuredClone(preset.mounts ?? [homeMount()]);
    const homeAt = mounts.find((m) => m.destination === NODE_HOME && m.type === "volume");
    const log = preset.log ?? [READY];
    container = {
      id: `fakecontainer${containerCount++}`,
      image,
      labels: { ...preset.labels },
      mounts,
      running: (preset.state ?? "running") === "running",
      startedAt: stamp(),
      log: [...log],
      history: [...log],
      home: homeAt?.name === HOME_VOLUME ? volumes.get(HOME_VOLUME)! : newHome(),
      env: { ...seed.env },
    };
  }

  const volumeHome = (name: string): Home => {
    let home = volumes.get(name);
    if (home === undefined) {
      home = name === HOME_VOLUME ? (pendingHome ?? newHome(seed)) : newHome();
      volumes.set(name, home);
    }
    return home;
  };

  const start = (c: Container, command: readonly string[] = []) => {
    const log = command.length > 0
      ? ["entrypoint: takes no arguments; sessions run with docker exec"]
      : [...(world.docker?.startLog ?? [READY])];
    c.startedAt = stamp();
    c.log = log;
    c.history.push(...log);
    c.running = command.length === 0 && !log.includes(NOT_STARTING);
  };

  const noContainer = (name: string) => ({ status: 1, stdout: "[]\n", stderr: `Error response from daemon: No such container: ${name}\n` });
  const named = (name: string | undefined) =>
    container !== undefined && (name === DOCKER_NAME || name === container.id) ? container : undefined;

  const inspectContainer = (c: Container) => ({
    Id: c.id,
    Name: `/${DOCKER_NAME}`,
    Image: c.image,
    Config: {
      Image: DOCKER_NAME,
      Labels: c.labels,
      Env: Object.entries(c.env).map(([k, v]) => `${k}=${v}`),
    },
    State: { Status: c.running ? "running" : "exited", Running: c.running, StartedAt: c.startedAt },
    Mounts: c.mounts.map((m) => ({
      Type: m.type,
      ...(m.name === undefined ? {} : { Name: m.name }),
      Source: m.source,
      Destination: m.destination,
      RW: true,
    })),
    HostConfig: { RestartPolicy: { Name: "no" } },
  });

  const inspectImage = (tag: string) => {
    const id = images.get(tag.replace(/:latest$/, ""));
    return id === undefined
      ? { status: 1, stdout: "[]\n", stderr: `Error response from daemon: No such image: ${tag}\n` }
      : json([{ Id: id, RepoTags: [`${tag.replace(/:latest$/, "")}:latest`] }]);
  };

  const run = (call: FakeCall): RunResult => {
    const d = world.docker;
    if (d === undefined || d.reachable === false) return failed(UNREACHABLE);
    const args = call.args;
    const [a0, a1] = args;
    switch (a0) {
      case "info":
        return ok("Server Version: 28.3.0\nOperating System: colima\n");
      case "build":
        return build(args);
      case "image":
        if (a1 === "build") return build(args.slice(1));
        if (a1 === "inspect") return inspectImage(args[args.length - 1] ?? "");
        break;
      case "container":
        if (a1 === "inspect") return inspect(args.slice(1), "container");
        break;
      case "inspect":
        return inspect(args, undefined);
      case "volume":
        return volume(args);
      case "run":
        return runContainer(args);
      case "start": {
        const c = named(args[args.length - 1]);
        if (c === undefined) return noContainer(args[args.length - 1] ?? "");
        if (!c.running) start(c);
        return c.running ? ok(`${DOCKER_NAME}\n`) : failed(`Error response from daemon: container ${c.id} exited at start`);
      }
      case "stop": {
        const c = named(args[args.length - 1]);
        if (c === undefined) return noContainer(args[args.length - 1] ?? "");
        c.running = false;
        return ok(`${DOCKER_NAME}\n`);
      }
      case "rm": {
        const c = named(args[args.length - 1]);
        if (c === undefined) return noContainer(args[args.length - 1] ?? "");
        const force = args.includes("-f") || args.includes("--force");
        if (c.running && !force) {
          return failed(`Error response from daemon: cannot remove container "/${DOCKER_NAME}": container is running: stop the container before removing or force remove`);
        }
        container = undefined;
        return ok(`${DOCKER_NAME}\n`);
      }
      case "logs": {
        const c = named(args[args.length - 1]);
        if (c === undefined) return noContainer(args[args.length - 1] ?? "");
        const since = flagValue(args, "--since") ?? args.find((a) => a.startsWith("--since="))?.slice("--since=".length);
        const lines = since === c.startedAt ? c.log : c.history;
        const out = lines.filter((l) => !/failed/.test(l));
        const err = lines.filter((l) => /failed/.test(l));
        return { status: 0, stdout: out.map((l) => `${l}\n`).join(""), stderr: err.map((l) => `${l}\n`).join("") };
      }
      case "exec":
        return exec(call);
    }
    return failed(`unscripted: docker ${args.join(" ")}`, 127);
  };

  const build = (args: readonly string[]): RunResult => {
    builds.push([...args]);
    const tag = (flagValue(args, "-t") ?? flagValue(args, "--tag") ?? "").replace(/:latest$/, "");
    const id = world.docker?.buildId ?? FAKE_IMAGE_ID;
    if (tag !== "") images.set(tag, id);
    return args.includes("-q") || args.includes("--quiet") ? ok(`${id}\n`) : ok(`naming to docker.io/library/${tag} done\n`);
  };

  const inspect = (args: readonly string[], type: "container" | undefined): RunResult => {
    const name = args[args.length - 1] ?? "";
    const asType = type ?? flagValue(args, "--type");
    if (asType === "image") return inspectImage(name);
    const c = named(name);
    if (c !== undefined) return json([inspectContainer(c)]);
    if (asType === undefined && images.has(name.replace(/:latest$/, ""))) return inspectImage(name);
    return noContainer(name);
  };

  const volume = (args: readonly string[]): RunResult => {
    const [, sub] = args;
    const name = args[args.length - 1] ?? "";
    if (sub === "inspect") {
      return volumes.has(name)
        ? json([{ Name: name, Driver: "local", Mountpoint: `/var/lib/docker/volumes/${name}/_data` }])
        : { status: 1, stdout: "[]\n", stderr: `Error response from daemon: get ${name}: no such volume\n` };
    }
    if (sub === "create") {
      volumeHome(name);
      return ok(`${name}\n`);
    }
    if (sub === "rm" || sub === "remove") {
      if (!volumes.has(name)) return failed(`Error response from daemon: get ${name}: no such volume`);
      volumes.delete(name);
      if (name === HOME_VOLUME) pendingHome = newHome();
      return ok(`${name}\n`);
    }
    if (sub === "ls") return ok([...volumes.keys()].map((v) => `local     ${v}\n`).join(""));
    return failed(`unscripted: docker ${args.join(" ")}`, 127);
  };

  const runContainer = (args: readonly string[]): RunResult => {
    const { opts, image, command } = parseRun(args);
    const name = opts.find(([f]) => f === "--name")?.[1];
    if (container !== undefined && name === DOCKER_NAME) {
      return failed(`docker: Error response from daemon: Conflict. The container name "/${DOCKER_NAME}" is already in use by container "${container.id}".`, 125);
    }
    const imageId = image === undefined ? undefined : images.get(image.replace(/:latest$/, ""));
    if (imageId === undefined) {
      return failed(`Unable to find image '${image}:latest' locally\ndocker: Error response from daemon: pull access denied for ${image}`, 125);
    }
    const env: Record<string, string> = { ...world.docker?.env };
    const labels: Record<string, string> = {};
    const mounts: FakeMount[] = [];
    for (const [flag, value] of opts) {
      if (flag === "--env-file") {
        const text = host.files[value];
        if (text === undefined) return failed(`docker: open ${value}: no such file or directory.`, 125);
        for (const line of text.split("\n")) {
          const eq = line.indexOf("=");
          if (line.trim() !== "" && !line.startsWith("#") && eq > 0) env[line.slice(0, eq)] = line.slice(eq + 1);
        }
      } else if (flag === "-e" || flag === "--env") {
        const eq = value.indexOf("=");
        if (eq > 0) env[value.slice(0, eq)] = value.slice(eq + 1);
      } else if (flag === "--label" || flag === "-l") {
        const eq = value.indexOf("=");
        labels[eq < 0 ? value : value.slice(0, eq)] = eq < 0 ? "" : value.slice(eq + 1);
      } else if (flag === "-v" || flag === "--volume") {
        mounts.push(parseVolumeFlag(value));
      } else if (flag === "--mount") {
        mounts.push(parseMountFlag(value));
      }
    }
    for (const m of mounts) if (m.type === "volume" && m.name !== undefined) volumeHome(m.name);
    const homeAt = mounts.find((m) => m.destination === NODE_HOME && m.type === "volume");
    const c: Container = {
      id: `fakecontainer${containerCount++}`,
      image: imageId,
      labels,
      mounts,
      running: false,
      startedAt: "",
      log: [],
      history: [],
      home: homeAt?.name !== undefined ? volumeHome(homeAt.name) : newHome(),
      env,
    };
    if (name === DOCKER_NAME) container = c;
    start(c, command);
    return ok(`${c.id}\n`);
  };

  const exec = (call: FakeCall): RunResult => {
    const x = parseDockerExec(call);
    if (x === undefined) return failed("docker: 'docker exec' requires at least 2 arguments.", 1);
    const c = named(x.container);
    if (c === undefined) return failed(`Error response from daemon: No such container: ${x.container}`);
    if (!c.running) return failed(`Error response from daemon: container ${c.id} is not running`);
    const env = { ...c.env };
    for (const kv of x.env) {
      const eq = kv.indexOf("=");
      if (eq > 0) env[kv.slice(0, eq)] = kv.slice(eq + 1);
    }
    return inContainer(c.home, x.command, {
      cwd: x.workdir ?? NODE_HOME,
      input: x.interactive ? call.input : undefined,
      env,
      user: x.user ?? "root",
    });
  };

  /** A command run in the container's home. */
  const inContainer = (
    home: Home,
    command: readonly string[],
    at: { cwd: string; input: string | undefined; env: Record<string, string>; user: string },
  ): RunResult => {
    const [cmd, ...args] = command;
    const abs = (p: string) => (p.startsWith("/") ? p : `${at.cwd}/${p}`).replace(/\/+$/, "") || "/";
    const missing = (tool: string, p: string, status = 1) => failed(`${tool}: ${p}: No such file or directory`, status);
    const write = (path: string, text: string, mode: number): RunResult | undefined => {
      if (!isDir(home, parentOf(path))) return missing("sh", path, 2);
      home.files.set(path, { text, mode });
      return undefined;
    };
    const unscripted = () => failed(`unscripted: docker exec … ${command.join(" ")}`, 127);

    switch (cmd) {
      case "cat": {
        let out = "";
        for (const p of args.filter((a) => !a.startsWith("-")).map(abs)) {
          const f = home.files.get(p);
          if (f === undefined) return isDir(home, p) ? failed(`cat: ${p}: Is a directory`) : missing("cat", p);
          out += f.text;
        }
        return ok(out);
      }
      case "test": {
        const negate = args[0] === "!";
        const [op, p] = negate ? args.slice(1) : args;
        if (op === undefined || p === undefined) return { status: 1, stdout: "", stderr: "" };
        const path = abs(p);
        const f = home.files.get(path);
        const holds =
          op === "-e" ? f !== undefined || isDir(home, path)
          : op === "-f" ? f !== undefined
          : op === "-d" ? isDir(home, path)
          : op === "-s" ? f !== undefined && f.text.length > 0
          : op === "-r" ? f !== undefined || isDir(home, path)
          : false;
        return { status: holds !== negate ? 0 : 1, stdout: "", stderr: "" };
      }
      case "grep": {
        const flags = new Set<string>();
        let pattern: string | undefined;
        const paths: string[] = [];
        let options = true;
        for (let i = 0; i < args.length; i++) {
          const a = args[i]!;
          if (options && a === "--") options = false;
          else if (options && a === "-e") pattern = args[++i];
          else if (options && /^-[a-zA-Z]+$/.test(a)) for (const ch of a.slice(1)) flags.add(ch);
          else if (pattern === undefined) pattern = a;
          else paths.push(abs(a));
        }
        if (pattern === undefined) return failed("grep: no pattern", 2);
        const matches = (line: string) =>
          flags.has("F")
            ? (flags.has("i") ? line.toLowerCase().includes(pattern!.toLowerCase()) : line.includes(pattern!))
            : new RegExp(pattern!, flags.has("i") ? "i" : "").test(line);
        const files: string[] = [];
        let error = false;
        for (const p of paths) {
          if (home.files.has(p)) files.push(p);
          else if (isDir(home, p) && (flags.has("r") || flags.has("R"))) {
            files.push(...entriesUnder(home, p).filter((e) => e.kind === "f").map((e) => e.path));
          } else error = true;
        }
        let out = "";
        let matched = false;
        for (const f of files) {
          const lines = home.files.get(f)!.text.split("\n");
          const hits = lines.filter(matches);
          if (hits.length === 0) continue;
          matched = true;
          if (flags.has("l")) out += `${f}\n`;
          else if (!flags.has("q")) out += hits.map((l) => (files.length > 1 ? `${f}:${l}\n` : `${l}\n`)).join("");
        }
        return { status: matched ? 0 : error ? 2 : 1, stdout: flags.has("q") ? "" : out, stderr: "" };
      }
      case "stat": {
        const format = flagValue(args, "-c") ?? flagValue(args, "--format") ?? "%a";
        const p = abs(args[args.length - 1] ?? "");
        const f = home.files.get(p);
        const mode = f?.mode ?? (isDir(home, p) ? (home.dirs.get(p) ?? 0o755) : undefined);
        if (mode === undefined) return failed(`stat: cannot statx '${p}': No such file or directory`);
        return ok(`${format.replaceAll("%a", mode.toString(8)).replaceAll("%U", "node").replaceAll("%n", p).replaceAll("%s", String(f?.text.length ?? 4096))}\n`);
      }
      case "install":
      case "mkdir": {
        if (cmd === "install" && !args.includes("-d")) return unscripted();
        const mode = Number.parseInt(flagValue(args, "-m") ?? "755", 8);
        const dirs = args.filter((a, i) => !a.startsWith("-") && args[i - 1] !== "-m").map(abs);
        for (const dir of dirs) {
          if (cmd === "mkdir" && !args.includes("-p") && !isDir(home, parentOf(dir))) return missing("mkdir", dir);
          home.dirs.set(dir, isDir(home, dir) && cmd === "mkdir" ? (home.dirs.get(dir) ?? mode) : mode);
        }
        return ok();
      }
      case "rm": {
        const flags = args.filter((a) => a.startsWith("-")).join("");
        for (const p of args.filter((a) => !a.startsWith("-")).map(abs)) {
          if (home.files.delete(p)) continue;
          if (isDir(home, p) && (flags.includes("r") || flags.includes("R"))) {
            for (const e of entriesUnder(home, p)) {
              home.files.delete(e.path);
              home.dirs.delete(e.path);
            }
            home.dirs.delete(p);
            home.clones.delete(p);
            continue;
          }
          if (!flags.includes("f")) return failed(`rm: cannot remove '${p}': No such file or directory`);
        }
        return ok();
      }
      case "sh": {
        const i = args.indexOf("-c");
        const script = args[i + 1] ?? "";
        const positional = args.slice(i + 2);
        if (i >= 0 && /cat\s*>/.test(script) && positional.length > 0) {
          const path = abs(positional[positional.length - 1]!);
          return write(path, at.input ?? "", 0o600) ?? ok();
        }
        return unscripted();
      }
      case "printenv": {
        if (args.length === 0) return ok(Object.entries(at.env).map(([k, v]) => `${k}=${v}\n`).join(""));
        const values = args.map((a) => at.env[a]);
        return values.every((v) => v !== undefined) ? ok(values.map((v) => `${v}\n`).join("")) : { status: 1, stdout: "", stderr: "" };
      }
      case "ssh-keygen":
        return keygen(home, args, abs);
      case "curl":
        return curl(args);
      case "git":
        return git(home, args, at.cwd, abs);
      case "gh":
        return ghIn(home, args, at.cwd, at.input, at.user);
      case "claude":
        return claudeIn(home, args, at.cwd);
    }
    return unscripted();
  };

  const keygen = (home: Home, args: readonly string[], abs: (p: string) => string): RunResult => {
    const fileArg = flagValue(args, "-f") ?? (args.find((a) => /^-[a-z]*f$/.test(a) && a !== "-f") ? args[args.length - 1] : undefined);
    if (fileArg === undefined) return failed(`unscripted: ssh-keygen ${args.join(" ")}`, 127);
    const path = abs(fileArg);
    const base = path.slice(path.lastIndexOf("/") + 1);
    const comment = flagValue(args, "-C") ?? `node@${DOCKER_NAME}`;
    if (args.includes("-t")) {
      if (home.files.has(path)) return failed(`${path} already exists.\nOverwrite (y/n)? `);
      if (!isDir(home, parentOf(path))) return failed(`Saving key "${path}" failed: No such file or directory`);
      home.files.set(path, {
        text: `-----BEGIN OPENSSH PRIVATE KEY-----\nFAKE-CONTAINER-KEY-FOR-TESTS-${base}\n-----END OPENSSH PRIVATE KEY-----\n`,
        mode: 0o600,
      });
      home.files.set(`${path}.pub`, { text: `ssh-ed25519 AAAAFAKECONTAINER${base} ${comment}\n`, mode: 0o644 });
      return ok(`Your identification has been saved in ${path}\nYour public key has been saved in ${path}.pub\n`);
    }
    const key = home.files.get(path);
    if (key === undefined) return failed(`${path}: No such file or directory`, 255);
    return failed(`unscripted: ssh-keygen ${args.join(" ")}`, 127);
  };

  const curl = (args: readonly string[]): RunResult => {
    const url = args.find((a) => /^https?:\/\//.test(a));
    if (url === undefined) return failed(`unscripted: curl ${args.join(" ")}`, 127);
    const parsed = new URL(url);
    const reach = world.docker?.reach ?? ["api.github.com", "github.com"];
    if (!reach.includes(parsed.hostname)) {
      return failed(`curl: (7) Failed to connect to ${parsed.hostname} port 443 after 2 ms: Couldn't connect to server`, 7);
    }
    if (parsed.hostname === "api.github.com" && parsed.pathname === "/meta") {
      return json({ verifiable_password_authentication: false, ssh_keys: world.docker?.metaKeys ?? FAKE_META_KEYS });
    }
    if (parsed.hostname === "api.github.com" && parsed.pathname === "/rate_limit") {
      return json({ resources: { core: { limit: 60, remaining: 59 } }, rate: { limit: 60, remaining: 59 } });
    }
    return ok("<html>ok</html>\n");
  };

  /** Whether git in `home` reaches `url` over ssh; the failure when it does not. */
  const reaches = (home: Home, url: string): { repo: string } | RunResult => {
    const m = /^(?:ssh:\/\/)?git@([^:/]+)[:/]([^/]+)\/(.+?)(?:\.git)?\/?$/.exec(url);
    if (!m) return failed("fatal: could not read Username for 'https://github.com': No such device or address", 128);
    const [, hostAlias, owner, name] = m;
    const config = home.files.get(`${NODE_HOME}/.ssh/config`)?.text ?? "";
    const { hostname, identityFiles } = sshOptions(config, hostAlias!);
    if ((hostname ?? hostAlias) !== "github.com") {
      return failed(`ssh: Could not resolve hostname ${hostAlias}: Name or service not known\r\nfatal: Could not read from remote repository.`, 128);
    }
    const knownHosts = home.files.get(`${NODE_HOME}/.ssh/known_hosts`)?.text ?? "";
    if (!knownHosts.split("\n").some((l) => l.split(/\s+/)[0]?.split(",").includes("github.com"))) {
      return failed("Host key verification failed.\r\nfatal: Could not read from remote repository.", 128);
    }
    const key = `${NODE_HOME}/.ssh/deploy-${name}`;
    const repo = `${owner}/${name}`;
    if (!identityFiles.includes(key) || !home.files.has(key) || !host.githubKeys.has(repo)) {
      return failed("git@github.com: Permission denied (publickey).\r\nfatal: Could not read from remote repository.", 128);
    }
    return { repo };
  };

  const git = (home: Home, rawArgs: readonly string[], cwd: string, abs: (p: string) => string): RunResult => {
    const { dir: dirArg, rest } = gitArgs(rawArgs);
    const dir = dirArg === undefined ? cwd : abs(dirArg);
    const [sub, ...args] = rest;
    const originOf = (d: string) => home.clones.get(d);
    if (sub === "ls-remote") {
      const target = args.find((a) => !a.startsWith("-"));
      const url = target === "origin" || target === undefined ? originOf(dir) : target;
      if (url === undefined) return failed("fatal: not a git repository (or any of the parent directories): .git", 128);
      const reached = reaches(home, url);
      return "repo" in reached ? ok(`${"0123456789abcdef".repeat(2)}01234567\tHEAD\n${"0123456789abcdef".repeat(2)}01234567\trefs/heads/main\n`) : reached;
    }
    if (sub === "clone") {
      const positional = args.filter((a) => !a.startsWith("-"));
      const url = positional[0];
      if (url === undefined) return failed("fatal: You must specify a repository to clone.", 129);
      const name = (/([^/:]+?)(?:\.git)?\/?$/.exec(url)?.[1]) ?? "repo";
      const target = abs(positional[1] ?? name);
      if (isDir(home, target) && entriesUnder(home, target).length > 0) {
        return failed(`fatal: destination path '${target}' already exists and is not an empty directory.`, 128);
      }
      const reached = reaches(home, url);
      if (!("repo" in reached)) return reached;
      addClone(home, target, url);
      return ok(`Cloning into '${target}'...\n`);
    }
    if (sub === "remote" && args[0] === "get-url") {
      const url = originOf(dir);
      return url === undefined
        ? failed("fatal: not a git repository (or any of the parent directories): .git", 128)
        : ok(`${url}\n`);
    }
    if (sub === "fetch") {
      const url = originOf(dir);
      if (url === undefined) return failed("fatal: not a git repository (or any of the parent directories): .git", 128);
      const reached = reaches(home, url);
      return "repo" in reached ? ok() : reached;
    }
    if (sub === "config") {
      const words = args.filter((a) => a !== "--global" && a !== "--get");
      if (args.includes("--list") || args.includes("-l")) {
        return ok(Object.entries(home.git).map(([k, v]) => `${k}=${v}\n`).join(""));
      }
      const [key, value] = words;
      if (key === undefined) return failed("error: key does not contain a section", 2);
      if (value === undefined || args.includes("--get")) {
        const found = home.git[key];
        return found === undefined ? { status: 1, stdout: "", stderr: "" } : ok(`${found}\n`);
      }
      home.git[key] = value;
      return ok();
    }
    return failed(`unscripted: git ${rawArgs.join(" ")}`, 127);
  };

  const ghIn = (home: Home, args: readonly string[], cwd: string, input: string | undefined, user: string): RunResult => {
    const [a0, a1] = args;
    if (a0 === "auth" && a1 === "token") {
      // node's login lives in node's home; root's gh config (under /root) holds none.
      if (user !== "node" || home.token === undefined) return failed("no oauth token found for github.com");
      return ok(`${home.token}\n`);
    }
    if (a0 === "auth" && a1 === "status") {
      if (args.includes("--json")) {
        return json({
          hosts: {
            "github.com": home.login === undefined ? [] : [{
              state: "success",
              active: true,
              host: "github.com",
              login: FAKE_LOGIN,
              tokenSource: "keyring",
              token: home.login === "fine-grained" ? "github_pat_******" : "gho_******",
              gitProtocol: "ssh",
            }],
          },
        });
      }
      return home.login === undefined
        ? failed("You are not logged into any GitHub hosts. To log in, run: gh auth login")
        : ok(`github.com\n  ✓ Logged in to github.com account ${FAKE_LOGIN} (keyring)\n`);
    }
    if (a0 === "auth" && a1 === "login") {
      const token = (input ?? "").trim();
      if (token === "") return failed("error validating token: missing token");
      home.login = token.startsWith("github_pat_") ? "fine-grained" : "classic";
      home.token = token;
      return ok();
    }
    if (a0 === "repo" && a1 === "view") {
      if (home.login === undefined) return failed("To get started with GitHub CLI, please run:  gh auth login", 4);
      const named = args[2] !== undefined && !args[2].startsWith("-") ? args[2] : undefined;
      const url = home.clones.get(cwd);
      const repo = named ?? (url === undefined ? undefined : originRepo(url));
      if (repo === undefined) return failed("failed to run git: fatal: not a git repository (or any of the parent directories): .git");
      const [owner, name] = repo.split("/");
      return args.includes("--json")
        ? json({ name, nameWithOwner: repo, owner: { login: owner } })
        : ok(`name:\t${repo}\ndescription:\t\n`);
    }
    return failed(`unscripted: gh ${args.join(" ")}`, 127);
  };

  const claudeIn = (home: Home, args: readonly string[], cwd: string): RunResult => {
    const [a0, a1, a2, a3] = args;
    // Claude Code creates its config directory on first use.
    if (!home.dirs.has(`${NODE_HOME}/.claude`)) home.dirs.set(`${NODE_HOME}/.claude`, 0o700);
    if (args.includes("--bg")) {
      const name = flagValue(args, "--name");
      const prompt = args[args.length - 1] ?? "";
      if (name === undefined) return failed("claude: --bg needs --name in this fake", 127);
      if (!isDir(home, cwd)) return failed(`claude: ${cwd}: No such file or directory`);
      const skip = new Set([args.indexOf("--bg"), args.indexOf("--name"), args.indexOf("--name") + 1, args.length - 1]);
      const flags = args.filter((_, i) => !skip.has(i));
      const id = `fake-session-${++sessionCount}`;
      const launch: FakeLaunch = { dir: cwd, name, flags, prompt, env: {} };
      host.launches.push(launch);
      home.sessions.push({ id, name, state: "running", startedAt: 1_800_000_000_000 + sessionCount });
      if (world.docker?.unlisted) unlistedIds.add(id);
      const result = world.docker?.probe?.(launch);
      if (result !== undefined) home.files.set(`${cwd}/.${name}.txt`, { text: result, mode: 0o644 });
      return ok(`Started background session ${name} (${id})\n`);
    }
    if (a0 === "agents") {
      const listed = home.sessions.filter((s) => s.id === undefined || !unlistedIds.has(s.id));
      return args.includes("--json") ? json(listed) : ok(listed.map((s) => `${s.name ?? "(unnamed)"}\t${s.state}\n`).join(""));
    }
    if (a0 === "stop" && a1 !== undefined) {
      const session = home.sessions.find((s) => s.id === a1);
      if (session === undefined) return failed(`No session found with id ${a1}`);
      session.state = "stopped";
      return ok(`Stopped ${a1}\n`);
    }
    if (a0 !== "plugin") return failed(`unscripted: claude ${args.join(" ")}`, 127);
    if (a1 === "list") return json(home.plugins);
    if (a1 === "marketplace") {
      if (a2 === "list") {
        return json(home.marketplaces.map((name) => ({ name, source: "github", repo: "askrzypczak/claude-workflow" })));
      }
      if (a2 === "add" && a3 !== undefined) {
        const name = /claude-workflow/.test(a3) ? "askrzypczak-plugins" : (a3.split("/").pop() ?? a3);
        if (!home.marketplaces.includes(name)) home.marketplaces.push(name);
        return ok(`Successfully added marketplace: ${name}\n`);
      }
      if (a2 === "update") {
        if (a3 !== undefined && !home.marketplaces.includes(a3)) return failed(`Marketplace '${a3}' not found`);
        return ok(`Successfully updated marketplace: ${a3 ?? "all"}\n`);
      }
      return failed(`unscripted: claude ${args.join(" ")}`, 127);
    }
    const scope = flagValue(args, "--scope") ?? flagValue(args, "-s") ?? "user";
    if (a1 === "install" && a2 !== undefined) {
      const market = a2.split("@")[1];
      if (market === undefined || !home.marketplaces.includes(market)) {
        return failed(`Plugin "${a2}" not found in any configured marketplace`);
      }
      if (!home.plugins.some((p) => p.id === a2 && p.scope === scope)) {
        const plugin = a2.split("@")[0]!;
        home.plugins.push({ id: a2, scope, installPath: `${NODE_HOME}/.claude/plugins/cache/${market}/${plugin}/1.0.0`, version: "1.0.0" });
      }
      return ok(`Successfully installed plugin: ${a2} (scope: ${scope})\n`);
    }
    if (a1 === "update" && a2 !== undefined) {
      if (!home.plugins.some((p) => p.id === a2 && p.scope === scope)) return failed(`Plugin "${a2}" is not installed at ${scope} scope`);
      return ok(`Plugin "${a2}" updated.\n`);
    }
    return failed(`unscripted: claude ${args.join(" ")}`, 127);
  };
  const unlistedIds = new Set<string>();

  /** The current home: the container's, else the claude-workflow-home volume's (or its seed). */
  const currentHome = (): Home => container?.home ?? volumes.get(HOME_VOLUME) ?? seededHome();

  const handle: FakeDockerHandle = {
    container: () =>
      container === undefined
        ? undefined
        : {
            state: container.running ? "running" : "stopped",
            image: container.image,
            labels: { ...container.labels },
            mounts: structuredClone(container.mounts),
            startedAt: container.startedAt,
            env: { ...container.env },
          },
    file: (path) => currentHome().files.get(path)?.text,
    mode: (path) => currentHome().files.get(path)?.mode,
    sessions: () => currentHome().sessions,
    login: () => currentHome().login,
    gitConfig: () => ({ ...currentHome().git }),
    plugins: () => structuredClone(currentHome().plugins),
    builds,
  };

  return { run, handle, publicKey: (name: string) => currentHome().files.get(`${NODE_HOME}/.ssh/deploy-${name}.pub`)?.text };
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
  const githubKeys = new Set(world.deployKeys ?? []);
  let clipboard: string | undefined;
  let lastOpen: string | undefined;
  const launches: FakeLaunch[] = [];
  const modes: Record<string, number> = {};
  for (const path of Object.keys(files)) modes[path] = world.modes?.[path] ?? 0o600;
  const hostGit: Record<string, string> = { ...(world.hostGit ?? FAKE_GIT_IDENTITY) };
  const polls: { timeoutMs: number }[] = [];
  const docker = createDocker(world, { files, githubKeys, launches });

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
    if (isMergeProbe(call)) {
      if (call.env.GH_TOKEN !== undefined && world.merges?.includes(call.env.GH_TOKEN)) {
        return failed("gh: Object does not exist (HTTP 422)");
      }
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

  /** `git [-C <dir>] remote get-url origin`, or undefined for other git calls. */
  const gitRemote = (call: FakeCall): RunResult | undefined => {
    const i = call.args.indexOf("remote");
    if (i < 0 || call.args[i + 1] !== "get-url") return undefined;
    return ok(`${world.origin ?? `git@github.com:${FAKE_REPO}.git`}\n`);
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
    if (call.cmd === "docker") return docker.run(call);
    if (call.cmd === "stat") {
      const path = call.args[call.args.length - 1] ?? "";
      if (files[path] === undefined) return failed(`stat: ${path}: stat: No such file or directory`);
      return ok(`${(modes[path] ?? 0o600).toString(8)}\n`);
    }
    if (call.cmd === "chmod") {
      const [mode, path] = call.args.filter((a) => !a.startsWith("-"));
      if (path === undefined || files[path] === undefined) return failed(`chmod: ${path}: No such file or directory`);
      modes[path] = Number.parseInt(mode ?? "", 8);
      return ok();
    }
    if (call.cmd === "mkdir") return ok();
    if (call.cmd === "git") {
      const remote = gitRemote(call);
      if (remote) return remote;
      const { rest } = gitArgs(call.args);
      if (rest[0] === "config") {
        const words = rest.slice(1).filter((a) => a !== "--global" && a !== "--get");
        const [key, value] = words;
        if (key === undefined) return failed("error: key does not contain a section", 2);
        if (value === undefined || rest.includes("--get")) {
          const found = hostGit[key];
          return found === undefined ? { status: 1, stdout: "", stderr: "" } : ok(`${found}\n`);
        }
        hostGit[key] = value;
        return ok();
      }
    }
    if (call.cmd === "open") {
      lastOpen = a0;
      return ok();
    }
    if (call.cmd === "pbcopy") {
      clipboard = call.input ?? "";
      return ok();
    }
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
    copyFile(from: string, to: string): void {
      fileOps.push({ op: "copyFile", path: from, to });
      if (files[from] === undefined) throw new Error(`ENOENT: no such file or directory, copyfile '${from}'`);
      if (files[to] !== undefined) throw new Error(`EEXIST: file already exists, copyfile '${from}' -> '${to}'`);
      files[to] = files[from]!;
    },
    writeFile(path: string, text: string): void {
      fileOps.push({ op: "writeFile", path, text });
      if (files[path] === undefined) modes[path] = 0o600;
      files[path] = text;
    },
    waitForEnter(prompt: string): void {
      prompts.push({ kind: "enter", text: prompt });
      if (world.pastes === false || lastOpen === undefined) return;
      const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/settings\/keys\/new$/.exec(lastOpen);
      if (!m) return;
      const [, owner, name] = m;
      const inContainer = docker.publicKey(name!);
      if (inContainer !== undefined && clipboard?.trim() === inContainer.trim()) githubKeys.add(`${owner}/${name}`);
    },
    poll(read, done, timeoutMs) {
      polls.push({ timeoutMs });
      let last: string | undefined;
      for (let i = 0; i < 3; i++) {
        const text = read();
        if (text === undefined) continue;
        if (done(text)) return text;
        last = text;
      }
      return last;
    },
  };

  return { io, calls, reports, prompts, fileOps, files, launches, modes, polls, docker: docker.handle };
}
