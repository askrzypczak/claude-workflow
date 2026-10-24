import { describe, expect, it } from "vitest";
import { expandHome, parseConfig, parseMaxSessions } from "./config.ts";

const ok = { repo: "org/app", dir: "/work/app", sessionPrefix: "app", owner: "me" };
const parse = (value: unknown, dirExists = (_dir: string) => true) =>
  parseConfig(typeof value === "string" ? value : JSON.stringify(value), {
    path: "/cfg.json",
    home: "/home/me",
    dirExists,
  });

describe("parseConfig", () => {
  it("returns typed entries with optional fields and ~ expanded", () => {
    const repos = parse([
      { ...ok, dir: "~/app", maxSessions: 2, extra: "ignored" },
      { ...ok, repo: "org/b.c_d-e", sessionPrefix: "B_c-1", dir: "~" },
    ]);
    expect(repos).toEqual([
      { ...ok, dir: "/home/me/app", maxSessions: 2 },
      { ...ok, repo: "org/b.c_d-e", sessionPrefix: "B_c-1", dir: "/home/me" },
    ]);
  });

  it("accepts an empty array", () => {
    expect(parse([])).toEqual([]);
  });

  it.each([
    ["{not json", /^config \/cfg\.json: not valid JSON/],
    [{ repo: "x/y" }, /: not a JSON array$/],
    [[3], /\[0\]: expected an object/],
  ])("rejects %j", (value, error) => {
    expect(() => parse(value)).toThrow(error);
  });

  it.each(["repo", "dir", "sessionPrefix", "owner"])("requires a non-empty %s", (field) => {
    const missing: Record<string, unknown> = { ...ok };
    delete missing[field];
    const message = `[0].${field}: expected a non-empty string`;
    expect(() => parse([missing])).toThrow(message);
    expect(() => parse([{ ...ok, [field]: "" }])).toThrow(`[0].${field}:`);
  });

  it.each(["alpha", "a/b/c", "org/", "/x", "or g/x"])("rejects repo %j", (repo) => {
    expect(() => parse([{ ...ok, repo }])).toThrow("[0].repo: not of the form owner/name");
  });

  it.each(["../x", "a b", "a.b"])("rejects sessionPrefix %j", (sessionPrefix) => {
    expect(() => parse([{ ...ok, sessionPrefix }])).toThrow("[0].sessionPrefix: expected only letters");
  });

  it.each([0, -2, 1.5, "3", null, true])("rejects maxSessions %j", (maxSessions) => {
    expect(() => parse([{ ...ok, maxSessions }])).toThrow("[0].maxSessions: expected a positive integer");
  });

  it("ignores a leftover bgFlags key of any type", () => {
    const repos = parse([
      { ...ok, bgFlags: "--model opus" },
      { ...ok, sessionPrefix: "b", bgFlags: null },
      { ...ok, sessionPrefix: "c", bgFlags: 3 },
    ]);
    expect(repos).toEqual([ok, { ...ok, sessionPrefix: "b" }, { ...ok, sessionPrefix: "c" }]);
    for (const repo of repos) expect(repo).not.toHaveProperty("bgFlags");
  });

  it("names the entry index and lists every problem", () => {
    expect(() => parse([ok, { ...ok, sessionPrefix: "b", owner: 1, maxSessions: 0 }])).toThrow(
      "[1].owner: expected a non-empty string; [1].maxSessions: expected a positive integer",
    );
  });

  it("rejects a sessionPrefix used twice, compared case-insensitively", () => {
    expect(() => parse([{ ...ok, sessionPrefix: "Cw" }, { ...ok, sessionPrefix: "cW" }])).toThrow(
      "config /cfg.json: duplicate sessionPrefix 'cw' (compared case-insensitively)",
    );
  });

  it("rejects a dir that does not exist, after expanding ~", () => {
    const seen: string[] = [];
    const exists = (dir: string) => {
      seen.push(dir);
      return dir !== "/home/me/gone";
    };
    expect(() => parse([{ ...ok, dir: "~/gone" }], exists)).toThrow(
      "config /cfg.json: dir '/home/me/gone' (repo org/app) does not exist",
    );
    expect(seen).toEqual(["/home/me/gone"]);
  });
});

describe("expandHome", () => {
  it.each([
    ["~", "/h"],
    ["~/x/y", "/h/x/y"],
    ["~x", "~x"],
    ["/abs/~/p", "/abs/~/p"],
  ])("%s -> %s", (dir, expected) => {
    expect(expandHome(dir, "/h")).toBe(expected);
  });
});

describe("parseMaxSessions", () => {
  it("defaults to 10 when unset or empty", () => {
    expect(parseMaxSessions(undefined)).toBe(10);
    expect(parseMaxSessions("")).toBe(10);
  });

  it("parses a positive integer", () => {
    expect(parseMaxSessions("25")).toBe(25);
  });

  it.each(["0", "abc", "-1", "1.5", "01", " 3"])("rejects %j", (raw) => {
    expect(() => parseMaxSessions(raw)).toThrow(`CLAUDE_MAX_SESSIONS='${raw}' is not a positive integer`);
  });
});
