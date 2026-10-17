# claude-workflow

Claude Code plugin marketplace (`askrzypczak-plugins`) holding the `ticket-workflow` plugin. See README.md for contents and install.

## Conventions
- **Bump the version in every PR that changes the plugin**: `version` in `plugins/ticket-workflow/.claude-plugin/plugin.json`, in the same commit. Patch for wording or doc fixes, minor for behaviour changes. Claude Code updates installed plugins by comparing this version, so an unbumped merge may never reach agent sessions. `marketplace.json` has no version.
- Keep README.md's Workflow list in step with `skills/work-ticket/SKILL.md`.
- Validate with `claude plugin validate .`; self-test grg with `plugins/ticket-workflow/scripts/test-grg.sh`; run `node --test test/*.test.mjs dispatch/*.test.mjs`.
- Guardrails (git guard hook, deny rules) live in each consuming project, not here.
- Maintainer: `askrzypczak`. Branch per change, PR to `main`; humans merge.
- **Public repo**: tracked files must not contain home-directory paths, personal emails (GitHub noreply is fine), tokens, names of unpublished repos or projects, or role references to a named person (use "the human" / "the maintainer"). `test/public-hygiene.test.mjs` enforces this.
