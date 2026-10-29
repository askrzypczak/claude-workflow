// The stray-token scan's places beyond the shell and git: Claude Code's user settings and the
// poller's LaunchAgent.
import { describe, expect, it } from "vitest";
import { credentials } from "./credentials.ts";
import { FAKE_REPO, fakeIo, writeCalls } from "./fake-io.ts";

const HOME = "/home/example";

function scan(files: Record<string, string>) {
  const fake = fakeIo({ login: "fine-grained", files });
  const result = credentials.run({
    io: fake.io,
    dryRun: false,
    clone: "/clone",
    home: HOME,
    repos: [{ repo: FAKE_REPO, dir: "/clone" }],
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
