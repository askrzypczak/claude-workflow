// The stray-token scan's places beyond the shell and git: Claude Code's user settings, the
// poller's LaunchAgent and the served repos' .mcp.json files.
import { describe, expect, it } from "vitest";
import { credentials } from "./credentials.ts";
import { FAKE_REPO, fakeIo, parseDockerExec, writeCalls } from "./fake-io.ts";
import type { FakeDocker } from "./fake-io.ts";

const HOME = "/home/example";

function scan(files: Record<string, string>) {
  const fake = fakeIo({ login: "fine-grained", files });
  const result = credentials.run({
    io: fake.io,
    dryRun: false,
    clone: "/clone",
    home: HOME,
    repos: [{ repo: FAKE_REPO }],
  });
  return { ...fake, result, todos: fake.reports.filter((r) => r.status === "todo").map((r) => r.text) };
}

describe("stray-token scan", () => {
  it("reports GH_TOKEN in the env block of ~/.claude/settings.json without its value", () => {
    const value = "ghp_SETTINGSVALUE555";
    const { result, todos, reports, calls } = scan({
      [`${HOME}/.claude/settings.json`]: JSON.stringify({ env: { GH_TOKEN: value, EDITOR: "vi" } }),
    });

    expect(result).toBe("stop");
    expect(writeCalls(calls)).toEqual([]);
    expect(todos.some((t) => t.includes("settings.json") && t.includes("GH_TOKEN"))).toBe(true);
    for (const r of reports) expect(r.text).not.toContain(value);
  });

  it("reports GITHUB_TOKEN in the poller's LaunchAgent plist without its value", () => {
    const value = "ghp_PLISTVALUE666";
    const plist = [
      '<?xml version="1.0" encoding="UTF-8"?>',
      '<plist version="1.0"><dict>',
      "  <key>EnvironmentVariables</key>",
      "  <dict>",
      "    <key>GITHUB_TOKEN</key>",
      `    <string>${value}</string>`,
      "  </dict>",
      "</dict></plist>",
    ].join("\n");
    const { result, todos, reports, calls } = scan({
      [`${HOME}/Library/LaunchAgents/com.askrzypczak.claude-workflow-poller.plist`]: plist,
    });

    expect(result).toBe("stop");
    expect(writeCalls(calls)).toEqual([]);
    expect(todos.some((t) => t.includes("claude-workflow-poller.plist") && t.includes("GITHUB_TOKEN"))).toBe(true);
    for (const r of reports) expect(r.text).not.toContain(value);
  });
});

describe("stray-token scan of .mcp.json files", () => {
  const APP = "example-owner/example-app";
  const APP_CLONE = "/home/node/example-app";
  const mcpJson = (name: string) =>
    JSON.stringify({ mcpServers: { [name]: { command: "npx", args: ["-y", "@modelcontextprotocol/server-github"] } } });

  function scanServed(docker: FakeDocker) {
    const fake = fakeIo({ login: "fine-grained", files: { "/clone/.mcp.json": mcpJson("github-tools") }, docker });
    const result = credentials.run({
      io: fake.io,
      dryRun: false,
      clone: "/clone",
      home: HOME,
      repos: [
        { repo: FAKE_REPO },
        { repo: APP },
      ],
    });
    return {
      ...fake,
      result,
      todos: fake.reports.filter((r) => r.status === "todo").map((r) => r.text),
      notes: fake.reports.filter((r) => r.status === "note").map((r) => r.text),
    };
  }

  it("the stray-token scan reads this clone's .mcp.json on the host and each served repo's through the container", () => {
    const { result, todos, fileOps, calls } = scanServed({
      container: { state: "running" },
      files: { [`${APP_CLONE}/.mcp.json`]: mcpJson("github-app") },
    });

    expect(result).toBe("stop");
    expect(todos.some((t) => t.includes(".mcp.json") && t.includes("github-tools"))).toBe(true);
    expect(todos.some((t) => t.includes(".mcp.json") && t.includes("github-app"))).toBe(true);
    expect(fileOps.some((op) => op.op === "readFile" && op.path === "/clone/.mcp.json")).toBe(true);
    // The served repo's dir is a container path: the host is never asked for it.
    expect(fileOps.filter((op) => op.path.startsWith("/home/node"))).toEqual([]);
    expect(
      calls.some((c) => parseDockerExec(c)?.command.some((a) => a.includes(`${APP_CLONE}/.mcp.json`)) === true),
    ).toBe(true);
    expect(writeCalls(calls)).toEqual([]);
  });

  it("the stray-token scan notes the served repos it did not scan when the container is not running", () => {
    const { todos, notes, fileOps, calls } = scanServed({
      container: { state: "stopped" },
      files: { [`${APP_CLONE}/.mcp.json`]: mcpJson("github-app") },
    });

    expect(notes.filter((n) => n.includes(APP) && n.includes(".mcp.json"))).toHaveLength(1);
    expect(todos.some((t) => t.includes("github-tools"))).toBe(true);
    expect(todos.some((t) => t.includes("github-app"))).toBe(false);
    expect(fileOps.filter((op) => op.path.startsWith("/home/node"))).toEqual([]);
    expect(calls.some((c) => c.cmd === "docker" && c.args[0] === "start")).toBe(false);
  });
});
