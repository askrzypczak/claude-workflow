import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { scanText } from "./hygiene-scan.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const rules = (text, path = "README.md") => scanText(text, path).map((f) => f.rule);

test("home-path: flags home directories, allows CI runner and placeholders", () => {
  assert.deepEqual(rules("cd /Users/x/y"), ["home-path"]);
  assert.deepEqual(rules("cd /home/alice/code"), ["home-path"]);
  assert.deepEqual(rules("cd /home/runner/work"), []);
  assert.deepEqual(rules("add /path/to/claude-workflow"), []);
});

test("email: flags personal emails, allows noreply, ssh and version refs", () => {
  assert.deepEqual(rules("me at foo@bar.com"), ["email"]);
  assert.deepEqual(rules("Co-Authored-By: C <noreply@anthropic.com>"), []);
  assert.deepEqual(rules("1234+u@users.noreply.github.com"), []);
  assert.deepEqual(rules("git clone git@github.com:o/r.git"), []);
  assert.deepEqual(rules("uses: actions/checkout@v4"), []);
  assert.deepEqual(rules("npm i pkg@1.2.3"), []);
  assert.deepEqual(rules("calls ticket-labels.yml@main"), []);
});

test("token: flags credential shapes", () => {
  const alnum = "a1B2".repeat(9);
  assert.deepEqual(rules(`ghp_${alnum}`), ["token"]);
  assert.deepEqual(rules("github_pat_" + "A".repeat(22)), ["token"]);
  assert.deepEqual(rules("AKIA" + "A1".repeat(8)), ["token"]);
  assert.deepEqual(rules("xoxb-1234567890-abc"), ["token"]);
  assert.deepEqual(rules("-----BEGIN RSA PRIVATE KEY-----", "x.txt"), ["token"]);
  assert.deepEqual(rules("sk-" + "a".repeat(24)), ["token"]);
  assert.deepEqual(rules("ghp_short and sk-short"), []);
});

test("private-name: flags ttrpg in any case", () => {
  assert.deepEqual(rules("see TTRPG-agents"), ["private-name"]);
  assert.deepEqual(rules("see example-app"), []);
});

test("named-person-role: flags Tony except in authorship files", () => {
  assert.deepEqual(rules("ask Tony", "plugins/x/SKILL.md"), ["named-person-role"]);
  assert.deepEqual(rules("Copyright Tony Skrzypczak", "LICENSE"), []);
  assert.deepEqual(rules('"name": "Tony"', ".claude-plugin/marketplace.json"), []);
  assert.deepEqual(rules('"name": "Tony"', "plugins/ticket-workflow/.claude-plugin/plugin.json"), []);
  assert.deepEqual(rules("Tonys and Antony", "README.md"), []);
});

test("gendered-pronoun: only in plugin markdown", () => {
  assert.deepEqual(rules("if he declines", "plugins/a/SKILL.md"), ["gendered-pronoun"]);
  assert.deepEqual(rules("His feedback", "plugins/a/agents/b.md"), ["gendered-pronoun"]);
  assert.deepEqual(rules("if they decline, the help", "plugins/a/SKILL.md"), []);
  assert.deepEqual(rules("if he declines", "README.md"), []);
});

test("private-wording: only README/CLAUDE.md", () => {
  assert.deepEqual(rules("Private marketplace", "README.md"), ["private-wording"]);
  assert.deepEqual(rules("a private repo", "CLAUDE.md"), ["private-wording"]);
  assert.deepEqual(rules("a private repo", "dispatch/README.md"), []);
  assert.deepEqual(rules("- **Public repo**: no private names", "CLAUDE.md"), ["private-wording"]);
  assert.deepEqual(rules("- **Public repo**: no names of unpublished repos or projects", "CLAUDE.md"), []);
});

test("repo scan: no tracked file has public-hygiene findings", () => {
  // Tracked plus new-but-unignored files, so the check also works before the first commit.
  const files = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
    cwd: ROOT,
    encoding: "utf8",
  })
    .split("\n")
    .filter(Boolean)
    // The scanner and this test contain deliberately matching samples.
    .filter((f) => f !== "test/hygiene-scan.mjs" && f !== "test/public-hygiene.test.mjs");
  const problems = [];
  for (const f of files) {
    const path = join(ROOT, f);
    if (!existsSync(path)) continue;
    const buf = readFileSync(path);
    if (buf.includes(0)) continue;
    for (const x of scanText(buf.toString("utf8"), f)) problems.push(`${f}:${x.line} ${x.rule} ${x.match}`);
  }
  assert.deepEqual(problems, [], `hygiene findings:\n${problems.join("\n")}`);
});

test("LICENSE is MIT and plugin.json declares it", () => {
  assert.ok(existsSync(join(ROOT, "LICENSE")), "LICENSE missing");
  assert.equal(readFileSync(join(ROOT, "LICENSE"), "utf8").split("\n")[0], "MIT License");
  const plugin = JSON.parse(readFileSync(join(ROOT, "plugins/ticket-workflow/.claude-plugin/plugin.json"), "utf8"));
  assert.equal(plugin.license, "MIT");
});

for (const skill of ["address-feedback", "work-ticket"]) {
  test(`${skill} SKILL.md frontmatter is valid and impersonal`, () => {
    const text = readFileSync(join(ROOT, `plugins/ticket-workflow/skills/${skill}/SKILL.md`), "utf8");
    assert.ok(text.startsWith("---\n"), "must start with ---");
    const fm = text.slice(4, text.indexOf("\n---", 4));
    assert.match(fm, /^name: \S+/m);
    const desc = fm.match(/^description: (.+)$/m);
    assert.ok(desc && desc[1].trim().length > 0, "description must be non-empty");
    assert.doesNotMatch(desc[1], /Tony/);
  });
}
