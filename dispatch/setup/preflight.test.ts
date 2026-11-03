// The list of what setup still needs, as runSetup prints it: at the end of a dry run, and before
// any change in a live run. The item texts come from the phases themselves, run on the same
// fake world, so a phase's wording is never retyped here.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_FILE, container } from "./container.ts";
import { credentials } from "./credentials.ts";
import { FAKE_HOME, FAKE_REPO, fakeIo, fileWrites, restrictUpdates, writeCalls } from "./fake-io.ts";
import type { FakeWorld } from "./fake-io.ts";
import type { Phase } from "./main.ts";
import { runSetup } from "./main.ts";

const APP = "example-owner/example-app";
const CONFIG = "/config/repos.json";
const ENV_PATH = `${FAKE_HOME}/${ENV_FILE}`;
const CLAUDE_TOKEN = "sk-ant-oat01-fake-token-for-tests";
/** A dispatch config that serves APP after this clone's repo. */
const APP_CONFIG = JSON.stringify([
  { repo: APP, dir: "/home/node/example-app", sessionPrefix: "app", owner: "example-owner" },
]);
const STEPS_LEAD = (n: number) => `${n} step(s) the run asks for when it reaches them:`;
const NOTHING = (lead: string) => `${lead}: nothing to do before setup can pass.`;
const COUNT = (lead: string, n: number) => `${lead}: ${n} to do before setup can pass:`;
const liveSession = [{ name: "tools-3", state: "running" as const, startedAt: 1 }];

const base = (io: ReturnType<typeof fakeIo>["io"]) => ({ io, clone: "/clone", home: FAKE_HOME, configPath: CONFIG });

/** Every line console.log printed. */
const printed = () => vi.mocked(console.log).mock.calls.flatMap((args) => args.join(" ").split("\n"));

/** The printed lines from the one opening with `lead` to the end of the output. */
function summary(lead: string): string[] {
  const lines = printed();
  const at = lines.findIndex((line) => line.startsWith(`${lead}:`));
  return at < 0 ? [] : lines.slice(at);
}

/** The deploy-key step as the list prints it. */
const deployKeyItem = (repo: string) =>
  `  - the deploy key: when the run asks, add it on https://github.com/${repo}/settings/keys/new with "Allow write access" ticked (the run creates the key in the container, copies it and opens that page)`;

/** The to-do lines `phase` reports in a dry run on a fresh fake of `world`. */
function phaseTodos(phase: Phase, world: FakeWorld, repos: readonly string[]): string[] {
  const { io, reports } = fakeIo(world);
  phase.run({ io, dryRun: true, clone: "/clone", home: FAKE_HOME, repos: repos.map((repo) => ({ repo })), fullRun: true });
  return reports.filter((r) => r.status === "todo").map((r) => r.text);
}

/** A repo's to-dos among `todos`, as listed: an item line without the `<repo>: ` prefix. */
const repoItems = (todos: readonly string[], repo: string) =>
  todos.filter((t) => t.startsWith(`${repo}: `)).map((t) => `  - ${t.slice(repo.length + 2)}`);

describe("the preflight list", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("a dry run with missing prerequisites on two served repos and on this machine ends with one summary that counts them and lists each under its repo, or under this machine, with the to-do text its phase printed", () => {
    const world: FakeWorld = {
      login: "fine-grained",
      rulesets: [],
      env: { GH_TOKEN: "set-in-this-shell" },
      files: { [CONFIG]: APP_CONFIG },
    };
    const served = [FAKE_REPO, APP];
    const fromCredentials = phaseTodos(credentials, world, served);
    const fromContainer = phaseTodos(container, world, served);
    const strayToken = fromCredentials.find((t) => t.startsWith("stray token: GH_TOKEN"));
    const noDocker = fromContainer.find((t) => t.startsWith("docker does not answer"));
    const toolsItems = repoItems(fromCredentials, FAKE_REPO);
    const appItems = repoItems(fromCredentials, APP);
    const { io, reports } = fakeIo(world);

    runSetup(["--dry-run"], base(io));

    const lines = printed();
    const list = summary("Dry run summary");
    expect(lines.indexOf("--- check (dry run) ---")).toBeLessThan(lines.length - list.length);
    expect(list).toEqual([
      COUNT("Dry run summary", toolsItems.length + appItems.length + 2),
      `${FAKE_REPO}:`,
      ...toolsItems,
      `${APP}:`,
      ...appItems,
      "this machine:",
      `  - ${strayToken}`,
      `  - ${noDocker}`,
      STEPS_LEAD(2),
      `${FAKE_REPO}:`,
      deployKeyItem(FAKE_REPO),
      `${APP}:`,
      deployKeyItem(APP),
    ]);
    const printedTodos = reports.filter((r) => r.status === "todo").map((r) => r.text);
    for (const text of [...fromCredentials, noDocker]) expect(printedTodos).toContain(text);
  });

  it("a live run whose preflight finds missing prerequisites prints them all and exits 1 with no write command, no file written (the --add-repo entry included) and no prompt", () => {
    const world: FakeWorld = {
      dispatch: "running",
      env: { GH_TOKEN: "set-in-this-shell" },
      files: { [`${FAKE_HOME}/.git-credentials`]: "https://example-owner@github.com\n" },
    };
    const todos = phaseTodos(credentials, world, [FAKE_REPO, APP]);
    const strayToken = todos.find((t) => t.startsWith("stray token: GH_TOKEN"));
    const gitCredentials = todos.find((t) => t.startsWith("stray token: ~/.git-credentials:1"));
    const { io, calls, fileOps, files, prompts } = fakeIo(world);

    expect(runSetup(["credentials", "--add-repo", APP], base(io))).toBe(1);

    expect(printed()).toEqual([
      COUNT("Preflight", 2),
      "this machine:",
      `  - ${strayToken}`,
      `  - ${gitCredentials}`,
      "Stopped before any change: do the to-dos above, then rerun dispatch/setup-agents.sh.",
    ]);
    expect(writeCalls(calls)).toEqual([]);
    expect(fileWrites(fileOps)).toEqual([]);
    expect(files[CONFIG]).toBeUndefined();
    expect(prompts).toEqual([]);
    expect(console.error).not.toHaveBeenCalled();
  });

  it("a live session is not in the preflight's list: the live credentials phase still pauses dispatch first and then stops on it", () => {
    const { io, calls, reports } = fakeIo({ dispatch: "running", sessions: liveSession });

    expect(runSetup(["credentials"], base(io))).toBe(1);

    const lines = printed();
    const lead = lines.indexOf(NOTHING("Preflight"));
    expect(lead).toBeGreaterThanOrEqual(0);
    expect(lines.indexOf("--- credentials ---")).toBeGreaterThan(lead);
    expect(lines.some((line) => line.startsWith("Stopped in credentials:"))).toBe(true);
    expect(calls.some((c) => c.cmd.endsWith("install-launchd.sh") && c.args[0] === "pause")).toBe(true);
    const paused = reports.findIndex((r) => r.status === "done" && /paused dispatch/.test(r.text));
    const session = reports.findIndex((r) => r.status === "todo" && /tools-3 is running: stop it with claude stop/.test(r.text));
    expect(paused).toBeGreaterThanOrEqual(0);
    expect(session).toBeGreaterThan(paused);
  });

  it("a full dry run under the fine-grained login lists a repo's missing protect-main once, though the credentials and container phases both print it", () => {
    const world: FakeWorld = { login: "fine-grained", rulesets: [restrictUpdates()], docker: {} };
    const [protectMain] = phaseTodos(credentials, world, [FAKE_REPO]);
    const { io, reports } = fakeIo(world);

    runSetup(["--dry-run"], base(io));

    expect(protectMain).toMatch(/protect-main/);
    expect(reports.filter((r) => r.status === "todo" && r.text === protectMain)).toHaveLength(2);
    expect(summary("Dry run summary")).toEqual([
      COUNT("Dry run summary", 1),
      `${FAKE_REPO}:`,
      ...repoItems([protectMain!], FAKE_REPO),
      STEPS_LEAD(1),
      `${FAKE_REPO}:`,
      deployKeyItem(FAKE_REPO),
    ]);
  });

  it("a full dry run under an admin login lists nothing for a repo with no protect-main, no restrict-updates, auto-merge on and a new --add-repo entry, though the container phase prints a protect-main to-do", () => {
    const { io, reports } = fakeIo({ rulesets: [], allowAutoMerge: true, docker: {} });

    runSetup(["--dry-run", "--add-repo", APP], base(io));

    const todo = (text: RegExp) => reports.some((r) => r.status === "todo" && text.test(r.text));
    const would = (text: RegExp) => reports.some((r) => r.status === "would" && text.test(r.text));
    expect(todo(new RegExp(`^${FAKE_REPO}: protect-main:`))).toBe(true);
    expect(would(new RegExp(`^add ${APP} to ${CONFIG}`))).toBe(true);
    for (const repo of [FAKE_REPO, APP]) {
      expect(would(new RegExp(`^${repo}: create the protect-main ruleset`)), repo).toBe(true);
      expect(would(new RegExp(`^${repo}: create the restrict-updates ruleset`)), repo).toBe(true);
      expect(would(new RegExp(`^${repo}: turn auto-merge off`)), repo).toBe(true);
      expect(would(new RegExp(`^${repo}: run .*setup-labels\\.sh`)), repo).toBe(true);
    }
    expect(summary("Dry run summary")).toEqual([
      NOTHING("Dry run summary"),
      STEPS_LEAD(2),
      `${FAKE_REPO}:`,
      deployKeyItem(FAKE_REPO),
      `${APP}:`,
      deployKeyItem(APP),
    ]);
  });

  it("a full dry run leaves the check phase's to-dos out of the list", () => {
    const { io, reports } = fakeIo({ docker: {} });

    runSetup(["--dry-run"], base(io));

    expect(reports.some((r) => r.status === "todo" && r.text.includes("then rerun dispatch/setup-agents.sh check"))).toBe(true);
    expect(summary("Dry run summary")).toEqual([
      NOTHING("Dry run summary"),
      STEPS_LEAD(1),
      `${FAKE_REPO}:`,
      deployKeyItem(FAKE_REPO),
    ]);
  });

  it("a full dry run on a machine with no agent container lists each served repo's deploy key, with its settings/keys/new page, as a step the run asks for and not as a to-do", () => {
    const { io } = fakeIo({ files: { [CONFIG]: APP_CONFIG }, docker: {} });

    runSetup(["--dry-run"], base(io));

    expect(summary("Dry run summary")).toEqual([
      NOTHING("Dry run summary"),
      STEPS_LEAD(2),
      `${FAKE_REPO}:`,
      deployKeyItem(FAKE_REPO),
      `${APP}:`,
      deployKeyItem(APP),
    ]);
  });

  it("a container dry run after a live run that added the deploy key lists no deploy-key step", () => {
    const { io, prompts } = fakeIo({ files: { [ENV_PATH]: `CLAUDE_CODE_OAUTH_TOKEN=${CLAUDE_TOKEN}\n` }, docker: {} });

    expect(runSetup(["container"], base(io))).toBe(0);
    expect(prompts.some((p) => p.kind === "enter" && p.text.includes(FAKE_REPO))).toBe(true);
    vi.mocked(console.log).mockClear();

    runSetup(["container", "--dry-run"], base(io));

    expect(summary("Dry run summary")).toEqual([NOTHING("Dry run summary")]);
  });

  it("a live check run whose container checks fail lists each failed check before its to-do and stops with exit 1", () => {
    const world: FakeWorld = {
      deployKeys: [FAKE_REPO],
      docker: {
        container: { state: "running" },
        clones: { "/home/node/example-tools": `git@github.com-example-tools:${FAKE_REPO}.git` },
        files: {
          "/home/node/.ssh/deploy-example-tools": "-----BEGIN OPENSSH PRIVATE KEY-----\nFAKE-KEY-BODY-FOR-TESTS\n-----END OPENSSH PRIVATE KEY-----\n",
        },
        ghLogin: "fine-grained",
        reach: ["api.github.com", "github.com", "example.com"],
      },
    };
    const dry = fakeIo(world);
    runSetup(["check", "--dry-run"], base(dry.io));
    const failed = dry.reports.filter((r) => r.status === "fail").map((r) => r.text);
    const checksFailed = dry.reports.filter((r) => r.status === "todo").map((r) => r.text);
    vi.mocked(console.log).mockClear();
    const { io, calls } = fakeIo(world);

    expect(runSetup(["check"], base(io))).toBe(1);

    expect(failed).toEqual([expect.stringMatching(/^firewall: https:\/\/example\.com was reached/)]);
    expect(checksFailed).toEqual([expect.stringMatching(/^the container checks failed \(above\)/)]);
    const lines = printed();
    expect(lines.slice(0, 5)).toEqual([
      COUNT("Preflight", 2),
      "this machine:",
      `  - ${failed[0]}`,
      `  - ${checksFailed[0]}`,
      "Stopped before any change: do the to-dos above, then rerun dispatch/setup-agents.sh.",
    ]);
    expect(writeCalls(calls)).toEqual([]);
    expect(calls.some((c) => c.cmd.endsWith("install-launchd.sh") && c.args[0] === "resume")).toBe(false);
  });

  it("a live session without a name, or in the agent container, is not in the preflight's list either", () => {
    const { io, calls, reports } = fakeIo({
      dispatch: "running",
      sessions: [{ state: "running", startedAt: 1 }],
      docker: { container: { state: "running" }, sessions: [{ id: "c0ffee01", name: "tools-12", state: "running", startedAt: 1 }] },
    });

    expect(runSetup(["credentials"], base(io))).toBe(1);

    const todos = reports.filter((r) => r.status === "todo").map((r) => r.text);
    expect(todos.some((t) => /^an unnamed session is running: stop it from claude agents$/.test(t))).toBe(true);
    expect(todos.some((t) => /in the agent container .* stop it with docker exec .*claude stop c0ffee01$/.test(t))).toBe(true);
    const lines = printed();
    expect(lines[0]).toBe(NOTHING("Preflight"));
    expect(calls.some((c) => c.cmd.endsWith("install-launchd.sh") && c.args[0] === "pause")).toBe(true);
    expect(lines.at(-2)).toMatch(/^Stopped in credentials:/);
    expect(lines.at(-1)).toMatch(/^Dispatch stays paused/);
  });
});
