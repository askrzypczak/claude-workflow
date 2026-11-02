// The credentials phase's token paste, login swap and after-swap checks.
import { describe, expect, it } from "vitest";
import { credentials } from "./credentials.ts";
import { FAKE_LOGIN, FAKE_REPO, fakeIo, parseGhApi } from "./fake-io.ts";
import type { FakeCall, FakeWorld } from "./fake-io.ts";

const OTHER_REPO = "example-owner/example-other";

function run(world: FakeWorld, repos: readonly string[] = [FAKE_REPO]) {
  const fake = fakeIo(world);
  const result = credentials.run({
    io: fake.io,
    dryRun: false,
    clone: "/clone",
    home: "/home/example",
    repos: repos.map((repo) => ({ repo })),
  });
  return { ...fake, result };
}

const isGh = (call: FakeCall, ...words: string[]) =>
  call.cmd === "gh" && words.every((w, i) => call.args[i] === w);

/** `gh auth status --json` as gh prints it for these stored github.com logins. */
const authStatus = (logins: { login: string; token: string }[]) => ({
  status: 0,
  stdout: `${JSON.stringify({
    hosts: {
      "github.com": logins.map((l, i) => ({
        state: "success",
        active: i === 0,
        host: "github.com",
        login: l.login,
        tokenSource: "keyring",
        token: l.token,
      })),
    },
  })}\n`,
  stderr: "",
});

/** A world whose `gh auth status` answers with `logins` once `gh auth login` has run. */
function afterLogin(logins: { login: string; token: string }[]): FakeWorld {
  let loggedIn = false;
  return {
    respond(call) {
      if (isGh(call, "auth", "login")) loggedIn = true;
      if (loggedIn && isGh(call, "auth", "status")) return authStatus(logins);
      return undefined;
    },
  };
}

describe("credentials phase token paste and login swap", () => {
  it("an empty paste or plain text stops the phase before any gh auth logout", () => {
    for (const secret of ["", "y"]) {
      const { result, calls } = run({ secret });

      expect(result).toBe("stop");
      expect(calls.some((c) => isGh(c, "auth", "logout"))).toBe(false);
      expect(calls.some((c) => isGh(c, "auth", "login"))).toBe(false);
    }
  });

  it("a paste gh auth login refuses stops the phase with a to-do saying gh has no github.com login and how to log in", () => {
    const { result, reports } = run({
      respond: (call) =>
        isGh(call, "auth", "login")
          ? { status: 1, stdout: "", stderr: "error validating token: HTTP 401: Bad credentials" }
          : undefined,
    });

    expect(result).toBe("stop");
    expect(
      reports.some(
        (r) =>
          r.status === "todo" &&
          r.text.includes("no github.com login") &&
          r.text.includes("gh auth login --hostname github.com --with-token"),
      ),
    ).toBe(true);
  });
});

describe("credentials phase after-swap checks", () => {
  it("after the swap the phase reads gh auth status and each served repo's restrict-updates again", () => {
    const { calls } = run({}, [FAKE_REPO, OTHER_REPO]);

    const login = calls.findIndex((c) => isGh(c, "auth", "login"));
    expect(login).toBeGreaterThanOrEqual(0);
    const after = calls.slice(login + 1);
    expect(after.some((c) => isGh(c, "auth", "status"))).toBe(true);
    for (const repo of [FAKE_REPO, OTHER_REPO]) {
      expect(
        after.some((c) => {
          const a = parseGhApi(c);
          return a?.method === "GET" && a.endpoint === `repos/${repo}/rulesets`;
        }),
      ).toBe(true);
    }
  });

  it("a second stored login after the swap is a to-do and stops the phase", () => {
    const { result, reports } = run(
      afterLogin([
        { login: FAKE_LOGIN, token: "github_pat_******" },
        { login: "example-second", token: "gho_******" },
      ]),
    );

    expect(result).toBe("stop");
    expect(reports.some((r) => r.status === "todo" && r.text.includes("example-second"))).toBe(true);
  });

  it("one stored login after the swap passes the one-login check whatever its token kind", () => {
    const { result, reports } = run(afterLogin([{ login: FAKE_LOGIN, token: "gho_******" }]));

    expect(result).toBe("ok");
    expect(reports.filter((r) => r.status === "todo")).toEqual([]);
  });
});
