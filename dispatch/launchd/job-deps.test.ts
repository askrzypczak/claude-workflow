// The deps step's refusals, on the fake SetupIo's docker world: the host clone's git and the
// container clone's git and npm calls are answered through its `respond` hook.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CONTAINER } from "../setup/docker.ts";
import { FAKE_HOME, fakeIo, parseDockerExec } from "../setup/fake-io.ts";
import type { FakeCall } from "../setup/fake-io.ts";
import type { RunResult } from "../setup/io.ts";
import { deps } from "./job.ts";

/** The container's clone of this repo: the fake host clone's origin is example-owner/example-tools. */
const CLONE_DIR = "/home/node/example-tools";
const SHA = "fedcba9876543210fedcba9876543210fedcba98";

const ok = (stdout = ""): RunResult => ({ status: 0, stdout, stderr: "" });

/** Git and npm answers for a commit that is on origin; `answers` replaces any of them. */
function setup(answers: { status?: RunResult; npm?: RunResult } = {}) {
  const fake = fakeIo({
    docker: {
      container: { state: "running" },
      clones: { [CLONE_DIR]: "git@github.com-example-tools:example-owner/example-tools.git" },
    },
    respond: (call: FakeCall) => {
      if (call.cmd === "git" && call.args.includes("rev-parse")) return ok(`${SHA}\n`);
      const command = parseDockerExec(call)?.command ?? [];
      if (command[0] === "git" && command.includes("status")) return answers.status ?? ok("");
      if (command[0] === "git") return ok();
      if (command[0] === "npm") return answers.npm ?? ok("added 3 packages\n");
      return undefined;
    },
  });
  return { ...fake, ctx: { io: fake.io, clone: "/clone", home: FAKE_HOME } };
}

const inContainer = (calls: readonly FakeCall[]) => calls.map((c) => parseDockerExec(c)?.command ?? []);

let printed: string[];
beforeEach(() => {
  printed = [];
  const keep = (...args: unknown[]) => void printed.push(args.map(String).join(" "));
  vi.spyOn(console, "log").mockImplementation(keep);
  vi.spyOn(console, "error").mockImplementation(keep);
  const write = (chunk: unknown) => (printed.push(String(chunk)), true);
  vi.spyOn(process.stdout, "write").mockImplementation(write as typeof process.stdout.write);
  vi.spyOn(process.stderr, "write").mockImplementation(write as typeof process.stderr.write);
});
afterEach(() => vi.restoreAllMocks());

const output = () => printed.join("\n");

describe("deps", () => {
  it("deps leaves a container clone with local changes as it is and names git status", () => {
    const { ctx, calls } = setup({ status: ok(" M package.json\n") });

    expect(deps(ctx)).toBe(1);
    const commands = inContainer(calls);
    expect(commands.some((c) => c[0] === "git" && c.includes("checkout"))).toBe(false);
    expect(commands.some((c) => c[0] === "npm")).toBe(false);
    expect(output()).toContain("git status");
  });

  it("deps exits 1 when npm ci fails in the container's clone and says how to run it there", () => {
    const { ctx, calls } = setup({ npm: { status: 1, stdout: "", stderr: "npm error example lockfile mismatch\n" } });

    expect(deps(ctx)).toBe(1);
    expect(inContainer(calls).some((c) => c[0] === "git" && c.includes("checkout") && c.includes(SHA))).toBe(true);
    expect(output()).toContain("npm error example lockfile mismatch");
    expect(output()).toMatch(new RegExp(`docker exec -u node -w ${CLONE_DIR} ${CONTAINER} npm ci`));
  });
});
