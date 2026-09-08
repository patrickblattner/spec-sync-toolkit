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
spec-sync gate --profile local|merge|nightly [--changed] [--preflight]
spec-sync queue [--check]
spec-sync pack <issue>
spec-sync merge <issue> --branch <name> [--dry-run]
spec-sync lenses [--base main]
spec-sync report [--run <id>]
spec-sync doctor
spec-sync budget [--session <id|path>] [--label <text>]
spec-sync handover [--note <text>] [--reason <budget|done|red-2x|question-open|pause|unexpected>]
spec-sync repin [--ids <a,b>] [--server <url>]
spec-sync map extract [<repo-root>] [--out <dir>] [--meaning <file>] [--project <id>]
spec-sync map check [<repo-root>] [--meaning <file>] [--project <id>]
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

Remote mode (`GATE_MODE=remote`, the repo variable of `PROC-DEV-044`): `gate --profile merge`
refuses to run locally — exit 4, `reason: "remote-mode"`, no ledger event — because there the
merge gate is the required check `pr-gate` on CI, and `merge` refuses the local sequence with
the precondition `gate-mode-local`. Both name the PR path, and both name how to wait on it:
poll `pr-gate` in the foreground while the next path-disjoint ticket builds, never with a
background monitor and never with `--watch` (decision register #442). Inside the CI runner
(`GITHUB_ACTIONS=true`) the check is void; a missing or unreadable variable never blocks
(SST-DESIGN-013 rev 3, SST-DESIGN-019 rev 3).

Pre-run (`gate --profile merge --preflight`, SST-DESIGN-013 rev 4): the one call that runs
the merge profile locally in **every** mode. It walks the profile in its order, runs each
phase's `preflightCmd` where the config carries one and its `cmd` otherwise, and skips every
phase marked `imageOnly` — listing it as `image-only (<reason>)`. It is **not** a gate: no
ledger event, no evidence for `merge`, and the response carries `preflight: true` so a reader
cannot mistake it for one. Exit codes as in a gate run (`0` clean, `1` a red phase, `2`
unprovable); `--changed` combines, the gate lock is taken, battery and `node_modules`
preconditions apply. Before the first spawn it refuses a merge profile whose `unit`, `build`,
`e2e-smoke`, `e2e-touched` or `e2e-full` phase carries no `imageOnly` mark — exit 4,
`reason: "preflight-config"` — so a pre-run never starts a database, a build or a browser by
accident. `--preflight` on any other profile is exit 4 naming the flag.

The two phase fields it reads, both optional:

```jsonc
{ "name": "unit", "cmd": "npm test", "imageOnly": "PROC-REL-030" },
{ "name": "audits", "cmd": "npm run audit:gate", "preflightCmd": "npm run audit:gate -- --no-build" }
```

`imageOnly` is the **reason** the phase stays out of the pre-run (it judges only in the gate
image, or a norm forbids it on the developer machine), never a boolean; `preflightCmd` is the
build-free part of the phase.

Everything project-specific lives in one file, `spec-sync.config.json`: gate phases and
profiles, path globs for review lenses, label names, log retention, context budget.

## Map (`map extract` · `map check`)

The **model** of a repo's architecture: nodes and edges on three levels — landscape, one app
opened, one process — derived from the checkout alone. Six extractors read the compose file,
the modules root, the mode-switched adapters, the inbound routes, the SQL migrations and the
n8n workflows. Deterministic, offline, zero LLM, no network and no spec server.

What the code does not carry is the **meaning layer**, `docs/architecture/meaning.json` — the
one file a human edits. It gives the project its id, label and modules root, maps the raw keys
the extractors emit (`adapter:payment`, `route:POST /api/webhooks/stripe`,
`n8n-host:api.heygen.com`) to stable node ids, and gives every external node its display facts:

```jsonc
{
  "schema_version": 1,
  "project": { "id": "cockpit", "label": "production-cockpit", "modulesRoot": "server/src/domain" },
  "raw": { "adapter:payment": "stripe", "n8n-host:api.heygen.com": "heygen" },
  "nodes": {
    "stripe": { "label": "Stripe", "sublabel": "checkout · payouts", "type": "external" },
  },
}
```

`map extract` writes `model.json`, `processes/<id>.json`, `unmapped.json` and a copy of the
meaning layer into `--out` (default `.spec-sync/map/`, which the consuming repo's `.gitignore`
covers). It stays green with unmapped keys — the run reports them, it does not judge them.

`map check` is the gate phase: same extraction, **writes nothing**, and answers exit 1 for
every raw key without a mapping and every node without display facts, naming each one and the
file to edit. As a phase in `spec-sync.config.json`:

```jsonc
{ "name": "map", "cmd": "npx spec-sync map check" }
```

Exit codes: `0` the meaning layer is complete (`check`) or the model was written (`extract`) ·
`1` unmapped keys or nodes (`check` only) · `4` no meaning layer at the given path, no project
id, an unknown subcommand or an unknown option.

Both read a repo checkout: the positional `<repo-root>` (default: the repo the CLI runs in) and
`--meaning` for a meaning layer that does not yet live in that repo. Model schema and the
meaning layer in full: `docs/map-model-schema.md` in the spec repo (PROC-SPEC-002).

## Turn-End Hooks (`dist/hooks/`)

Besides the CLI, the package builds standalone hook binaries for Claude Code
(moved home from the worker repos, decision #193, 2026-08-18):

```bash
node <toolkit>/dist/hooks/stop-check.js            # stop hook: valve chain of the worker session
node <toolkit>/dist/hooks/subagent-stop-check.js   # SubagentStop hook: completion acceptance of the build agents
node <toolkit>/dist/hooks/architect-stop-check.js  # stop hook: budget boundary of the architect inbox (75 %, once)
```

`architect-stop-check` (owner's word 08/22, PROC-DEV-020 rev 4 / PROC-DEV-036 rev 5) is the
architect variant: pause flag → fresh handover (with attest verification) → budget stage at
**75 %** of `contextBudget` from the spec repo's `spec-sync.config.json`, exactly once per
session. No workbench, no checker. The block dictates the handover with the measured number
(the session does not know its window, the hook does); if an owner conversation is running
(the worker-harness hook's state file `session-state.js`, field `last_owner_prompt_at`), it
forces the announcement "please /handover" instead of the handover. A freshly written
`reason: budget` handover is verified against the harness's attestation contract
(`- State: <n> Tokens (measured <ISO>)`, PROC-DEV-037): unreadable — e.g. a translated
literal, incident 2026-08-29 — means another block that dictates the exact lines, capped at
3 attempts, fail-open beyond that.

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
