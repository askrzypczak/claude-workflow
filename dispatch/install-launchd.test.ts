// Tests for dispatch/install-launchd.sh. Run: npx vitest run dispatch/install-launchd
// A fake `launchctl` records its calls; all paths are redirected into a temp dir.
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const SRC = import.meta.dirname;
const LABEL = "com.askrzypczak.claude-workflow-poller";

let dir: string;
const p = (...a: string[]) => join(dir, ...a);

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "install-"));
  writeFileSync(
    p("launchctl"),
    `#!/usr/bin/env bash\necho "$*" >>"${p("launchctl.log")}"\necho "launchctl $*" >>"${p("order.log")}"\n` +
      // print-disabled prints the fixture if present; launchctl-fail-<subcommand> makes that subcommand fail.
      `if [ "$1" = print-disabled ] && [ -f "${p("print-disabled.txt")}" ]; then cat "${p("print-disabled.txt")}"; fi\n` +
      `if [ -f "${p("launchctl-fail-")}$1" ]; then echo "launchctl $1 failed" >&2; exit 5; fi\n`,
  );
  chmodSync(p("launchctl"), 0o755);
  // Fake poller: records its args, prints a recognisable line, fails if poller-fail exists.
  writeFileSync(
    p("poller"),
    `#!/usr/bin/env bash\necho "poller $*" >>"${p("order.log")}"\necho "WOULD LAUNCH app-1"\necho "ENV max=\${CLAUDE_MAX_SESSIONS-unset} keep=\${KEEP_ME-unset}"\n[ -f "${p("poller-busy")}" ] && echo "another run is active (pid 1); exiting"\n[ -f "${p("poller-fail")}" ] && exit 3\nexit 0\n`,
  );
  chmodSync(p("poller"), 0o755);
  // Fake npm: records its args and working dir, fails if npm-fail exists.
  writeFileSync(
    p("npm"),
    `#!/usr/bin/env bash\necho "npm $*" >>"${p("order.log")}"\npwd -P >>"${p("npm.cwd")}"\n[ -f "${p("npm-fail")}" ] && exit 1\nexit 0\n`,
  );
  chmodSync(p("npm"), 0o755);
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

interface RunOpts {
  input?: string;
  env?: Record<string, string>;
}

const run = (...args: string[]) => runWith({}, ...args);
const runWith = (opts: RunOpts, ...args: string[]) =>
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
      NPM: p("npm"),
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
    expect(r.status, r.stderr).toBe(0);
    const plist = readFileSync(p("agents", `${LABEL}.plist`), "utf8");
    expect(plist).not.toMatch(/__CLONE__|__HOME__/);
    expect(plist).toMatch(/dispatch\/agent-poller\.sh/);
    expect(plist).toMatch(/claude-workflow-poller\.log/);
    expect(calls().some((c) => /^bootstrap gui\/\d+ .*\.plist$/.test(c))).toBe(true);
  });

  it("fails without a config and installs nothing", () => {
    rmSync(p("cfg", "repos.json"));
    const r = run("install");
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/No config/);
    expect(existsSync(p("agents", `${LABEL}.plist`))).toBe(false);
    expect(calls()).toStrictEqual([]);
  });

  it("removes each --legacy-label job and plist on install", () => {
    writeFileSync(p("agents", "com.old.job.plist"), "x");
    const r = run("install", "--yes", "--legacy-label", "com.old.job");
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(p("agents", "com.old.job.plist"))).toBe(false);
    const c = calls();
    expect(c.some((l) => /^bootout gui\/\d+\/com\.old\.job$/.test(l))).toBe(true);
    // legacy is booted out before the new job is bootstrapped
    expect(
      c.findIndex((l) => l.includes("com.old.job")) <
        c.findIndex((l) => l.startsWith("bootstrap")),
    ).toBe(true);
  });

  it("migrates state without overwriting existing files", () => {
    mkdirSync(p("old"));
    writeFileSync(p("old", "launched.json"), '{"7":{"name":"app-7","at":1}}');
    writeFileSync(p("old", "conflicts.json"), '{"7":{"pr":"9","mainSha":"a"}}');
    mkdirSync(p("state", "repos", "app"), { recursive: true });
    writeFileSync(p("state", "repos", "app", "conflicts.json"), "{}");
    const r = run("install", "--yes", "--migrate-state", p("old"), "app");
    expect(r.status, r.stderr).toBe(0);
    expect(readFileSync(p("state", "repos", "app", "launched.json"), "utf8")).toBe('{"7":{"name":"app-7","at":1}}');
    expect(readFileSync(p("state", "repos", "app", "conflicts.json"), "utf8")).toBe("{}");
  });

  it("uninstall boots out, removes the plist and legacy plists", () => {
    run("install", "--yes");
    writeFileSync(p("agents", "com.old.job.plist"), "x");
    const r = run("uninstall", "--legacy-label", "com.old.job");
    expect(r.status, r.stderr).toBe(0);
    expect(existsSync(p("agents", `${LABEL}.plist`))).toBe(false);
    expect(existsSync(p("agents", "com.old.job.plist"))).toBe(false);
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
          NPM: p("npm"),
        },
      },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/not a worktree/);
  });

  describe("confirmation", () => {
    const notInstalled = () => {
      expect(existsSync(p("agents", `${LABEL}.plist`))).toBe(false);
      expect(calls()).toStrictEqual([]);
    };

    it("shows the dry run, then installs on y", () => {
      const r = runWith({ input: "y\n" }, "install");
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/WOULD LAUNCH app-1/);
      expect(r.stdout).toMatch(/Install and start polling\? \[y\/N\]/);
      const o = order();
      expect(o.slice(0, 2)).toStrictEqual(["npm ci", "poller --dry-run"]);
      expect(o.findIndex((l) => l.startsWith("launchctl bootstrap")) > 0).toBe(true);
      expect(existsSync(p("agents", `${LABEL}.plist`))).toBe(true);
    });

    for (const [name, input] of [
      ["n", "n\n"],
      ["an empty answer", "\n"],
      ["EOF on stdin", ""],
      ["anything else", "maybe\n"],
    ]) {
      it(`aborts with nothing written on ${name}`, () => {
        const r = runWith({ input }, "install");
        expect(r.status).toBe(1);
        expect(r.stdout).toMatch(/WOULD LAUNCH app-1/);
        expect(r.stderr).toMatch(/Aborted/);
        notInstalled();
      });
    }

    it("runs npm ci in the clone before the dry run", () => {
      const r = run("install", "--yes");
      expect(r.status, r.stderr).toBe(0);
      expect(order()[0]).toBe("npm ci");
      const cwd = readFileSync(p("npm.cwd"), "utf8").trim();
      expect(cwd).toBe(realpathSync(p("clone")));
    });

    it("aborts with nothing installed (and no dry run) when npm ci fails", () => {
      writeFileSync(p("npm-fail"), "");
      const r = run("install", "--yes");
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/npm ci failed/);
      expect(!order().some((l) => l.startsWith("poller"))).toBe(true);
      notInstalled();
    });

    it("uninstall does not run npm", () => {
      expect(run("uninstall").status).toBe(0);
      expect(existsSync(p("npm.cwd"))).toBe(false);
    });

    it("--yes skips the prompt but still runs the dry run first", () => {
      const r = run("install", "--yes");
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/WOULD LAUNCH app-1/);
      expect(r.stdout).not.toMatch(/\[y\/N\]/);
      expect(order().slice(0, 2)).toStrictEqual(["npm ci", "poller --dry-run"]);
      expect(order().some((l) => l.startsWith("launchctl bootstrap"))).toBe(true);
    });

    for (const args of [["install"], ["install", "--yes"]]) {
      it(`aborts on a failing dry run (${args.join(" ")})`, () => {
        writeFileSync(p("poller-fail"), "");
        const r = runWith({ input: "y\n" }, ...args);
        expect(r.status).toBe(1);
        expect(r.stdout).toMatch(/WOULD LAUNCH app-1/);
        expect(r.stderr).toMatch(/dry run failed/);
        notInstalled();
      });
    }

    it("runs the dry run without the poller settings from the caller's shell", () => {
      const r = runWith(
        {
          input: "n\n",
          env: {
            CLAUDE_MAX_SESSIONS: "99",
            KEEP_ME: "yes",
          },
        },
        "install",
      );
      expect(r.stdout).toMatch(/ENV max=unset keep=yes/);
    });

    it("aborts without prompting when another poll is running", () => {
      writeFileSync(p("poller-busy"), "");
      const r = runWith({ input: "y\n" }, "install");
      expect(r.status).toBe(1);
      expect(r.stdout).not.toMatch(/\[y\/N\]/);
      expect(r.stderr).toMatch(/poll is running/);
      notInstalled();
      expect(runWith({ input: "y\n" }, "install", "--yes").status).toBe(1);
    });

    it("notes that migration has not happened before the dry run", () => {
      const r = runWith({ input: "n\n" }, "install", "--migrate-state", p("old"), "app");
      expect(r.stdout).toMatch(/have not been applied yet/);
      expect(run("install", "--yes").stdout).not.toMatch(/have not been applied/);
    });

    it("uninstall needs no confirmation or dry run", () => {
      const r = run("uninstall");
      expect(r.status, r.stderr).toBe(0);
      expect(!order().some((l) => l.startsWith("poller"))).toBe(true);
    });
  });

  it("rejects unknown arguments", () => {
    expect(run("install", "--bogus").status).toBe(2);
  });

  describe("argument validation", () => {
    for (const bad of ["../x", "a/b", "a b", "..", ".", "", "x;y"]) {
      for (const cmd of ["install", "uninstall"]) {
        it(`rejects --legacy-label ${JSON.stringify(bad)} on ${cmd} before touching anything`, () => {
          writeFileSync(p("agents", "x.plist"), "keep");
          const r = run(cmd, "--yes", "--legacy-label", bad);
          expect(r.status).toBe(2);
          expect(r.stderr).toMatch(/Invalid --legacy-label/);
          expect(calls()).toStrictEqual([]);
          expect(existsSync(p("agents", "x.plist"))).toBe(true);
          expect(existsSync(p("agents", `${LABEL}.plist`))).toBe(false);
        });
      }
    }

    it("rejects a --migrate-state PREFIX that is not a plain session prefix", () => {
      for (const bad of ["../x", "a/b", "a b", ""]) {
        const r = run("install", "--yes", "--migrate-state", p("old"), bad);
        expect(r.status, bad).toBe(2);
        expect(r.stderr).toMatch(/Invalid --migrate-state PREFIX/);
      }
      expect(calls()).toStrictEqual([]);
      expect(existsSync(p("state"))).toBe(false);
    });

    it("still accepts dotted labels and prefixes with dashes and underscores", () => {
      writeFileSync(p("agents", "com.old-job_2.plist"), "x");
      const r = run(
        "install",
        "--yes",
        "--legacy-label",
        "com.old-job_2",
        "--migrate-state",
        p("old"),
        "my_app-1",
      );
      expect(r.status, r.stderr).toBe(0);
      expect(existsSync(p("agents", "com.old-job_2.plist"))).toBe(false);
    });

    it("rejects --purge on install", () => {
      const r = run("install", "--yes", "--purge");
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/--purge only applies to uninstall/);
      expect(calls()).toStrictEqual([]);
    });
  });

  describe("plist templating", () => {
    const SPECIAL = "we&ird|dir <x> y--z";
    const pl = () => p("agents", `${LABEL}.plist`);
    const unescape = (s: string) =>
      s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
    // Copy the installer into a clone whose path has sed/XML metacharacters and run it there.
    const runInSpecialClone = (env: Record<string, string> = {}) => {
      const clone = p(SPECIAL);
      mkdirSync(join(clone, "dispatch", "launchd"), { recursive: true });
      copyFileSync(
        join(SRC, "install-launchd.sh"),
        join(clone, "dispatch", "install-launchd.sh"),
      );
      copyFileSync(
        join(SRC, "launchd", `${LABEL}.plist`),
        join(clone, "dispatch", "launchd", `${LABEL}.plist`),
      );
      const r = spawnSync(
        "bash",
        [join(clone, "dispatch", "install-launchd.sh"), "install", "--yes"],
        {
          encoding: "utf8",
          env: {
            ...process.env,
            LAUNCHCTL: p("launchctl"),
            LAUNCH_AGENTS_DIR: p("agents"),
            LOG_DIR: p("logs"),
            STATE_DIR: p("state"),
            CLAUDE_WORKFLOW_CONFIG: p("cfg", "repos.json"),
            POLLER: p("poller"),
            NPM: p("npm"),
            ...env,
          },
        },
      );
      return { r, clone };
    };

    it("writes a valid plist with the exact clone path when it contains & | < > and spaces", () => {
      const { r, clone } = runInSpecialClone();
      expect(r.status, r.stderr).toBe(0);
      const plist = readFileSync(pl(), "utf8");
      expect(plist).not.toMatch(/__CLONE__|__HOME__/);
      const m = plist.match(/<string>([^<]*agent-poller\.sh)<\/string>/);
      expect(m, plist).toBeTruthy();
      expect(unescape(m![1])).toBe(`${clone}/dispatch/agent-poller.sh`);
      const lint = spawnSync("plutil", ["-lint", pl()], { encoding: "utf8" });
      if (!lint.error) expect(lint.status, lint.stdout + lint.stderr).toBe(0);
      expect(calls().some((c) => c.startsWith("bootstrap"))).toBe(true);
    });

    it("escapes & in HOME and substitutes it literally", () => {
      const rh =runWith({ env: { HOME: "/tmp/a&b" } }, "install", "--yes");
      expect(rh.status, rh.stderr).toBe(0);
      const plist = readFileSync(pl(), "utf8");
      expect(plist).toMatch(/<string>\/tmp\/a&amp;b\/Library\/Logs\/claude-workflow-poller\.log<\/string>/);
    });

    it("leaves no plist (and no temp file) and does not bootstrap when validation fails", () => {
      mkdirSync(p("bin"));
      writeFileSync(p("bin", "plutil"), "#!/bin/sh\necho bad plist >&2\nexit 1\n");
      chmodSync(p("bin", "plutil"), 0o755);
      const { r } = runInSpecialClone({
        PATH: `${p("bin")}:${process.env.PATH}`,
      });
      expect(r.status).toBe(1);
      expect(r.stderr).toMatch(/invalid/);
      expect(readdirSync(p("agents"))).toStrictEqual([]);
      expect(!calls().some((c) => c.startsWith("bootstrap"))).toBe(true);
    });

    it("keeps the previous plist when the new one fails validation", () => {
      writeFileSync(pl(), "old good plist");
      mkdirSync(p("bin"));
      writeFileSync(p("bin", "plutil"), "#!/bin/sh\nexit 1\n");
      chmodSync(p("bin", "plutil"), 0o755);
      const { r } = runInSpecialClone({
        PATH: `${p("bin")}:${process.env.PATH}`,
      });
      expect(r.status).toBe(1);
      expect(readFileSync(pl(), "utf8")).toBe("old good plist");
      expect(readdirSync(p("agents"))).toStrictEqual([`${LABEL}.plist`]);
    });
  });

  describe("uninstall leftovers", () => {
    const seed = () => {
      mkdirSync(p("state", "repos", "app"), { recursive: true });
      mkdirSync(p("state", "repos", "web"), { recursive: true });
      writeFileSync(
        p("state", "repos", "app", "launched.json"),
        '{"7":{"name":"app-7","at":1},"9":{"name":"app-9","at":2}}',
      );
      writeFileSync(
        p("state", "repos", "web", "launched.json"),
        '{"3":{"name":"web-3","at":1}}',
      );
      mkdirSync(p("logs"));
      writeFileSync(p("logs", "claude-workflow-poller.log"), "log");
    };

    it("lists state, config, log, sessions and plugin commands and keeps the files", () => {
      seed();
      const r = run("uninstall");
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout.includes(p("state"))).toBe(true);
      expect(r.stdout.includes(p("cfg", "repos.json"))).toBe(true);
      expect(r.stdout.includes(p("logs", "claude-workflow-poller.log"))).toBe(true);
      for (const n of ["app-7", "app-9", "web-3"])
        expect(r.stdout).toMatch(new RegExp(`claude stop ${n}\\b`));
      expect(r.stdout).toMatch(/claude plugin uninstall ticket-workflow/);
      expect(r.stdout).toMatch(/claude plugin marketplace remove askrzypczak-plugins/);
      expect(existsSync(p("state", "repos", "app", "launched.json"))).toBe(true);
      expect(existsSync(p("cfg", "repos.json"))).toBe(true);
      expect(existsSync(p("logs", "claude-workflow-poller.log"))).toBe(true);
    });

    it("says so when jq is missing instead of silently skipping sessions", () => {
      seed();
      mkdirSync(p("nojq"));
      for (const t of ["bash", "dirname", "id", "rm", "cat", "mkdir"]) {
        const found = spawnSync("sh", ["-c", `command -v ${t}`], {
          encoding: "utf8",
        }).stdout.trim();
        symlinkSync(found, p("nojq", t));
      }
      const r = runWith({ env: { PATH: p("nojq") } }, "uninstall");
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/jq not found; check .*launched\.json/);
      expect(r.stdout).not.toMatch(/claude stop/);
    });

    it("works with no state at all", () => {
      const r = run("uninstall");
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).not.toMatch(/claude stop/);
      expect(r.stdout).toMatch(/claude plugin uninstall/);
    });

    it("--purge removes state, config and log, still lists sessions and plugin commands", () => {
      seed();
      writeFileSync(p("agents", `${LABEL}.plist`), "x");
      const r = run("uninstall", "--purge");
      expect(r.status, r.stderr).toBe(0);
      expect(existsSync(p("state"))).toBe(false);
      expect(existsSync(p("cfg", "repos.json"))).toBe(false);
      expect(existsSync(p("logs", "claude-workflow-poller.log"))).toBe(false);
      expect(existsSync(p("agents", `${LABEL}.plist`))).toBe(false);
      expect(r.stdout).toMatch(/Purged/);
      expect(r.stdout).toMatch(/claude stop app-7\b/);
      expect(r.stdout).toMatch(/claude plugin uninstall ticket-workflow/);
    });
  });

  describe("pause, resume and status", () => {
    const uid = () => String(process.getuid!());
    const job = () => `gui/${uid()}/${LABEL}`;
    const plist = () => p("agents", `${LABEL}.plist`);
    const installPlist = () => writeFileSync(plist(), "installed plist");
    const failLaunchctl = (sub: string) => writeFileSync(p(`launchctl-fail-${sub}`), "");
    const printDisabled = (state: "enabled" | "disabled") =>
      writeFileSync(
        p("print-disabled.txt"),
        `disabled services = {\n\t\t"com.apple.other" => enabled\n\t\t"${LABEL}" => ${state}\n\t}\n\nlogin item associations = {\n\t}\n`,
      );
    const statusLines = (stdout: string) => stdout.split("\n").filter(Boolean);

    it("pause disables then boots out the poller and keeps the plist", () => {
      installPlist();
      const r = run("pause");
      expect(r.status, r.stderr).toBe(0);
      const c = calls();
      const disable = c.indexOf(`disable ${job()}`);
      const bootout = c.indexOf(`bootout ${job()}`);
      expect(disable, c.join("\n")).toBeGreaterThanOrEqual(0);
      expect(bootout, c.join("\n")).toBeGreaterThan(disable);
      expect(readFileSync(plist(), "utf8")).toBe("installed plist");
    });

    it("pause succeeds when the job is not loaded", () => {
      installPlist();
      failLaunchctl("bootout");
      const r = run("pause");
      expect(r.status, r.stderr).toBe(0);
      expect(calls()).toContain(`bootout ${job()}`);
    });

    it("pause lists claude stop for each recorded session", () => {
      installPlist();
      mkdirSync(p("state", "repos", "app"), { recursive: true });
      mkdirSync(p("state", "repos", "web"), { recursive: true });
      const app = '{"7":{"name":"app-7","at":1},"9":{"name":"app-9","at":2}}';
      const web = '{"3":{"name":"web-3","at":1}}';
      writeFileSync(p("state", "repos", "app", "launched.json"), app);
      writeFileSync(p("state", "repos", "web", "launched.json"), web);
      const r = run("pause");
      expect(r.status, r.stderr).toBe(0);
      for (const n of ["app-7", "app-9", "web-3"])
        expect(r.stdout).toMatch(new RegExp(`claude stop ${n}\\b`));
      expect(calls()).toStrictEqual([`disable ${job()}`, `bootout ${job()}`]);
      expect(readFileSync(p("state", "repos", "app", "launched.json"), "utf8")).toBe(app);
      expect(readFileSync(p("state", "repos", "web", "launched.json"), "utf8")).toBe(web);
    });

    it("resume enables then bootstraps the installed plist without npm ci or the dry run", () => {
      installPlist();
      const r = run("resume");
      expect(r.status, r.stderr).toBe(0);
      const c = calls();
      const enable = c.indexOf(`enable ${job()}`);
      const bootstrap = c.indexOf(`bootstrap gui/${uid()} ${plist()}`);
      expect(enable, c.join("\n")).toBeGreaterThanOrEqual(0);
      expect(bootstrap, c.join("\n")).toBeGreaterThan(enable);
      expect(order().filter((l) => l.startsWith("npm") || l.startsWith("poller"))).toStrictEqual([]);
    });

    it("resume succeeds when the job is already loaded", () => {
      installPlist();
      failLaunchctl("bootstrap");
      const r = run("resume");
      expect(r.status, r.stderr).toBe(0);
      expect(calls()).toContain(`bootstrap gui/${uid()} ${plist()}`);
    });

    it("resume exits non-zero when bootstrap fails and the job is not loaded", () => {
      installPlist();
      failLaunchctl("bootstrap");
      failLaunchctl("print");
      const r = run("resume");
      expect(r.status).not.toBe(0);
      const c = calls();
      expect(c).toContain(`enable ${job()}`);
      expect(c).toContain(`bootstrap gui/${uid()} ${plist()}`);
    });

    it("resume without an installed plist exits non-zero, points at install and calls no launchctl", () => {
      const r = run("resume");
      expect(r.status).not.toBe(0);
      expect(r.stderr).toMatch(/install-launchd\.sh install\b/);
      expect(calls()).toStrictEqual([]);
    });

    it("status reports an installed, loaded, enabled job and exits 0", () => {
      installPlist();
      printDisabled("enabled");
      const r = run("status");
      expect(r.status, r.stderr).toBe(0);
      expect(statusLines(r.stdout)).toStrictEqual([
        `Installed: yes (${plist()})`,
        "Loaded:    yes",
        "Disabled:  no",
      ]);
    });

    it("status reports a missing, unloaded, disabled job and exits 0", () => {
      failLaunchctl("print");
      printDisabled("disabled");
      const r = run("status");
      expect(r.status, r.stderr).toBe(0);
      expect(statusLines(r.stdout)).toStrictEqual([
        "Installed: no",
        "Loaded:    no",
        "Disabled:  yes",
      ]);
    });

    it("pause, resume and status reject --purge, --legacy-label and --migrate-state with exit 2 before calling launchctl", () => {
      installPlist();
      const flags = [
        ["--purge"],
        ["--legacy-label", "com.old.job"],
        ["--migrate-state", p("old"), "app"],
      ];
      for (const cmd of ["pause", "resume", "status"]) {
        for (const f of flags) {
          rmSync(p("launchctl.log"), { force: true });
          const r = run(cmd, ...f);
          expect(r.status, `${cmd} ${f[0]}`).toBe(2);
          expect(calls(), `${cmd} ${f[0]}`).toStrictEqual([]);
        }
      }
    });

    it("install enables the job before bootstrapping it", () => {
      const r = run("install", "--yes");
      expect(r.status, r.stderr).toBe(0);
      const c = calls();
      const enable = c.indexOf(`enable ${job()}`);
      const bootstrap = c.findIndex((l) => l.startsWith("bootstrap "));
      expect(enable, c.join("\n")).toBeGreaterThanOrEqual(0);
      expect(bootstrap, c.join("\n")).toBeGreaterThan(enable);
    });
  });
});
