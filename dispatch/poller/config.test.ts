import { describe, expect, it } from "vitest";
import {
  combinedFlags,
  expandHome,
  parseMaxSessions,
  splitFlags,
  validateConfig,
} from "./config.ts";

describe("parseMaxSessions", () => {
  it("defaults to 10 when unset or empty", () => {
    expect(parseMaxSessions(undefined)).toEqual({ ok: true, value: 10 });
    expect(parseMaxSessions("")).toEqual({ ok: true, value: 10 });
  });

  it("accepts a positive integer", () => {
    expect(parseMaxSessions("3")).toEqual({ ok: true, value: 3 });
    expect(parseMaxSessions("120")).toEqual({ ok: true, value: 120 });
  });

  for (const bad of ["0", "03", "-1", "1.5", "x", " 3"]) {
    it(`rejects ${JSON.stringify(bad)} with the abort message`, () => {
      expect(parseMaxSessions(bad)).toEqual({
        ok: false,
        message: `CLAUDE_MAX_SESSIONS='${bad}' is not a positive integer; aborting`,
      });
    });
  }
});

describe("validateConfig", () => {
  const path = "/cfg/repos.json";
  const home = "/home/u";
  const dirs = new Set(["/work/a", "/work/b", "/home/u/proj", "/home/u"]);
  const check = (text: string | null) =>
    validateConfig(text, { path, home, dirExists: (d) => dirs.has(d) });
  const ok = { repo: "org/alpha", dir: "/work/a", sessionPrefix: "a", owner: "me" };
  const cfg = (...entries: unknown[]) => check(JSON.stringify(entries));
  const badEntry = (i: number) => ({
    ok: false,
    exitCode: 1,
    message: `config ${path}: entry ${i} needs string repo, dir, sessionPrefix ([A-Za-z0-9_-]+), owner (and optional string bgFlags, positive integer maxSessions); aborting`,
  });

  it("aborts when the file is missing or unreadable", () => {
    expect(check(null)).toEqual({
      ok: false,
      exitCode: 1,
      message: `config ${path} missing or unreadable; aborting`,
    });
  });

  for (const [label, text] of [
    ["malformed JSON", "{not json"],
    ["an empty file", ""],
    ["an object", '{"repo":"x/y"}'],
  ]) {
    it(`aborts on ${label} as not a JSON array`, () => {
      expect(check(text as string)).toEqual({
        ok: false,
        exitCode: 1,
        message: `config ${path} is not a JSON array; aborting`,
      });
    });
  }

  it("returns the repos with defaults filled in", () => {
    const r = cfg(ok, { ...ok, repo: "org/beta", dir: "/work/b", sessionPrefix: "b", bgFlags: "--x", maxSessions: 2 });
    expect(r).toEqual({
      ok: true,
      repos: [
        { ...ok, bgFlags: "" },
        { repo: "org/beta", dir: "/work/b", sessionPrefix: "b", owner: "me", bgFlags: "--x", maxSessions: 2 },
      ],
    });
  });

  for (const field of ["repo", "dir", "sessionPrefix", "owner"]) {
    it(`reports an entry missing ${field}`, () => {
      const e: Record<string, unknown> = { ...ok };
      delete e[field];
      expect(cfg(ok, e)).toEqual(badEntry(1));
    });
    it(`reports an entry with an empty or non-string ${field}`, () => {
      expect(cfg({ ...ok, [field]: "" })).toEqual(badEntry(0));
      expect(cfg({ ...ok, [field]: 5 })).toEqual(badEntry(0));
    });
  }

  it("reports non-object entries", () => {
    expect(cfg("x")).toEqual(badEntry(0));
    expect(cfg(ok, [ok])).toEqual(badEntry(1));
    expect(cfg(ok, null)).toEqual(badEntry(1));
  });

  it("reports the first bad index", () => {
    expect(cfg(ok, { ...ok, owner: "" }, { ...ok, repo: 1 })).toEqual(badEntry(1));
  });

  for (const prefix of ["../x", "a b", "a.b", "é"]) {
    it(`rejects sessionPrefix ${JSON.stringify(prefix)}`, () => {
      expect(cfg({ ...ok, sessionPrefix: prefix })).toEqual(badEntry(0));
    });
  }

  it("treats bgFlags null or false as absent and rejects other non-strings", () => {
    for (const bgFlags of [null, false]) {
      const r = cfg({ ...ok, bgFlags });
      expect(r.ok && r.repos[0]?.bgFlags).toBe("");
    }
    for (const bgFlags of [0, true, ["--x"]]) {
      expect(cfg({ ...ok, bgFlags })).toEqual(badEntry(0));
    }
  });

  for (const maxSessions of [0, -2, 1.5, "2", null, true]) {
    it(`rejects maxSessions ${JSON.stringify(maxSessions)}`, () => {
      expect(cfg({ ...ok, maxSessions })).toEqual(badEntry(0));
    });
  }

  it("accepts maxSessions written as 1.0", () => {
    const r = check(`[${JSON.stringify(ok).slice(0, -1)},"maxSessions":1.0}]`);
    expect(r.ok && r.repos[0]?.maxSessions).toBe(1);
  });

  it("rejects a duplicate sessionPrefix, case-insensitively, naming the first in sorted order", () => {
    const e = (sessionPrefix: string, repo: string) => ({ ...ok, sessionPrefix, repo });
    expect(cfg(e("zz", "o/1"), e("CW", "o/2"), e("ZZ", "o/3"), e("cw", "o/4"))).toEqual({
      ok: false,
      exitCode: 1,
      message: `config ${path}: duplicate sessionPrefix 'cw' (compared case-insensitively); aborting`,
    });
  });

  for (const repo of ["alpha", "a/b/c", "org/", "/x", "or g/x", "a/b\n"]) {
    it(`rejects repo ${JSON.stringify(repo)}`, () => {
      expect(cfg({ ...ok, repo })).toEqual({
        ok: false,
        exitCode: 1,
        message: `config ${path}: repo '${repo}' is not of the form owner/name; aborting`,
      });
    });
  }

  it("checks each entry's repo then dir, in order", () => {
    const r = cfg({ ...ok, dir: "/missing" }, { ...ok, sessionPrefix: "b", repo: "bad" });
    expect(r).toEqual({
      ok: false,
      exitCode: 1,
      message: `config ${path}: dir '/missing' (repo org/alpha) does not exist; aborting`,
    });
  });

  it("expands ~ before checking dir, keeping the raw dir in the result", () => {
    const r = cfg({ ...ok, dir: "~/proj" }, { ...ok, sessionPrefix: "b", dir: "~" });
    expect(r.ok && r.repos.map((x) => x.dir)).toEqual(["~/proj", "~"]);
    expect(cfg({ ...ok, dir: "~/nope" })).toMatchObject({
      message: `config ${path}: dir '/home/u/nope' (repo org/alpha) does not exist; aborting`,
    });
  });

  it("treats an empty array as nothing to do (exit 0)", () => {
    expect(check("[]")).toEqual({
      ok: false,
      exitCode: 0,
      message: `config ${path} has no repos; nothing to do`,
    });
  });
});

describe("expandHome", () => {
  it("expands ~ and ~/ only", () => {
    expect(expandHome("~/x/y", "/h")).toBe("/h/x/y");
    expect(expandHome("~", "/h")).toBe("/h");
    expect(expandHome("~x", "/h")).toBe("~x");
    expect(expandHome("/a/~/b", "/h")).toBe("/a/~/b");
  });
});

describe("splitFlags / combinedFlags", () => {
  it("splits on spaces and tabs, dropping empties", () => {
    expect(splitFlags("  --a  b\t--c ")).toEqual(["--a", "b", "--c"]);
    expect(splitFlags("")).toEqual([]);
  });

  it("uses the first line only and does not glob", () => {
    expect(splitFlags("--a *\n--b")).toEqual(["--a", "*"]);
    expect(splitFlags("\n--b")).toEqual([]);
  });

  it("puts the defaults first, then CLAUDE_BG_FLAGS, then bgFlags", () => {
    expect(combinedFlags("--permission-mode plan", "--model opus")).toEqual([
      "--model", "sonnet", "--effort", "xhigh", "--permission-mode", "plan", "--model", "opus",
    ]);
    expect(combinedFlags("", "")).toEqual(["--model", "sonnet", "--effort", "xhigh"]);
  });

  it("drops CLAUDE_BG_FLAGS after its first line", () => {
    expect(combinedFlags("--a\n--b", "")).toEqual(["--model", "sonnet", "--effort", "xhigh", "--a"]);
  });
});
