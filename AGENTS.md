# Agent instructions — spec-sync-toolkit

Read `CLAUDE.md` first; it carries the module map, the runtime and the three rules that are
easy to break. This file adds only what is specific to working here as an agent.

## Source of truth

The spec server at the URL in `.mcp.json` (`http://localhost:8788/mcp` during the v2
transition, back to `8787` after the final flip), project `spec-sync-toolkit`:
`SST-VISION-001` with its `SST-DESIGN-0xx` leaves and the `SST-ADR-0xx` subtree. Enter
through `spec_usage`, then `spec_tree`/`spec_search`, then `spec_get`/`spec_get_many` — a
leaf is small and self-contained, so read the ones you need, never a whole level. The
foundation norms come from the `PROC-DEV-015` subtree (Worker-Loop).

If the spec does not answer a question: `ask_question` to the architect, note it in the
ticket, keep working. Do not guess and do not invent a default.

## Before you touch a command

The output contract (`SST-DESIGN-011`) is the toolkit's central promise to every caller. A command
returns a `CommandResult`; the dispatcher in `src/cli.ts` owns timing, exit code and the
single `emit()`. If you find yourself wanting to print something, you want `progress()` —
stderr — or a log file.

Response payloads stay small: the guideline is under 15 lines formatted, and `gate` and
`queue --check` are held to it. Put full output in the log directory and return its path.

## Gate

`npm run build && npm run lint && npm test` must be green before every commit — locally, on
this machine. There is no CI to fall back on; this repo has no remote.

## Boundaries

- Remote exists (GitHub = mirror/backup/ticket store). Push `main` immediately after every
  squash-merge, push tags with releases — never let merges pile up unpushed. No
  `gh repo create` and no other remote changes — that is the owner's call.
- Stage named files (`git add src/gate.ts`), never `git add .`; parallel agents share this
  tree.
- No new dependency without a reason in the report. The narrow dependency set is a decision
  (`SST-DESIGN-027`), not an oversight.
- The toolkit never decides on the merits: ticket cut, bug-vs-feature, merge approval and
  review verdicts stay with the model or the owner (ADR, Entscheidung 4).
