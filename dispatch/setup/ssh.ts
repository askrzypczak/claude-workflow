// The ssh phase: a deploy key and an SSH host alias per served repo, origin switched to the
// alias once it reaches the repo, and the account key unloaded from ssh-agent.
import type { SetupIo } from "./io.ts";
import type { Phase } from "./main.ts";

/**
 * Absolute paths of the files directly in `sshDir` whose first line is a PEM private-key
 * header, sorted.
 */
export function findPrivateKeys(io: Pick<SetupIo, "listDir" | "readFirstLine">, sshDir: string): string[] {
  void io;
  void sshDir;
  throw new Error("not implemented");
}

export const ssh: Phase = {
  name: "ssh",
  run() {
    throw new Error("not implemented");
  },
};
