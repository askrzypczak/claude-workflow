# claude-workflow

Private Claude Code plugin marketplace (`askrzypczak-plugins`) holding the `ticket-workflow` plugin. See README.md for contents and install.

## Conventions
- **Bump the version in every PR that changes the plugin**: `version` in `plugins/ticket-workflow/.claude-plugin/plugin.json`, in the same commit. Patch for wording or doc fixes, minor for behaviour changes. Claude Code updates installed plugins by comparing this version, so an unbumped merge may never reach agent sessions. `marketplace.json` has no version.
- Keep README.md's Workflow list in step with `skills/work-ticket/SKILL.md`.
- Validate with `claude plugin validate .`; self-test grg with `plugins/ticket-workflow/scripts/test-grg.sh`.
- Guardrails (git guard hook, deny rules) live in each consuming project, not here.
- Owner: Tony (`askrzypczak`). Branch per change, PR to `main`; humans merge.
- `.github/workflows/ticket-labels.yml` is a reusable workflow that embeds `scripts/ticket-labels.ts` (callers cannot check out this private repo). Edit both together; `npm test` checks they match. Requires Actions access `user` on this repo.
