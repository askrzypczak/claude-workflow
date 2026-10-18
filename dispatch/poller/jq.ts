// Small helpers that read untrusted JSON the way the original jq filters did.

/** `.key` on a value: undefined unless the value is a JSON object. */
export function field(value: unknown, key: string): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return (value as Record<string, unknown>)[key];
}

/** What `jq -r` prints for a value: strings raw, null/missing as "null". */
export function jqRaw(value: unknown): string {
  if (value === undefined || value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

/** jq's `// x`: null, false and missing count as absent. */
export function isAbsent(value: unknown): boolean {
  return value === undefined || value === null || value === false;
}

function typeRank(value: unknown): number {
  if (value === undefined || value === null) return 0;
  if (value === false) return 1;
  if (value === true) return 2;
  if (typeof value === "number") return 3;
  if (typeof value === "string") return 4;
  if (Array.isArray(value)) return 5;
  return 6;
}

/** jq's ordering for scalars (null < false < true < numbers < strings < arrays < objects). */
export function jqCompare(a: unknown, b: unknown): number {
  const ra = typeRank(a);
  const rb = typeRank(b);
  if (ra !== rb) return ra - rb;
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") {
    return a < b ? -1 : a > b ? 1 : 0;
  }
  return 0;
}

/** Label names of an issue or issue row (`[.labels[].name]`). */
export function labelNames(item: unknown): string[] {
  const labels = field(item, "labels");
  if (!Array.isArray(labels)) return [];
  return labels
    .map((l) => field(l, "name"))
    .filter((n): n is string => typeof n === "string");
}

/** `.author.login` as `jq -r` prints it. */
export function authorLogin(item: unknown): string {
  return jqRaw(field(field(item, "author"), "login"));
}
