import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export const STATE_LABELS = [
  "ready",
  "in-progress",
  "needs-review",
  "blocked",
] as const;

export interface BlockedIssue {
  number: number;
  body: string;
}

/** All `#M` references on every line containing `Blocked by ...` (case-insensitive). */
export function parseBlockers(body: string): number[] {
  const found = new Set<number>();
  for (const line of body.split(/\r?\n/)) {
    const match = /blocked\s+by\b(.*)/i.exec(line);
    if (!match) continue;
    for (const ref of (match[1] ?? "").matchAll(/(?<![\w/])#(\d+)/g)) {
      found.add(Number(ref[1]));
    }
  }
  return [...found];
}

/**
 * Open `blocked` issues that should lose the label: they reference at least one
 * blocker and every blocker is closed (the just-closed issue counts as closed).
 */
export function planUnblocks(opts: {
  closed: number;
  openBlocked: BlockedIssue[];
  isClosed: (n: number) => boolean;
}): number[] {
  const result: number[] = [];
  for (const issue of opts.openBlocked) {
    const blockers = parseBlockers(issue.body);
    if (!blockers.includes(opts.closed)) continue;
    if (blockers.every((n) => n === opts.closed || opts.isClosed(n))) {
      result.push(issue.number);
    }
  }
  return result;
}

/** Runs `gh` with the given args and returns stdout. */
export type GhRunner = (args: string[]) => string;

export const defaultGh: GhRunner = (args) =>
  execFileSync("gh", args, { encoding: "utf8" });

export function cleanupClosedIssue(issue: number, gh: GhRunner): void {
  const view = JSON.parse(
    gh(["issue", "view", String(issue), "--json", "labels"]),
  ) as {
    labels: { name: string }[];
  };
  const present = new Set(view.labels.map((l) => l.name));
  const toRemove = STATE_LABELS.filter((l) => present.has(l));
  if (toRemove.length > 0) {
    gh(["issue", "edit", String(issue), "--remove-label", toRemove.join(",")]);
  }

  const openBlocked = JSON.parse(
    gh([
      "issue",
      "list",
      "--state",
      "open",
      "--label",
      "blocked",
      "--limit",
      "200",
      "--json",
      "number,body",
    ]),
  ) as BlockedIssue[];

  const stateCache = new Map<number, boolean>();
  const isClosed = (n: number): boolean => {
    let closed = stateCache.get(n);
    if (closed === undefined) {
      try {
        const v = JSON.parse(
          gh(["issue", "view", String(n), "--json", "state"]),
        ) as {
          state: string;
        };
        closed = v.state === "CLOSED";
      } catch (err) {
        console.warn(`could not look up blocker #${n}; treating as open`, err);
        closed = false;
      }
      stateCache.set(n, closed);
    }
    return closed;
  };

  for (const n of planUnblocks({ closed: issue, openBlocked, isClosed })) {
    gh(["issue", "edit", String(n), "--remove-label", "blocked"]);
  }
}

function main(): void {
  const issue = Number(process.argv[2]);
  if (!Number.isInteger(issue) || issue <= 0) {
    console.error("usage: node scripts/ticket-labels.ts <issue-number>");
    process.exit(2);
  }
  cleanupClosedIssue(issue, defaultGh);
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
