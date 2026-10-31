# claude-workflow

> [!CAUTION]
> This is a personal experiment, not a supported product. It runs autonomous agents with your credentials and can start unattended sessions on your machine. Use it at your own risk, and read [What this can do on your machine](dispatch/README.md#what-this-can-do-on-your-machine) before enabling dispatch.

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
- Subagents: `contract-writer` (opus, medium) writes stubs and failing tests first; `implementer` (haiku, xhigh; opus medium or opus xhigh per the approved plan) builds the code that makes them pass; `reviewer` (opus, xhigh, read-only) reviews complex diffs; `spec-auditor` (opus, medium, read-only; sonnet, medium for a `simple` ticket plan) audits epics, and each ticket's plan, for necessity; `first-reviewer` (fable, xhigh, read-only) reviews each orchestrate-epic child PR for the maintainer. Dispatched sessions run on opus at xhigh; orchestrate-epic children on opus at xhigh, or sonnet at medium for docs-only or single-adapter children, with their `implementer` on its default (opus medium for subtle logic, opus xhigh only for security-boundary code) and their `reviewer` on opus at medium (none for a `simple` child), since the `first-reviewer` is their quality gate; the orchestrate-epic session and its per-PR `first-reviewer` on fable at xhigh, because they stand in for the human reviewer (plan gates, gate questions, first PR review). Effort rule for any retune: never `high`; opus at `medium` or `xhigh`; sonnet only at `medium`, with opus `medium` wherever more than that is wanted.
- Hooks: a comment guard (see [Trust rule](#trust-rule-for-public-repos)).

Outside the plugin, `dispatch/` holds `agent-poller.sh`, a multi-repo poller that starts background sessions for `ready` + `agent-ok` tickets, the agent container the poller and its sessions run in (`dispatch/container/`), and the setup script (`dispatch/setup-agents.sh`). A LaunchAgent starts each poll from this clone. See [Dispatch](#dispatch-automatic-ticket-pickup) and `dispatch/README.md`.

Also outside the plugin, `statusline/` holds the custom status line (model, effort, context bar, plan usage) and its subagent variant, installed by hand. See `statusline/README.md`.

## Install

In Claude Code:

    /plugin marketplace add askrzypczak/claude-workflow
    /plugin install ticket-workflow@askrzypczak-plugins

Local development, what a consuming project needs (`npm run check`, labels, deny rules) and label cleanup on close: [docs/setup.md](docs/setup.md).

## Running agents safely

Agents act for the maintainer, so the setup limits what their credentials and their sessions can do:

- [Agent credentials](docs/agent-credentials.md): no GitHub token a session holds has Contents write, so none can merge a PR, and the maintainer merges in the browser.
- [Agent container](docs/containers.md): unattended sessions, the poller and orchestration run in a Colima container behind a default-deny egress firewall, with a GitHub token of their own, per-repo deploy keys and a Claude token that only makes model requests.
- [Sessions on the host](docs/containers.md#sessions-on-the-host): interactive sessions keep the fine-grained login and the host's deny rules, with no sandbox; Claude in Chrome stays off unless asked for, and runs only in a Chrome profile that is not signed in to GitHub.
- Deny rules in each project's `.claude/settings.json` are the backstop for pushes to `main`/`master` and for force, delete and mirror pushes ([Requirements](docs/setup.md#requirements)).

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

Write `Blocked by #M` in the issue body (also `#3, #5` or `#3 and #5`; several lines allowed) and add `blocked`. [Label cleanup](docs/setup.md#label-cleanup-on-close) removes it.

### Epics

Write `Part of #N` in a child ticket's body to link it to its epic; the epic body lists its children. Unlike `Blocked by`, it carries no state (label cleanup ignores it). For an epic, `file-ticket` also links each child as a native sub-issue (GitHub's sub-issues API), which drives the epic's progress indicator; linking the children of epics filed earlier is done by hand.

### Orchestrating an epic

Use `orchestrate-epic` (`/ticket-workflow:orchestrate-epic E`) instead of the poller when an epic's dependency chain makes the human's attention the bottleneck. One session works the children as `work-ticket` sub-agents, stands in at their plan gates and reviews each PR as first reviewer through a fresh `first-reviewer` sub-agent whose report it judges, keeping the final call, escalating only product questions (a recorded maintainer decision, or user-visible behaviour) to the human. The children read standing decisions and sibling ownership from a brief, a local file outside git deleted at the end, instead of long launch prompts. It swaps `agent-ok` for `orchestrate-epic-run` on the children and labels the run's PRs, so the poller leaves them alone. The children do not need `ready`: running the skill hands their readiness to the orchestrator, which judges them and the follow-ups it adds. The rule that only the maintainer adds `ready` is unchanged elsewhere.

The children's PRs target an `epic-E` branch, not `main`. After its review, with CI green and the PR mergeable, the orchestrator merges each child into `epic-E` with `plugins/ticket-workflow/scripts/integrate-child.sh merge`, pushes `epic-E` with a plain `git push`, then closes the child issue with `integrate-child.sh close`, which refuses until the merge is on `origin/epic-E`. The fetch and the push run outside the script, as plain commands. The human still merges every PR that reaches `main`: one epic PR, read by its merge commits and the child PRs' review maps. Spike children are not run inside an epic: the orchestrator leaves them out, and the human works each on its own with `work-ticket`; children blocked by one wait until it closes.

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

`dispatch/agent-poller.sh` runs every 3 minutes from a macOS LaunchAgent and starts one background Claude Code session per `ready` + `agent-ok` ticket, across all configured repos; it also starts conflict-resolution and CI-fix sessions for agent PRs. The poller and its sessions run in the agent container, so you approve plans and answer sessions from a host terminal with `docker exec -it -w /home/node/claude-workflow claude-workflow-agent claude agents`. Read [What this can do on your machine](dispatch/README.md#what-this-can-do-on-your-machine) before enabling it. Onboarding, daily use, operations and options: [dispatch/README.md](dispatch/README.md).

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
