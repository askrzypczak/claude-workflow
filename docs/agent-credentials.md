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

## What the script trusts

The setup script opens a pre-filled form for each token and stores the token pasted from it; it does not test what the token can do. The decisions behind that:

- The script trusts the token made from the pre-filled form (maintainer, 2026-11-02 (#195, #196)). It opens the form, reads the paste and stores it, and does not test what the token can do. A missing permission shows up when an agent first needs it, and is fixed by editing the token in the browser. The accepted cost: if Contents write gets ticked on the form, agents can merge and nothing reports it. #164 found that such a token merges past `restrict-updates`, and `protect-main` requires zero approvals, so the form is then all that stops an agent merging. The rule in [Why](#why) stands, but the script no longer checks it. This reverses part of #182: it removes the pre-swap test, which needed an open PR with a `test` check run, an open issue and a completed workflow run, and wrote a comment and labels to live work; and it removes the merge probe on the host's and the container's tokens.
- A paste must start `github_pat_` (maintainer, 2026-11-02 (#195, #196)), because the login swap logs out every account first. A paste that `gh auth login` refuses leaves no login, and the to-do says how to log in.
- Nothing checks that the container's token sees every served repo (maintainer, 2026-11-02 (#195, #196)): `check`'s `gh repo view` reads only the first clone. The accepted cost: a repo not selected on the token passes setup, and its poller `gh` calls fail once dispatch runs.

The after-swap `restrict-updates` read-back is the only repo-access check of a newly pasted host token, and it runs after the swap: a served repo the new token cannot see is a to-do naming the repo and how to select it on the token (epic #195 orchestrator, not human-approved).

## The token

The host's token is a fine-grained personal access token. The script opens GitHub's token form pre-filled with everything the form's URL parameters allow: the name (`claude-workflow-agents-` and the date), a description, the resource owner and the six permissions. The form cannot pre-fill the repositories, and the expiry is left for the maintainer to pick. The container's token has the same six permissions ([The container's token](#the-containers-token)).

- Resource owner: the maintainer.
- Repository access: "Only select repositories", the repos the workflow serves.
- Account permissions: none.
- Repository permissions, these six and nothing else: Metadata read, Contents read, Actions read, Commit statuses read, Issues write, Pull requests write.
- Expiry: choose one, or none: "Infinite lifetimes are allowed but may be blocked by a maximum lifetime policy set by your organization or enterprise owner." (GitHub Docs, *Managing your personal access tokens*). With an expiry, note the date and rotate the token before it: an expired token makes every `gh` call on the host fail, the maintainer's sessions' and the setup script's (the `container` phase reads each served repo with it). To rotate, rerun `dispatch/setup-agents.sh credentials` and answer Yes to "Create a new token and swap it in?". An expired token is rotated the same way, by rerunning `dispatch/setup-agents.sh credentials`: the script sees that GitHub refuses the stored token, skips the ruleset step and goes straight to the token form, with no question.

Actions stays read: write would let the token dispatch or re-run workflows (`POST /repos/{owner}/{repo}/actions/workflows/{workflow_id}/dispatches` and `POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun` are Actions write), and nothing uses that.

Checks is not in the list. GitHub offers fine-grained tokens no Checks permission and lists "Using fine-grained personal access token to call the Checks API." among their limitations (GitHub Docs, *Managing your personal access tokens*). Check runs feed `gh pr checks` and `--json statusCheckRollup` (the poller's PR list in `dispatch/poller/io.ts`). On public repos they are expected to work through the token's read access to public repos ("Tokens always include read-only access to all public repositories on GitHub.", same page), but GitHub's docs do not confirm it, and on a private repo nothing grants them. A failed check read, or an empty rollup, stops the poller's conflict and CI-fix sessions, and the token cannot serve the workflow as documented. Setup does not test this ([What the script trusts](#what-the-script-trusts)), so on a private repo it shows first as those sessions stopping.

What each `gh` command needs, from the skills, the agents, `plugins/ticket-workflow/scripts/`, `dispatch/poller/` and `dispatch/setup/`:

| Commands | Used by | Permission |
|---|---|---|
| `gh issue view`, `gh issue list` (including `--search`) | skills, agents, poller | Issues: read |
| `gh issue create`, `gh issue edit` (labels, assignee, body), `gh issue comment`, `gh issue close` | skills, poller, `integrate-child.sh` | Issues: write |
| `gh pr view`, `gh pr list`, `gh pr diff`, `gh pr checkout` (the API lookup; the fetch is git over SSH) | skills, agents, poller | Pull requests: read |
| `gh pr create`, `gh pr edit --add-label`, `gh pr comment` | skills, poller | Pull requests: write |
| `gh pr checks`; `--json statusCheckRollup` on `gh pr view` and `gh pr list` | skills, poller | Commit statuses: read for status contexts. Check runs: no fine-grained permission covers them (the Checks API is unsupported); expected to work on public repos through the token's read-only public access; unconfirmed |
| `gh run list`, `gh run view --log-failed` | `fix-ci` | Actions: read |
| `gh api repos/{owner}/{repo}/issues/N` (`.author_association`, `.id`), `.../issues/N/comments`, `GET .../issues/E/sub_issues` | skills, agents | Issues: read |
| `gh api -X POST .../issues/E/sub_issues` | `file-ticket`, `orchestrate-epic` | Issues: write |
| `gh api repos/{owner}/{repo}/pulls/N` (`.author_association`), `.../pulls/N/comments` | skills | Pull requests: read |
| `gh api repos/<repo>/commits/main` | poller | Contents: read |
| `gh label list`, `gh label create` | `setup-labels.sh` | Issues: read / write |
| `gh api repos/<owner>/<repo>` (the default branch, admin rights, the auto-merge setting) | the setup script's `credentials` and `container` phases | Metadata: read |
| `gh api repos/<owner>/<repo>/rules/branches/<branch>` | the `credentials` and `container` phases' `protect-main` check | Metadata: read (expected; unconfirmed until the first run) |
| `gh api repos/<owner>/<repo>/rulesets/<id>` | the setup script's `protect-main` check and [Verify](#verify) | Metadata: read |
| Merging a PR (`PUT .../pulls/N/merge`) | nothing in the workflow | Contents: write, which the token lacks |

Metadata read comes with every fine-grained token. `plugins/ticket-workflow/scripts/ticket-labels.ts` runs in Actions on the caller workflow's `GITHUB_TOKEN` (`contents: read`, `issues: write`), not on the local login. The setup script's ruleset and auto-merge writes need admin rights, which the token lacks: it makes them with the login it replaces, before the swap.

## The container's token

The agent container has a `gh` login of its own, set up by the `container` phase, so it can be revoked alone. The phase opens the same pre-filled token form as [the host's](#the-token), named `claude-workflow-container-` and the date, with the same six permissions: select the served repos under Repository access, keep Contents read-only and pick an expiry. The host's fine-grained token is accepted too, but a separate one is recommended.

- A paste that does not start `github_pat_` is refused. Otherwise `gh auth login --with-token` stores the token in the container as `node`, the token on standard input; it lands in `~/.config/gh/hosts.yml` there, mode 0600 (#164). Nothing tests what it can do ([What the script trusts](#what-the-script-trusts)), so keep Contents read-only on the form.
- A later run checks only that the container has one working fine-grained login, and does not read its token.
- A new token changes the container's `gh` login, so the phase first pauses dispatch and refuses while a session is live in the container.
- When the token expires, or must be rotated, log it out in the container and rerun the phase, which asks for a new one:

      docker exec -u node claude-workflow-agent gh auth logout --hostname github.com --user <login>
      dispatch/setup-agents.sh container

  When GitHub refuses the stored login, the phase stops with that logout command in its to-do.
- Its expiry is what makes every poll log `[<prefix>] poll failed` and every container session's `gh` call fail: note the date.
- A served repo added later needs this token edited in the browser too, so it can see the repo. Nothing checks this, and until it is done the poller's `gh` calls for that repo fail.

## The Claude token

Container sessions sign in to Claude with a token from `claude setup-token`, which the `container` phase asks for: run `claude setup-token` in another terminal on the host, log in with the Claude account the agents use, and paste the token it prints at the phase's hidden prompt. The phase writes it to `~/.config/claude-workflow/claude-agent.env` as `CLAUDE_CODE_OAUTH_TOKEN=<token>`, mode 0600, and `docker run --env-file` passes it to the container. Every run checks that the file holds that line and has mode 0600, and sets the mode when it differs.

- Every container session can read it: it is in each session's environment ([What it can't stop](containers.md#what-it-cant-stop)).
- `claude setup-token` makes "a one-year OAuth token", and "It can only make model requests, so it can't establish Remote Control sessions or fetch claude.ai connectors." (Claude Code docs, *Authentication*). So container sessions have neither, and are answered through `docker exec` ([Talking to sessions](containers.md#talking-to-sessions)).
- A session signed in this way starts in manual permission mode and stops at its first Bash call (#164, answer 5), so the poller launches sessions with `--permission-mode auto`.
- On the host, the deny rules keep the env file from the Read and Edit tools; a Bash command can still read it ([Sessions on the host](containers.md#sessions-on-the-host)).
- Revoking: Claude Code's docs (*Authentication*) describe no way to revoke a `setup-token` token, and spike #164 found none.
- Rotating: delete the env file, then rerun `dispatch/setup-agents.sh container`, which asks for a new token. The env file is part of the container's config label, so the container is replaced, which refuses while a session is live in the container. The old token stays valid until it expires.

## Wiring

What `dispatch/setup-agents.sh credentials` does, in order. Each step checks first and does nothing when its work is already done, so a rerun is safe. It first lists everything it can read as missing and stops before any change; otherwise it stops at the first step that needs the maintainer and prints what to do. With `--dry-run` it runs the reads, prints what each write would do, and goes through every step without stopping.

1. Pauses dispatch (`dispatch/install-launchd.sh pause`, which also ends a poll running in the agent container) and refuses to go on while a session is live on the host (`claude agents`) or in the agent container (`docker exec claude-workflow-agent claude agents`), idle sessions included. It names each with its stop command by id: `claude stop <id>`, or `docker exec claude-workflow-agent claude stop <id>`. Dispatch stays paused until a full setup run passes every phase and resumes it, or until `dispatch/install-launchd.sh resume`. A rerun pauses it again.
2. On each served repo (this clone's, then those in the [dispatch config](../dispatch/README.md#onboarding-a-repo)), with the current login, it first handles `protect-main`: the default branch must have an active ruleset with a `pull_request` rule that this login cannot bypass (`current_user_can_bypass` reads `never`). It finds that ruleset through `rules/branches/<branch>` and the rulesets behind those rules, not by matching names. Under the admin login the ruleset's bypass list must also be empty; the fine-grained login cannot read the list, so it gets a note to check it in the browser.
   - Under an admin login, when no active ruleset puts a `pull_request` rule on the default branch, the step creates `protect-main` on `~DEFAULT_BRANCH`: active, with no bypass actors, the `deletion` and `non_fast_forward` rules and a `pull_request` rule with no required approvals. It requires no status checks, since a repo may have no CI yet; a note says to add them in the browser once the repo has CI. The step then checks `protect-main` again, and `restrict-updates` is not created or reset until that check passes. A create GitHub refuses is a to-do quoting GitHub's answer, and that repo gets no `restrict-updates`.
   - An existing ruleset is never edited, replaced or deleted: a bypassable one, or one with bypass actors, is a to-do fixed in the browser.
   - Then the step creates the `restrict-updates` ruleset ([The Actions token](#the-actions-token)), or puts it back when it drifted, and turns auto-merge off ([Auto-merge](#auto-merge)). Other rulesets are left alone.
   - Under a login without admin rights, such as the fine-grained one on a rerun, no ruleset or setting is changed and the step checks what it can read: `protect-main`, the ruleset as in [Verify](#verify), and auto-merge, which it reports as unchecked when GitHub does not return the setting. A missing `protect-main` is a to-do naming both fixes: create it in the browser and rerun, or log in with an admin login (`gh auth login`) and rerun `dispatch/setup-agents.sh credentials`, which creates it and then asks for a new fine-grained token.
   - Last, under any login, it runs `plugins/ticket-workflow/scripts/setup-labels.sh <repo>`, which creates the workflow's missing labels and leaves existing ones alone. A failing run is a to-do quoting the script's answer.

   A repo the token cannot see (HTTP 404) is a to-do: select it under the token's Repository access, then rerun. Each served repo is handled even when an earlier one has a to-do, and the step stops at its end. When GitHub refuses the stored login's token (it expired), nothing can be read or changed as that login: the script skips this step, the `protect-main` check and the labels included, with a note per repo, and the after-swap checks read `restrict-updates` back.
3. Under the fine-grained login it first asks "Create a new token and swap it in? [y/N]"; No skips to step 5. Otherwise it opens the pre-filled token form ([The token](#the-token)), lists the repos to select, and reads the token at a prompt that does not echo it. An empty paste, or one that does not start `github_pat_`, stops the run before anything is logged out. With the stored token expired, it asks nothing and goes straight to the form. How it tells a fine-grained login: `gh auth status --json` leaves the token out, so the script reads it with `--show-token`, keeps only whether it starts `github_pat_`, and never prints or stores it.
4. Swaps the login: `gh auth logout` for each github.com account, then `gh auth login --with-token` with the token on standard input. Logging out comes first because both tokens belong to the same GitHub user: a logout by user after the login would remove the new login too. A token `gh auth login` refuses leaves no login, and the to-do says how to log in. The token is never on a command line, in a file or in the output.
5. Looks for every other GitHub API token on the machine and reports each one to remove by hand, by place and never by value; it removes nothing:
   - `GH_TOKEN`/`GITHUB_TOKEN` (`gh` prefers them over the stored login) in the environment, the shell startup files, the `env` block of `~/.claude/settings.json` and the poller's LaunchAgent plist;
   - a github.com internet password in the macOS keychain (a token a git credential helper stored, or a password saved for the website) and stored git credentials for github.com (remotes stay on SSH);
   - GitHub MCP servers in Claude Code's configuration (`~/.claude.json`, this clone's `.mcp.json`, and each served repo's `.mcp.json` in the agent container, read through it; when the container is not running, a note says those were not scanned).

   A finding stops the run after step 6.
6. Runs the after-swap checks ([Verify](#verify)).

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

After the swap, the script checks the login and each served repo's `restrict-updates`. It does not test the token's permissions ([What the script trusts](#what-the-script-trusts)).

1. `gh auth status` shows one github.com login.
2. On each served repo, `restrict-updates` reads back with a rule of type `update`, `enforcement` `active`, and `current_user_can_bypass` `exempt`. GitHub returns the bypass list only to callers who can edit the ruleset ("the bypass_actors property is only returned if the user making the API request has write access to the ruleset", GitHub Docs, *REST API endpoints for rules*). When `bypass_actors` is returned, it must be the Repository admin role alone, in `exempt` mode; when it is missing, the script says to read the ruleset's Bypass list in the browser: the Repository admin role alone, in exempt mode (the label the browser gives that mode is unconfirmed). A repo the new token cannot see (HTTP 404) is a to-do: select it under the token's Repository access, then rerun.

The maintainer's first run should confirm what the script assumes but no run has shown yet:

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
