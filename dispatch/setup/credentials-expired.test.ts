// The credentials phase when the stored gh login's token has expired: gh auth status reports the
// account in error and every read as that login fails with HTTP 401. The run rotates the token
// anyway, skipping what needs the stored login.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FAKE_LOGIN, FAKE_REPO, FAKE_TOKEN, fakeIo, parseGhApi, protectMain, writeCalls } from "./fake-io.ts";
import type { FakeCall, FakeWorld } from "./fake-io.ts";
import type { RunResult, SetupIo } from "./io.ts";
import { runSetup } from "./main.ts";

const STORED = "github_pat_STORED_FOR_TESTS_ONLY";

const base = (io: SetupIo) => ({ io, clone: "/clone", home: "/home/example", configPath: "/nonexistent/repos.json" });

const isGh = (call: FakeCall, ...words: string[]) =>
  call.cmd === "gh" && words.every((w, i) => call.args[i] === w);

/** gh auth status --json hosts for an expired login: exit 0, the account in error, the token only with --show-token. */
const expiredStatus = (call: FakeCall): RunResult => ({
  status: 0,
  stdout: `${JSON.stringify({
    hosts: {
      "github.com": [
        {
          state: "error",
          error: "The token in keyring is invalid.",
          active: true,
          host: "github.com",
          login: FAKE_LOGIN,
          tokenSource: "keyring",
          gitProtocol: "ssh",
          ...(call.args.includes("--show-token") ? { token: STORED } : {}),
        },
      ],
    },
  })}\n`,
  stderr: "",
});

/** Any read as the expired login. */
const unauthorized = (call: FakeCall): RunResult =>
  parseGhApi(call)
    ? {
        status: 1,
        stdout: '{"message":"Bad credentials","documentation_url":"https://docs.github.com/rest","status":"401"}',
        stderr: "gh: Bad credentials (HTTP 401)",
      }
    : {
        status: 1,
        stdout: "",
        stderr: "HTTP 401: Bad credentials (https://api.github.com/graphql)\nTry authenticating with:  gh auth login",
      };

/**
 * The stored login is expired until `gh auth login` stores a new token; from then on the fake's
 * own world answers, with the new fine-grained login. `first` answers before anything else.
 */
function expiredWorld(first?: (call: FakeCall) => RunResult | undefined): FakeWorld {
  let swapped = false;
  return {
    login: "fine-grained",
    respond(call) {
      const answer = first?.(call);
      if (answer) return answer;
      if (call.cmd !== "gh" || swapped) return undefined;
      if (isGh(call, "auth", "login")) {
        swapped = true;
        return undefined;
      }
      if (isGh(call, "auth", "logout")) return undefined;
      if (isGh(call, "auth", "status")) return expiredStatus(call);
      if (call.env.GH_TOKEN !== undefined) return undefined;
      return unauthorized(call);
    },
  };
}

/** Ruleset and repo-setting writes: POST, PUT or PATCH on the repo or its rulesets. */
const settingWrites = (calls: readonly FakeCall[]) =>
  calls.filter((c) => {
    const a = parseGhApi(c);
    return (
      a !== undefined &&
      ["POST", "PUT", "PATCH"].includes(a.method) &&
      (a.endpoint === `repos/${FAKE_REPO}` || a.endpoint.startsWith(`repos/${FAKE_REPO}/rulesets`))
    );
  });

const skippedReport = (reports: readonly { text: string }[]) =>
  reports.some((r) => /skipped/i.test(r.text) && r.text.includes(FAKE_REPO));

describe("credentials phase with the stored token expired", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("with the stored token expired, setup-agents credentials opens the token form, runs the pre-swap test as the new token and swaps the login", () => {
    const { io, calls, prompts } = fakeIo(expiredWorld());

    expect(runSetup(["credentials"], base(io))).toBe(0);

    expect(prompts.filter((p) => p.kind === "confirm")).toEqual([]);
    const opened = calls.findIndex((c) => c.cmd === "open");
    expect(opened).toBeGreaterThanOrEqual(0);
    const login = calls.findIndex((c) => isGh(c, "auth", "login"));
    expect(login).toBeGreaterThan(opened);
    expect(calls[login]!.input?.trim()).toBe(FAKE_TOKEN);
    const logout = calls.findIndex((c) => isGh(c, "auth", "logout"));
    expect(logout).toBeGreaterThanOrEqual(0);
    expect(calls[logout]!.args).toContain(FAKE_LOGIN);
    expect(logout).toBeLessThan(login);

    const beforeSwap = calls.slice(0, login);
    for (const words of [["pr", "list"], ["issue", "list"], ["run", "list"], ["label", "list"]]) {
      const reads = beforeSwap.filter((c) => isGh(c, ...words));
      expect(reads.length, `gh ${words.join(" ")} before the swap`).toBeGreaterThan(0);
      for (const read of reads) expect(read.env.GH_TOKEN, `gh ${read.args.join(" ")}`).toBe(FAKE_TOKEN);
    }
    const firstPrList = calls.findIndex((c) => isGh(c, "pr", "list"));
    expect(firstPrList).toBeGreaterThan(opened);
    for (const words of [["issue", "comment"], ["run", "view"], ["pr", "diff"]]) {
      const preSwap = beforeSwap.filter((c) => isGh(c, ...words));
      expect(preSwap.length, `gh ${words.join(" ")} in the pre-swap test`).toBeGreaterThan(0);
      for (const c of preSwap) expect(c.env.GH_TOKEN).toBe(FAKE_TOKEN);
    }
  });

  it("with the stored token expired, a served repo the new token cannot read is a to-do naming the repo and the login is not swapped", () => {
    const { io, calls, reports } = fakeIo(
      expiredWorld((c) =>
        isGh(c, "pr", "list") && c.env.GH_TOKEN !== undefined
          ? {
              status: 1,
              stdout: "",
              stderr: `GraphQL: Could not resolve to a Repository with the name '${FAKE_REPO}'. (repository)`,
            }
          : undefined,
      ),
    );

    expect(runSetup(["credentials"], base(io))).toBe(1);

    expect(console.error).not.toHaveBeenCalled();
    expect(reports.some((r) => r.status === "todo" && r.text.includes(FAKE_REPO))).toBe(true);
    expect(calls.filter((c) => isGh(c, "auth", "logout") || isGh(c, "auth", "login"))).toEqual([]);
  });

  it("with the stored token expired, the run makes no ruleset or auto-merge write and reports the ruleset step as skipped", () => {
    const { io, calls, reports } = fakeIo({ ...expiredWorld(), rulesets: [protectMain()], allowAutoMerge: true });

    runSetup(["credentials"], base(io));

    expect(settingWrites(calls)).toEqual([]);
    expect(skippedReport(reports)).toBe(true);
  });

  it("under --dry-run with the stored token expired, every step is listed and nothing runs as the stored login", () => {
    const { io, calls, reports } = fakeIo(expiredWorld());

    expect(runSetup(["credentials", "--dry-run"], base(io))).toBe(0);

    expect(console.error).not.toHaveBeenCalled();
    const would = reports.filter((r) => r.status === "would").map((r) => r.text);
    for (const keyword of [/token/i, /pre-swap/i, /login/i, /after-swap/i]) {
      expect(would.some((t) => keyword.test(t)), `a would line matching ${keyword}`).toBe(true);
    }
    expect(skippedReport(reports)).toBe(true);
    expect(writeCalls(calls)).toEqual([]);
    expect(calls.filter((c) => c.cmd === "gh" && !isGh(c, "auth", "status"))).toEqual([]);
  });

  it("an expired login whose gh error is not a string still reaches the skip note", () => {
    const objectError = (call: FakeCall): RunResult | undefined => {
      if (!isGh(call, "auth", "status")) return undefined;
      const status = JSON.parse(expiredStatus(call).stdout) as {
        hosts: Record<string, Record<string, unknown>[]>;
      };
      for (const account of status.hosts["github.com"]!) account.error = { message: "Bad credentials" };
      return { status: 0, stdout: `${JSON.stringify(status)}\n`, stderr: "" };
    };
    const { io, reports } = fakeIo(expiredWorld(objectError));

    expect(runSetup(["credentials", "--dry-run"], base(io))).toBe(0);

    expect(console.error).not.toHaveBeenCalled();
    expect(skippedReport(reports)).toBe(true);
    for (const r of reports) expect(r.text).not.toContain("[object Object]");
  });
});
