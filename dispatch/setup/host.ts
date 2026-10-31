// The host phase: merges host-settings.json (CLAUDE_CODE_ENABLE_CFC=0 and the deny rules) into
// ~/.claude/settings.json, after a backup. Needs no docker.
import type { Phase } from "./main.ts";

/** The settings this phase merges, from host-settings.json. */
export function hostSettings(): Record<string, unknown> {
  throw new Error("not implemented");
}

export const host: Phase = {
  name: "host",
  run() {
    throw new Error("not implemented");
  },
};
