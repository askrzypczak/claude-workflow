# Agent credentials

Agent sessions and the poller use the machine's `gh` login. Set it up so that it cannot merge, and only the maintainer merges, in the browser. `dispatch/setup-agents.sh` does the setup. The maintainer runs it in a terminal, never an agent: it reads the new token and changes the settings that confine agent sessions.

## Steps

1. In a terminal, never from an agent session, in the main clone (after `npm ci` there once): `dispatch/setup-agents.sh credentials`. `--dry-run` first shows what each step would do and changes nothing.
2. In the token form it opens, pre-filled: under Repository access, choose "Only select repositories" and select the repos the script lists; pick an expiry ([The token](#the-token)); click Generate token.
3. Paste the token at the script's prompt.
4. When the script stops, do what it prints, then rerun it. Repeat until it passes.

Two standing rules, which no script can check:

- github.com stays out of Claude in Chrome's site permissions.
- Nobody signs in to github.com in the Claude desktop app's browser pane.

## Why

- Merging a PR (`PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge`) needs "Repository permissions for "Contents"" (write); opening one (`POST /repos/{owner}/{repo}/pulls`) needs only "Repository permissions for "Pull requests"" (write) (GitHub Docs, *Permissions required for fine-grained personal access tokens*). The token below has no Contents write.
- A fine-grained token is limited to one owner: "The token will only be able to access resources owned by the selected resource owner." (GitHub Docs, *Managing your personal access tokens*).
- A workflow's `GITHUB_TOKEN` is stopped by the ruleset rule "Restrict updates": "If selected, only users with bypass permissions can push to branches or tags whose name matches the pattern you specify." (GitHub Docs, *Available rules for rulesets*). Details in [The Actions token](#the-actions-token).
- Agents get no route into the maintainer's logged-in browser on github.com ([Wiring](#wiring)).

Together, only the maintainer can merge. Nothing in the workflow needs Contents write through the API: branches are pushed with git over SSH, which cannot merge a PR, and `protect-main` refuses direct pushes to `main`; `orchestrate-epic` folds children into `epic-E` with a local merge (`plugins/ticket-workflow/scripts/integrate-child.sh`) and a plain `git push`; auto-merge stays off.

## The token

A fine-grained personal access token. The script opens GitHub's token form pre-filled with everything the form's URL parameters allow: the name (`claude-workflow-agents-` and the date), a description, the resource owner and the six permissions. The form cannot pre-fill the repositories, and the expiry is left for the maintainer to pick.

- Resource owner: the maintainer.
- Repository access: "Only select repositories", the repos the workflow serves.
- Account permissions: none.
- Repository permissions, these six and nothing else: Metadata read, Contents read, Actions read, Commit statuses read, Issues write, Pull requests write.
- Expiry: choose one, or none: "Infinite lifetimes are allowed but may be blocked by a maximum lifetime policy set by your organization or enterprise owner." (GitHub Docs, *Managing your personal access tokens*). With an expiry, note the date and rotate the token before it: an expired token makes every poll log `poll failed` and every session's `gh` call fail. To rotate, rerun `dispatch/setup-agents.sh credentials` and answer Yes to "Create a new token and swap it in?".

Actions stays read: write would let the token dispatch or re-run workflows (`POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches` and `POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun` are Actions write), and nothing uses that.

Checks is not in the list. GitHub offers fine-grained tokens no Checks permission and lists "Using fine-grained personal access token to call the Checks API." among their limitations (GitHub Docs, *Managing your personal access tokens*). Check runs feed `gh pr checks` and `--json statusCheckRollup` (the poller's PR list in `dispatch/poller/io.ts`). On public repos they are expected to work through the token's read access to public repos ("Tokens always include read-only access to all public repositories on GitHub.", same page), but GitHub's docs do not confirm it, and on a private repo nothing grants them. A failed check read, or an empty rollup, stops the poller's conflict and CI-fix sessions, and the token cannot serve the workflow as documented. The pre-swap test in [Verify](#verify) settles this before the login changes.

What each `gh` command needs, from the skills, the agents, `plugins/ticket-workflow/scripts/`, `dispatch/poller/` and `dispatch/setup/`:

| Commands | Used by | Permission |
|---|---|---|
| `gh issue view`, `gh issue list` (including `--search`) | skills, agents, poller | Issues: read |
| `gh issue create`, `gh issue edit` (labels, assignee, body), `gh issue comment`, `gh issue close` | skills, poller, `integrate-child.sh` | Issues: write |
| `gh api -X DELETE .../issues/comments/<id>` | the setup script's pre-swap test, removing its test comment | Issues: write |
| `gh pr view`, `gh pr list`, `gh pr diff`, `gh pr checkout` (the API lookup; the fetch is git over SSH) | skills, agents, poller | Pull requests: read |
| `gh pr create`, `gh pr edit --add-label`, `gh pr comment` | skills, poller | Pull requests: write |
| `gh pr checks`; `--json statusCheckRollup` on `gh pr view` and `gh pr list` | skills, poller | Commit statuses: read for status contexts. Check runs: no fine-grained permission covers them (the Checks API is unsupported); expected to work on public repos through the token's read-only public access; unconfirmed until Verify runs |
| `gh run list`, `gh run view --log-failed` | `fix-ci` | Actions: read |
| `gh api repos/{owner}/{repo}/issues/N` (`.author_association`, `.id`), `.../issues/N/comments`, `GET .../issues/E/sub_issues` | skills, agents | Issues: read |
| `gh api -X POST .../issues/E/sub_issues` | `file-ticket`, `orchestrate-epic` | Issues: write |
| `gh api repos/{owner}/{repo}/pulls/N` (`.author_association`), `.../pulls/N/comments` | skills | Pull requests: read |
| `gh api repos/<repo>/commits/main` | poller | Contents: read |
| `gh label list`, `gh label create` | `setup-labels.sh` | Issues: read / write |
| `gh api repos/<owner>/<repo>/rulesets/<id>` | the setup script ([Verify](#verify)) | Metadata: read |
| Merging a PR (`PUT .../pulls/N/merge`) | nothing in the workflow | Contents: write, which the token lacks |

Metadata read comes with every fine-grained token. `plugins/ticket-workflow/scripts/ticket-labels.ts` runs in Actions on the caller workflow's `GITHUB_TOKEN` (`contents: read`, `issues: write`), not on the local login. The setup script's ruleset and auto-merge writes need admin rights, which the token lacks: it makes them with the login it replaces, before the swap.

## Wiring

What `dispatch/setup-agents.sh credentials` does, in order. Each step checks first and does nothing when its work is already done, so a rerun is safe. It stops at the first step that needs the maintainer and prints what to do. With `--dry-run` it runs the reads, prints what each write would do, and goes through every step without stopping.

1. Pauses dispatch (`dispatch/install-launchd.sh pause`) and refuses to go on while `claude agents` shows a live session, naming each with `claude stop <name>`. Dispatch stays paused until a full setup run passes every phase and resumes it, or until `dispatch/install-launchd.sh resume`. A rerun pauses it again.
2. On each served repo (this clone's, then those in the [dispatch config](../dispatch/README.md#onboarding-a-repo)), with the current login: creates the `restrict-updates` ruleset ([The Actions token](#the-actions-token)), or puts it back when it drifted, and turns auto-merge off ([Auto-merge](#auto-merge)). Other rulesets are left alone. Under a login without admin rights, such as the fine-grained one on a rerun, it changes nothing and checks what it can read: the ruleset as in [Verify](#verify), and auto-merge, which it reports as unchecked when GitHub does not return the setting.
3. Opens the pre-filled token form ([The token](#the-token)), lists the repos to select, and reads the token at a prompt that does not echo it. Under the fine-grained login it first asks "Create a new token and swap it in? [y/N]"; No skips to step 6.
4. Runs the pre-swap test ([Verify](#verify)) with the token only in the commands' environment.
5. Only when every check passed, swaps the login: `gh auth logout` for each github.com account, then `gh auth login --with-token` with the token on standard input. Logging out comes first because both tokens belong to the same GitHub user: a logout by user after the login would remove the new login too. The token is never on a command line, in a file or in the output.
6. Looks for every other GitHub API token on the machine and reports each one to remove by hand; it removes nothing: `GH_TOKEN`/`GITHUB_TOKEN` in the environment and in the shell startup files (`gh` prefers them over the stored login), a github.com password in the macOS keychain and stored git credentials for github.com (remotes stay on SSH), and GitHub MCP servers in Claude Code's configuration (`~/.claude.json`, each served repo's `.mcp.json`). A finding stops the run after step 7.
7. Runs the after-swap checks ([Verify](#verify)).

`gh auth logout` does not revoke the old login: "The authentication configuration is only removed locally. This command does not revoke authentication tokens." (`gh auth logout --help`). Revoking the old "GitHub CLI" authorization at github.com/settings/applications is optional; the script prints it as a last note.

Standing rules, which no script can check:

- Browser automation that acts in the maintainer's browser (Claude in Chrome) must not be allowed on github.com: leave github.com out of the extension's site permissions, which is not a boundary in auto mode; see [Claude in Chrome on demand](sandboxing.md#claude-in-chrome-on-demand).
- The Claude desktop app's built-in browser pane keeps its own sign-ins: do not sign in to github.com there (same route as Claude in Chrome).

## Admin work

Merging happens in the browser, and so do rulesets and repo settings, apart from what `dispatch/setup-agents.sh` sets before the swap. A temporary broader login, if ever needed, is made with no agent sessions running (`dispatch/install-launchd.sh pause`, and `claude agents` shows none live) and logged out afterwards, restoring the restricted login.

## Auto-merge

Keep auto-merge off on every repo the workflow serves. With it on, enabling auto-merge on a PR would be another way for an agent to merge. The setup script turns it off with the login it replaces; after the swap, GitHub may not return the setting to the token, and the script then reports it as unchecked.

## Verify

What the setup script checks. The maintainer reads its report; nothing here is run by hand.

The pre-swap test, before anything is logged out. With the current login, the script picks the first served repo that has an open PR whose checks include a `test` check run, an open issue, a completed workflow run, and a label carried by neither (never one of the workflow's own labels). Then, with the new token only as `GH_TOKEN` in each command's environment, it runs one command per row of the [table](#the-token):

- `gh issue view <i> --json number,state` and `gh api repos/<owner>/<repo>/issues/<i> --jq .author_association`
- `gh issue comment <i>`, and the test comment deleted again (`gh api -X DELETE repos/<owner>/<repo>/issues/comments/<id>`)
- `gh issue edit <i> --add-label <label>`, then `--remove-label <label>`
- `gh pr view <n> --json mergeable`, `gh api repos/<owner>/<repo>/pulls/<n> --jq .author_association` and `gh pr diff <n>`
- `gh pr edit <n> --add-label <label>`, then `--remove-label <label>`
- `gh pr checks <n>`: passes when it lists a `test` row. It exits 8 while a check is pending and 1 when one has failed, even when the read worked, so it is judged by the output, not the exit code.
- `gh pr view <n> --json statusCheckRollup`: passes when the output has an entry with `"__typename": "CheckRun"` and name `test`. An empty rollup exits 0 but fails.
- `gh run view <id> --log`, `gh api repos/<owner>/<repo>/commits/main --jq .sha`, `gh label list --limit 5` and `gh api repos/<owner>/<repo>/rulesets`

The rest pass on exit 0. The test comment and the label are removed even when a check fails. If any check fails, the login is not swapped: the classic login stays, and the failure is worth a ticket.

After the swap:

1. `gh auth status` shows one github.com login, with a fine-grained token (it starts `github_pat_`).
2. A merge with a deliberately wrong head `sha` against an open, mergeable PR: `gh api -X PUT repos/<owner>/<repo>/pulls/<n>/merge -f sha=0000000000000000000000000000000000000000`. 403 means correct. 409 means the token can merge. Anything else (405, 422), or no mergeable PR, is inconclusive. The wrong `sha` keeps the check from ever merging. A 409 and an inconclusive answer both stop the script with a to-do.
3. On each served repo, `restrict-updates` reads back with a rule of type `update`, `enforcement` `active`, and `current_user_can_bypass` `pull_requests_only`. GitHub returns the bypass list only to callers who can edit the ruleset ("the bypass_actors property is only returned if the user making the API request has write access to the ruleset", GitHub Docs, *REST API endpoints for rules*). When `bypass_actors` is returned, it must be the Repository admin role alone in `pull_request` mode; when it is missing, the script says to read the ruleset's Bypass list in the browser: the Repository admin role only, in "For pull requests only" mode, nothing in "Always allow".

## The limit

GitHub's plans page lists protected branches under GitHub Pro's "Advanced tools and insights in private repositories", and GitHub Free covers private repos "with a limited feature set" (GitHub Docs, *GitHub's plans*). So private repos on GitHub Free don't enforce `protect-main`. There, a direct push to `main` over SSH and a workflow-token merge are stopped only by the deny rules ([Requirements](setup.md#requirements)) and the skills.

## The Actions token

The path: an agent can push a branch that edits `.github/workflows/` (SSH pushes carry no `workflow`-scope check). `ci.yml` runs on `pull_request`, and for a same-repo PR GitHub runs the workflow file from the PR branch. A workflow that asks for `permissions: contents: write` could then merge with `GITHUB_TOKEN`, since `protect-main` requires 0 approvals.

The fix: a ruleset of its own on each served repo, `restrict-updates`, targeting the default branch and holding only the "Restrict updates" rule, with the Repository admin role as the only bypass actor, in "For pull requests only" mode. The setup script creates it while the login still has admin rights. Workflows should then be unable to merge into or push to `main`, while the maintainer's browser merge still works.

GitHub Docs, *Creating rulesets for a repository*: eligible bypass actors include "Repository admins, organization owners, and enterprise owners". On the "For pull requests only" mode: "The selected actor is now required to open a pull request to make changes to a repository" and "The actor can then choose to bypass any branch protections and merge that pull request." The REST schema says "pull_request means that an actor can only bypass rules on pull requests."

Gaps:

- The docs list repository admins as bypass actors without limiting them to organization repos, but do not say in so many words that a personal-account repo offers that actor and mode. If GitHub refuses them, the script stops and prints GitHub's answer.
- The docs describe the rule in terms of pushes, and the REST schema as "Only allow users with bypass permission to update matching refs". A merge updates `main`'s ref, and the pull-requests-only text treats bypass as what lets an actor merge, but the docs do not say in words that a PR merge by an actor without bypass is refused. `GITHUB_TOKEN` is such an actor: the GitHub Actions app is not on the bypass list.

If either fails, the workflow-token merge path stays open on that repo, and only the agent-side guardrails stand in its way.

The placement, the maintainer's choice: with the rule inside `protect-main`, every maintainer merge into `main` would be a bypass of `protect-main`, and a bypass lifts every rule in that ruleset for the merge, including the required `test` check. A bypass applies to "the rules in the ruleset" (GitHub Docs, *About rulesets*), so in a ruleset of its own the merge bypasses only Restrict updates, and `protect-main`'s required check stays binding.
