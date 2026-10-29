// The sandbox phase: checks the installed ticket-workflow plugin knows `--no-track`, then
// merges the sandbox settings (docs/sandboxing.md, Settings) into ~/.claude/settings.json,
// denying every private key in ~/.ssh, and writes the managed settings copy through sudo.
import type { Phase } from "./main.ts";

/** Where macOS Claude Code reads managed settings from. */
export const MANAGED_SETTINGS = "/Library/Application Support/ClaudeCode/managed-settings.json";

/**
 * The settings template plus, for each key, its `credentials.files` deny entry and its
 * `Read` and `Edit` rules. Keys are absolute paths under `home`, written as `~/...`.
 */
export function sandboxSettings(keys: readonly string[], home: string): Record<string, unknown> {
  throw new Error("not implemented");
}

/** One line per expected setting `settings` lacks; empty when it has them all. */
export function missingSandboxSettings(settings: unknown, keys: readonly string[], home: string): string[] {
  throw new Error("not implemented");
}

export const sandbox: Phase = {
  name: "sandbox",
  run() {
    throw new Error("not implemented");
  },
};
