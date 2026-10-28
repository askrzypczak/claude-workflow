# claude-workflow

> [!CAUTION]
> This is a personal experiment, not a supported product. It runs autonomous agents with your credentials and can start unattended sessions on your machine. Use it at your own risk, and read [What this can do on your machine](#what-this-can-do-on-your-machine) before enabling dispatch.

Claude Code plugin marketplace (`askrzypczak-plugins`) for an orchestrated, ticket-driven agent workflow.

## Contents

Plugin `ticket-workflow`:

- Skills:
  - `work-ticket`: works a GitHub issue end to end.
  - `address-feedback`: handles review feedback on the PR.
  - `resolve-conflicts`: merges `origin/main` into a conflicting `issue-N-*` PR branch, runs `npm run check`, publishes. Stops with `needs input` on semantic conflicts; never rebases or force-pushes.
  - `fix-ci`: reads the failing run's logs on an `issue-N-*` PR, fixes the cause, runs `npm run check`, pushes. Stops with `needs input` for infrastructure, secrets or required-check changes; never force-pushes.
  - `file-ticket`: files a ticket in the house format (type-prefixed title, Problem, Proposed change, checkable acceptance criteria, labels per [Ticket conventions](#ticket-conventions)) after verifying its claims and searching for duplicates. Never sets `ready` or `skip-plan`. After filing an epic with children it links them as sub-issues, runs the `spec-auditor` over the set, applies the findings it verifies to the tickets it just filed, and asks the human only about the unclear ones (the auditor itself writes nothing to GitHub).
  - `orchestrate-epic`: runs an epic's children as `work-ticket` sub-agents into an `epic-E` branch, stands in at the plan gates (escalating only product questions), reviews and integrates each child PR, then opens one epic PR to `main` for the human to merge. See [Orchestrating an epic](#orchestrating-an-epic).
- Subagents: `contract-writer` (opus, medium) writes stubs and failing tests first; `implementer` (haiku, xhigh; opus medium or opus xhigh per the approved plan) builds the code that makes them pass; `reviewer` (opus, xhigh, read-only) reviews complex diffs; `spec-auditor` (opus, medium, read-only; sonnet, medium for a `simple` ticket plan) audits epics, and each ticket's plan, for necessity; `first-reviewer` (fable, xhigh, read-only) reviews each orchestrate-epic child PR for the maintainer. Dispatched sessions run on opus at xhigh; orchestrate-epic children on opus at xhigh, or sonnet at medium for docs-only or single-adapter children; the orchestrate-epic session and its per-PR `first-reviewer` on fable at xhigh, because they stand in for the human reviewer (plan gates, gate questions, first PR review). Effort rule for any retune: never `high`; opus at `medium` or `xhigh`; sonnet only at `medium`, with opus `medium` wherever more than that is wanted.
- Hooks: a git guard and a comment guard (see [Requirements](#requirements) and [Trust rule](#trust-rule-for-public-repos)).

Outside the plugin, `dispatch/` holds `agent-poller.sh`, a multi-repo poller that starts background sessions for `ready` + `agent-ok` tickets. It runs from this clone. See [Dispatch](#dispatch-automatic-ticket-pickup) and `dispatch/README.md`.

## Install

In Claude Code:

    /plugin marketplace add askrzypczak/claude-workflow
    /plugin install ticket-workflow@askrzypczak-plugins

From a shell:

    claude plugin marketplace add askrzypczak/claude-workflow
    claude plugin install ticket-workflow@askrzypczak-plugins --scope project

Local development:

    claude plugin marketplace add /path/to/claude-workflow
    claude plugin update ticket-workflow@askrzypczak-plugins
    /reload-plugins
    claude plugin validate .
    npm run typecheck

## Requirements

A consuming project needs:

- `npm run check`: build, lint, typecheck and tests. It is the definition of done and what CI runs.
- Ticket labels, created with `plugins/ticket-workflow/scripts/setup-labels.sh [owner/repo]` (idempotent: existing labels are left untouched; `--update` overwrites their colour and description). See [Ticket conventions](#ticket-conventions).
- `gh` authenticated (SSH remote, `gh auth login`) and `jq` on PATH.
- The plugin enabled in `.claude/settings.json`: `enabledPlugins` with `ticket-workflow@askrzypczak-plugins`, plus an `extraKnownMarketplaces` entry for `askrzypczak/claude-workflow`.
- Deny rules in `.claude/settings.json`. The guards ship with the plugin (`hooks/hooks.json`): the git guard blocks pushes to `main`/`master`, force pushes and `gh pr merge`; the comment guard enforces the [trust rule](#trust-rule-for-public-repos). The project only adds the deny rules:

        "permissions": {
          "deny": [
            "Bash(gh pr merge *)",
            "Bash(git push --force*)",
            "Bash(git push -f*)"
          ]
        }
- Optional, for [dispatch](#dispatch-automatic-ticket-pickup): an entry in the poller config and a directory trusted by Claude Code.
- Optional: an unused-export / dead-file check inside `npm run check` (for example knip in production mode, excluding test suites; default knip treats test files as entry points).
- Optional, for [label cleanup](#label-cleanup-on-close): a caller workflow.
- The machine's only GitHub API credential is a fine-grained token that cannot merge, and the maintainer merges in the browser. See [Agent credentials](#agent-credentials).

## Agent credentials

Agent sessions and the poller use the machine's `gh` login. Set it up so that it cannot merge, and only the maintainer merges, in the browser. These are the maintainer's steps; no agent applies them.

### Why

- Merging a PR (`PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge`) needs "Repository permissions for "Contents"" (write); opening one (`POST /repos/{owner}/{repo}/pulls`) needs only "Repository permissions for "Pull requests"" (write) (GitHub Docs, *Permissions required for fine-grained personal access tokens*). The token below has no Contents write.
- A fine-grained token is limited to one owner: "The token will only be able to access resources owned by the selected resource owner." (GitHub Docs, *Managing your personal access tokens*).
- A workflow's `GITHUB_TOKEN` is stopped by the ruleset rule "Restrict updates": "If selected, only users with bypass permissions can push to branches or tags whose name matches the pattern you specify." (GitHub Docs, *Available rules for rulesets*). Details in [The Actions token](#the-actions-token).
- Agents get no route into the maintainer's logged-in browser on github.com ([Wiring](#wiring)).

Together, only the maintainer can merge. Nothing in the workflow needs Contents write through the API: branches are pushed with git over SSH, which cannot merge a PR, and `protect-main` refuses direct pushes to `main`; `orchestrate-epic` folds children into `epic-E` with a local merge and a push (`plugins/ticket-workflow/scripts/integrate-child.sh`); auto-merge stays off.

### The token

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

### Wiring

1. Pass the pre-swap test in [Verify](#verify) first. It pauses dispatch.
2. `gh auth logout`, then `gh auth login --with-token` with the token pasted on standard input (end with Ctrl-D), so it is never on a command line.
3. Remove every other GitHub API token on the machine: `GH_TOKEN`/`GITHUB_TOKEN` exports (`gh` prefers them over the stored login), stored git credentials for github.com (remotes are SSH), and any GitHub MCP server or connector token in Claude Code's configuration.
4. Keep git over SSH.
5. Browser automation that acts in the maintainer's browser (Claude in Chrome) must not be allowed on github.com: leave github.com out of the extension's site permissions. The Claude desktop app's built-in browser pane keeps its own sign-ins: do not sign in to github.com there (same route as Claude in Chrome).
6. Run the after-swap checks in [Verify](#verify). The last one resumes dispatch.

### Admin work

Merging, rulesets and repo settings happen in the browser. A temporary broader login, if ever needed, is made with no agent sessions running (`dispatch/install-launchd.sh pause`, and `claude agents` shows none live) and logged out afterwards, restoring the restricted login.

### Auto-merge

Keep auto-merge off on every repo the workflow serves. With it on, enabling auto-merge on a PR would be another way for an agent to merge.

### Verify

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

### The limit

GitHub's plans page lists protected branches under GitHub Pro's "Advanced tools and insights in private repositories", and GitHub Free covers private repos "with a limited feature set" (GitHub Docs, *GitHub's plans*). So private repos on GitHub Free don't enforce `protect-main`. There, a direct push to `main` over SSH and a workflow-token merge are stopped only by the deny rules (#136 adds them) and the skills.

### The Actions token

The path: an agent can push a branch that edits `.github/workflows/` (SSH pushes carry no `workflow`-scope check). `ci.yml` runs on `pull_request`, and for a same-repo PR GitHub runs the workflow file from the PR branch. A workflow that asks for `permissions: contents: write` could then merge with `GITHUB_TOKEN`, since `protect-main` requires 0 approvals.

The fix: add "Restrict updates" to each served repo's `protect-main`, with the Repository admin role as the only bypass actor, in "For pull requests only" mode. Workflows should then be unable to merge into or push to `main`, while the maintainer's browser merge still works.

GitHub Docs, *Creating rulesets for a repository*: eligible bypass actors include "Repository admins, organization owners, and enterprise owners". On the "For pull requests only" mode: "The selected actor is now required to open a pull request to make changes to a repository" and "The actor can then choose to bypass any branch protections and merge that pull request." The REST schema says "pull_request means that an actor can only bypass rules on pull requests."

Gaps:

- The docs list repository admins as bypass actors without limiting them to organization repos, but do not say in so many words that a personal-account repo offers that actor and mode. Confirm it in the bypass dialog when adding the rule.
- The docs describe the rule in terms of pushes, and the REST schema as "Only allow users with bypass permission to update matching refs". A merge updates `main`'s ref, and the pull-requests-only text treats bypass as what lets an actor merge, but the docs do not say in words that a PR merge by an actor without bypass is refused. `GITHUB_TOKEN` is such an actor: the GitHub Actions app is not on the bypass list.

If either fails, the workflow-token merge path stays open on that repo, and only the agent-side guardrails stand in its way.

The cost: with the rule in place, every maintainer merge into `main` is a bypass, and a bypass lifts every rule in that ruleset for the merge, including the required `test` check. Check CI before merging.

The alternative: put "Restrict updates" in a ruleset of its own with the admin bypass, and leave `protect-main` with no bypass actors. A bypass applies to "the rules in the ruleset" (GitHub Docs, *About rulesets*), so `protect-main`'s required check stays binding. The maintainer picks one placement when applying the step.

## Ticket conventions

GitHub Issues is the source of truth; agents use `gh`. Ask an agent to "file a ticket for X" and the `file-ticket` skill writes it in this format: a `bug:`, `feature:`, `chore:` or `spike:` title prefix, Problem, Proposed change and checkable acceptance criteria sections, and the labels below.

### Labels

- State: `ready` -> `in-progress` -> `needs-review`; `blocked` while waiting on something. With a `Blocked by #M` line in the body, label cleanup removes `blocked` once #M closes; without one, the human does.
- Type: `bug`, `feature`, `chore`.
- Dispatch: `agent-ok` (safe for unattended agents), `skip-plan` (launch with `work-ticket N auto`, no plan sign-off), `agent-failed` (set by the poller when a session failed), `orchestrate-epic-run` (set by `orchestrate-epic` on the children it runs and on the run's PRs; the poller launches nothing for them, even with `agent-ok`; to hand a child back to normal dispatch, remove it from the child and its PR and restore `agent-ok`).

`ready` means a human reviewed the ticket and approved its premise for work. It does not approve every acceptance criterion (AC): AC are proposals until the plan gate, where the human approves them as a diff against the ticket. **Only the maintainer adds `ready`.** Agents that file tickets never set `ready` or `skip-plan`. They may set type labels, `agent-ok` and `blocked` (with `Blocked by #M`); the maintainer removes `agent-ok` during review if needed.

### One ticket, one worktree

One ticket = one worktree = one branch (`issue-N-slug`) = one PR containing `Closes #N`. A spike (`spike:` title, `chore` label) is the exception: its output is a findings comment on the ticket, with no worktree, branch or PR, and the human closes it on accepting the findings. Agents may push their own `issue-N-*` branch; humans merge. Nobody pushes to `main`, force-pushes, or merges PRs into `main` from an agent session. The one exception to merging is `orchestrate-epic`, which merges child branches into its `epic-E` branch (see [Orchestrating an epic](#orchestrating-an-epic)).

### Dependencies

Write `Blocked by #M` in the issue body (also `#3, #5` or `#3 and #5`; several lines allowed) and add `blocked`. [Label cleanup](#label-cleanup-on-close) removes it.

### Epics

Write `Part of #N` in a child ticket's body to link it to its epic; the epic body lists its children. Unlike `Blocked by`, it carries no state (label cleanup ignores it). For an epic, `file-ticket` also links each child as a native sub-issue (GitHub's sub-issues API), which drives the epic's progress indicator; linking the children of epics filed earlier is done by hand.

### Orchestrating an epic

Use `orchestrate-epic` (`/ticket-workflow:orchestrate-epic E`) instead of the poller when an epic's dependency chain makes the human's attention the bottleneck. One session works the children as `work-ticket` sub-agents, stands in at their plan gates and reviews each PR as first reviewer through a fresh `first-reviewer` sub-agent whose report it judges, keeping the final call, escalating only product questions (a recorded maintainer decision, or user-visible behaviour) to the human. The children read standing decisions and sibling ownership from a brief, a local file outside git deleted at the end, instead of long launch prompts. It swaps `agent-ok` for `orchestrate-epic-run` on the children and labels the run's PRs, so the poller leaves them alone. The children do not need `ready`: running the skill hands their readiness to the orchestrator, which judges them and the follow-ups it adds. The rule that only the maintainer adds `ready` is unchanged elsewhere.

The children's PRs target an `epic-E` branch, not `main`. After its review, with CI green and the PR mergeable, the orchestrator runs `plugins/ticket-workflow/scripts/integrate-child.sh` to merge each child into `epic-E` (a local merge and a plain push) and close the child issue. The human still merges every PR that reaches `main`: one epic PR, read by its merge commits and the child PRs' review maps. Spike children are not run inside an epic: the orchestrator leaves them out, and the human works each on its own with `work-ticket`; children blocked by one wait until it closes.

### Architecture rules

Optional. When a project has an Architecture section (a heading titled `Architecture` in its root `CLAUDE.md`), `file-ticket`, the `work-ticket` plan, `spec-auditor` and `reviewer` check designs against it; [Workflow](#workflow) has the detail. When a project adds or changes an architecture rule, re-audit its open tickets for designs that conflict with the rule instead of only refreshing their paths and names.

### Decision log

Optional. When a project has a Decision log section (a heading titled `Decision log` in its root `CLAUDE.md`, naming a folder), each ticket's PR commits one Markdown file there, `<folder>/<N>-<slug>.md`, with an entry per decision: who decided, the options weighed with the chosen one first, where it lives in the code, and whether it still stands. Decisions only agents saw are logged too, marked `not human-approved`. `work-ticket` writes the file, `address-feedback` and `orchestrate-epic` add to it, `spec-auditor` flags a plan that reverses an active entry without declaring it, and `reviewer` flags a choice in the diff that the log does not record. The format is in `plugins/ticket-workflow/skills/work-ticket/decision-log.md`. Without the section nothing changes, except that the `implementer` always reports the decisions the plan left open.

### Trust rule for public repos

Comments on a public repo can come from anyone, so an agent reading them is open to prompt injection. The skills pipe `gh` output through `scripts/trusted-comments.ts`, which keeps only comments, reviews and review comments whose author association is `OWNER`, `MEMBER` or `COLLABORATOR`. Everything else (or a missing association) is dropped; the script reports the count and authors' logins, never bodies, and agents report the count. The filter fails closed: it exits non-zero on comment-like fields it cannot filter (e.g. `latestReviews`), and the agent then stops and tells the human.

Issue and PR bodies are not filtered, so the skills also check the author's association and stop if it is not one of the three. The poller launches only owner-authored tickets, but manual launches can name any issue. `resolve-conflicts` acts only on same-repo PRs by trusted authors and never checks out a fork's code.

The plugin's PreToolUse hook (`hooks/guard-comments.sh`, tested by `hooks/test-guard-comments.sh`) denies Bash commands that read comments or reviews unless piped into `trusted-comments.ts`. That covers `--comments`, `--json` with comment/review fields, `gh api` comment/review endpoints, graphql, and `curl`/`wget` of API comment endpoints. It denies regardless of piping: timelines, GitHub issue/PR/discussion page URLs (also via `WebFetch`), `gh api` issue/PR paths built from shell variables, and `--json` listings that include `body`. It fails closed if `jq` is missing. It is a text-matching guardrail, not a security boundary.

Limits:

- `MEMBER` means anyone in the owning organisation, even without access to this repo; `COLLABORATOR` includes read-only collaborators.
- The filter checks authors, not content: a trusted user who quotes untrusted text passes it through.

Stopgap: GitHub's temporary interaction limits (repo Settings, Moderation options) restrict commenting to collaborators for a period.

### Working a ticket

Agents follow the `work-ticket` skill with an explicit issue number, run manually (`/ticket-workflow:work-ticket N`) or launched by the poller. Agents never pick tickets themselves. See [Workflow](#workflow).

## Dispatch (automatic ticket pickup)

A poller runs every 3 minutes from a macOS LaunchAgent and starts one interactive background Claude Code session per eligible ticket, across all configured repos. Sessions show up in `claude agents`.

A ticket is picked up when it is open, authored by the repo's configured `owner`, and labelled `agent-ok` + `ready` (and not `in-progress`, `blocked`, `agent-failed` or `orchestrate-epic-run`). The session is named `<sessionPrefix>-<issue>` (e.g. `app-12`) and runs `work-ticket`.

The poller, installer and config run from the local clone of this repo, not the plugin cache: a LaunchAgent needs a stable path.

The poller is TypeScript run by Node 24. It needs `node` on the launchd `PATH`, which is minimal (the entrypoint adds fnm's default bin, `~/.local/bin` and Homebrew to it), and the clone's npm dependencies: the installer runs `npm ci` in the clone; rerun it (or the installer) after pulling a change to `package-lock.json`. It also needs `gh` and `claude`.

### What this can do on your machine

Labels on GitHub start unattended agent sessions locally:

- Sessions run as you, with your `gh` token. They can read and write every repo that token reaches, not only the configured one.
- They work in `dir` on your files, with your credentials and tools, under the permission mode from your Claude Code settings for that directory (user, project or local `settings.json`, `permissions.defaultMode`). By default that is Claude Code's default mode, so sessions stop and show as `blocked` in `claude agents` at permission prompts. `acceptEdits` widens what they do without asking; the poller does not check this setting, so `bypassPermissions` there lets unattended sessions act with no prompts.
- Every session uses your Claude usage limits and costs money if you pay per token. Several `ready` tickets start several sessions at once.
- At most 10 sessions are live at once across all repos (`CLAUDE_MAX_SESSIONS`; per-repo `maxSessions`). Extra tickets log `deferred #N: at session cap` and start on a later poll.
- Launch flags are logged on every launch. Anyone who can get `owner` to label an issue `ready` can start a session, so keep labelling rights tight.

### Onboarding a repo

1. Meet the [requirements](#requirements) (`npm run check`, deny rules, plugin enabled).
2. Create the labels: `setup-labels.sh owner/repo`.
3. Optionally add the [label-cleanup caller](#label-cleanup-on-close).
4. Add the repo to `~/.config/claude-workflow/repos.json` (`dispatch/repos.example.json` is a starting point; the installer refuses to run without the file):

        [
          {
            "repo": "example-owner/example-app",
            "dir": "~/Projects/example-app",
            "sessionPrefix": "app",
            "owner": "example-owner"
          }
        ]

   - `repo`: `owner/name`.
   - `dir`: the main checkout sessions start in (not a worktree).
   - `sessionPrefix`: names sessions; unique per repo.
   - `owner`: the only ticket author whose tickets are launched.
   - `maxSessions` (optional, positive integer): cap on live sessions for this repo.
5. Trust the directory: run `claude` once in `dir`, accept the prompt, exit. `claude --bg` fails in an untrusted workspace.
6. Dry run: `npm ci` in the clone once, then `dispatch/agent-poller.sh --dry-run` logs which tickets would launch and with which flags, and launches nothing.
7. Install the LaunchAgent once, from the main clone (not a worktree): `dispatch/install-launchd.sh`.
   - The installer first runs `npm ci` in the clone (a failure aborts with nothing installed).
   - The agent polls as soon as it loads, so the installer repeats the dry run, shows its output and asks `Install and start polling? [y/N]` before writing or starting anything. Anything but `y`, no input, a failing dry run, or a poll already running aborts. `--yes` skips the question for scripted reinstalls.
   - launchd only gives the job `HOME` and `PATH`, so the dry run drops `CLAUDE_MAX_SESSIONS` from your shell. Set it in the plist's `EnvironmentVariables` for the real poller.
   - Remove with `dispatch/install-launchd.sh uninstall`. Adding repos later only needs a config edit.

Migrating from an older single-repo poller: pass `--legacy-label <its launchd label>` (booted out, plist removed) and `--migrate-state <its state dir> <sessionPrefix>` (copies `launched.json` / `conflicts.json` into the per-repo state, never overwriting) so in-flight tickets are not relaunched. Keep the old session naming as `sessionPrefix` so reconciliation finds live sessions. With these flags the dry run runs before the migration and says so.

### Daily use

1. Write and review the ticket, then add `ready`. Within ~3 minutes a session starts.
2. In `claude agents`, a `blocked` session is waiting for you: usually plan sign-off, also questions and permission prompts. Use `claude attach <prefix>-<issue>`, answer, and leave it running.
3. For easy tickets add `skip-plan`: the session runs `work-ticket N auto` and skips sign-off (it still asks if the ticket is ambiguous or risky).
4. When it finishes, the ticket is `needs-review` with a PR (a spike: with a findings comment and no PR). Review, then use `address-feedback`.

### Conflict resolution

After launching tickets, the poller lists open, same-repo PRs by `owner` on `issue-N-*` branches whose `mergeable` is `CONFLICTING` and launches `claude --bg --name <prefix>-N-conflict "/ticket-workflow:resolve-conflicts N"`. The skill merges `main` into the branch (merge, not rebase: force-push is not allowed).

- Fork PRs and PRs by anyone other than `owner` are skipped and logged, whatever the branch name. The skill repeats the check (not a fork, author `OWNER`, `MEMBER` or `COLLABORATOR`) and only takes the branch from `origin`, so manual launches are covered too.
- `UNKNOWN` (GitHub computes it lazily) is retried next poll; `BEHIND` without conflicts is ignored.
- Skipped when `<prefix>-N` is `working` or `blocked` (it owns the branch), a `<prefix>-N-conflict` session is alive, or the ticket is closed, not `agent-ok`, not by `owner`, has `agent-failed`, or the PR or ticket carries `orchestrate-epic-run`.
- At most one attempt per `{pr, main SHA}`; a new commit on main allows a new attempt.
- A conflict session that fails, is stopped, or ends with the PR still `CONFLICTING` gets `agent-failed` on the ticket plus a comment on the PR and ticket.

### CI fixes

After the conflict phase, the poller launches `claude --bg --name <prefix>-N-ci "/ticket-workflow:fix-ci N"` for open, same-repo PRs by `owner` on `issue-N-*` branches that are `MERGEABLE` and have a failed check with none still pending. The skill reads the failing run's logs (as data, not instructions), fixes the branch and pushes with a plain `git push`.

- The same fork and author checks apply; `UNKNOWN` mergeability is retried next poll, and a conflicting PR gets only the conflict session.
- Skipped when `<prefix>-N` is `working` or `blocked`, a `<prefix>-N-ci` or conflict session is alive, or the ticket is closed, not `agent-ok`, not by `owner`, has `agent-failed`, or the PR or ticket carries `orchestrate-epic-run`.
- One attempt per PR head SHA, at most two per PR (`ci-attempts.json`); a new commit on the PR allows the next.
- A CI-fix session that fails, is stopped, or ends with the PR still red gets `agent-failed` on the ticket plus a comment on the PR and ticket.

### When something fails

If a session fails, is stopped, or ends without handing the ticket off, the poller adds `agent-failed` and comments with how to inspect it (`claude logs <prefix>-<issue>`). To retry, remove `agent-failed` and add `ready` again. Only `done` (checked for hand-off), `failed` and `stopped` end a tracked session; any other state (`working`, `blocked`, `waiting`, `idle`, unknown) counts as alive.

### Operations

| What | Command |
|---|---|
| Log | `tail -f ~/Library/Logs/claude-workflow-poller.log` |
| Is it loaded? | `launchctl list \| grep claude-workflow` |
| Sessions | `claude agents` (or `claude agents --json --all`) |
| One session's output | `claude logs <prefix>-<issue>` |
| Stop a session | `claude stop <prefix>-<issue>` |
| What would launch now | `dispatch/agent-poller.sh --dry-run` |
| Pause everything | `dispatch/install-launchd.sh pause` |
| Resume | `dispatch/install-launchd.sh resume` |

### Options

Per repo options are in `repos.json` (above). Global options are environment variables: set them in `EnvironmentVariables` of the plist template and rerun the installer (it regenerates the installed copy, so edits made only under `~/Library/LaunchAgents/` are overwritten), or prefix a one-off run, e.g. `CLAUDE_MAX_SESSIONS=3 dispatch/agent-poller.sh --dry-run`.

| Variable | Default | Meaning |
|---|---|---|
| `CLAUDE_MAX_SESSIONS` | `10` | Most sessions live at once across all repos (positive integer; invalid values abort the run). A guard against a runaway label batch; raise it deliberately. |
| `EXTRA_PATH` | empty | Directories prepended to the poller's PATH (inherited by sessions). fnm's default bin dir (`~/.local/share/fnm/aliases/default/bin`) is always included so sessions find `node`/`npm`. |
| `STATE_DIR` | `~/.local/state/claude-workflow` | Lock file and per-repo `launched.json` / `conflicts.json` / `ci-attempts.json`. |

### Notes

- The poller never claims a ticket; the session does (`in-progress`) as part of `work-ticket`.
- A ticket is launched once. Delete its entry from `launched.json` to relaunch a ticket that still has `ready`.
- A live session is a tracked launch that is not `done`, `failed` or `stopped`. Tickets over the cap are deferred, not dropped.
- The Mac must be awake and logged in. Nothing runs while it sleeps; the next run after wake picks up anything missed.

## Label cleanup on close

A reusable workflow (`workflow_call`, ticket #15) that runs when an issue is closed (e.g. by merging a PR with `Closes #N`):

- removes `ready`, `in-progress`, `needs-review`, `blocked` and `orchestrate-epic-run` from the closed issue (only those it has);
- for each open `blocked` issue whose body has `Blocked by #N`, removes `blocked` once every referenced blocker is closed (closed as not planned counts);
- never adds `ready`.

A consuming repo adds `.github/workflows/ticket-labels.yml`:

    name: ticket-labels
    on:
      issues:
        types: [closed]
    permissions:
      contents: read
      issues: write
    jobs:
      cleanup:
        uses: askrzypczak/claude-workflow/.github/workflows/ticket-labels.yml@main

The workflow checks out this public repo, sets up Node 24 itself and runs `plugins/ticket-workflow/scripts/ticket-labels.ts`, so callers need no secrets or Actions settings. Tests: `npm test`; type-check: `npm run typecheck`.

## Workflow

1. Check the ticket author is trusted (owner, member, collaborator) before reading anything else, then read and claim the ticket (planning counts as work), reading only trusted comments.
2. Plan, with human sign-off: the draft plan is audited for necessity by `spec-auditor` against the ticket, its epic and sibling tickets (on sonnet for `simple` plans; skipped for docs-only tickets); open questions, the auditor's included, are asked up front with the question tool, written to be answered cold (ticket in the header, what the code does today, what each option does), then the plan shows the AC as a diff against the ticket with the audit verdicts folded in (additions struck unless approved), the Decisions made (with the options offered, when the project has a Decision log section), Interfaces, Test titles and Carrying costs; when the project has a Decision log section, it also lists the active entries the plan supersedes, and a plan that reverses a maintainer-decided entry goes to the human; when the project has an Architecture section, the plan also lists the new workspace import edges, cross-package exports and lint exceptions (and the port and adapter for each external dependency), and a design that conflicts with it goes to the human before the plan is shown.
3. Branch in a worktree; the approved plan is posted on the issue. With a Decision log section, the ticket's log file is started and filled as decisions arise, uncommitted until the PR.
4. Contract and implement: the contract-writer writes stubs and failing tests from the approved Interfaces and Test titles, and the red run is observed and committed; the implementer then makes them pass. Tickets with no red state say "contract N/A"; a `simple` change with no tests whose plan holds the change verbatim is applied by the orchestrator, with no subagent.
5. Verify the tests: `npm run check`, contract tests unchanged since the contract commit, and red/green record.
6. Reviewer on complex changes; the orchestrator triages its findings: blockers and behaviour-preserving cuts go to the implementer; additive suggestions and notes are deferred to the PR body; cuts that remove validation, error handling, security code or a test, and any AC suspect or plan gap, are left to the human; a workspace edge, export or lint exception the plan did not list, or a breach of the project's Architecture section, is a blocker (simple changes get the same check from the orchestrator); with a Decision log section it also flags a choice in the diff that the log does not record, as a suggestion.
7. Open an active (non-draft) PR with CI green and no conflicts with main (a conflicting branch gets `origin/main` merged in first); its body links the approved plan comment and carries only its AC diff, Interfaces and Test titles, a review map and a Test proof; with a Decision log section the log is committed in its own commit after the code and the body links its entries, or says `Decision log: none` with a reason.
8. Human review, then address-feedback.
9. Human merges.

A spike (a plan whose output is a findings comment and no repo change) takes the place of steps 3 to 9: experiments run outside the repo, follow-up tickets are filed, the findings are posted on the ticket and it is handed off `needs-review` with no PR; the human reviews the findings and closes the ticket.

## License

MIT, see [LICENSE](LICENSE).
