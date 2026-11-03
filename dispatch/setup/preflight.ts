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
  void io;
  void into;
  void echo;
  throw new Error("not implemented");
}

/** The list from each phase's reports, keyed by phase name in run order. */
export function findings(byPhase: ReadonlyMap<string, readonly Report[]>, repos: readonly ServedRepo[]): Findings {
  void byPhase;
  void repos;
  throw new Error("not implemented");
}

/** The list as printed; `lead` opens its first line ("Preflight", "Dry run summary"). */
export function findingLines(found: Findings, lead: string): string[] {
  void found;
  void lead;
  throw new Error("not implemented");
}

/** A live run's preflight: `phases` as a dry run through an io that prints nothing, and their list. */
export function preflight(phases: readonly Phase[], ctx: SetupContext): Findings {
  void phases;
  void ctx;
  throw new Error("not implemented");
}
