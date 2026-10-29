// The credentials phase: pause dispatch, the restrict-updates ruleset, the fine-grained
// token, the pre-swap test, the login swap, the stray-token scan and the after-swap checks.
import type { RunResult } from "./io.ts";
import type { Phase } from "./main.ts";

export const credentials: Phase = {
  name: "credentials",
  run() {
    throw new Error("not implemented");
  },
};

/** `gh pr checks`: exit 0, 1 or 8 and an output row whose first tab-separated field is `test`. */
export function judgePrChecks(result: RunResult): boolean {
  throw new Error("not implemented");
}

/** `gh pr view --json statusCheckRollup`: exit 0 and a CheckRun named `test` in the rollup. */
export function judgeRollup(result: RunResult): boolean {
  throw new Error("not implemented");
}
