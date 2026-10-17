import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (rel: string) =>
  readFileSync(new URL(rel, import.meta.url), "utf8");

describe("ticket-labels workflow", () => {
  it("embeds ticket-labels.ts verbatim", () => {
    const lines = read("../../../.github/workflows/ticket-labels.yml").split(
      "\n",
    );
    const start = lines.findIndex((l) => l.includes("<<'TICKET_LABELS_EOF'"));
    const end = lines.findIndex((l) => l.trim() === "TICKET_LABELS_EOF");
    expect(start).toBeGreaterThanOrEqual(0);
    expect(end).toBeGreaterThan(start);
    const indent = lines[start]!.match(/^ */)![0];
    const embedded =
      lines
        .slice(start + 1, end)
        .map((l) => (l.startsWith(indent) ? l.slice(indent.length) : l))
        .join("\n") + "\n";
    expect(
      embedded === read("./ticket-labels.ts"),
      "Embedded script in .github/workflows/ticket-labels.yml differs from ticket-labels.ts: re-copy the script into the workflow",
    ).toBe(true);
  });
});
