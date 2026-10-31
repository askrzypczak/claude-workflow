import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { FAKE_REPO, fakeIo } from "./fake-io.ts";
import { servedRepos } from "./repos.ts";

const opts = { clone: "/clone", configPath: "/config/repos.json", home: "/home/example" };

describe("servedRepos", () => {
  it("reads this repo from an https, ssh or ssh-alias origin", () => {
    for (const origin of [
      `https://github.com/${FAKE_REPO}.git`,
      `https://github.com/${FAKE_REPO}`,
      `git@github.com:${FAKE_REPO}.git`,
      `git@github.com-example-tools:${FAKE_REPO}.git`,
    ]) {
      const { io } = fakeIo({ origin });

      expect(servedRepos(io, opts), origin).toEqual([{ repo: FAKE_REPO, dir: "/clone" }]);
    }
  });

  it("throws on an origin outside github.com", () => {
    const { io } = fakeIo({ origin: `git@example.com:${FAKE_REPO}.git` });

    expect(() => servedRepos(io, opts)).toThrow(Error);
  });

  it("serves only this repo when the config file is missing, and says so", () => {
    const { io, reports } = fakeIo();

    expect(servedRepos(io, opts)).toEqual([{ repo: FAKE_REPO, dir: "/clone" }]);
    expect(reports.filter((r) => r.status === "note")).toHaveLength(1);
  });

  it("adds the config's repos after this one, each once", () => {
    const config = JSON.stringify([
      { repo: "example-owner/example-app", dir: "/home/node/example-app", sessionPrefix: "app", owner: "example-owner" },
      { repo: "Example-Owner/Example-Tools", dir: "/home/node/example-tools", sessionPrefix: "tools", owner: "example-owner" },
    ]);
    const { io } = fakeIo({ files: { [opts.configPath]: config } });

    expect(servedRepos(io, opts)).toEqual([
      { repo: FAKE_REPO, dir: "/clone" },
      { repo: "example-owner/example-app", dir: "/home/node/example-app" },
    ]);
  });

  it("accepts a config dir that is the container clone, as /home/node/<name> or ~/<name>", () => {
    const config = JSON.stringify([
      { repo: "example-owner/example-app", dir: "/home/node/example-app", sessionPrefix: "app", owner: "example-owner" },
      { repo: "example-owner/example-site", dir: "~/example-site", sessionPrefix: "site", owner: "example-owner" },
    ]);
    const { io, fileOps } = fakeIo({ files: { [opts.configPath]: config } });

    expect(servedRepos(io, opts)).toEqual([
      { repo: FAKE_REPO, dir: "/clone" },
      { repo: "example-owner/example-app", dir: "/home/node/example-app" },
      { repo: "example-owner/example-site", dir: "/home/node/example-site" },
    ]);
    // The config's dirs are container paths: nothing on the host is read for them.
    expect(fileOps.filter((op) => op.path.startsWith("/home/node"))).toEqual([]);
  });

  it("refuses a config dir that is not the container clone, naming the dir to use", () => {
    // A directory that exists on the host, so only the container-clone rule can refuse it.
    const config = JSON.stringify([
      { repo: "example-owner/example-app", dir: tmpdir(), sessionPrefix: "app", owner: "example-owner" },
    ]);
    const { io } = fakeIo({ files: { [opts.configPath]: config } });

    expect(() => servedRepos(io, opts)).toThrow(/\/home\/node\/example-app/);
  });
});
