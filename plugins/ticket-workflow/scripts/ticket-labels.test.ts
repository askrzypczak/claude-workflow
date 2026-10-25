import { describe, expect, it, vi } from "vitest";
import {
  cleanupClosedIssue,
  parseBlockers,
  type GhRunner,
} from "./ticket-labels.ts";

describe("parseBlockers", () => {
  it("parses a single ref", () => {
    expect(parseBlockers("Blocked by #3")).toEqual([3]);
  });
  it("parses a comma list", () => {
    expect(parseBlockers("Blocked by #3, #5")).toEqual([3, 5]);
  });
  it("parses an 'and' list", () => {
    expect(parseBlockers("Blocked by #3 and #5")).toEqual([3, 5]);
  });
  it("parses multiple lines", () => {
    expect(parseBlockers("intro\nBlocked by #3\nmore\nBlocked by #7")).toEqual([
      3, 7,
    ]);
  });
  it("is case-insensitive", () => {
    expect(parseBlockers("blocked BY #4")).toEqual([4]);
  });
  it("ignores cross-repo refs", () => {
    expect(parseBlockers("Blocked by other/repo#5, #6")).toEqual([6]);
  });
  it("returns empty when no match", () => {
    expect(parseBlockers("nothing here")).toEqual([]);
  });
  it("ignores Closes and plain refs", () => {
    expect(parseBlockers("Closes #9\nSee #2\nBlocked by #3")).toEqual([3]);
  });
});

interface FakeIssue {
  labels: string[];
  state: "OPEN" | "CLOSED";
  body: string;
}

function fake(issues: Record<number, FakeIssue>) {
  const edits: { issue: number; labels: string[] }[] = [];
  const gh: GhRunner = (args) => {
    if (args[0] === "issue" && args[1] === "view") {
      const i = issues[Number(args[2])]!;
      return JSON.stringify({
        labels: i.labels.map((name) => ({ name })),
        state: i.state,
      });
    }
    if (args[0] === "issue" && args[1] === "list") {
      return JSON.stringify(
        Object.entries(issues)
          .filter(([, i]) => i.state === "OPEN" && i.labels.includes("blocked"))
          .map(([n, i]) => ({ number: Number(n), body: i.body })),
      );
    }
    if (args[0] === "issue" && args[1] === "edit") {
      expect(args[3]).toBe("--remove-label");
      edits.push({ issue: Number(args[2]), labels: args[4]!.split(",") });
      return "";
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  return { gh, edits };
}

const closed = (labels: string[] = []): FakeIssue => ({
  labels,
  state: "CLOSED",
  body: "",
});
const dep = (body: string): FakeIssue => ({
  labels: ["blocked"],
  state: "OPEN",
  body,
});

describe("cleanupClosedIssue", () => {
  it("removes only the state labels present on the closed issue", () => {
    const { gh, edits } = fake({
      1: closed(["in-progress", "needs-review", "feature"]),
    });
    cleanupClosedIssue(1, gh);
    expect(edits).toEqual([
      { issue: 1, labels: ["in-progress", "needs-review"] },
    ]);
  });

  it("removes orchestrate-epic-run from the closed issue along with its state labels", () => {
    const { gh, edits } = fake({
      1: closed(["in-progress", "orchestrate-epic-run", "feature"]),
    });
    cleanupClosedIssue(1, gh);
    expect(edits).toHaveLength(1);
    expect(edits[0]!.issue).toBe(1);
    expect([...edits[0]!.labels].sort()).toEqual(["in-progress", "orchestrate-epic-run"]);
  });

  it("does nothing when the closed issue has no state labels", () => {
    const { gh, edits } = fake({ 1: closed(["bug"]) });
    cleanupClosedIssue(1, gh);
    expect(edits).toEqual([]);
  });

  it("unblocks a dependent whose sole blocker closed", () => {
    const { gh, edits } = fake({ 1: closed(), 2: dep("Blocked by #1") });
    cleanupClosedIssue(1, gh);
    expect(edits).toEqual([{ issue: 2, labels: ["blocked"] }]);
  });

  it("keeps blocked when another blocker is still open", () => {
    const { gh, edits } = fake({
      1: closed(),
      3: { labels: [], state: "OPEN", body: "" },
      2: dep("Blocked by #1, #3"),
    });
    cleanupClosedIssue(1, gh);
    expect(edits).toEqual([]);
  });

  it("unblocks when all multiple blockers are closed", () => {
    const { gh, edits } = fake({
      1: closed(),
      3: closed(),
      2: dep("Blocked by #1 and #3"),
    });
    cleanupClosedIssue(1, gh);
    expect(edits).toEqual([{ issue: 2, labels: ["blocked"] }]);
  });

  it("leaves blocked issues that do not reference the closed one", () => {
    const { gh, edits } = fake({
      1: closed(),
      3: closed(),
      2: dep("Blocked by #3"),
    });
    cleanupClosedIssue(1, gh);
    expect(edits).toEqual([]);
  });

  it("treats a failed blocker lookup as open and still unblocks others", () => {
    const { gh, edits } = fake({
      1: closed(),
      2: dep("Blocked by #1, #99"),
      3: dep("Blocked by #1"),
    });
    const flaky: GhRunner = (args) => {
      if (args[1] === "view" && args[2] === "99") throw new Error("boom");
      return gh(args);
    };
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    cleanupClosedIssue(1, flaky);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
    expect(edits).toEqual([{ issue: 3, labels: ["blocked"] }]);
  });

  it("never adds ready", () => {
    const { gh, edits } = fake({
      1: closed(["ready"]),
      2: dep("Blocked by #1"),
    });
    cleanupClosedIssue(1, gh);
    // Every gh edit is a --remove-label (asserted in the fake); dependent only loses blocked.
    expect(edits).toEqual([
      { issue: 1, labels: ["ready"] },
      { issue: 2, labels: ["blocked"] },
    ]);
  });
});
