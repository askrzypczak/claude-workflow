import { spawnSync } from "node:child_process";
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = fileURLToPath(new URL("./setup-labels.sh", import.meta.url));

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "setup-labels-"));
  // Fake gh: `label list` prints the names in $dir/existing; everything is logged.
  writeFileSync(
    join(dir, "gh"),
    `#!/usr/bin/env bash\necho "$*" >>"${join(dir, "gh.log")}"\nif [ "$1 $2" = "label list" ]; then cat "${join(dir, "existing")}"; fi\n`,
  );
  chmodSync(join(dir, "gh"), 0o755);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const run = (existing: string[], ...args: string[]) => {
  writeFileSync(join(dir, "existing"), existing.map((n) => `${n}\n`).join(""));
  const r = spawnSync("bash", [script, ...args], {
    encoding: "utf8",
    env: { ...process.env, GH: join(dir, "gh") },
  });
  let log: string[] = [];
  try {
    log = readFileSync(join(dir, "gh.log"), "utf8").split("\n").filter(Boolean);
  } catch {
    /* gh was never called */
  }
  return { ...r, log, creates: log.filter((l) => l.startsWith("label create")) };
};

describe("setup-labels.sh", () => {
  it("creates only missing labels and leaves existing ones untouched", () => {
    const r = run(["bug", "ready"]);
    expect(r.status).toBe(0);
    expect(r.creates).toHaveLength(8);
    expect(r.creates.some((l) => l.startsWith("label create bug "))).toBe(false);
    expect(r.creates.some((l) => l.startsWith("label create ready "))).toBe(false);
    expect(r.creates.some((l) => l.startsWith("label create chore "))).toBe(true);
    expect(r.creates.every((l) => !l.includes("--force"))).toBe(true);
    expect(r.stdout).toContain("bug: exists, skipped");
    expect(r.stdout).toContain("ready: exists, skipped");
  });

  it("does not treat a longer name as an existing label", () => {
    const r = run(["bugfix", "in-progress-2"]);
    expect(r.creates).toHaveLength(10);
  });

  it("matches existing names case-insensitively (GitHub treats Bug and bug as one label)", () => {
    const r = run(["Bug"]);
    expect(r.status).toBe(0);
    expect(r.creates.some((l) => l.startsWith("label create bug "))).toBe(false);
    expect(r.stdout).toContain("bug: exists, skipped");
    const u = run(["Bug"], "--update");
    expect(u.creates.find((l) => l.startsWith("label create bug "))).toContain(
      "--force",
    );
  });

  it("lists up to 1000 existing labels", () => {
    expect(run([]).log[0]).toContain("--limit 1000");
  });

  it("creates everything when none exist", () => {
    const r = run([]);
    expect(r.creates).toHaveLength(10);
    expect(r.stdout).not.toContain("skipped");
  });

  it("--update overwrites existing labels with --force and still creates missing ones", () => {
    const r = run(["bug"], "--update");
    expect(r.status).toBe(0);
    expect(r.creates).toHaveLength(10);
    expect(r.creates.find((l) => l.startsWith("label create bug "))).toContain("--force");
    expect(r.creates.find((l) => l.startsWith("label create chore "))).not.toContain(
      "--force",
    );
  });

  it("passes the repo to every gh call, with the flag in any position", () => {
    for (const args of [
      ["o/r", "--update"],
      ["--update", "o/r"],
    ]) {
      rmSync(join(dir, "gh.log"), { force: true });
      const r = run(["bug"], ...args);
      expect(r.status).toBe(0);
      expect(r.log.length).toBeGreaterThan(1);
      expect(r.log.every((l) => l.endsWith("--repo o/r"))).toBe(true);
    }
  });

  it("rejects unknown flags and extra positional args", () => {
    expect(run([], "--bogus").status).toBe(2);
    expect(run([], "a/b", "c/d").status).toBe(2);
  });
});
