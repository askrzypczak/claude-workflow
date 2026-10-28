# Agent credentials

Agent sessions and the poller use the machine's `gh` login. Set it up so that it cannot merge, and only the maintainer merges, in the browser. These are the maintainer's steps; no agent applies them.

## Why

- Merging a PR (`PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge`) needs "Repository permissions for "Contents"" (write); opening one (`POST /repos/{owner}/{repo}/pulls`) needs only "Repository permissions for "Pull requests"" (write) (GitHub Docs, *Permissions required for fine-grained personal access tokens*). The token below has no Contents write.
- A fine-grained token is limited to one owner: "The token will only be able to access resources owned by the selected resource owner." (GitHub Docs, *Managing your personal access tokens*).
- A workflow's `GITHUB_TOKEN` is stopped by the ruleset rule "Restrict updates": "If selected, only users with bypass permissions can push to branches or tags whose name matches the pattern you specify." (GitHub Docs, *Available rules for rulesets*). Details in [The Actions token](#the-actions-token).
- Agents get no route into the maintainer's logged-in browser on github.com ([Wiring](#wiring)).

Together, only the maintainer can merge. Nothing in the workflow needs Contents write through the API: branches are pushed with git over SSH, which cannot merge a PR, and `protect-main` refuses direct pushes to `main`; `orchestrate-epic` folds children into `epic-E` with a local merge (`plugins/ticket-workflow/scripts/integrate-child.sh`) and a plain `git push`; auto-merge stays off.

## The token

Create a fine-grained personal access token:

- Resource owner: the maintainer.
- Repository access: "Only select repositories", the repos the workflow serves.
- Account permissions: none.
- Repository permissions, these six and nothing else: Metadata read, Contents read, Actions read, Commit statuses read, Issues write, Pull requests write.
- Expiry: choose one, or none: "Infinite lifetimes are allowed but may be blocked by a maximum lifetime policy set by your organization or enterprise owner." (GitHub Docs, *Managing your personal access tokens*). With an expiry, note the date and rotate the token before it: an expired token makes every poll log `poll failed` and every session's `gh` call fail.

Actions stays read: write would let the token dispatch or re-run workflows (`POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches` and `POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun` are Actions write), and nothing uses that.

Checks is not in the list. GitHub offers fine-grained tokens no Checks permission and lists "Using fine-grained personal access token to call the Checks API." among their limitations (GitHub Docs, *Managing your personal access tokens*). Check runs feed `gh pr checks` and `--json statusCheckRollup` (the poller's PR list in `dispatch/poller/io.ts`). On public repos they are expected to work through the token's read access to public repos ("Tokens always include read-only access to all public repositories on GitHub.", same page), but GitHub's docs do not confirm it, and on a private repo nothing grants them. A failed check read, or an empty rollup, stops the poller's conflict and CI-fix sessions, and the token cannot serve the workflow as documented. The pre-swap test in [Verify](#verify) settles this before the login changes.

What each `gh` command needs, from the skills, the agents, `plugins/ticket-workflow/scripts/` and `dispatch/poller/`:

| Commands | Used by | Permission |
|---|---|---|
| `gh issue view`, `gh issue list` (including `--search`) | skills, agents, poller | Issues: read |
| `gh issue create`, `gh issue edit` (labels, assignee, body), `gh issue comment`, `gh issue close` | skills, poller, `integrate-child.sh` | Issues: write |
| `gh pr view`, `gh pr list`, `gh pr diff`, `gh pr checkout` (the API lookup; the fetch is git over SSH) | skills, agents, poller | Pull requests: read |
| `gh pr create`, `gh pr edit --add-label`, `gh pr comment` | skills, poller | Pull requests: write |
| `gh pr checks`; `--json statusCheckRollup` on `gh pr view` and `gh pr list` | skills, poller | Commit statuses: read for status contexts. Check runs: no fine-grained permission covers them (the Checks API is unsupported); expected to work on public repos through the token's read-only public access; unconfirmed until Verify runs |
| `gh run list`, `gh run view --log-failed` | `fix-ci` | Actions: read |
| `gh api repos/{owner}/{repo}/issues/N` (`.author_association`, `.id`), `.../issues/N/comments`, `GET .../issues/E/sub_issues` | skills, agents | Issues: read |
| `gh api -X POST .../issues/E/sub_issues` | `file-ticket`, `orchestrate-epic` | Issues: write |
| `gh api repos/{owner}/{repo}/pulls/N` (`.author_association`), `.../pulls/N/comments` | skills | Pull requests: read |
| `gh api repos/<repo>/commits/main` | poller | Contents: read |
| `gh label list`, `gh label create` | `setup-labels.sh` | Issues: read / write |
| `gh api repos/<owner>/<repo>/rulesets/<id>` | [Verify](#verify) | Metadata: read |
| Merging a PR (`PUT .../pulls/N/merge`) | nothing in the workflow | Contents: write, which the token lacks |

Metadata read comes with every fine-grained token. `plugins/ticket-workflow/scripts/ticket-labels.ts` runs in Actions on the caller workflow's `GITHUB_TOKEN` (`contents: read`, `issues: write`), not on the local login.

## Wiring

1. Pass the pre-swap test in [Verify](#verify) first. It pauses dispatch.
2. `gh auth logout`, then `gh auth login --with-token` with the token pasted on standard input (end with Ctrl-D), so it is never on a command line.
3. Remove every other GitHub API token on the machine: `GH_TOKEN`/`GITHUB_TOKEN` exports (`gh` prefers them over the stored login), stored git credentials for github.com (remotes are SSH), and any GitHub MCP server or connector token in Claude Code's configuration.
4. Keep git over SSH.
5. Browser automation that acts in the maintainer's browser (Claude in Chrome) must not be allowed on github.com: leave github.com out of the extension's site permissions, which is not a boundary in auto mode; see [Claude in Chrome on demand](sandboxing.md#claude-in-chrome-on-demand). The Claude desktop app's built-in browser pane keeps its own sign-ins: do not sign in to github.com there (same route as Claude in Chrome).
6. Run the after-swap checks in [Verify](#verify). The last one resumes dispatch.

## Admin work

Merging, rulesets and repo settings happen in the browser. A temporary broader login, if ever needed, is made with no agent sessions running (`dispatch/install-launchd.sh pause`, and `claude agents` shows none live) and logged out afterwards, restoring the restricted login.

## Auto-merge

Keep auto-merge off on every repo the workflow serves. With it on, enabling auto-merge on a PR would be another way for an agent to merge.

## Verify

Pre-swap test, before anything is logged out:

1. `dispatch/install-launchd.sh pause`; `claude agents` shows no live sessions.
2. In a fresh terminal, set the new token as a one-off environment variable without typing it on a command line: `read -rs GH_TOKEN` (paste, Enter), then `export GH_TOKEN`. `gh` then uses it in this terminal only, and its value goes in no file and no shell history.
3. Against a served repo, with an open PR `<n>`, an issue `<i>` and a run `<id>` (from `gh run list --limit 1`; any run exercises Actions read, so a failed run need not exist), run one representative command per table row, for example:
   - `gh issue view <i> --json number,state`
   - `gh api repos/<owner>/<repo>/issues/<i> --jq .author_association`
   - `gh issue comment <i> --body "token test"`
   - `gh issue edit <i> --add-label <label>`, then `--remove-label <label>`
   - `gh pr view <n> --json mergeable`
   - `gh api repos/<owner>/<repo>/pulls/<n> --jq .author_association`
   - `gh pr diff <n>`
   - `gh pr edit <n> --add-label <label>`, then `--remove-label <label>`
   - `gh pr checks <n>`: passes when it lists a `test` row. It exits 8 while a check is pending and 1 when one has failed, even when the read worked, so judge by the output, not the exit code.
   - `gh pr view <n> --json statusCheckRollup`: passes when the output has an entry with `"__typename": "CheckRun"` and name `test`. An empty rollup exits 0 but fails.
   - `gh run view <id> --log`
   - `gh api repos/<owner>/<repo>/commits/main --jq .sha`
   - `gh label list --limit 5`
   - `gh api repos/<owner>/<repo>/rulesets`
4. `unset GH_TOKEN` and close the terminal.
5. Swap the login ([Wiring](#wiring)) only when every command passes. If a check read fails, do not swap: keep the classic login and file a ticket.

After the swap:

1. `gh auth status` shows one github.com login, with a fine-grained token (it starts `github_pat_`).
2. The maintainer, in a terminal, tries a merge with a deliberately wrong head `sha` against an open, mergeable PR: `gh api -X PUT repos/<owner>/<repo>/pulls/<n>/merge -f sha=0000000000000000000000000000000000000000`. 403 means correct. 409 means the token can merge. Anything else (405, 422) is inconclusive: retry on a mergeable PR. The wrong `sha` keeps the check from ever merging.
3. Opening a PR, labelling and commenting still work.
4. On each served repo, check the ruleset that holds Restrict updates: find its id with `gh api repos/<owner>/<repo>/rulesets`, then `gh api repos/<owner>/<repo>/rulesets/<id>` shows a rule of type `update`, `enforcement` `active`, and `current_user_can_bypass` `pull_requests_only`. GitHub returns the bypass list only to callers who can edit the ruleset ("the bypass_actors property is only returned if the user making the API request has write access to the ruleset", GitHub Docs, *REST API endpoints for rules*), so if `bypass_actors` is missing, read the ruleset's Bypass list in the browser: the Repository admin role only, in "For pull requests only" mode, nothing in "Always allow".
5. `dispatch/install-launchd.sh resume`.

## The limit

GitHub's plans page lists protected branches under GitHub Pro's "Advanced tools and insights in private repositories", and GitHub Free covers private repos "with a limited feature set" (GitHub Docs, *GitHub's plans*). So private repos on GitHub Free don't enforce `protect-main`. There, a direct push to `main` over SSH and a workflow-token merge are stopped only by the deny rules ([Requirements](setup.md#requirements)) and the skills.

## The Actions token

The path: an agent can push a branch that edits `.github/workflows/` (SSH pushes carry no `workflow`-scope check). `ci.yml` runs on `pull_request`, and for a same-repo PR GitHub runs the workflow file from the PR branch. A workflow that asks for `permissions: contents: write` could then merge with `GITHUB_TOKEN`, since `protect-main` requires 0 approvals.

The fix: add "Restrict updates" to each served repo's `protect-main`, with the Repository admin role as the only bypass actor, in "For pull requests only" mode. Workflows should then be unable to merge into or push to `main`, while the maintainer's browser merge still works.

GitHub Docs, *Creating rulesets for a repository*: eligible bypass actors include "Repository admins, organization owners, and enterprise owners". On the "For pull requests only" mode: "The selected actor is now required to open a pull request to make changes to a repository" and "The actor can then choose to bypass any branch protections and merge that pull request." The REST schema says "pull_request means that an actor can only bypass rules on pull requests."

Gaps:

- The docs list repository admins as bypass actors without limiting them to organization repos, but do not say in so many words that a personal-account repo offers that actor and mode. Confirm it in the bypass dialog when adding the rule.
- The docs describe the rule in terms of pushes, and the REST schema as "Only allow users with bypass permission to update matching refs". A merge updates `main`'s ref, and the pull-requests-only text treats bypass as what lets an actor merge, but the docs do not say in words that a PR merge by an actor without bypass is refused. `GITHUB_TOKEN` is such an actor: the GitHub Actions app is not on the bypass list.

If either fails, the workflow-token merge path stays open on that repo, and only the agent-side guardrails stand in its way.

The cost: with the rule in place, every maintainer merge into `main` is a bypass, and a bypass lifts every rule in that ruleset for the merge, including the required `test` check. Check CI before merging.

The alternative: put "Restrict updates" in a ruleset of its own with the admin bypass, and leave `protect-main` with no bypass actors. A bypass applies to "the rules in the ruleset" (GitHub Docs, *About rulesets*), so `protect-main`'s required check stays binding. The maintainer picks one placement when applying the step.
