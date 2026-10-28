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
- Agent sessions run Bash in Claude Code's sandbox, set in user settings, and push with per-repo deploy keys. See [Sandboxing agent sessions](#sandboxing-agent-sessions).

## Agent credentials

Agent sessions and the poller use the machine's `gh` login. Set it up so that it cannot merge, and only the maintainer merges, in the browser. These are the maintainer's steps; no agent applies them.

### Why

- Merging a PR (`PUT /repos/{owner}/{repo}/pulls/{pull_number}/merge`) needs "Repository permissions for "Contents"" (write); opening one (`POST /repos/{owner}/{repo}/pulls`) needs only "Repository permissions for "Pull requests"" (write) (GitHub Docs, *Permissions required for fine-grained personal access tokens*). The token below has no Contents write.
- A fine-grained token is limited to one owner: "The token will only be able to access resources owned by the selected resource owner." (GitHub Docs, *Managing your personal access tokens*).
- A workflow's `GITHUB_TOKEN` is stopped by the ruleset rule "Restrict updates": "If selected, only users with bypass permissions can push to branches or tags whose name matches the pattern you specify." (GitHub Docs, *Available rules for rulesets*). Details in [The Actions token](#the-actions-token).
- Agents get no route into the maintainer's logged-in browser on github.com ([Wiring](#wiring)).

Together, only the maintainer can merge. Nothing in the workflow needs Contents write through the API: branches are pushed with git over SSH, which cannot merge a PR, and `protect-main` refuses direct pushes to `main`; `orchestrate-epic` folds children into `epic-E` with a local merge (`plugins/ticket-workflow/scripts/integrate-child.sh`) and a plain `git push`; auto-merge stays off.

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
5. Browser automation that acts in the maintainer's browser (Claude in Chrome) must not be allowed on github.com: leave github.com out of the extension's site permissions, which is not a boundary in auto mode; see [Claude in Chrome on demand](#claude-in-chrome-on-demand). The Claude desktop app's built-in browser pane keeps its own sign-ins: do not sign in to github.com there (same route as Claude in Chrome).
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

## Sandboxing agent sessions

Agent sessions run their Bash commands in Claude Code's sandbox, set in the maintainer's user settings so that every session on the machine has it: interactive sessions, the poller's background sessions ("its Bash commands are sandboxed when its settings enable sandboxing") and their subagents ("Bash commands inside a subagent are sandboxed when sandboxing is enabled in the parent session"; both Claude Code docs, *Configure the sandboxed Bash tool*). These are the maintainer's steps; no agent applies them. Results described as tested come from nested `claude -p --settings` sessions in auto mode on macOS 26, with Claude Code 2.1.308 and `gh` 2.102.0.

### Settings

Merge these keys into `~/.claude/settings.json`, adding to any `env` and `permissions.deny` entries already there. The `~/.ssh` entries must name every private key file on the machine, the account key and every deploy key ([Deploy keys](#deploy-keys)), each in `credentials.files` and in a `Read(...)` and an `Edit(...)` rule. The three below are example names: replace them with yours. After setup, run `ls ~/.ssh` and confirm that each private key in it is listed.

```json
{
  "env": {
    "CLAUDE_CODE_PLUGIN_PREFER_HTTPS": "1",
    "CLAUDE_CODE_ENABLE_CFC": "0"
  },
  "sandbox": {
    "enabled": true,
    "failIfUnavailable": true,
    "allowUnsandboxedCommands": false,
    "enableWeakerNetworkIsolation": true,
    "excludedCommands": ["git fetch *", "git pull *", "git push *"],
    "network": {
      "allowedDomains": [
        "api.github.com",
        "results-receiver.actions.githubusercontent.com",
        "registry.npmjs.org"
      ],
      "strictAllowlist": true
    },
    "credentials": {
      "files": [
        { "path": "~/.ssh/id_ed25519", "mode": "deny" },
        { "path": "~/.ssh/deploy-claude-workflow", "mode": "deny" },
        { "path": "~/.ssh/deploy-example-app", "mode": "deny" },
        { "path": "~/.claude/.credentials.json", "mode": "deny" },
        { "path": "~/Library/Application Support/Google/Chrome", "mode": "deny" },
        { "path": "~/Library/Application Support/BraveSoftware", "mode": "deny" },
        { "path": "~/Library/Application Support/Arc", "mode": "deny" },
        { "path": "~/Library/Application Support/Microsoft Edge", "mode": "deny" },
        { "path": "~/Library/Application Support/Firefox", "mode": "deny" },
        { "path": "~/Library/Safari", "mode": "deny" },
        { "path": "~/Library/Cookies", "mode": "deny" }
      ]
    }
  },
  "permissions": {
    "deny": [
      "Read(~/.ssh/id_ed25519)",
      "Edit(~/.ssh/id_ed25519)",
      "Read(~/.ssh/deploy-claude-workflow)",
      "Edit(~/.ssh/deploy-claude-workflow)",
      "Read(~/.ssh/deploy-example-app)",
      "Edit(~/.ssh/deploy-example-app)",
      "Read(~/.claude/.credentials.json)",
      "Edit(~/.claude/.credentials.json)",
      "Read(~/Library/Application Support/Google/Chrome/**)",
      "Edit(~/Library/Application Support/Google/Chrome/**)",
      "Read(~/Library/Application Support/BraveSoftware/**)",
      "Edit(~/Library/Application Support/BraveSoftware/**)",
      "Read(~/Library/Application Support/Arc/**)",
      "Edit(~/Library/Application Support/Arc/**)",
      "Read(~/Library/Application Support/Microsoft Edge/**)",
      "Edit(~/Library/Application Support/Microsoft Edge/**)",
      "Read(~/Library/Application Support/Firefox/**)",
      "Edit(~/Library/Application Support/Firefox/**)",
      "Read(~/Library/Safari/**)",
      "Edit(~/Library/Safari/**)",
      "Read(~/Library/Cookies/**)",
      "Edit(~/Library/Cookies/**)",
      "Edit(~/.gitconfig)",
      "Edit(~/.config/git/**)",
      "Edit(//**/.git/hooks/**)",
      "Edit(//**/.git/config)",
      "Bash(git fetch *--upl*)",
      "Bash(git pull *--upl*)",
      "Bash(git push *--rece*)",
      "Bash(git push *--e*)"
    ]
  }
}
```

- `enabled` also turns on auto-allow mode: a sandboxed command is approved "automatically, with no prompt" whatever the permission mode, with a few exceptions such as plan mode, while excluded commands still go through the regular permission flow (*Configure the sandboxed Bash tool*). To keep prompts for Bash, also set `autoAllowBashIfSandboxed` to `false`.
- `failIfUnavailable` makes Claude Code exit at startup when the sandbox can't start, instead of running commands unsandboxed. `allowUnsandboxedCommands: false` takes away Claude's retry outside the sandbox: "With the retry disabled, Claude Code ignores the `dangerouslyDisableSandbox` parameter." (same page).
- `allowedDomains`: `api.github.com` for `gh`, `results-receiver.actions.githubusercontent.com` for `gh run view --log`, `registry.npmjs.org` for `npm ci`; not `github.com` as a whole. `strictAllowlist` refuses every other host. Without it, auto mode lets a command name extra hosts for the classifier to approve, and `bypassPermissions` allows any host (Claude Code docs, *All settings*, `sandbox.network.strictAllowlist`).
- `credentials.files`: by default sandboxed commands can read "Most of the machine, including credential files such as `~/.ssh` and `~/.aws/credentials`", and "There is no built-in credential deny list, so only the files and variables you list are restricted." (*Configure the sandboxed Bash tool*). The list: the private key files, Claude Code's credential store `~/.claude/.credentials.json`, the Chrome, Brave, Arc, Edge, Firefox and Safari profile directories, and `~/Library/Cookies`.
  - The key files are listed by name, not `~/.ssh` as a whole, because sandboxed `gh` reads `~/.ssh/config` ([macOS exceptions](#macos-exceptions)). In a test, a `~/.ssh` deny with `~/.ssh/config` re-opened through `filesystem.allowRead` left the file unreadable.
  - `~/Library/Keychains` stays readable: sandboxed `gh` reads its token from the keychain through `security`, and with the keychain denied every authenticated `gh` call failed in a test (`HTTP 401: Requires authentication` from `gh issue view`), while `gh api` on a public repo still worked because it needs no token. [What stays outside](#what-stays-outside) has the cost.
  - `~/.config/gh` stays readable: it holds `gh`'s configuration and no token while the login is stored in the keyring (`gh auth status` shows `(keyring)`).
- `permissions.deny`: the file tools run outside the sandbox ("A `denyRead` entry doesn't stop the Read tool", same page), so each denied path also gets a `Read(...)` and an `Edit(...)` rule. `Edit` rules cover the Write tool too ("`Edit` rules apply to all built-in tools that edit files."), and `Write(...)` path rules never match (Claude Code docs, *Configure permissions*). The git rules are explained under [macOS exceptions](#macos-exceptions).
- `env`: `CLAUDE_CODE_PLUGIN_PREFER_HTTPS` ([Deploy keys](#deploy-keys)) and `CLAUDE_CODE_ENABLE_CFC` ([Claude in Chrome on demand](#claude-in-chrome-on-demand)).

### macOS exceptions

**Git over SSH.** "On macOS, `git fetch`, `git pull`, and `git push` against an SSH remote fail inside the sandbox even when the host is allowed." (*Configure the sandboxed Bash tool*). The JSON takes those three out of the sandbox with `excludedCommands`, the fix that page gives. "An excluded command runs with your full access.", and "The excluded git commands can reach any host, not only the ones in `allowedDomains`." (same page). They read `~/.ssh/config`, the key files and `~/.gitconfig`, so [Deploy keys](#deploy-keys) keeps the account key out of their reach, and these rules keep them from running a program Claude chose:

- `Bash(git fetch *--upl*)`, `Bash(git pull *--upl*)`, `Bash(git push *--rece*)` and `Bash(git push *--e*)` deny `--upload-pack`, `--receive-pack` and `--exec`, which name a program for git to run. Git accepts any unambiguous prefix of a long option, so each rule matches the shortest one. In a test, `git fetch --upload-pack=<script> .` and `git push --dry-run --receive-pack=<script> . <ref>` ran the script inside the sandbox even though both matched the exclusions, but *All settings* lists the call shapes that stay sandboxed only "among others", so the rules keep this from resting on undocumented behaviour.
- A variable prefix needs no rule: in a test, `GIT_SSH_COMMAND=<script> git fetch origin` and a `PATH=...` prefix ran the script inside the sandbox, so there are no `GIT_SSH*` or `GIT_CONFIG*` rules. `git -c core.sshCommand=... fetch` doesn't start with `git fetch`, and a pattern matches "everything before the first `*` as written" (*Configure permissions*), so that call stays sandboxed too.
- `Edit(~/.gitconfig)` and `Edit(~/.config/git/**)`: a `core.sshCommand`, or another setting that names a program, written there by the Edit or Write tool, which run outside the sandbox, would run with full access under an excluded git command. Sandboxed commands can't write there.
- `Edit(//**/.git/hooks/**)` and `Edit(//**/.git/config)`: excluded git commands also run the repository's `.git/hooks` and read its `.git/config`. Sandboxed commands can't write them (protected paths), and these rules close the Edit and Write tools' path. A relative pattern would match only under the current directory and miss the main repository's `.git` in a worktree session, so the rules anchor at the filesystem root, the closest documented form for "any repository" (*Configure permissions*: "To write a rule in user settings that applies inside every project, use a `//` absolute path or a `~/` home-relative path", and `Read(//**/.env)` blocks "any `.env` anywhere on the filesystem").

**`gh`** runs sandboxed. Without `enableWeakerNetworkIsolation` it failed TLS verification in a test (`x509: OSStatus -26276`); with it, `gh api`, `gh pr checks`, a redirected `gh` call and the trust-rule pipe (`gh issue view ... | node .../trusted-comments.ts`) worked. The cost: "This reduces security by opening a potential data exfiltration path through the trust service." (*All settings*, `sandbox.enableWeakerNetworkIsolation`). The docs' other fix, excluding `gh *`, is worse here:

- An exclusion covers a call only when every command in it matches, and a redirect keeps the call sandboxed, so piped and redirected `gh` calls would still fail TLS (tested with `gh ... | cat`). The [trust rule](#trust-rule-for-public-repos) pipe is such a call, used in 11 places in the plugin's skills and agents.
- An excluded `gh` runs with full access: it can read any file and post it with `--body-file`.

With `gh` inside the sandbox, `gh extension` and `gh alias` need no deny rules: they can't write outside the working directory or reach a host outside the allowlist. Sandboxed `gh` reads `~/.ssh/config` to resolve alias remotes: go-gh's `pkg/ssh/ssh.go` runs `ssh -G <host>` and, when that fails, keeps "the original hostname unchanged", which no GitHub host matches.

**`integrate-child.sh`** gets no exclusion. A pattern for it needs a `*` for the plugin cache path, which carries a commit SHA, and in a test a `*` in an exclusion let another script out: `<root>/plugin/*/scripts/integrate-child.sh *` matched `<root>/plugin/../other.sh /scripts/integrate-child.sh x`, which ran outside the sandbox. Instead, the script runs no git network command: `orchestrate-epic` fetches before `integrate-child.sh merge` and pushes `epic-E` before `integrate-child.sh close`, as plain commands, which the exclusions match.

**What breaks under the sandbox:**

- Creating a branch that tracks a remote one (`git switch -c X origin/Y`, `git checkout -b X origin/Y`, `git worktree add -b X <path> origin/Y`, and `git switch Y` or `git worktree add <path> Y` when only `origin/Y` exists) fails in the clone and in a worktree, because the upstream is written to git's `config`. The sandbox protects "`hooks` and `config` inside `.git`" in the working directory, and for a worktree the main repository's: "Writes to `hooks/` and `config` inside that directory remain denied." (*Configure the sandboxed Bash tool*). Create the branch with `--no-track`, then let `git push -u origin <branch>` (an excluded command) set the upstream. The skills do this: `work-ticket`, `orchestrate-epic`, `fix-ci`, `resolve-conflicts` and `address-feedback` create their branches with `--no-track` and set the upstream with `git push -u origin <branch>` on the first push.
- Bare `mktemp -d` creates its directory under the system temp folder (`/var/folders/...`) even with `TMPDIR` set (macOS `mktemp(1)` prefers `_CS_DARWIN_USER_TEMP_DIR`), and the sandbox denies it. Pass a template: `mktemp -d "$TMPDIR/name.XXXXXX"`.
- A call with a `cd` or `git -C` stays sandboxed (*All settings*, `sandbox.excludedCommands`: "A `cd`, `pushd`, or `popd`, wherever it appears in the call"; *Configure the sandboxed Bash tool*: "A call that adds a `cd`, uses `git -C`, or contains a command substitution stays sandboxed."); in a test, `git -C . fetch` failed at the proxy with `github.com:22: 403 host is not on the allow list`. Run git's network commands as plain commands from the working directory. The skills name each push as its own call for this reason; run fetches the same way.
- `plugins/ticket-workflow/hooks/test-guard-git.sh` fails on its bare `mktemp -d` until #136 removes it. Run it outside the sandbox, in a terminal.

### Deploy keys

An excluded git command uses whatever key ssh offers it. With the account key, that is every repo the account can push to; with a deploy key, one: "If you use multiple repositories on one server, you will need to generate a dedicated key pair for each one. You can't reuse a deploy key for multiple repositories." (GitHub Docs, *Managing deploy keys*). Within its repo a write key is broad: "Deploy keys with write access can perform the same actions as an organization member with admin access, or a collaborator on a personal repository." (same page). Deploy keys are a bypass actor a ruleset can name (the bypass `actor_type` "Can be one of: `Integration`, `OrganizationAdmin`, `RepositoryRole`, `Team`, `DeployKey`, `User`", GitHub Docs, *REST API endpoints for rules*), so a ruleset binds their pushes unless its bypass list names them: keep deploy keys off every ruleset's bypass list.

For each served repo, and for this one:

1. `ssh-keygen -t ed25519 -N "" -f ~/.ssh/deploy-<repo>`. No passphrase, since sessions push unattended; the file is denied to sandboxed commands and opens one repo. Add `~/.ssh/deploy-<repo>.pub` in the repo's Settings, Deploy keys, with "Allow write access".
2. Add a host alias to `~/.ssh/config`. `IdentitiesOnly yes` makes ssh offer only that key, "even if ssh-agent(1) or a PKCS11Provider or SecurityKeyProvider offers more identities" (`ssh_config(5)`):

        Host github.com-<repo>
          HostName github.com
          User git
          IdentityFile ~/.ssh/deploy-<repo>
          IdentitiesOnly yes

3. In the repo's clone (a served repo's `dir`; for this repo, the clone the poller runs from): `git remote set-url origin git@github.com-<repo>:<owner>/<repo>.git`. Worktrees share the clone's remotes.
4. Add the key file to the [Settings](#settings) JSON.

The account key:

- Out of `ssh-agent`: `ssh-add -D`, or `ssh-add -d --apple-use-keychain <key>`, which also removes its stored passphrase ("When removing identities with -d, each passphrase will be removed from it.", `ssh-add(1)` on macOS).
- No `UseKeychain` or `AddKeysToAgent` lines for it in `~/.ssh/config`: they would load it again.
- Off the disk, or kept passphrase-protected: an excluded git command can read the file, and ssh tries default key names such as `~/.ssh/id_ed25519` on its own.

The marketplace clone moves to HTTPS; the repo is public, so it needs no credentials. For an `owner/repo` source Claude Code "probes `ssh -T git@github.com` and clones over SSH when the probe succeeds", and "Installs from `/plugin` inside a session and plugin updates don't fall back" (Claude Code docs, *Host and maintain a marketplace*). `CLAUDE_CODE_PLUGIN_PREFER_HTTPS=1` in the JSON covers new clones. Switch the existing one: `git -C ~/.claude/plugins/marketplaces/askrzypczak-plugins remote set-url origin https://github.com/askrzypczak/claude-workflow.git`.

The maintainer pushes through the same alias remotes. For a repo without a deploy key, load the account key briefly with dispatch paused, as [Admin work](#admin-work) does, and `ssh-add -D` afterwards.

### Claude in Chrome on demand

Claude in Chrome acts in the maintainer's own browser, with its sign-ins, and in auto mode, "when the auto mode classifier itself approves a browser call to a site, the extension skips its own per-site check for that call, unless your permission rules deny any site to Claude in Chrome" (Claude Code docs, *Use Claude Code with Chrome*). So keeping github.com out of the extension's site permissions is not a boundary in auto mode, and the docs give no rule syntax for denying a site to Claude in Chrome. The control is when it runs: off by default, never in a background session, and on only in an interactive session the maintainer is watching:

- Run `/chrome` and turn off **Enabled by default** (the `claudeInChromeDefaultEnabled` key in `~/.claude.json`).
- `CLAUDE_CODE_ENABLE_CFC=0` in the JSON's `env` keeps it off; the variable "Takes precedence over the `claudeInChromeDefaultEnabled` setting. The `--chrome` and `--no-chrome` flags take precedence over both." (Claude Code docs, *Environment variables*).
- Start `claude --chrome` only for an interactive session you are watching. Keep github.com out of the extension's site permissions as well ([Wiring](#wiring)).

In a test, `-p` sessions loaded no Chrome tools even with Enabled by default on. Background sessions are interactive, so [Checks](#checks) covers them.

### What stays outside

- Hooks, local MCP servers and the other processes Claude Code starts "run with your full access" (*Configure the sandboxed Bash tool*). Connectors act on their services with their own credentials.
- The Read, Edit, Write and web tools follow permission rules, not the sandbox; beyond the deny rules above, they reach what the permission mode allows. WebFetch reaches any host its permission rules allow, a way out that the network allowlist doesn't touch ("in-process tools such as `WebFetch` still follow their permission rules", *Configure the sandboxed Bash tool*). A file the Edit tool writes, such as a shell startup file, can change what an unsandboxed process does, and the Edit tool can write `~/.claude/settings.json` and `~/.claude.json` themselves, the files that hold the sandbox and Chrome keys (both are protected paths, so in auto mode such a write goes to the classifier); the managed-settings copy under Repository settings below closes that too.
- Exfiltration through GitHub: the allowed hosts are enough to put data in an issue, a comment or a pushed branch. The proxy also checks only hostnames: "code running inside the sandbox can potentially use domain fronting or similar techniques to reach hosts outside the allowlist" (*Configure the sandboxed Bash tool*).
- The excluded git commands, within the limits under [macOS exceptions](#macos-exceptions). The repository hooks they run and the `.git/config` they read are closed to sandboxed commands (protected paths) and to the file tools (the `.git` deny rules).
- The keychain. Sandboxed commands can read the `gh` token through `security`, and any other item `security` reads without a prompt: with no keychain deny, `security find-generic-password -s gh:github.com -w` exited 0 from a sandboxed command in a test.
- The `gh` token cannot merge ([Agent credentials](#agent-credentials)) and, from a sandboxed session, reaches only the allowed hosts. But it could be posted to GitHub and used elsewhere until rotated, which is why the expiry note in [The token](#the-token) matters.
- An untested alternative: deny `~/Library/Keychains` (in `credentials.files` and as `Read(...)` and `Edit(...)` rules) and store the `gh` token in `~/.config/gh/hosts.yml` with `gh auth login --with-token --insecure-storage`. That exposes only that token to sandboxed commands and leaves other keychain items closed, at the cost of a plaintext token file. The `gh` check in [Checks](#checks) covers it if the maintainer chooses it.
- The trust-service path that `enableWeakerNetworkIsolation` opens.
- Repository settings: "A `false` in your user settings doesn't make the sandbox admin-required, so a project's other sandbox settings still apply." (*Configure the sandboxed Bash tool*). A repo's `.claude/settings.json` or `.claude/settings.local.json` can set `enabled: false`, add `excludedCommands` or turn on weaker options. Sandboxed commands can't write those files, and Edit-tool writes to them go to the classifier in auto mode (`.claude` is a protected path, *Choose a permission mode*). `strictAllowlist` in user settings already makes Claude Code ignore a repo's `allowedDomains` (*Configure the sandboxed Bash tool*, "Locks that apply without an admin-required sandbox"). The same JSON in `/Library/Application Support/ClaudeCode/managed-settings.json` closes the rest: `allowUnsandboxedCommands: false` there makes the sandbox admin-required, and Claude Code then ignores "the settings in a repository's files that loosen the sandbox, `excludedCommands` entries included" (same page); a managed `enabled` "overrides anything a developer sets" (*All settings*).
- A separate macOS user or a container would put all of the above behind one boundary. Left for later.

### Checks

Ask Claude to run these in a session started in a served `dir`: "What you type at the `!` prompt usually runs outside the sandbox, so typing a line yourself doesn't test it." (*Configure the sandboxed Bash tool*). Credential checks test readability only; never print a key.

1. `touch ~/sandbox-probe`: fails with `Operation not permitted`. If it succeeds, delete `~/sandbox-probe` and check `/sandbox`.
2. `curl -sS https://example.com`: refused, naming the host as not on the allow list.
3. For each private key file, `test -r ~/.ssh/<key> && echo READABLE || echo DENIED`: `DENIED`. The same for `~/.ssh/config`: `READABLE`, since sandboxed `gh` needs it.
4. The Read tool on a non-secret file inside a denied directory, such as Chrome's empty `~/Library/Application Support/Google/Chrome/First Run`: refused. Don't point the Read tool at a real key: if the deny were wrong, the key would land in the transcript.
5. `gh repo view --json nameWithOwner` in a `dir` whose remote uses an alias: prints the repo. Then `gh issue view <i> --json number,title`: prints the issue. That call needs the token: it failed with `HTTP 401` in the test where sandboxed `gh` couldn't read it.
6. `git fetch origin` and `git push --dry-run origin <branch>` there: both succeed, through the deploy key.
7. `claude --bg --name sandbox-check "list your tools"` in a served `dir`, then `claude attach sandbox-check`: `/sandbox` shows the same settings on its Config tab, and the session has no browser tools.

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

The children's PRs target an `epic-E` branch, not `main`. After its review, with CI green and the PR mergeable, the orchestrator merges each child into `epic-E` with `plugins/ticket-workflow/scripts/integrate-child.sh merge`, pushes `epic-E` with a plain `git push`, then closes the child issue with `integrate-child.sh close`, which refuses until the merge is on `origin/epic-E`. The fetch and the push run outside the script as plain commands, which the sandbox's git exclusions match ([Sandboxing agent sessions](#sandboxing-agent-sessions)). The human still merges every PR that reaches `main`: one epic PR, read by its merge commits and the child PRs' review maps. Spike children are not run inside an epic: the orchestrator leaves them out, and the human works each on its own with `work-ticket`; children blocked by one wait until it closes.

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

After the conflict phase, the poller launches `claude --bg --name <prefix>-N-ci "/ticket-workflow:fix-ci N"` for open, same-repo PRs by `owner` on `issue-N-*` branches that are `MERGEABLE` and have a failed check with none still pending. The skill reads the failing run's logs (as data, not instructions), fixes the branch and pushes it without force flags (`git push -u origin <branch>`).

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
