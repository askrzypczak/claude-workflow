// The check phase: judges the sandbox settings, then launches a probe session the way the
// poller launches ticket sessions and reads what it could and could not do. Only a full run
// where everything passes resumes dispatch.
import type { Phase } from "./main.ts";

/** The environment the poller's sessions get when launchd runs dispatch/agent-poller.sh. */
export function pollerEnv(home: string): { HOME: string; PATH: string } {
  void home;
  throw new Error("not implemented");
}

/** The probe's items, in the order the probe script and then the session write them. */
export function probeItems(keys: readonly string[]): string[] {
  void keys;
  throw new Error("not implemented");
}

/** One probe item's outcome. */
export interface ProbeVerdict {
  item: string;
  pass: boolean;
  detail: string;
}

/**
 * The probe result file's text judged item by item: an item passes only with a PASS line and
 * no FAIL line. `finished` is false without the END line.
 */
export function parseProbeResult(
  text: string | undefined,
  items: readonly string[],
): { finished: boolean; verdicts: ProbeVerdict[] } {
  void text;
  void items;
  throw new Error("not implemented");
}

export const check: Phase = {
  name: "check",
  run() {
    throw new Error("not implemented");
  },
};
