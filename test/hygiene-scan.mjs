// Scanner for content that must not appear in a public repo. Pure, no deps.

const AUTHORSHIP_FILES = new Set([
  "LICENSE",
  ".claude-plugin/marketplace.json",
  "plugins/ticket-workflow/.claude-plugin/plugin.json",
]);

const EMAIL_ALLOW = [
  /^noreply@anthropic\.com$/i,
  /@users\.noreply\.github\.com$/i,
  /^git@github\.com$/i,
];

const isPluginMd = (p) => p.startsWith("plugins/") && p.endsWith(".md");

// Each rule: name, regex (global), optional applies(relPath), optional allow(match, line).
export const RULES = [
  { name: "home-path", re: /\/(?:Users|home)\/[A-Za-z0-9._-]+\//g, allow: (m) => m.startsWith("/home/runner/") },
  {
    name: "email",
    re: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
    allow: (m) => EMAIL_ALLOW.some((r) => r.test(m)),
  },
  { name: "token", re: /gh[pousr]_[A-Za-z0-9]{36,}/g },
  { name: "token", re: /github_pat_[A-Za-z0-9_]{20,}/g },
  { name: "token", re: /AKIA[0-9A-Z]{16}/g },
  { name: "token", re: /xox[baprs]-[A-Za-z0-9-]{10,}/g },
  { name: "token", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  { name: "token", re: /sk-[A-Za-z0-9]{20,}/g },
  { name: "private-name", re: /ttrpg/gi },
  { name: "named-person-role", re: /\bTony\b/g, applies: (p) => !AUTHORSHIP_FILES.has(p) },
  { name: "gendered-pronoun", re: /\b(?:he|his|him|himself)\b/gi, applies: isPluginMd },
  {
    name: "private-wording",
    re: /\bprivate\b/gi,
    applies: (p) => p === "README.md" || p === "CLAUDE.md",
  },
];

/** @returns {{rule: string, line: number, match: string}[]} */
export function scanText(text, relPath) {
  const findings = [];
  const lines = text.split("\n");
  for (const rule of RULES) {
    if (rule.applies && !rule.applies(relPath)) continue;
    lines.forEach((line, i) => {
      for (const m of line.matchAll(rule.re)) {
        // For emails, a version/ref like actions/checkout@v4 has no alphabetic TLD, so never matches.
        if (rule.allow?.(m[0], line)) continue;
        findings.push({ rule: rule.name, line: i + 1, match: m[0] });
      }
    });
  }
  return findings;
}
