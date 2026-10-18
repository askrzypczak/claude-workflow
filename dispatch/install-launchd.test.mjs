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
    `#!/usr/bin/env bash\necho "$*" >>"${p("launchctl.log")}"\necho "launchctl $*" >>"${p("order.log")}"\n`,
  );
  chmodSync(p("launchctl"), 0o755);
  // Fake poller: records its args, prints a recognisable line, fails if poller-fail exists.
  writeFileSync(
    p("poller"),
    `#!/usr/bin/env bash\necho "poller $*" >>"${p("order.log")}"\necho "WOULD LAUNCH app-1"\necho "ENV bg=\${CLAUDE_BG_FLAGS-unset} bypass=\${CLAUDE_ALLOW_BYPASS_PERMISSIONS-unset} max=\${CLAUDE_MAX_SESSIONS-unset} keep=\${KEEP_ME-unset}"\n[ -f "${p("poller-busy")}" ] && echo "another run is active (pid 1); exiting"\n[ -f "${p("poller-fail")}" ] && exit 3\nexit 0\n`,
  );
  chmodSync(p("poller"), 0o755);
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

const run = (...args) => runWith({}, ...args);
const runWith = (opts, ...args) =>
  spawnSync("bash", [p("clone", "dispatch", "install-launchd.sh"), ...args], {
    encoding: "utf8",
    input: opts.input ?? "",
    env: {
      ...process.env,
      LAUNCHCTL: p("launchctl"),
      LAUNCH_AGENTS_DIR: p("agents"),
      LOG_DIR: p("logs"),
      STATE_DIR: p("state"),
      CLAUDE_WORKFLOW_CONFIG: p("cfg", "repos.json"),
      POLLER: p("poller"),
      ...opts.env,
    },
  });
const order = () =>
  existsSync(p("order.log"))
    ? readFileSync(p("order.log"), "utf8").split("\n").filter(Boolean)
    : [];
const calls = () =>
  existsSync(p("launchctl.log"))
    ? readFileSync(p("launchctl.log"), "utf8").split("\n").filter(Boolean)
    : [];

describe("install-launchd.sh", () => {
  it("installs: writes a filled plist and bootstraps it", () => {
    const r = run("install", "--yes");
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
    const r = run("install", "--yes", "--legacy-label", "com.old.job");
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
    const r = run("install", "--yes", "--migrate-state", p("old"), "app");
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
    run("install", "--yes");
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

  describe("confirmation", () => {
    const notInstalled = () => {
      assert.equal(existsSync(p("agents", `${LABEL}.plist`)), false);
      assert.deepEqual(calls(), []);
    };

    it("shows the dry run, then installs on y", () => {
      const r = runWith({ input: "y\n" }, "install");
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /WOULD LAUNCH app-1/);
      assert.match(r.stdout, /Install and start polling\? \[y\/N\]/);
      const o = order();
      assert.equal(o[0], "poller --dry-run");
      assert.ok(o.findIndex((l) => l.startsWith("launchctl bootstrap")) > 0);
      assert.ok(existsSync(p("agents", `${LABEL}.plist`)));
    });

    for (const [name, input] of [
      ["n", "n\n"],
      ["an empty answer", "\n"],
      ["EOF on stdin", ""],
      ["anything else", "maybe\n"],
    ]) {
      it(`aborts with nothing written on ${name}`, () => {
        const r = runWith({ input }, "install");
        assert.equal(r.status, 1);
        assert.match(r.stdout, /WOULD LAUNCH app-1/);
        assert.match(r.stderr, /Aborted/);
        notInstalled();
      });
    }

    it("--yes skips the prompt but still runs the dry run first", () => {
      const r = run("install", "--yes");
      assert.equal(r.status, 0, r.stderr);
      assert.match(r.stdout, /WOULD LAUNCH app-1/);
      assert.doesNotMatch(r.stdout, /\[y\/N\]/);
      assert.equal(order()[0], "poller --dry-run");
      assert.ok(order().some((l) => l.startsWith("launchctl bootstrap")));
    });

    for (const args of [["install"], ["install", "--yes"]]) {
      it(`aborts on a failing dry run (${args.join(" ")})`, () => {
        writeFileSync(p("poller-fail"), "");
        const r = runWith({ input: "y\n" }, ...args);
        assert.equal(r.status, 1);
        assert.match(r.stdout, /WOULD LAUNCH app-1/);
        assert.match(r.stderr, /dry run failed/);
        notInstalled();
      });
    }

    it("runs the dry run without the poller settings from the caller's shell", () => {
      const r = runWith(
        {
          input: "n\n",
          env: {
            CLAUDE_BG_FLAGS: "--model x",
            CLAUDE_ALLOW_BYPASS_PERMISSIONS: "1",
            CLAUDE_MAX_SESSIONS: "99",
            KEEP_ME: "yes",
          },
        },
        "install",
      );
      assert.match(
        r.stdout,
        /ENV bg=unset bypass=unset max=unset keep=yes/,
      );
    });

    it("aborts without prompting when another poll is running", () => {
      writeFileSync(p("poller-busy"), "");
      const r = runWith({ input: "y\n" }, "install");
      assert.equal(r.status, 1);
      assert.doesNotMatch(r.stdout, /\[y\/N\]/);
      assert.match(r.stderr, /poll is running/);
      notInstalled();
      assert.equal(runWith({ input: "y\n" }, "install", "--yes").status, 1);
    });

    it("notes that migration has not happened before the dry run", () => {
      const r = runWith({ input: "n\n" }, "install", "--migrate-state", p("old"), "app");
      assert.match(r.stdout, /have not been applied yet/);
      assert.doesNotMatch(run("install", "--yes").stdout, /have not been applied/);
    });

    it("uninstall needs no confirmation or dry run", () => {
      const r = run("uninstall");
      assert.equal(r.status, 0, r.stderr);
      assert.ok(!order().some((l) => l.startsWith("poller")));
    });
  });

  it("rejects unknown arguments", () => {
    assert.equal(run("install", "--bogus").status, 2);
  });
});
