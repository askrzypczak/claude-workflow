# claude-workflow

Claude Code plugin marketplace (`askrzypczak-plugins`) holding the `ticket-workflow` plugin. See README.md for contents, `docs/` for setup and the security setup, and `dispatch/README.md` for the poller.

## Conventions
- **No `version` in `plugin.json`, on purpose.** Installs track the commit SHA, so every merge to `main` reaches agent sessions and PRs have no version to collide on. Don't add one (here or in `marketplace.json`): a pinned version would freeze installs until someone changed it.
- Keep README.md's Workflow list in step with `skills/work-ticket/SKILL.md`.
- Keep the allowlist table in `docs/containers.md` in step with the hosts in `dispatch/container/init-firewall.sh`.
- Validate with `claude plugin validate .`; type-check TS with `npm run typecheck`.
- Guardrails: the comment guard ships with the plugin (`plugins/ticket-workflow/hooks/guard-comments.sh`; test: `test-guard-comments.sh` in the same directory, run in CI). Deny rules stay per project; this repo's own are in `.claude/settings.json`.
- Maintainer: `askrzypczak`. Branch per change, PR to `main`; humans merge.
- **Public repo**: tracked files must not contain home-directory paths, personal emails (GitHub noreply is fine), tokens, names of unpublished repos or projects, or role references to a named person (use "the human" / "the maintainer").
- `.github/workflows/ticket-labels.yml` is a reusable workflow that checks out this repo and runs `plugins/ticket-workflow/scripts/ticket-labels.ts`; callers need no secrets.
- **Agents' GitHub tokens cannot merge.** Every token a session holds (the host's login and the container's) is fine-grained without Contents write, and the maintainer merges in the browser (`docs/agent-credentials.md`). A new `gh` call that needs a permission outside the tokens' list updates the permission table and list in `docs/agent-credentials.md` in the same PR.
- **Unattended sessions run in the agent container** (`docs/containers.md`); a refused connection or a missing permission there means stop and report, not work around it. Interactive host sessions have no sandbox.
