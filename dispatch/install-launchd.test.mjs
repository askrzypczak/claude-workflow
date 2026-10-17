// Tests for dispatch/install-launchd.sh. Run: node --test dispatch/
// A fake `launchctl` records its calls; all paths are redirected into a temp dir.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

const SRC = import.meta.dirname;
const LABEL = "com.askrzypczak.claude-workflow-poller";

let dir;
const p = (...a) => join(dir, ...a);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "install-"));
  writeFileSync(
    p("launchctl"),
    `#!/usr/bin/env bash\necho "$*" >>"${p("launchctl.log")}"\n`,
  );
  chmodSync(p("launchctl"), 0o755);
  // The installer derives the clone from its own path and refuses worktrees, so run a copy.
  mkdirSync(p("clone", "dispatch", "launchd"), { recursive: true });
  copyFileSync(
    join(SRC, "install-launchd.sh"),
    p("clone", "dispatch", "install-launchd.sh"),
  );
  copyFileSync(
    join(SRC, "launchd", `${LABEL}.plist`),
    p("clone", "dispatch", "launchd", `${LABEL}.plist`),
  );
  mkdirSync(p("agents"));
  mkdirSync(p("cfg"));
  writeFileSync(p("cfg", "repos.json"), "[]");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = (...args) =>
  spawnSync("bash", [p("clone", "dispatch", "install-launchd.sh"), ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      LAUNCHCTL: p("launchctl"),
      LAUNCH_AGENTS_DIR: p("agents"),
      LOG_DIR: p("logs"),
      STATE_DIR: p("state"),
      CLAUDE_WORKFLOW_CONFIG: p("cfg", "repos.json"),
    },
  });
const calls = () =>
  existsSync(p("launchctl.log"))
    ? readFileSync(p("launchctl.log"), "utf8").split("\n").filter(Boolean)
    : [];

describe("install-launchd.sh", () => {
  it("installs: writes a filled plist and bootstraps it", () => {
    const r = run("install");
    assert.equal(r.status, 0, r.stderr);
    const plist = readFileSync(p("agents", `${LABEL}.plist`), "utf8");
    assert.doesNotMatch(plist, /__CLONE__|__HOME__/);
    assert.match(plist, /dispatch\/agent-poller\.sh/);
    assert.match(plist, /claude-workflow-poller\.log/);
    assert.ok(calls().some((c) => /^bootstrap gui\/\d+ .*\.plist$/.test(c)));
  });

  it("fails without a config and installs nothing", () => {
    rmSync(p("cfg", "repos.json"));
    const r = run("install");
    assert.equal(r.status, 1);
    assert.match(r.stderr, /No config/);
    assert.equal(existsSync(p("agents", `${LABEL}.plist`)), false);
    assert.deepEqual(calls(), []);
  });

  it("removes each --legacy-label job and plist on install", () => {
    writeFileSync(p("agents", "com.old.job.plist"), "x");
    const r = run("install", "--legacy-label", "com.old.job");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(p("agents", "com.old.job.plist")), false);
    const c = calls();
    assert.ok(c.some((l) => /^bootout gui\/\d+\/com\.old\.job$/.test(l)));
    // legacy is booted out before the new job is bootstrapped
    assert.ok(
      c.findIndex((l) => l.includes("com.old.job")) <
        c.findIndex((l) => l.startsWith("bootstrap")),
    );
  });

  it("migrates state without overwriting existing files", () => {
    mkdirSync(p("old"));
    writeFileSync(p("old", "launched.json"), '{"7":{"name":"app-7","at":1}}');
    writeFileSync(p("old", "conflicts.json"), '{"7":{"pr":"9","mainSha":"a"}}');
    mkdirSync(p("state", "repos", "app"), { recursive: true });
    writeFileSync(p("state", "repos", "app", "conflicts.json"), "{}");
    const r = run("install", "--migrate-state", p("old"), "app");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(
      readFileSync(p("state", "repos", "app", "launched.json"), "utf8"),
      '{"7":{"name":"app-7","at":1}}',
    );
    assert.equal(
      readFileSync(p("state", "repos", "app", "conflicts.json"), "utf8"),
      "{}",
    );
  });

  it("uninstall boots out, removes the plist and legacy plists", () => {
    run("install");
    writeFileSync(p("agents", "com.old.job.plist"), "x");
    const r = run("uninstall", "--legacy-label", "com.old.job");
    assert.equal(r.status, 0, r.stderr);
    assert.equal(existsSync(p("agents", `${LABEL}.plist`)), false);
    assert.equal(existsSync(p("agents", "com.old.job.plist")), false);
  });

  it("refuses to run from a worktree", () => {
    const wt = p("clone", ".claude", "worktrees", "w");
    mkdirSync(join(wt, "dispatch"), { recursive: true });
    const r = spawnSync(
      "bash",
      [
        "-c",
        `cp "${p("clone", "dispatch", "install-launchd.sh")}" "${wt}/dispatch/i.sh"; bash "${wt}/dispatch/i.sh" install`,
      ],
      {
        encoding: "utf8",
        env: {
          ...process.env,
          CLAUDE_WORKFLOW_CONFIG: p("cfg", "repos.json"),
          LAUNCHCTL: p("launchctl"),
        },
      },
    );
    assert.equal(r.status, 1);
    assert.match(r.stderr, /not a worktree/);
  });

  it("rejects unknown arguments", () => {
    assert.equal(run("install", "--bogus").status, 2);
  });
});
