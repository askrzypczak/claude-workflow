# Decision log format

Shared reference for the skills and agents that write or read a ticket's decision log. They point here instead of restating the format.

## Opt-in
A project keeps a decision log when its root `CLAUDE.md`, read from `origin/main`, has a heading titled `Decision log` that names the folder (for example `docs/decisions/`). Without that heading nothing here applies.

## File
One file per ticket: `<folder>/<N>-<slug>.md`, using the slug of the branch `issue-N-<slug>`. It opens with the ticket title and a link to the issue. Issue numbers are already unique, so parallel branches never collide on a global sequence number.

An epic's own file is `<folder>/<E>-<slug>.md`, with the slug made from the epic title. It is committed on `epic-E`.

## Entries
Each entry is a heading `## N.k <the decision, as a statement>`, where k counts up within the file, then:
- `Decided by:` one of maintainer, work-ticket orchestrator, epic #E orchestrator, implementer or reviewer; the date; where (plan gate, contract amendment, review round k); and `not human-approved` when no human approved it.
- `Context:` one or two lines.
- `Options:` the chosen one first, marked chosen, then one line per alternative with what it would have cost or why it lost.
- `Where:` the files and symbols that carry the decision.
- `Revisit if:` the condition for reopening it. Optional.
- `Status:` `active`, or `superseded by M.j`.
- `Supersedes: N.k`, on a superseding entry.

## What counts
A choice between reasonable alternatives that shapes behaviour, an interface, a persisted format, a dependency or the scope. Decisions only agents saw count too. Naming, formatting and wiring that the tests already pin do not.

## No decision
A ticket with no such decision gets no file. Its PR body says `Decision log: none` with a one-line reason.

## Superseding
Add a new entry with `Supersedes`, and edit the old entry's `Status` in the same PR. Reversing an entry the maintainer decided is asked of the human before it is decided.

## Auto mode
Every entry says `not human-approved`.
