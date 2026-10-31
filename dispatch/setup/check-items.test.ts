// The check phase's direct items, run in the container through docker exec on the fake
// SetupIo (fake-io.ts): the firewall, the private keys and the mounts.
//
// Report keywords these tests match on (case-insensitive): each item's `pass` or `fail` line
// names it: "firewall", "ssh-keys", "mounts".
import { describe, expect, it } from "vitest";
import { check, probeItems } from "./check.ts";
import { FAKE_HOME, FAKE_REPO, fakeIo, parseDockerExec } from "./fake-io.ts";
import type { FakeDocker, FakeMount, FakeReport } from "./fake-io.ts";
import type { SetupContext } from "./main.ts";

const CLONE = "/clone";
const FIRST = "/home/node/example-tools";
const HOME_VOLUME: FakeMount = {
  type: "volume",
  name: "claude-workflow-home",
  source: "/var/lib/docker/volumes/claude-workflow-home/_data",
  destination: "/home/node",
};

const pem = (name: string) => `-----BEGIN OPENSSH PRIVATE KEY-----\nFAKE-KEY-BODY-FOR-TESTS-${name}\n-----END OPENSSH PRIVATE KEY-----\n`;
const passing = () => [...probeItems().map((i) => `SETUP-PROBE PASS ${i}: ok`), "SETUP-PROBE END", ""].join("\n");

/** A running, ready container with the repo cloned, its deploy key, a gh login and a passing probe. */
function dockerWorld(overrides: FakeDocker = {}): FakeDocker {
  return {
    container: { state: "running", mounts: [HOME_VOLUME] },
    clones: { [FIRST]: `git@github.com-example-tools:${FAKE_REPO}.git` },
    files: {
      "/home/node/.ssh/deploy-example-tools": pem("deploy-example-tools"),
      "/home/node/.ssh/deploy-example-tools.pub": { text: "ssh-ed25519 AAAAFAKEtools deploy\n", mode: 0o644 },
    },
    ghLogin: "fine-grained",
    probe: passing,
    ...overrides,
  };
}

function run(docker: FakeDocker) {
  const fake = fakeIo({ deployKeys: [FAKE_REPO], docker });
  const ctx: SetupContext = {
    io: fake.io,
    dryRun: false,
    clone: CLONE,
    home: FAKE_HOME,
    repos: [{ repo: FAKE_REPO }],
  };
  return { ...fake, result: check.run(ctx) };
}

const item = (reports: readonly FakeReport[], name: RegExp, status: "pass" | "fail") =>
  reports.filter((r) => r.status === status && name.test(r.text));

describe("check phase items", () => {
  it("the firewall passes only when api.github.com is reached and example.com refused, both through docker exec -u node", () => {
    const passed = run(dockerWorld());
    expect(item(passed.reports, /firewall/i, "pass")).not.toHaveLength(0);
    expect(item(passed.reports, /firewall/i, "fail")).toHaveLength(0);
    const curls = passed.calls.map(parseDockerExec).filter((x) => x?.command[0] === "curl");
    expect(curls.some((x) => x!.command.some((a) => a.startsWith("https://api.github.com")))).toBe(true);
    expect(curls.some((x) => x!.command.some((a) => a.startsWith("https://example.com")))).toBe(true);
    expect(curls.every((x) => x!.user === "node")).toBe(true);
    expect(passed.calls.some((c) => c.cmd === "curl")).toBe(false);

    for (const reach of [["api.github.com", "github.com", "example.com"], ["github.com"]]) {
      const failed = run(dockerWorld({ reach }));
      expect(failed.result, reach.join(",")).toBe("stop");
      expect(item(failed.reports, /firewall/i, "fail"), reach.join(",")).not.toHaveLength(0);
      expect(item(failed.reports, /firewall/i, "pass"), reach.join(",")).toHaveLength(0);
    }
  });

  it("ssh-keys fails on a private key that is not a served repo's deploy key", () => {
    const clean = run(dockerWorld());
    expect(item(clean.reports, /ssh-keys/i, "pass")).not.toHaveLength(0);

    const extra = dockerWorld();
    extra.files = { ...extra.files, "/home/node/.ssh/id_ed25519": pem("id_ed25519") };
    const { result, reports } = run(extra);

    expect(result).toBe("stop");
    const failed = item(reports, /ssh-keys/i, "fail");
    expect(failed).not.toHaveLength(0);
    expect(failed.some((r) => r.text.includes("id_ed25519"))).toBe(true);
  });

  it("the mounts item passes when the only mount is the claude-workflow-home volume at /home/node", () => {
    const { reports } = run(dockerWorld());

    expect(item(reports, /mounts/i, "pass")).not.toHaveLength(0);
    expect(item(reports, /mounts/i, "fail")).toHaveLength(0);
  });

  it("a bind mount or a Docker socket mount fails the mounts item", () => {
    const extras: FakeMount[] = [
      { type: "bind", source: "/srv/example", destination: "/work" },
      { type: "bind", source: "/var/run/docker.sock", destination: "/var/run/docker.sock" },
    ];
    for (const extra of extras) {
      const { result, reports } = run(dockerWorld({ container: { state: "running", mounts: [HOME_VOLUME, extra] } }));

      expect(result, extra.source).toBe("stop");
      expect(item(reports, /mounts/i, "fail"), extra.source).not.toHaveLength(0);
      expect(item(reports, /mounts/i, "pass"), extra.source).toHaveLength(0);
    }
  });
});
