import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { createIo } from "./io.ts";

const PRINT = "process.stdout.write(JSON.stringify([process.env.GH_TOKEN ?? null, process.env.GITHUB_TOKEN ?? null, process.env.EXTRA ?? null, require('fs').readFileSync(0, 'utf8')]))";

describe("createIo().run", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("gives the child this environment without GH_TOKEN or GITHUB_TOKEN, plus the call's env and input", () => {
    vi.stubEnv("GH_TOKEN", "from-the-shell");
    vi.stubEnv("GITHUB_TOKEN", "from-the-shell");

    const result = createIo().run(process.execPath, ["-e", PRINT], { env: { EXTRA: "added" }, input: "stdin text" });

    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual([null, null, "added", "stdin text"]);
  });

  it("returns exit 127 for a command that cannot start, instead of throwing", () => {
    const result = createIo().run("/nonexistent/command", []);

    expect(result.status).toBe(127);
  });

  it("starts the child in the call's working directory", () => {
    const dir = mkdtempSync(join(tmpdir(), "io-cwd-"));
    try {
      const result = createIo().run(process.execPath, ["-e", "process.stdout.write(process.cwd())"], { cwd: dir });

      expect(result.status).toBe(0);
      expect(realpathSync(result.stdout)).toBe(realpathSync(dir));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("createIo() file methods", () => {
  const dir = mkdtempSync(join(tmpdir(), "io-files-"));
  afterAll(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("listDir names a directory's entries and is undefined for a missing one", () => {
    const listed = join(dir, "listed");
    mkdirSync(listed);
    writeFileSync(join(listed, "a"), "");
    mkdirSync(join(listed, "b"));

    expect(createIo().listDir(listed)?.sort()).toEqual(["a", "b"]);
    expect(createIo().listDir(join(dir, "missing"))).toBeUndefined();
  });

  it("readFirstLine is undefined for a missing path and for a directory", () => {
    expect(createIo().readFirstLine(join(dir, "missing"))).toBeUndefined();
    expect(createIo().readFirstLine(dir)).toBeUndefined();
  });

  it("appendFile creates a missing file with mode 0600 and then appends to it", () => {
    const path = join(dir, "appended");

    createIo().appendFile(path, "one\n");
    createIo().appendFile(path, "two\n");

    expect(readFileSync(path, "utf8")).toBe("one\ntwo\n");
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("writeFile creates a missing file with mode 0600 and replaces an existing file's text, keeping its mode", () => {
    const created = join(dir, "written");
    createIo().writeFile(created, "one\n");
    createIo().writeFile(created, "two\n");

    expect(readFileSync(created, "utf8")).toBe("two\n");
    expect(statSync(created).mode & 0o777).toBe(0o600);

    const existing = join(dir, "existing");
    writeFileSync(existing, "old\n");
    chmodSync(existing, 0o644);
    createIo().writeFile(existing, "new\n");

    expect(readFileSync(existing, "utf8")).toBe("new\n");
    expect(statSync(existing).mode & 0o777).toBe(0o644);
  });

  it("copyFile copies, and throws without overwriting when the target exists", () => {
    const from = join(dir, "from");
    const to = join(dir, "to");
    writeFileSync(from, "original\n");

    createIo().copyFile(from, to);
    writeFileSync(from, "changed\n");

    expect(readFileSync(to, "utf8")).toBe("original\n");
    expect(() => createIo().copyFile(from, to)).toThrow();
    expect(readFileSync(to, "utf8")).toBe("original\n");
  });
});
