// The repos setup serves: this clone's repo first, then the dispatch config's repos.
import type { SetupIo } from "./io.ts";

export interface ServedRepo {
  /** owner/name */
  repo: string;
  /** The local checkout. */
  dir: string;
}

export function servedRepos(
  io: SetupIo,
  opts: { clone: string; configPath: string; home: string },
): ServedRepo[] {
  throw new Error("not implemented");
}
