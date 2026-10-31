// The container phase's plugin step on the fake SetupIo (fake-io.ts) and its docker world: the
// install, the update on every run, and the marketplace's auto-update.
import { describe, expect, it } from "vitest";
import { container, ENV_FILE } from "./container.ts";
import { FAKE_HOME, FAKE_REPO, fakeIo, parseDockerExec } from "./fake-io.ts";
import type { FakeCall, FakeDocker, FakePlugin } from "./fake-io.ts";
import type { SetupContext } from "./main.ts";

const CLONE = "/clone";
const ENV_PATH = `${FAKE_HOME}/${ENV_FILE}`;
const INSTALL_LAUNCHD = `${CLONE}/dispatch/install-launchd.sh`;
const PLUGIN = "ticket-workflow@askrzypczak-plugins";
const MARKETPLACE = "askrzypczak-plugins";
const INSTALLED: FakePlugin = {
  id: PLUGIN,
  scope: "user",
  installPath: "/home/node/.claude/plugins/cache/askrzypczak-plugins/ticket-workflow/1.0.0",
  version: "1.0.0",
};

/** A Claude token in the env file and a gh login in the container, so no step prompts. */
function setup(docker: FakeDocker = {}, dispatch: "paused" | "running" = "paused") {
  const fake = fakeIo({
    dispatch,
    deployKeys: [FAKE_REPO],
    files: { [ENV_PATH]: "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-fake-token-for-tests\n" },
    docker: { ghLogin: "fine-grained", ...docker },
  });
  const ctx: SetupContext = { io: fake.io, dryRun: false, clone: CLONE, home: FAKE_HOME, repos: [{ repo: FAKE_REPO, dir: CLONE }] };
  return { ...fake, run: () => container.run(ctx) };
}

/** The claude command a docker exec call runs (after `claude`), or undefined. */
const claudeArgs = (c: FakeCall) => {
  const command = parseDockerExec(c)?.command;
  return command?.[0] === "claude" ? command.slice(1) : undefined;
};
const isPluginCall = (c: FakeCall, ...words: string[]) => {
  const args = claudeArgs(c);
  return args !== undefined && words.every((w, i) => args[i] === w);
};
const scopeOf = (c: FakeCall) => {
  const args = claudeArgs(c) ?? [];
  const i = args.indexOf("--scope");
  return i >= 0 ? args[i + 1] : args.find((a) => a.startsWith("--scope="))?.slice("--scope=".length);
};

describe("container phase plugin", () => {
  it("a missing plugin is installed at user scope after its marketplace is added", () => {
    const { run, calls, docker } = setup();

    expect(run()).toBe("ok");
    const add = calls.findIndex((c) => isPluginCall(c, "plugin", "marketplace", "add", "askrzypczak/claude-workflow"));
    const install = calls.findIndex((c) => isPluginCall(c, "plugin", "install", PLUGIN));
    expect(add).toBeGreaterThanOrEqual(0);
    expect(install).toBeGreaterThan(add);
    expect(scopeOf(calls[install]!)).toBe("user");
    expect(docker.plugins().some((p) => p.id === PLUGIN && p.scope === "user")).toBe(true);
  });

  it("an installed plugin and its marketplace are updated on every run", () => {
    const { run, calls } = setup({ plugins: [INSTALLED], marketplaces: [MARKETPLACE] });

    for (const pass of [1, 2]) {
      const from = calls.length;
      expect(run(), `run ${pass}`).toBe("ok");
      const these = calls.slice(from);
      expect(these.some((c) => isPluginCall(c, "plugin", "marketplace", "update", MARKETPLACE)), `run ${pass}`).toBe(true);
      const updates = these.filter((c) => isPluginCall(c, "plugin", "update", PLUGIN));
      expect(updates, `run ${pass}`).toHaveLength(1);
      expect(scopeOf(updates[0]!), `run ${pass}`).toBe("user");
      expect(these.some((c) => isPluginCall(c, "plugin", "install")), `run ${pass}`).toBe(false);
      expect(these.some((c) => isPluginCall(c, "plugin", "marketplace", "add")), `run ${pass}`).toBe(false);
    }
  });

  it("the marketplace entry in the container's user settings gets autoUpdate true", () => {
    const { run, docker } = setup();

    expect(run()).toBe("ok");
    const settings = JSON.parse(docker.file("/home/node/.claude/settings.json") ?? "{}") as {
      extraKnownMarketplaces?: Record<string, { autoUpdate?: boolean; source?: { repo?: string } }>;
    };
    const entry = settings.extraKnownMarketplaces?.[MARKETPLACE];
    expect(entry?.autoUpdate).toBe(true);
    expect(entry?.source?.repo).toBe("askrzypczak/claude-workflow");
  });

  it("a plugin update alone runs with a session live, without pausing or stopping", () => {
    const { run, calls, reports, docker, io } = setup({}, "running");
    expect(run()).toBe("ok");
    // Dispatch running again and a session live in the container.
    io.run(INSTALL_LAUNCHD, ["resume"]);
    docker.sessions().push({ id: "fake-live-1", name: "tools-12", state: "running", startedAt: 1 });

    const from = calls.length;
    const reportsFrom = reports.length;
    expect(run()).toBe("ok");
    const second = calls.slice(from);
    expect(second.some((c) => isPluginCall(c, "plugin", "update", PLUGIN))).toBe(true);
    expect(second.some((c) => c.cmd === INSTALL_LAUNCHD && c.args[0] === "pause")).toBe(false);
    expect(second.some((c) => isPluginCall(c, "stop") || (c.cmd === "claude" && c.args[0] === "stop"))).toBe(false);
    expect(second.some((c) => c.cmd === "docker" && ["stop", "rm", "run", "start"].includes(c.args[0] ?? ""))).toBe(false);
    expect(reports.slice(reportsFrom).some((r) => r.status === "todo")).toBe(false);
    expect(docker.sessions().find((s) => s.id === "fake-live-1")?.state).toBe("running");
  });
});
