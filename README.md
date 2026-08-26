# spec-sync-toolkit

> [!IMPORTANT]
> **Unmaintained · no support · not accepting contributions.**
>
> This repository is published so that machines can `npm install` it. It is not a product
> and not an invitation. **Issues and pull requests are not accepted** and will be closed
> without response — issues are disabled for that reason. There is no support, no roadmap,
> no release schedule, and no commitment to backwards compatibility: anything here may
> change or disappear at any time, without notice or a deprecation period.
>
> You are welcome to read it, copy it, or fork it. If you fork it, it is yours — please do
> not expect changes to flow back in either direction.

CLI that executes the mechanical parts of one specific, personal spec-driven development
workflow: gate runs, work-queue assembly, ticket context packs, the merge sequence, review
lens selection, a run ledger, and an environment check.

It is deliberately narrow. It assumes a particular setup — a spec server, GitHub Issues as
the only ticket store, a local-first squash-merge model, one repository layout — and it makes
no attempt to be general. Outside that setup most of it will not make sense.

## Commands

```bash
spec-sync gate --profile local|merge|nightly [--changed]
spec-sync queue [--check]
spec-sync pack <issue>
spec-sync merge <issue> --branch <name> [--dry-run]
spec-sync lenses [--base main]
spec-sync report [--run <id>]
spec-sync doctor
spec-sync budget [--session <id|path>] [--label <text>]
spec-sync handover [--note <text>] [--reason <budget|done|red-2x|question-open|pause|unexpected>]
spec-sync repin [--ids <a,b>] [--server <url>]
```

`--reason budget` is bound to the measurement: it is only written when the ledger's newest
`context` level reaches at least 75 % of the configured context budget —
otherwise `handover` writes nothing and ends with exit 1 (SST-DESIGN-024 rev 3, PROC-DEV-037).

`stdout` carries exactly one JSON object (`--human` renders text instead). Full command
output goes to `.spec-sync/logs/<timestamp>/<phase>.log`; the response carries only the exit
code, the first relevant error and that path.

`.spec-sync/`, `.spec-sync-pause` and the `.spec-sync-handover.md` that `handover` writes
belong in the consuming repo's `.gitignore`; `spec-sync.config.json` stays versioned.

Exit codes: `0` ok · `1` red · `2` unprovable (aborted under foreign load — **not** green) ·
`3` ambiguous, the caller decides · `4` precondition violated.

Counting gate repetitions (`PROC-REL-015` rev 4): a `gate` that aborts **before its first
phase** — battery, a working tree without its own install — answers exit 2 with
`reason: "no-run"` and writes **no ledger event**. It is not a run: no classification, no
consumed repetition; repeat it once the precondition holds. A run on a **saturated** box is
the other case — it took place, it is recorded, and it counts. That limit binds **per
incident, not per ticket**: once the cause of the load is found, fixed and recorded in the
ticket, the next run is a _first_ run of that ticket.

Everything project-specific lives in one file, `spec-sync.config.json`: gate phases and
profiles, path globs for review lenses, label names, log retention, context budget.

## Turn-End Hooks (`dist/hooks/`)

Besides the CLI, the package builds standalone hook binaries for Claude Code
(moved home from the worker repos, decision #193, 2026-08-18):

```bash
node <toolkit>/dist/hooks/stop-check.js            # stop hook: valve chain of the worker session
node <toolkit>/dist/hooks/subagent-stop-check.js   # SubagentStop hook: completion acceptance of the build agents
node <toolkit>/dist/hooks/architect-stop-check.js  # stop hook: budget boundary of the architect inbox (75 %, once)
```

`architect-stop-check` (owner's word 08/22, PROC-DEV-020 rev 4 / PROC-DEV-036 rev 5) is the
architect variant: pause flag → fresh handover → budget stage at **75 %** of
`contextBudget` from the spec repo's `spec-sync.config.json`, exactly once per session. No
workbench, no checker. The block dictates the handover with the measured number (the session
does not know its window, the hook does); if an owner conversation is running (the
worker-harness hook's state file `session-state.js`, field `last_owner_prompt_at`), it forces
the announcement "please /handover" instead of the handover.

The worker repos register the hooks by **absolute path** in their tracked
`.claude/settings.json` (the same pattern as `role-guard.sh`): one source, one
`npm run build`, and every repo behaves identically right away — no script copies,
no version bumps for the hooks. They speak Claude Code's hook stdout protocol,
NOT the CLI's JSON envelope; their behaviour (valve chains, budget stage,
fail-open) is documented in `src/hooks/` and pinned down in `test/hooks.test.ts`.
They are configured through the files of the consuming repo
(`spec-sync.config.json` → `contextBudget`, `.spec-sync-pause`, `.spec-sync-handover.md`).

**After every change to `src/hooks/`: `npm run build` — the repos call `dist/`.**

## Requirements

Node ≥ 22, `git`, and `gh` on the `PATH`. Some commands read a spec server over HTTP; its
endpoint comes from the `spec` entry in `.mcp.json` (`--server` overrides, both accept the
full endpoint or the base URL).

**Spec server port during the v2 cutover:** `.mcp.json` points at
`http://localhost:8788/mcp`. **Final flip → 8787**: once v2 takes over the regular port,
this entry is reverted. The value lives in this one place only — the file
is strict JSON (`JSON.parse` in `src/commands/repin.ts`), so it tolerates no comment,
which is why the note is here.

## Licence

None. No licence is granted; all rights reserved. If that matters to you, do not use it.
