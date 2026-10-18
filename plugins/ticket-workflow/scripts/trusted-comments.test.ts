import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { filterTrusted, render } from "./trusted-comments.ts";

const script = fileURLToPath(new URL("./trusted-comments.ts", import.meta.url));

const c = (assoc: string | undefined, who = "u", key = "authorAssociation") => ({
  author: { login: who },
  body: `body-of-${who}`,
  ...(assoc === undefined ? {} : { [key]: assoc }),
});

describe("filterTrusted", () => {
  it.each(["OWNER", "MEMBER", "COLLABORATOR"])("keeps %s", (a) => {
    const r = filterTrusted([c(a)]);
    expect(r.data).toHaveLength(1);
    expect(r.skipped).toBe(0);
  });

  it.each([
    "CONTRIBUTOR",
    "FIRST_TIME_CONTRIBUTOR",
    "FIRST_TIMER",
    "NONE",
    "BOGUS",
    undefined,
  ])("drops %s", (a) => {
    const r = filterTrusted([c(a, "evil")]);
    expect(r.data).toEqual([]);
    expect(r.skipped).toBe(1);
    expect(r.skippedAuthors).toEqual(["evil"]);
  });

  it("drops non-string association and non-object items", () => {
    const r = filterTrusted([{ authorAssociation: 5 }, null, "x"]);
    expect(r.data).toEqual([]);
    expect(r.skipped).toBe(3);
  });

  it("accepts the gh api spelling with user.login", () => {
    const keep = { user: { login: "a" }, author_association: "MEMBER" };
    const drop = { user: { login: "b" }, author_association: "NONE" };
    const r = filterTrusted([keep, drop]);
    expect(r.data).toEqual([keep]);
    expect(r.skippedAuthors).toEqual(["b"]);
  });

  it("filters comments and reviews of an issue/pr object, keeping other fields", () => {
    const input = {
      number: 7,
      title: "t",
      body: "issue body",
      labels: [{ name: "ready" }],
      state: "OPEN",
      comments: [c("OWNER", "me"), c("NONE", "x"), c("NONE", "x")],
      reviews: [c("COLLABORATOR", "rev"), c("CONTRIBUTOR", "y")],
    };
    const r = filterTrusted(input);
    const d = r.data as typeof input;
    expect(d.number).toBe(7);
    expect(d.body).toBe("issue body");
    expect(d.labels).toEqual(input.labels);
    expect(d.state).toBe("OPEN");
    expect(d.comments.map((x) => x.author.login)).toEqual(["me"]);
    expect(d.reviews.map((x) => x.author.login)).toEqual(["rev"]);
    expect(r.skipped).toBe(3);
    expect(r.skippedAuthors).toEqual(["x", "y"]);
  });

  it("handles an object without comments/reviews", () => {
    expect(filterTrusted({ number: 1 })).toEqual({
      data: { number: 1 },
      skipped: 0,
      skippedAuthors: [],
    });
  });

  it("drops an untrusted single comment object and counts it", () => {
    const r = filterTrusted(c("NONE", "solo"));
    expect(r.data).toEqual([]);
    expect(r.skipped).toBe(1);
    expect(r.skippedAuthors).toEqual(["solo"]);
  });

  it("keeps a trusted single comment object (both spellings)", () => {
    const a = c("OWNER", "o");
    const b = { user: { login: "m" }, author_association: "MEMBER" };
    expect(filterTrusted(a).data).toEqual([a]);
    expect(filterTrusted(b).data).toEqual([b]);
  });

  it("flattens paginated --slurp pages before filtering", () => {
    const r = filterTrusted([
      [c("OWNER", "a"), c("NONE", "x")],
      [c("MEMBER", "b"), c("NONE", "y")],
    ]);
    expect((r.data as { author: { login: string } }[]).map((i) => i.author.login)).toEqual(["a", "b"]);
    expect(r.skipped).toBe(2);
    expect(r.skippedAuthors).toEqual(["x", "y"]);
  });

  it("drops an untrusted item nested in a page", () => {
    expect(filterTrusted([[c(undefined, "z")]]).data).toEqual([]);
  });

  it("fails closed on comment-like fields it cannot filter", () => {
    const evil = { body: "inject", authorAssociation: "NONE" };
    expect(() => filterTrusted({ latestReviews: [evil] })).toThrow(/latestReviews/);
    expect(() => filterTrusted({ reviewThreads: [] })).toThrow(/reviewThreads/);
    expect(() => filterTrusted({ comments: { nodes: [evil] } })).toThrow(/comments/);
    expect(() => filterTrusted({ reviews: "x" })).toThrow(/reviews/);
  });

  it("rejects scalars", () => {
    expect(() => filterTrusted("x")).toThrow();
    expect(() => filterTrusted(null)).toThrow();
  });
});

describe("render", () => {
  it("never includes skipped bodies or untrusted content", () => {
    const out = render({
      comments: [c("NONE", "attacker"), c("OWNER", "owner")],
    });
    expect(out).not.toContain("body-of-attacker");
    expect(out).toContain("body-of-owner");
    expect(JSON.parse(out).skippedAuthors).toEqual(["attacker"]);
    expect(JSON.parse(out).skipped).toBe(1);
  });

  it("wraps a bare array as items", () => {
    const o = JSON.parse(render([c("MEMBER", "m"), c("NONE", "n")]));
    expect(o.items).toHaveLength(1);
    expect(o.skipped).toBe(1);
  });
});

describe("CLI", () => {
  const run = (input: string) =>
    spawnSync("node", [script], { input, encoding: "utf8" });

  it("reads stdin and prints filtered JSON", () => {
    const r = run(JSON.stringify({ comments: [c("OWNER", "o"), c("NONE", "n")] }));
    expect(r.status).toBe(0);
    const o = JSON.parse(r.stdout);
    expect(o.comments).toHaveLength(1);
    expect(o.skipped).toBe(1);
    expect(r.stdout).not.toContain("body-of-n");
  });

  it("exits non-zero with empty stdout on an unfiltered field", () => {
    const r = run(JSON.stringify({ latestReviews: [c("NONE", "n")] }));
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe("");
    expect(r.stderr).toContain("latestReviews");
  });

  it("exits non-zero on invalid JSON", () => {
    const r = run("not json");
    expect(r.status).not.toBe(0);
    expect(r.stdout).toBe("");
  });
});
