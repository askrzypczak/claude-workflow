// The container phase: the agent container, its image and home volume, and everything a session
// in it needs (deploy keys, clones, git identity, gh login, Claude token, trust, the plugin).
import type { Phase } from "./main.ts";

/** The Claude token's env file, under the home directory. */
export const ENV_FILE = ".config/claude-workflow/claude-agent.env";
/** The label whose value decides whether the container is replaced. */
export const CONFIG_LABEL = "claude-workflow.config";

/** The `docker run` arguments, with the env file and the config label's value. */
export function runArgs(envFile: string, config: string): string[] {
  throw new Error("not implemented");
}

/** The container's ~/.ssh/config: one alias per repo, each naming only that repo's deploy key. */
export function sshConfig(repos: readonly { repo: string }[]): string {
  throw new Error("not implemented");
}

/** ~/.claude.json with onboarding done and each dir trusted; throws on text that is not an object. */
export function seedClaudeJson(text: string | undefined, dirs: readonly string[]): string {
  throw new Error("not implemented");
}

export const container: Phase = {
  name: "container",
  run() {
    throw new Error("not implemented");
  },
};
