import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { FAKE_LOGIN, FAKE_REPO, fakeIo, fileWrites, writeCalls } from "./fake-io.ts";
import { servedRepos } from "./repos.ts";

const opts = { clone: "/clone", configPath: "/config/repos.json" };

describe("servedRepos", () => {
  it("reads this repo from an https, ssh or ssh-alias origin", () => {
    for (const origin of [
      `https://github.com/${FAKE_REPO}.git`,
      `https://github.com/${FAKE_REPO}`,
      `git@github.com:${FAKE_REPO}.git`,
      `git@github.com-example-tools:${FAKE_REPO}.git`,
    ]) {
      const { io } = fakeIo({ origin });

      expect(servedRepos(io, opts), origin).toEqual([{ repo: FAKE_REPO }]);
    }
  });

  it("throws on an origin outside github.com", () => {
    const { io } = fakeIo({ origin: `git@example.com:${FAKE_REPO}.git` });

    expect(() => servedRepos(io, opts)).toThrow(Error);
  });

  it("serves only this repo when the config file is missing, and says so", () => {
    const { io, reports } = fakeIo();

    expect(servedRepos(io, opts)).toEqual([{ repo: FAKE_REPO }]);
    expect(reports.filter((r) => r.status === "note")).toHaveLength(1);
  });

  it("adds the config's repos after this one, each once", () => {
    const config = JSON.stringify([
      { repo: "example-owner/example-app", dir: "/home/node/example-app", sessionPrefix: "app", owner: "example-owner" },
      { repo: "Example-Owner/Example-Tools", dir: "/home/node/example-tools", sessionPrefix: "tools", owner: "example-owner" },
    ]);
    const { io } = fakeIo({ files: { [opts.configPath]: config } });

    expect(servedRepos(io, opts)).toEqual([
      { repo: FAKE_REPO },
      { repo: "example-owner/example-app" },
    ]);
  });

  it("accepts a config dir that is the container clone, as /home/node/<name> or ~/<name>", () => {
    const config = JSON.stringify([
      { repo: "example-owner/example-app", dir: "/home/node/example-app", sessionPrefix: "app", owner: "example-owner" },
      { repo: "example-owner/example-site", dir: "~/example-site", sessionPrefix: "site", owner: "example-owner" },
    ]);
    const { io, fileOps } = fakeIo({ files: { [opts.configPath]: config } });

    expect(servedRepos(io, opts)).toEqual([
      { repo: FAKE_REPO },
      { repo: "example-owner/example-app" },
      { repo: "example-owner/example-site" },
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

  describe("with addRepo", () => {
    const NEW = "example-owner/example-app";
    const newEntry = { repo: NEW, dir: "/home/node/example-app", sessionPrefix: "example-app", owner: FAKE_LOGIN };
    /** The arrays each writeFile to the config path wrote, parsed. */
    const written = (ops: ReturnType<typeof fakeIo>["fileOps"]) =>
      fileWrites(ops)
        .filter((o) => o.op === "writeFile" && o.path === opts.configPath)
        .map((o) => JSON.parse(o.text ?? "") as Record<string, unknown>[]);
    /** The sessionPrefix of the one entry written for `addRepo`, with no config file. */
    const prefixFor = (addRepo: string) => {
      const { io, fileOps } = fakeIo();
      servedRepos(io, { ...opts, addRepo });
      const [config] = written(fileOps);
      return config?.[0]?.sessionPrefix;
    };

    it("with addRepo and no config file, servedRepos makes the config's directory and writes one entry (dir /home/node/<name>, the name as sessionPrefix, the gh login as owner) that servedRepos then accepts without addRepo", () => {
      const { io, calls, reports, fileOps, files } = fakeIo();

      expect(servedRepos(io, { ...opts, addRepo: NEW })).toEqual([{ repo: FAKE_REPO }, { repo: NEW }]);
      expect(writeCalls(calls)).toEqual([expect.objectContaining({ cmd: "mkdir", args: ["-p", "/config"] })]);
      const configs = written(fileOps);
      expect(configs).toEqual([[newEntry]]);
      expect(Object.keys(configs[0]![0]!)).toEqual(["repo", "dir", "sessionPrefix", "owner"]);
      expect(reports.some((r) => r.status === "done" && r.text.includes(NEW))).toBe(true);
      expect(reports.filter((r) => r.status === "note")).toEqual([]);

      const again = fakeIo({ files: { [opts.configPath]: files[opts.configPath]! } });
      expect(servedRepos(again.io, opts)).toEqual([{ repo: FAKE_REPO }, { repo: NEW }]);
    });

    it("addRepo appends its entry to an existing config and keeps the other entries with every field as written", () => {
      const other = {
        repo: "example-owner/example-site",
        dir: "~/example-site",
        sessionPrefix: "site",
        owner: "example-owner",
        maxSessions: 2,
        comment: "an unknown field kept as written",
      };
      const { io, calls, fileOps } = fakeIo({ files: { [opts.configPath]: JSON.stringify([other]) } });

      expect(servedRepos(io, { ...opts, addRepo: NEW })).toEqual([
        { repo: FAKE_REPO },
        { repo: "example-owner/example-site" },
        { repo: NEW },
      ]);
      expect(written(fileOps)).toEqual([[other, newEntry]]);
      expect(writeCalls(calls)).toEqual([]);
    });

    it("an addRepo value that is not owner/name is refused and nothing is written", () => {
      const { io, calls, fileOps } = fakeIo();

      expect(() => servedRepos(io, { ...opts, addRepo: "foo" })).toThrow(Error);
      expect(fileWrites(fileOps)).toEqual([]);
      expect(writeCalls(calls)).toEqual([]);
    });

    it("a repo name with dots gets a sessionPrefix with each dot replaced by -", () => {
      expect(prefixFor("example-owner/my.site.io")).toBe("my-site-io");
    });

    it("a repo name starting with . gets a sessionPrefix with no leading - (.github gives github)", () => {
      expect(prefixFor("example-owner/.github")).toBe("github");
    });

    it("addRepo naming a repo the config lists, in any case, writes nothing and reports it as already done", () => {
      const config = JSON.stringify([
        { repo: "Example-Owner/Example-App", dir: "/home/node/Example-App", sessionPrefix: "app", owner: "example-owner" },
      ]);
      const without = fakeIo({ files: { [opts.configPath]: config } });
      const expected = servedRepos(without.io, opts);
      const { io, calls, reports, fileOps } = fakeIo({ files: { [opts.configPath]: config } });

      expect(servedRepos(io, { ...opts, addRepo: NEW })).toEqual(expected);
      expect(fileWrites(fileOps)).toEqual([]);
      expect(writeCalls(calls)).toEqual([]);
      expect(calls.filter((c) => c.cmd === "gh")).toEqual([]);
      expect(reports.filter((r) => r.status === "already")).toHaveLength(1);
    });

    it("addRepo whose sessionPrefix another entry uses, in any case, is refused with a message naming that entry, and nothing is written", () => {
      const config = JSON.stringify([
        { repo: "example-owner/other-app", dir: "/home/node/other-app", sessionPrefix: "Example-App", owner: "example-owner" },
      ]);
      const { io, calls, fileOps } = fakeIo({ files: { [opts.configPath]: config } });

      expect(() => servedRepos(io, { ...opts, addRepo: NEW })).toThrow(/example-owner\/other-app/);
      expect(fileWrites(fileOps)).toEqual([]);
      expect(writeCalls(calls)).toEqual([]);
    });

    it("addRepo with dryRun writes nothing, makes no directory and reports the entry it would write", () => {
      const { io, calls, reports, fileOps } = fakeIo();

      expect(servedRepos(io, { ...opts, addRepo: NEW, dryRun: true })).toEqual([{ repo: FAKE_REPO }, { repo: NEW }]);
      expect(fileWrites(fileOps)).toEqual([]);
      expect(writeCalls(calls)).toEqual([]);
      const would = reports.filter((r) => r.status === "would");
      expect(would).toHaveLength(1);
      expect(would[0]!.text).toContain(NEW);
      expect(would[0]!.text).toContain(JSON.stringify(newEntry));
    });
  });
});
