// The check phase's probe result parser.
import { describe, expect, it } from "vitest";
import { parseProbeResult, probeItems } from "./check.ts";

const pass = (item: string) => `SETUP-PROBE PASS ${item}: ok`;
const fail = (item: string) => `SETUP-PROBE FAIL ${item}: refused nothing`;
const END = "SETUP-PROBE END";

describe("parseProbeResult", () => {
  it("a FAIL line fails the check", () => {
    const items = probeItems();
    const failing = items[1]!;
    const lines = items.map((i) => (i === failing ? fail(i) : pass(i)));

    const result = parseProbeResult([...lines, END, ""].join("\n"), items);
    expect(result.finished).toBe(true);
    expect(result.verdicts.find((v) => v.item === failing)?.pass).toBe(false);
    expect(result.verdicts.filter((v) => v.item !== failing).every((v) => v.pass)).toBe(true);

    // A FAIL line beats a PASS line for the same item.
    const both = parseProbeResult([...items.map(pass), fail(failing), END].join("\n"), items);
    expect(both.verdicts.find((v) => v.item === failing)?.pass).toBe(false);
  });

  it("a missing item line fails the check", () => {
    const items = probeItems();
    const absent = items[items.length - 1]!;

    const result = parseProbeResult([...items.filter((i) => i !== absent).map(pass), END].join("\n"), items);
    expect(result.verdicts.map((v) => v.item)).toEqual(items);
    expect(result.verdicts.find((v) => v.item === absent)?.pass).toBe(false);
  });

  it("a result without the END line fails the check as unfinished", () => {
    const items = probeItems();

    expect(parseProbeResult(items.map(pass).join("\n"), items).finished).toBe(false);
    expect(parseProbeResult(undefined, items).finished).toBe(false);
  });

  it("every item PASS followed by END passes", () => {
    const items = probeItems();

    const result = parseProbeResult([...items.map(pass), END, ""].join("\n"), items);
    expect(result.finished).toBe(true);
    expect(result.verdicts.map((v) => v.item)).toEqual(items);
    expect(result.verdicts.every((v) => v.pass)).toBe(true);
  });
});
