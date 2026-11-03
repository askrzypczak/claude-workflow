// What setup still needs before it can pass, read from a dry run of the phases: a live run
// lists it before any change (and stops when anything is to do), and a dry run ends with it.
import type { SetupIo, StepStatus } from "./io.ts";
import type { Phase, SetupContext } from "./main.ts";
import type { ServedRepo } from "./repos.ts";

/** One line a phase reported. */
export interface Report { status: StepStatus; text: string }

/** One entry of the list: the served repo it is about (undefined: this machine), and its text as the phase reported it. */
export interface Finding { repo: string | undefined; text: string }

/** `todo`: what must be done before setup can pass; `manual`: the steps the run asks for when it reaches them. */
export interface Findings { todo: Finding[]; manual: Finding[] }

/** `io`, with report() appending each line to `into` and passing it on to `io` only when `echo`. */
export function recordingIo(io: SetupIo, into: Report[], echo: boolean): SetupIo {
  return {
    ...io,
    report(status, text) {
      into.push({ status, text });
      if (echo) io.report(status, text);
    },
  };
}

/**
 * A live session's to-do. It stays out of the list: the live run pauses dispatch first and
 * then stops on it in its phase, so the poller cannot start another session before the rerun.
 */
const LIVE_SESSION = /: stop it (with \S.* stop .+|from \S.*)$/;

/** The page a container dry run names for a repo's deploy key. */
const KEYS_PAGE = /https:\/\/github\.com\/([^/\s]+\/[^/\s]+)\/settings\/keys\/new/;

const deployKey = (repo: string) =>
  `${repo}: the deploy key: when the run asks, add it on https://github.com/${repo}/settings/keys/new with "Allow write access" ticked (the run creates the key in the container, copies it and opens that page)`;

/** The list from each phase's reports, keyed by phase name in run order. */
export function findings(byPhase: ReadonlyMap<string, readonly Report[]>, repos: readonly ServedRepo[]): Findings {
  const withCredentials = byPhase.has("credentials");
  const withContainer = byPhase.has("container");
  const owner = (text: string) => repos.find((r) => text.startsWith(`${r.repo}: `))?.repo;
  const todo: Finding[] = [];
  const manual: Finding[] = [];
  const add = (into: Finding[], text: string) => {
    if (!into.some((f) => f.text === text)) into.push({ repo: owner(text), text });
  };
  for (const [phase, reports] of byPhase) {
    for (const { status, text } of reports) {
      // A failed check is listed with the to-dos: a to-do may point to it ("failed (above)").
      if (status === "todo" || status === "fail") {
        if (LIVE_SESSION.test(text)) continue;
        // The credentials phase checks protect-main first, and creates it under an admin login.
        if (phase === "container" && withCredentials && text.includes("protect-main")) continue;
        // The check reads the container that the container phase builds, starts, keys and clones.
        if (phase === "check" && withContainer) continue;
        add(todo, text);
      } else if (status === "would" && phase === "container") {
        const page = KEYS_PAGE.exec(text);
        if (page !== null) add(manual, deployKey(page[1]!));
      }
    }
  }
  // Served order, then this machine; a stable sort keeps each group's items in reported order.
  const rank = (f: Finding) => (f.repo === undefined ? repos.length : repos.findIndex((r) => r.repo === f.repo));
  const byRepo = (a: Finding, b: Finding) => rank(a) - rank(b);
  return { todo: todo.sort(byRepo), manual: manual.sort(byRepo) };
}

/** `found` under a heading per repo, then this machine, in the order given. */
function grouped(found: readonly Finding[]): string[] {
  const lines: string[] = [];
  let heading: string | undefined;
  for (const f of found) {
    const next = f.repo === undefined ? "this machine:" : `${f.repo}:`;
    if (next !== heading) lines.push(next);
    heading = next;
    lines.push(`  - ${f.repo === undefined ? f.text : f.text.slice(f.repo.length + 2)}`);
  }
  return lines;
}

/** The list as printed; `lead` opens its first line ("Preflight", "Dry run summary"). */
export function findingLines(found: Findings, lead: string): string[] {
  const lines =
    found.todo.length === 0
      ? [`${lead}: nothing to do before setup can pass.`]
      : [`${lead}: ${found.todo.length} to do before setup can pass:`, ...grouped(found.todo)];
  if (found.manual.length > 0) {
    lines.push(`${found.manual.length} step(s) the run asks for when it reaches them:`, ...grouped(found.manual));
  }
  return lines;
}

/** A live run's preflight: `phases` as a dry run through an io that prints nothing, and their list. */
export function preflight(phases: readonly Phase[], ctx: SetupContext): Findings {
  const withContainer = phases.some((p) => p.name === "container");
  const byPhase = new Map<string, Report[]>();
  for (const phase of phases) {
    // The check reads the container this run builds, so its lines would be left out anyway.
    if (phase.name === "check" && withContainer) continue;
    const reports: Report[] = [];
    byPhase.set(phase.name, reports);
    phase.run({ ...ctx, dryRun: true, io: recordingIo(ctx.io, reports, false) });
  }
  return findings(byPhase, ctx.repos);
}
