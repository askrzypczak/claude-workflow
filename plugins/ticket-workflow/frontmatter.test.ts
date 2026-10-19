import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const root = dirname(fileURLToPath(import.meta.url));

const files = [
  ...readdirSync(join(root, "skills"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => `skills/${d.name}/SKILL.md`),
  ...readdirSync(join(root, "agents"))
    .filter((f) => f.endsWith(".md"))
    .map((f) => `agents/${f}`),
];

const frontmatter = (file: string) => {
  const m = readFileSync(join(root, file), "utf8").match(/^---\n([\s\S]*?)\n---\n/);
  if (!m) throw new Error(`${file} has no frontmatter block`);
  return m[1];
};

// Read the description line by hand, so a plain scalar cut at " #" shows up as a mismatch.
const rawDescription = (block: string) => {
  const line = block.split("\n").find((l) => l.startsWith("description:")) ?? "";
  const raw = line.slice("description:".length).trim();
  if (/^'.*'$/.test(raw)) return raw.slice(1, -1).replaceAll("''", "'");
  if (/^".*"$/.test(raw)) return raw.slice(1, -1);
  return raw;
};

describe("skill and agent frontmatter", () => {
  it.each(files)("%s parses with a non-empty name and description", (file) => {
    const fm = parse(frontmatter(file));
    expect(fm.name).toMatch(/\S/);
    expect(fm.description).toMatch(/\S/);
  });

  it.each(files)("%s description matches its full raw value", (file) => {
    const block = frontmatter(file);
    expect(parse(block).description).toBe(rawDescription(block));
  });
});
