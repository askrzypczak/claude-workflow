import { pathToFileURL } from "node:url";

/** Associations whose comments count as ticket content. */
export const TRUSTED = ["OWNER", "MEMBER", "COLLABORATOR"] as const;

interface Item {
  author?: { login?: string } | null;
  user?: { login?: string } | null;
  authorAssociation?: unknown;
  author_association?: unknown;
  [key: string]: unknown;
}

export interface FilterResult {
  /** The input with untrusted comments/reviews removed. */
  data: unknown;
  skipped: number;
  skippedAuthors: string[];
}

function isTrusted(item: unknown): boolean {
  if (!item || typeof item !== "object") return false;
  const it = item as Item;
  const assoc = it.authorAssociation ?? it.author_association;
  return typeof assoc === "string" && (TRUSTED as readonly string[]).includes(assoc);
}

function login(item: unknown): string {
  const it = (item ?? {}) as Item;
  return it.author?.login ?? it.user?.login ?? "unknown";
}

/**
 * Keeps only comments/reviews by OWNER, MEMBER or COLLABORATOR. Accepts a gh
 * issue/pr object (filters its `comments` and `reviews` arrays) or a bare
 * array of comments (pages from `--slurp` are flattened one level), or a single
 * comment-like object with its own association (kept or dropped as one item). Fails closed: missing or unknown association is dropped.
 */
export function filterTrusted(input: unknown): FilterResult {
  const authors = new Set<string>();
  let skipped = 0;
  const keep = (list: unknown[]): unknown[] =>
    list.filter((item) => {
      if (isTrusted(item)) return true;
      skipped++;
      authors.add(login(item));
      return false;
    });

  let data: unknown;
  if (Array.isArray(input)) {
    // `gh api --paginate --slurp` yields an array of pages; flatten one level.
    data = keep(input.flatMap((x) => (Array.isArray(x) ? x : [x])));
  } else if (
    input &&
    typeof input === "object" &&
    !("comments" in input) &&
    !("reviews" in input) &&    ("authorAssociation" in input || "author_association" in input)
  ) {
    // A single comment-like object: filter it as one item.
    data = keep([input]);
  } else if (input && typeof input === "object") {
    const out: Record<string, unknown> = { ...(input as object) };
    for (const key of ["comments", "reviews"]) {
      if (Array.isArray(out[key])) out[key] = keep(out[key] as unknown[]);
    }
    data = out;
  } else {
    throw new Error("expected a JSON object or array");
  }
  return { data, skipped, skippedAuthors: [...authors].sort() };
}

/** Output shape: trusted data plus a summary of what was dropped (no bodies). */
export function render(input: unknown): string {
  const { data, skipped, skippedAuthors } = filterTrusted(input);
  const result = Array.isArray(data)
    ? { items: data, skipped, skippedAuthors }
    : { ...(data as object), skipped, skippedAuthors };
  return JSON.stringify(result, null, 2);
}

function main(): void {
  const chunks: Buffer[] = [];
  process.stdin.on("data", (c: Buffer) => chunks.push(c));
  process.stdin.on("end", () => {
    try {
      const input = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      process.stdout.write(render(input) + "\n");
    } catch (e) {
      console.error(`trusted-comments: ${(e as Error).message}`);
      process.exit(1);
    }
  });
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}
