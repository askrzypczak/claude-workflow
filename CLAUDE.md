# claude-workflow

Claude Code plugin marketplace (`askrzypczak-plugins`) holding the `ticket-workflow` plugin. See README.md for contents and install.

## Conventions
- **No `version` in `plugin.json`, on purpose.** Installs track the commit SHA, so every merge to `main` reaches agent sessions and PRs have no version to collide on. Don't add one (here or in `marketplace.json`): a pinned version would freeze installs until someone changed it.
- Keep README.md's Workflow list in step with `skills/work-ticket/SKILL.md`.
- Validate with `claude plugin validate .`; type-check TS with `npm run typecheck`.
- Guardrails: the git guard and the comment guard both ship with the plugin (`plugins/ticket-workflow/hooks/guard-git.sh` and `guard-comments.sh`; tests: `test-guard-git.sh` and `test-guard-comments.sh` in the same directory, run in CI). Deny rules stay per project; this repo's own are in `.claude/settings.json`, which also wires the git guard directly for local sessions.
- Maintainer: `askrzypczak`. Branch per change, PR to `main`; humans merge.
- **Public repo**: tracked files must not contain home-directory paths, personal emails (GitHub noreply is fine), tokens, names of unpublished repos or projects, or role references to a named person (use "the human" / "the maintainer").
- `.github/workflows/ticket-labels.yml` is a reusable workflow that checks out this repo and runs `plugins/ticket-workflow/scripts/ticket-labels.ts`; callers need no secrets.
