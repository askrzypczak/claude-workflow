# Agent credentials

Agent sessions use two `gh` logins, each with a fine-grained token that cannot merge: the host's, which the setup script and the maintainer's interactive sessions use, and the agent container's, which the poller and its sessions use ([The container's token](#the-containers-token)). Only the maintainer merges, in the browser. `dispatch/setup-agents.sh` sets both up. The maintainer runs it in a terminal, never an agent: it reads the new tokens and changes the settings that confine agent sessions.

## Steps

The host's token:

1. In a terminal, never from an agent session, in the main clone (after `npm ci` there once): `dispatch/setup-agents.sh credentials`. `--dry-run` first shows what each step would do and changes nothing.
2. In the token form it opens, pre-filled: under Repository access, choose "Only select repositories" and select the repos the script lists; pick an expiry ([The token](#the-token)); click Generate token.
3. Paste the token at the script's prompt.
4. When the script stops, do what it prints, then rerun it. Repeat until it passes.

The container's token and the Claude token come in the `container` phase ([The container's token](#the-containers-token), [The Claude token](#the-claude-token)).

Two standing rules, which no script can check:

- Claude in Chrome runs only in a dedicated Chrome profile that is not signed in to GitHub, with github.com out of its site permissions ([Claude in Chrome](containers.md#claude-in-chrome)).
- Nobody signs in to github.com in the Claude desktop app's browser pane.

## Why

- The rule: no token a session holds gets Contents write. Spike #164 tested it on a throwaway public repo holding the `restrict-updates` ruleset, with a fine-grained token limited to that repo:
  - With Contents write and no Administration permission, a direct push to `main` was refused (`GH013 ... Cannot update this protected ref`), but `gh pr merge --merge --admin` merged the PR past `restrict-updates`, though GitHub's `viewerCanMergeAsAdmin` read `false` just before. So a token carries its owner's admin bypass without the Administration permission.
  - With Contents read-only, `gh pr merge --merge --admin` got `Resource not accessible by personal access token (mergePullRequest)`, and `PUT .../pulls/N/merge` and an HTTPS push of a branch both got 403.
  - Spike #169 adds, reasoned and not tested, that under `exempt` ([The Actions token](#the-actions-token)) a token with Contents write may merge without `--admin`.
- Merging a PR (`PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge`) needs "Repository permissions for "Contents"" (write); opening one (`POST /repos/{owner}/{repo}/pulls`) needs only "Repository permissions for "Pull requests"" (write) (GitHub Docs, *Permissions required for fine-grained personal access tokens*). The tokens below have no Contents write.
- A fine-grained token is limited to one owner: "The token will only be able to access resources owned by the selected resource owner." (GitHub Docs, *Managing your personal access tokens*).
- A workflow's `GITHUB_TOKEN` is stopped by the ruleset rule "Restrict updates": "If selected, only users with bypass permissions can push to branches or tags whose name matches the pattern you specify." (GitHub Docs, *Available rules for rulesets*). Details in [The Actions token](#the-actions-token).
- Agents get no route into the maintainer's logged-in browser on github.com ([Wiring](#wiring)).

Together, only the maintainer can merge. Nothing in the workflow needs Contents write through the API: branches are pushed with git over SSH (each served repo's deploy key in the agent container, the maintainer's own key on the host), which cannot merge a PR, and `protect-main` refuses direct pushes to `main`; `orchestrate-epic` folds children into `epic-E` with a local merge (`plugins/ticket-workflow/scripts/integrate-child.sh`) and a plain `git push`; auto-merge stays off. A push over HTTPS would need Contents write, which is why branches go over SSH (#164).

## The token

The host's token is a fine-grained personal access token. The script opens GitHub's token form pre-filled with everything the form's URL parameters allow: the name (`claude-workflow-agents-` and the date), a description, the resource owner and the six permissions. The form cannot pre-fill the repositories, and the expiry is left for the maintainer to pick. The container's token has the same six permissions ([The container's token](#the-containers-token)).

- Resource owner: the maintainer.
- Repository access: "Only select repositories", the repos the workflow serves.
- Account permissions: none.
- Repository permissions, these six and nothing else: Metadata read, Contents read, Actions read, Commit statuses read, Issues write, Pull requests write.
- Expiry: choose one, or none: "Infinite lifetimes are allowed but may be blocked by a maximum lifetime policy set by your organization or enterprise owner." (GitHub Docs, *Managing your personal access tokens*). With an expiry, note the date and rotate the token before it: an expired token makes every `gh` call on the host fail, the maintainer's sessions' and the setup script's (the `container` phase reads each served repo with it). To rotate, rerun `dispatch/setup-agents.sh credentials` and answer Yes to "Create a new token and swap it in?". An expired token is rotated the same way, by rerunning `dispatch/setup-agents.sh credentials`: the script sees that GitHub refuses the stored token, skips the ruleset step and goes straight to the token form, with no question. It then picks what the pre-swap test uses only after the paste, so a missing one costs a token: first make sure a served repo has an open PR with a `test` check run, an open issue and a completed workflow run.

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
| `gh api repos/<owner>/<repo>` (the default branch, admin rights, the auto-merge setting) | the setup script's `credentials` and `container` phases | Metadata: read |
| `gh api repos/<owner>/<repo>/rules/branches/<branch>` | the `credentials` and `container` phases' `protect-main` check, and the pre-swap test ([Verify](#verify)) | Metadata: read (expected; unconfirmed until the first run) |
| `gh api repos/<owner>/<repo>/rulesets/<id>` | the setup script's `protect-main` check and [Verify](#verify) | Metadata: read |
| Merging a PR (`PUT .../pulls/N/merge`) | nothing in the workflow | Contents: write, which the token lacks |

Metadata read comes with every fine-grained token. `plugins/ticket-workflow/scripts/ticket-labels.ts` runs in Actions on the caller workflow's `GITHUB_TOKEN` (`contents: read`, `issues: write`), not on the local login. The setup script's ruleset and auto-merge writes need admin rights, which the token lacks: it makes them with the login it replaces, before the swap.

## The container's token

The agent container has a `gh` login of its own, set up by the `container` phase, so it can be revoked alone. The phase opens the same pre-filled token form as [the host's](#the-token), named `claude-workflow-container-` and the date, with the same six permissions: select the served repos under Repository access, keep Contents read-only and pick an expiry. The host's fine-grained token is accepted too, but a separate one is recommended.

- Before the token is stored, the phase checks on the host, with the token only as `GH_TOKEN`, that a wrong-sha merge with it is refused with 403 (as in [Verify](#verify), after the swap, item 2). A token that can merge is never stored, and without an open, mergeable PR in a served repo nothing can be checked, so the phase stops until there is one. Then `gh auth login --with-token` stores it in the container as `node`, the token on standard input; it lands in `~/.config/gh/hosts.yml` there, mode 0600 (#164).
- Every later run reads the stored token as `node` and probes it the same way. With no mergeable PR open, that is a note and the phase goes on, since the token was refused with 403 when it was pasted.
- A new token changes the container's `gh` login, so the phase first pauses dispatch and refuses while a session is live in the container.
- When the token expires, or must be rotated, log it out in the container and rerun the phase, which asks for a new one:

      docker exec -u node claude-workflow-agent gh auth logout --hostname github.com --user <login>
      dispatch/setup-agents.sh container

  When GitHub refuses the stored login, the phase stops with that logout command in its to-do.
- Its expiry is what makes every poll log `[<prefix>] poll failed` and every container session's `gh` call fail: note the date.
- A served repo added later needs this token edited in the browser too, so it can see the repo.

## The Claude token

Container sessions sign in to Claude with a token from `claude setup-token`, which the `container` phase asks for: run `claude setup-token` in another terminal on the host, log in with the Claude account the agents use, and paste the token it prints at the phase's hidden prompt. The phase writes it to `~/.config/claude-workflow/claude-agent.env` as `CLAUDE_CODE_OAUTH_TOKEN=<token>`, mode 0600, and `docker run --env-file` passes it to the container. Every run checks that the file holds that line and has mode 0600, and sets the mode when it differs.

- Every container session can read it: it is in each session's environment ([What it can't stop](containers.md#what-it-cant-stop)).
- `claude setup-token` makes "a one-year OAuth token", and "It can only make model requests, so it can't establish Remote Control sessions or fetch claude.ai connectors." (Claude Code docs, *Authentication*). So container sessions have neither, and are answered through `docker exec` ([Talking to sessions](containers.md#talking-to-sessions)).
- A session signed in this way starts in manual permission mode and stops at its first Bash call (#164, answer 5), so the poller launches sessions with `--permission-mode auto`.
- On the host, the deny rules keep the env file from the Read and Edit tools; a Bash command can still read it ([Sessions on the host](containers.md#sessions-on-the-host)).
- Revoking: Claude Code's docs (*Authentication*) describe no way to revoke a `setup-token` token, and spike #164 found none.
- Rotating: delete the env file, then rerun `dispatch/setup-agents.sh container`, which asks for a new token. The env file is part of the container's config label, so the container is replaced, which refuses while a session is live in the container. The old token stays valid until it expires.

## Wiring

What `dispatch/setup-agents.sh credentials` does, in order. Each step checks first and does nothing when its work is already done, so a rerun is safe. It stops at the first step that needs the maintainer and prints what to do. With `--dry-run` it runs the reads, prints what each write would do, and goes through every step without stopping.

1. Pauses dispatch (`dispatch/install-launchd.sh pause`, which also ends a poll running in the agent container) and refuses to go on while a session is live on the host (`claude agents`) or in the agent container (`docker exec claude-workflow-agent claude agents`), idle sessions included. It names each with its stop command by id: `claude stop <id>`, or `docker exec claude-workflow-agent claude stop <id>`. Dispatch stays paused until a full setup run passes every phase and resumes it, or until `dispatch/install-launchd.sh resume`. A rerun pauses it again.
2. On each served repo (this clone's, then those in the [dispatch config](../dispatch/README.md#onboarding-a-repo)), with the current login, it first checks `protect-main`: the default branch must have an active ruleset with a `pull_request` rule that this login cannot bypass (`current_user_can_bypass` reads `never`). It finds that ruleset through `rules/branches/<branch>` and the rulesets behind those rules, not by matching names. Under the admin login the ruleset's bypass list must also be empty; the fine-grained login cannot read the list, so it gets a note to check it in the browser. A missing or bypassable `protect-main` is a to-do, fixed in the browser, and `restrict-updates` is not created or reset until it passes. Then the step creates the `restrict-updates` ruleset ([The Actions token](#the-actions-token)), or puts it back when it drifted, and turns auto-merge off ([Auto-merge](#auto-merge)). Other rulesets are left alone. Under a login without admin rights, such as the fine-grained one on a rerun, it changes nothing and checks what it can read: the ruleset as in [Verify](#verify), and auto-merge, which it reports as unchecked when GitHub does not return the setting. A repo the token cannot see (HTTP 404) is a to-do: select it under the token's Repository access, then rerun. When GitHub refuses the stored login's token (it expired), nothing can be read or changed as that login: the script skips this step, `protect-main` check included, with a note per repo, and the after-swap checks read `restrict-updates` back.
3. Under the fine-grained login it first asks "Create a new token and swap it in? [y/N]"; No skips to step 6. It then picks what the pre-swap test will use ([Verify](#verify)), so a missing PR, issue or run is reported before a token is made. Last, it opens the pre-filled token form ([The token](#the-token)), lists the repos to select, and reads the token at a prompt that does not echo it. (How it tells a fine-grained login: [Verify](#verify), after the swap, item 1.) With the stored token expired, it asks nothing and goes straight to the form; after the paste, it picks what the pre-swap test will use with the new token. A served repo the new token cannot read is then a to-do: select the repo under the token's Repository access, rerun and paste the same token again.
4. Runs the pre-swap test ([Verify](#verify)) with the token only in the commands' environment.
5. Only when every check passed, swaps the login: `gh auth logout` for each github.com account, then `gh auth login --with-token` with the token on standard input. Logging out comes first because both tokens belong to the same GitHub user: a logout by user after the login would remove the new login too. The token is never on a command line, in a file or in the output.
6. Looks for every other GitHub API token on the machine and reports each one to remove by hand, by place and never by value; it removes nothing:
   - `GH_TOKEN`/`GITHUB_TOKEN` (`gh` prefers them over the stored login) in the environment, the shell startup files, the `env` block of `~/.claude/settings.json` and the poller's LaunchAgent plist;
   - a github.com internet password in the macOS keychain (a token a git credential helper stored, or a password saved for the website) and stored git credentials for github.com (remotes stay on SSH);
   - GitHub MCP servers in Claude Code's configuration (`~/.claude.json`, this clone's `.mcp.json`, and each served repo's `.mcp.json` in the agent container, read through it; when the container is not running, a note says those were not scanned).

   A finding stops the run after step 7.
7. Runs the after-swap checks ([Verify](#verify)).

`gh auth logout` does not revoke the old login: "The authentication configuration is only removed locally. This command does not revoke authentication tokens." (`gh auth logout --help`). Revoking the old "GitHub CLI" authorization at github.com/settings/applications is optional; the script prints it as a last note.

Standing rules, which no script can check:

- Browser automation that acts in the maintainer's browser (Claude in Chrome) must not reach a browser signed in to github.com: install the extension only in a dedicated Chrome profile that is not signed in to GitHub, and leave github.com out of its site permissions, which are not a boundary in auto mode; see [Claude in Chrome](containers.md#claude-in-chrome).
- The Claude desktop app's built-in browser pane keeps its own sign-ins: do not sign in to github.com there (same route as Claude in Chrome).

## Admin work

Merging happens in the browser, and so do rulesets and repo settings, apart from what `dispatch/setup-agents.sh` sets before the swap. A temporary broader login, if ever needed, is made with no agent session open on the host or in the agent container (`dispatch/install-launchd.sh pause`, and both agent views show none live) and logged out afterwards, restoring the restricted login. Under `exempt`, a plain `gh pr merge` by an admin login may merge without `--admin` (reasoned from spike #169, not tested), so while that login is in place only the deny rules stand in the way.

## Auto-merge

Keep auto-merge off on every repo the workflow serves. With it on, enabling auto-merge on a PR would be another way for an agent to merge. The setup script turns it off with the login it replaces; after the swap, GitHub may not return the setting to the token, and the script then reports it as unchecked.

## Verify

What the setup script checks. The maintainer reads its report; nothing here is run by hand.

The pre-swap test, before anything is logged out. With the current login, and before it opens the token form, the script picks the first served repo that has an open PR whose checks include a `test` check run, an open issue, a completed workflow run, and a label carried by neither (never one of the workflow's own labels). When GitHub refuses the stored login's token, it picks them with the new token instead, after the form. Then, with the new token only as `GH_TOKEN` in each command's environment, it runs one command per row of the [table](#the-token):

- `gh issue view <i> --json number,state` and `gh api repos/<owner>/<repo>/issues/<i> --jq .author_association`
- `gh issue comment <i>`, and the test comment deleted again (`gh api -X DELETE repos/<owner>/<repo>/issues/comments/<id>`)
- `gh issue edit <i> --add-label <label>`, then `--remove-label <label>`
- `gh pr view <n> --json mergeable`, `gh api repos/<owner>/<repo>/pulls/<n> --jq .author_association` and `gh pr diff <n>`
- `gh pr edit <n> --add-label <label>`, then `--remove-label <label>`
- `gh pr checks <n>`: passes when it lists a `test` row. It exits 8 while a check is pending and 1 when one has failed, even when the read worked, so it is judged by the output, not the exit code.
- `gh pr view <n> --json statusCheckRollup`: passes when the output has an entry with `"__typename": "CheckRun"` and name `test`. An empty rollup exits 0 but fails.
- `gh run view <id> --log`, `gh api repos/<owner>/<repo>/commits/main --jq .sha`, `gh api repos/<owner>/<repo>/rules/branches/main`, `gh label list --limit 5` and `gh api repos/<owner>/<repo>/rulesets`

The rest pass on exit 0. The test comment and the label are removed even when a check fails. If any check fails, the login is not swapped: the current login stays, and the failure is worth a ticket.

After the swap:

1. `gh auth status` shows one github.com login, with a fine-grained token (it starts `github_pat_`). `gh auth status --json` leaves the token out, so the script reads it with `--show-token`, keeps only whether it starts `github_pat_`, and never prints or stores it.
2. A merge with a deliberately wrong head `sha` against an open, mergeable PR, a non-draft one when there is one (a draft only when no other open PR is mergeable): `gh api -X PUT repos/<owner>/<repo>/pulls/<n>/merge -f sha=0000000000000000000000000000000000000000`. 403 means correct. 409 means the token can merge. Anything else (405, 422), or no mergeable PR, is inconclusive; when GitHub is still computing whether the open PRs can be merged (`mergeable` is `UNKNOWN`), a rerun in a moment is enough. The wrong `sha` keeps the check from ever merging. A 409 and an inconclusive answer both stop the script with a to-do.
3. On each served repo, `restrict-updates` reads back with a rule of type `update`, `enforcement` `active`, and `current_user_can_bypass` `exempt`. GitHub returns the bypass list only to callers who can edit the ruleset ("the bypass_actors property is only returned if the user making the API request has write access to the ruleset", GitHub Docs, *REST API endpoints for rules*). When `bypass_actors` is returned, it must be the Repository admin role alone, in `exempt` mode; when it is missing, the script says to read the ruleset's Bypass list in the browser: the Repository admin role alone, in exempt mode (the label the browser gives that mode is unconfirmed).

The maintainer's first run should confirm what the script assumes but no run has shown yet:

- whether a draft PR is enough for the wrong-sha merge, which matters only when the draft is the only mergeable PR: that holds only if GitHub checks the token's permission (403) before it refuses a draft (405);
- that `gh pr checks`, with its output not on a terminal, prints tab-separated rows with the check name first;
- that the fine-grained token reads `current_user_can_bypass`: `exempt` on `restrict-updates` and `never` on `protect-main`;
- that the fine-grained token can read `rules/branches/<branch>`;
- the label the browser's Bypass list gives exempt mode.

## The limit

GitHub's plans page lists protected branches under GitHub Pro's "Advanced tools and insights in private repositories", and GitHub Free covers private repos "with a limited feature set" (GitHub Docs, *GitHub's plans*). So private repos on GitHub Free don't enforce `protect-main`. There, a write deploy key's direct push to `main` goes through, and so would a workflow-token merge, with only the deny rules ([Requirements](setup.md#requirements)) and the skills in the way.

## The Actions token

The path: an agent can push a branch that edits `.github/workflows/` (SSH pushes carry no `workflow`-scope check). `ci.yml` runs on `pull_request`, and for a same-repo PR GitHub runs the workflow file from the PR branch. A workflow that asks for `permissions: contents: write` could then merge with `GITHUB_TOKEN`, since `protect-main` requires 0 approvals.

The fix: a ruleset of its own on each served repo, `restrict-updates`, targeting the default branch and holding only the "Restrict updates" rule, with the Repository admin role as the only bypass actor, in `exempt` mode. The setup script creates it while the login still has admin rights. GitHub's REST docs on `bypass_mode`: "When bypass_mode is exempt, rules will not be run for that actor and a bypass audit entry will not be created." (as quoted in spike #169). GitHub Docs, *Creating rulesets for a repository*: eligible bypass actors include "Repository admins, organization owners, and enterprise owners".

Why `exempt`: the ruleset first used "For pull requests only" mode (`pull_request`), and under it the maintainer's browser merge worked only after ticking "Merge without waiting for requirements to be met (bypass rules)" (#164, #169). Spike #169 ran both modes on a throwaway repo shaped like a served one:

- A browser merge of a green PR needs no box under `exempt`.
- A failing required `test` check still blocks it, in both modes: the check belongs to `protect-main`, whose rules still run.
- Under `exempt` the merge logs in the rule log as `pass`, with `restrict-updates`' `update` rule `skipped`, not as `bypass`: it stays visible but no longer stands out as a bypass.

The two gaps the docs left are answered (#169):

- GitHub accepted the Repository admin role (`RepositoryRole`, actor id 5) as the bypass actor on a personal-account repo, in both modes; `current_user_can_bypass` read back `pull_requests_only` and then `exempt`.
- The rule refuses a PR merge by a workflow's `GITHUB_TOKEN`. A same-repo PR's workflow with `contents: write` and `pull-requests: write`, after its required check passed, was refused on both routes in both modes: `PUT .../merge` with HTTP 405 and `gh pr merge --admin` through GraphQL (`mergePullRequest`), each with "Repository rule violations found" and "Cannot update this protected ref." The rule log showed `restrict-updates`' `update` rule `fail` and every `protect-main` rule `pass`.

A write deploy key counts as the owner for this bypass: under `exempt`, its push to `main` logged `restrict-updates`' `update` rule as `skipped`. So `protect-main` alone refuses direct updates to `main` by a write deploy key and by the admin identity: both were refused with "Changes must be made through a pull request." and "Required status check "test" is expected." (#169). That is why the `credentials` phase checks `protect-main` before it creates or resets `restrict-updates`, and the `container` phase checks it before it makes a repo's deploy key.

The placement, the maintainer's choice: `restrict-updates` stays a ruleset of its own. A bypass applies to "the rules in the ruleset" (GitHub Docs, *About rulesets*), and `exempt` skips every rule of the ruleset that lists the actor. With the rule inside `protect-main`, the admin role would skip `protect-main`'s rules too, the required `test` check included. In a ruleset of its own, only Restrict updates is skipped, and #169's rule log shows `protect-main`'s rules still ran for the maintainer's merge.
