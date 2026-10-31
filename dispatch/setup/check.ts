// The check phase: checks the agent container directly through docker exec (firewall, keys,
// gh, mounts), then starts a probe session in it and reads what the session could and could
// not do. Only a full run where everything passes resumes dispatch.
import type { Phase } from "./main.ts";

/** The prefix of every probe result line; the END line closes the result. */
const PREFIX = "SANDBOX-PROBE";
const END = `${PREFIX} END`;
const RESULT_LINE = /^SANDBOX-PROBE (PASS|FAIL) (.*)$/;

/** The probe session's items, in the order the session writes them. */
export function probeItems(): string[] {
  throw new Error("not implemented");
}

/** One probe item's outcome. */
export interface ProbeVerdict {
  item: string;
  pass: boolean;
  detail: string;
}

/** Whether `text` holds the END line. */
const isFinished = (text: string) => text.split("\n").some((line) => line.trimEnd() === END);

/**
 * The probe result file's text judged item by item: an item passes only with a PASS line and
 * no FAIL line. `finished` is false without the END line.
 */
export function parseProbeResult(
  text: string | undefined,
  items: readonly string[],
): { finished: boolean; verdicts: ProbeVerdict[] } {
  const seen = new Map<string, { pass?: string; fail?: string }>();
  for (const line of (text ?? "").split("\n")) {
    const m = RESULT_LINE.exec(line.trimEnd());
    if (!m) continue;
    const status = m[1];
    const rest = m[2] ?? "";
    // Item names are compared exactly ("<item>:", then the end or a space), so a key path
    // holding a colon still names its item; the longest match wins.
    const item = items
      .filter((i) => rest === `${i}:` || rest.startsWith(`${i}: `))
      .reduce<string | undefined>((best, i) => (best === undefined || i.length > best.length ? i : best), undefined);
    if (item === undefined) continue;
    const detail = rest.slice(item.length + 1).trim();
    const entry = seen.get(item) ?? {};
    if (status === "FAIL") entry.fail ??= detail;
    else entry.pass ??= detail;
    seen.set(item, entry);
  }
  const verdicts = items.map((item): ProbeVerdict => {
    const entry = seen.get(item);
    if (entry?.fail !== undefined) return { item, pass: false, detail: entry.fail };
    if (entry?.pass !== undefined) return { item, pass: true, detail: entry.pass };
    return { item, pass: false, detail: "the result has no line for this item" };
  });
  return { finished: text !== undefined && isFinished(text), verdicts };
}

export const check: Phase = {
  name: "check",
  run() {
    throw new Error("not implemented");
  },
};
