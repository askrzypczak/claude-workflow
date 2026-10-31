// Shapes of the JSON the poller reads: gh and claude output, and its own state files.
// Each is parsed once, at the IO boundary; past it the poller uses plain typed properties.
import { z } from "zod";

const Author = z.object({ login: z.string() });
const Labels = z
  .array(z.object({ name: z.string() }))
  .transform((labels) => labels.map((l) => l.name));

/** `claude agents --json --all`. `startedAt` is epoch milliseconds. */
export const Sessions = z.array(
  z.object({ id: z.string().optional(), name: z.string().optional(), state: z.string(), startedAt: z.number() }),
);
export type Session = z.infer<typeof Sessions>[number];

/** `gh issue list --json number,author,labels` */
export const IssueList = z.array(
  z.object({ number: z.number(), author: Author, labels: Labels }),
);
export type IssueRow = z.infer<typeof IssueList>[number];

/** `gh issue view --json author,labels,state` */
export const Issue = z.object({ state: z.string(), author: Author.optional(), labels: Labels });
export type Issue = z.infer<typeof Issue>;

/** One `statusCheckRollup` row: a CheckRun (`status`, `conclusion`) or a StatusContext (`state`). */
export const Check = z.object({
  status: z.string().nullish(),
  conclusion: z.string().nullish(),
  state: z.string().nullish(),
});
export type Check = z.infer<typeof Check>;

/** `gh pr list --json number,headRefName,headRefOid,mergeable,isCrossRepository,author,labels,statusCheckRollup` */
export const PrList = z.array(
  z.object({
    number: z.number(),
    headRefName: z.string(),
    headRefOid: z.string(),
    mergeable: z.string(),
    isCrossRepository: z.boolean(),
    author: Author,
    labels: Labels,
    statusCheckRollup: z.array(Check),
  }),
);
export type PrRow = z.infer<typeof PrList>[number];

/** `gh pr view --json state,mergeable,statusCheckRollup` */
export const PrStatus = z.object({ state: z.string(), mergeable: z.string(), statusCheckRollup: z.array(Check) });
export type PrStatus = z.infer<typeof PrStatus>;

/** `gh api repos/<repo>/commits/main` */
export const Commit = z.object({ sha: z.string().min(1) });

/**
 * launched.json: `{"<N>": {name, at}, "conflict-<N>": {name, at, pr, mainSha}, "ci-<N>": {name, at, pr}}`,
 * `at` in epoch seconds.
 */
export const Launched = z
  .record(
    z.string().regex(/^(conflict-|ci-)?[0-9]+$/),
    z.object({
      name: z.string(),
      at: z.number(),
      pr: z.string().optional(),
      mainSha: z.string().optional(),
    }),
  )
  .refine(
    (launched) =>
      Object.entries(launched).every(
        ([key, e]) => !(key.startsWith("conflict-") || key.startsWith("ci-")) || e.pr !== undefined,
      ),
    "conflict-N and ci-N entries need a pr",
  );
export type Launched = z.infer<typeof Launched>;

/** conflicts.json: `{"<N>": {pr, mainSha}}`, the last conflict attempt per ticket. */
export const Attempts = z.record(
  z.string().regex(/^[0-9]+$/),
  z.object({ pr: z.string(), mainSha: z.string() }),
);
export type Attempts = z.infer<typeof Attempts>;

/** ci-attempts.json: `{"<pr>": {headSha, count}}`, CI-fix attempts per PR and the head SHA last tried. */
export const CiAttempts = z.record(
  z.string().regex(/^[0-9]+$/),
  z.object({ headSha: z.string(), count: z.number() }),
);
export type CiAttempts = z.infer<typeof CiAttempts>;

/** One repo's state files, read at the start of a run and written back after every change. */
export interface RepoState {
  launched: Launched;
  attempts: Attempts;
  ciAttempts: CiAttempts;
}

function pathText(path: PropertyKey[]): string {
  return path
    .map((p) => (typeof p === "number" ? `[${p}]` : `.${String(p)}`))
    .join("")
    .replace(/^\./, "");
}

/** Parses `text` as JSON matching `schema`; throws an Error naming `what` and each problem. */
export function parseJson<T extends z.ZodType>(schema: T, text: string, what: string): z.output<T> {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (err) {
    throw new Error(`${what}: not valid JSON (${(err as Error).message})`);
  }
  const result = schema.safeParse(data);
  if (!result.success) {
    const problems = result.error.issues.map((i) =>
      i.path.length > 0 ? `${pathText(i.path)}: ${i.message}` : i.message,
    );
    throw new Error(`${what}: ${problems.join("; ")}`);
  }
  return result.data;
}
