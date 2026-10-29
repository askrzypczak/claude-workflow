// createIo().readFirstLine on the real file system, with node:fs wrapped in pass-through spies
// so the test can count the bytes read from the file.
import { closeSync, mkdtempSync, openSync, readFileSync, readSync, readvSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { createIo } from "./io.ts";

vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const spied = {
    ...actual,
    openSync: vi.fn(actual.openSync),
    readSync: vi.fn(actual.readSync),
    readvSync: vi.fn(actual.readvSync),
    readFileSync: vi.fn(actual.readFileSync),
    closeSync: vi.fn(actual.closeSync),
  };
  return { ...spied, default: spied };
});

const dir = mkdtempSync(join(tmpdir(), "io-first-line-"));

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("createIo().readFirstLine", () => {
  it("createIo().readFirstLine returns a file's first line and reads no byte past its newline", () => {
    const header = "-----BEGIN OPENSSH PRIVATE KEY-----";
    const path = join(dir, "id_example");
    writeFileSync(path, `${header}\nFAKE-KEY-BODY-FOR-TESTS\n-----END OPENSSH PRIVATE KEY-----\n`);
    vi.mocked(openSync).mockClear();
    vi.mocked(readSync).mockClear();
    vi.mocked(readvSync).mockClear();
    vi.mocked(readFileSync).mockClear();
    vi.mocked(closeSync).mockClear();

    const line = createIo().readFirstLine(path);

    expect(line).toBe(header);
    const opens = vi.mocked(openSync).mock;
    const fds = new Set(
      opens.calls
        .map((args, i) => (args[0] === path ? opens.results[i]?.value : undefined))
        .filter((fd): fd is number => typeof fd === "number"),
    );
    expect(fds.size).toBeGreaterThan(0);
    const bytesFrom = (mock: { calls: unknown[][]; results: { value: unknown }[] }) =>
      mock.calls.reduce<number>((sum, args, i) => {
        const value = mock.results[i]?.value;
        return fds.has(args[0] as number) && typeof value === "number" ? sum + value : sum;
      }, 0);
    const bytesRead = bytesFrom(vi.mocked(readSync).mock) + bytesFrom(vi.mocked(readvSync).mock);
    expect(bytesRead).toBeGreaterThanOrEqual(header.length);
    expect(bytesRead).toBeLessThanOrEqual(Buffer.byteLength(header) + 1);
    const wholeReads = vi.mocked(readFileSync).mock.calls.filter(
      (args) => args[0] === path || fds.has(args[0] as number),
    );
    expect(wholeReads).toEqual([]);
    for (const fd of fds) expect(vi.mocked(closeSync).mock.calls.some((args) => args[0] === fd)).toBe(true);
  });
});
