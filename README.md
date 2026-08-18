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
spec-sync handover [--note <text>] [--reason <budget|done|rot-2x|frage-offen|pause|unerwartet>]
```

`stdout` carries exactly one JSON object (`--human` renders text instead). Full command
output goes to `.spec-sync/logs/<timestamp>/<phase>.log`; the response carries only the exit
code, the first relevant error and that path.

`.spec-sync/`, `.spec-sync-pause` and the `.spec-sync-handover.md` that `handover` writes
belong in the consuming repo's `.gitignore`; `spec-sync.config.json` stays versioned.

Exit codes: `0` ok · `1` red · `2` unprovable (aborted under foreign load — **not** green) ·
`3` ambiguous, the caller decides · `4` precondition violated.

Everything project-specific lives in one file, `spec-sync.config.json`: gate phases and
profiles, path globs for review lenses, label names, log retention, context budget.

## Turn-Ende-Hooks (`dist/hooks/`)

Neben der CLI baut das Paket zwei eigenständige Hook-Binaries für Claude Code
(Heimat-Umzug aus den Worker-Repos, Entscheid #193, 2026-08-18):

```bash
node <toolkit>/dist/hooks/stop-check.js           # Stop-Hook: Ventilkette der Worker-Session
node <toolkit>/dist/hooks/subagent-stop-check.js  # SubagentStop-Hook: Abschluss-Abnahme der Build-Agenten
```

Die Worker-Repos registrieren die Hooks per **absolutem Pfad** in ihrer getrackten
`.claude/settings.json` (dasselbe Muster wie `role-guard.sh`): eine Quelle, ein
`npm run build`, und jedes Repo verhält sich sofort identisch — keine Script-Kopien,
keine Versions-Bumps für die Hooks. Sie sprechen das Hook-stdout-Protokoll von Claude
Code, NICHT den JSON-Envelope der CLI; ihr Verhalten (Ventilketten, Budget-Stufe,
fail-open) ist in `src/hooks/` dokumentiert und in `test/hooks.test.ts` festgenagelt.
Konfiguriert werden sie über die Dateien des konsumierenden Repos
(`spec-sync.config.json` → `contextBudget`, `.spec-sync-pause`, `.spec-sync-handover.md`).

**Nach jeder Änderung an `src/hooks/` gilt: `npm run build` — die Repos rufen `dist/` auf.**

## Requirements

Node ≥ 22, `git`, and `gh` on the `PATH`. Some commands read a spec server over HTTP.

## Licence

None. No licence is granted; all rights reserved. If that matters to you, do not use it.
