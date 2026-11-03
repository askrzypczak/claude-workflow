// A first setup end to end on the fake: every phase, live, from an admin login and a repo
// with nothing configured to a running agent container and dispatch resumed. The only
// steps left to the maintainer are the two token pastes and the deploy key.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeItems } from "./check.ts";
import { ENV_FILE } from "./container.ts";
import { FAKE_HOME, FAKE_REPO, fakeIo } from "./fake-io.ts";
import type { FakeCall } from "./fake-io.ts";
import { runSetup } from "./main.ts";

const KEYS_PAGE = `https://github.com/${FAKE_REPO}/settings/keys/new`;
const TOKEN_FORM = "https://github.com/settings/personal-access-tokens/new?";

/** No PR, issue or workflow run on the repo. */
const nothingOpen = (c: FakeCall) =>
  c.cmd === "gh" && ["pr", "issue", "run"].includes(c.args[0] ?? "") && c.args[1] === "list"
    ? { status: 0, stdout: "[]\n", stderr: "" }
    : undefined;

/** Every line console.log printed. */
const printed = () => vi.mocked(console.log).mock.calls.flatMap((args) => args.join(" ").split("\n"));

/**
 * The admin login (the fake's default), a Claude token on the machine, the LaunchAgent
 * installed, no ruleset, auto-merge off, no deploy key on GitHub, no dispatch config, and
 * docker answering with no image, volume or container.
 */
function firstSetup() {
  const fake = fakeIo({
    rulesets: [],
    files: { [`${FAKE_HOME}/${ENV_FILE}`]: "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fake-token-for-tests\n" },
    docker: { probe: () => [...probeItems().map((i) => `SETUP-PROBE PASS ${i}: ok`), "SETUP-PROBE END", ""].join("\n") },
    respond: nothingOpen,
  });
  const code = runSetup([], { io: fake.io, clone: "/clone", home: FAKE_HOME, configPath: "/nonexistent/repos.json" });
  return { ...fake, code };
}

describe("a full live run on a repo with one commit, no CI, no open PR and no open issue, under an admin login, on a machine with no agent container", () => {
  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("passes every phase and resumes dispatch", () => {
    const { code, calls } = firstSetup();

    expect(code).toBe(0);
    expect(console.error).not.toHaveBeenCalled();
    const headers = printed()
      .map((line) => /^--- (\S+)/.exec(line)?.[1])
      .filter((name) => name !== undefined);
    expect(headers).toEqual(["credentials", "host", "container", "check"]);
    expect(printed().some((line) => line.startsWith("Stopped"))).toBe(false);
    expect(calls.some((c) => c.cmd.endsWith("install-launchd.sh") && c.args[0] === "resume")).toBe(true);
  });

  it("asks only for the host token paste, the deploy-key Enter and the container token paste, and opens only the two token forms and the repo's settings/keys/new page", () => {
    const { code, prompts, calls } = firstSetup();

    expect(code).toBe(0);
    expect(prompts.map((p) => p.kind)).toEqual(["secret", "enter", "secret"]);
    expect(prompts[1]!.text).toContain(FAKE_REPO);
    expect(prompts[2]!.text).toMatch(/container/);
    const opened = calls.filter((c) => c.cmd === "open").map((c) => c.args[0] ?? "");
    expect(opened).toHaveLength(3);
    expect(opened[0]!.startsWith(TOKEN_FORM)).toBe(true);
    expect(opened[1]).toBe(KEYS_PAGE);
    expect(opened[2]!.startsWith(TOKEN_FORM)).toBe(true);
  });

  it("has a preflight that lists nothing to do and names the repo's deploy key as the one step the run asks for", () => {
    firstSetup();

    const lines = printed();
    const lead = lines.indexOf("Preflight: nothing to do before setup can pass.");
    expect(lead).toBeGreaterThanOrEqual(0);
    const end = lines.findIndex((line, i) => i > lead && line.startsWith("--- "));
    expect(lines.slice(lead, end)).toEqual([
      "Preflight: nothing to do before setup can pass.",
      "1 step(s) the run asks for when it reaches them:",
      `${FAKE_REPO}:`,
      `  - the deploy key: when the run asks, add it on ${KEYS_PAGE} with "Allow write access" ticked (the run creates the key in the container, copies it and opens that page)`,
    ]);
  });
});
