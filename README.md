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

Run every command from the repo root as `node_modules/.bin/spec-sync <command>` — never through
`npx` (`GL-SEC-011`); inside a `package.json` script a bare `spec-sync …` is enough. Which
commands a repo uses is its lead's call: `queue`, `handover`, `budget`, `repin` and `drift` are
optional, and no hook or gate asks for their result (`SST-DESIGN-015`).

```bash
spec-sync gate --profile local|merge|nightly [--changed] [--preflight]
spec-sync queue [--check | --health]
spec-sync pack <issue>
spec-sync merge <issue> --branch <name> [--dry-run]
spec-sync lenses [--base main]
spec-sync report [--run <id>]
spec-sync doctor
spec-sync budget [--session <id|path>] [--label <text>]
spec-sync handover [--note <text>] [--reason <budget|done|red-2x|question-open|pause|unexpected>] [--session <id|path>]
spec-sync repin [--ids <a,b>] [--server <url>]
spec-sync drift [--server <url>]
spec-sync ledger start <issue> [--new-increment] [--dry-run]
spec-sync ledger build <issue> [--agent impl|impl-fast|impl-deep] [--dry-run]
spec-sync ledger close <issue> --reason "<text>" [--dry-run]
spec-sync slot run --step <name> --cap <minutes> [--run <id>] -- <cmd> [args…]
spec-sync slot status [--last <n>]
spec-sync map extract [<repo-root>] [--out <dir>] [--meaning <file>] [--project <id>]
spec-sync map check [<repo-root>] [--meaning <file>] [--project <id>]
spec-sync measure set <file> <pointer> <value> --register <n> [--server <url>]
spec-sync measure remove <file> <pointer> --register <n> [--server <url>]
spec-sync review pr <n> [--issue <t>] [--recheck]
spec-sync review batch [--dry-run]
spec-sync review tag <from>..<to>
spec-sync review verdict <pr|issue> <n> <id> (accepted (fixed|ticket <t>|collected <c>) | rejected "<reason>") [--source claude:<lens>]
spec-sync licence-inventory [--allowlist <file>]
spec-sync e2e-select [--format json|lines]
spec-sync cadence tag
```

`licence-inventory` (SST-FEATURE-001) replaces `license-checker`: it inventories the production
closure from `npm ls --omit=dev --all --json` (workspaces included, deduplicated by name@version,
the repo's own workspace packages skipped; nodes npm marks `extraneous` are not judged, only
counted as `skippedExtraneous`), reads each licence from the installed `package.json`
(`license`, legacy `licenses`) or, when that is missing or `*`, from the LICENSE/LICENCE/COPYING
file matched against common licence texts, and judges it against `licence-allowlist.json`. Offline
and fail-closed: an unreadable licence is a finding. Exit 0 without findings, 1 with findings, 4
when the allowlist is missing or an exception lacks `licence` or `reason`. The payload carries the
package count, `skippedExtraneous`, the finding count, the first 10
findings and the path of the full inventory JSON in the log directory. The allowlist:

```json
{
  "licenses": ["MIT", "Apache-2.0"],
  "exceptions": [
    { "package": "name[@version]", "licence": "LGPL-3.0-or-later", "reason": "…" },
    { "package": "our-closed-pkg", "licence": "UNLICENSED", "reason": "…" },
    { "package": "no-licence-pkg@1.2.3", "licence": "unreadable", "reason": "…" }
  ]
}
```

An SPDX expression passes when it is satisfiable from `licenses` (`OR` needs one, `AND` needs all,
`WITH` reads as the base licence). An exception is bound to the licence it was granted for:
`licence` is the read SPDX expression, `UNLICENSED`, or `unreadable` for a package without a
readable licence. It passes only while the package still reads exactly that (SPDX text compared up
to case and whitespace); otherwise it is a finding `exception granted for <X>, package now <Y>`.
An exception is the only way `UNLICENSED` or an unreadable licence passes.

### E2E selection for `e2e-targeted` (PROC-REL-071)

```bash
spec-sync e2e-select [--format json|lines]
```

Picks what the merge phase `e2e-targeted` runs, from the same diff base and changed-file union as
`gate --changed` (branch commits + working tree + untracked):

1. The resolved version of `@suite/ui` differs between the merge base and the working tree — a
   `…node_modules/@suite/ui` entry (`version`, `resolved`) in a changed `package-lock.json`, or the
   spec in `dependencies`/`devDependencies` of a changed `package.json` (root or workspace) →
   `mode: "full"`.
2. Else changed files matching `e2e/**/*.spec.ts` that still exist → `mode: "files"`, `files`
   sorted and repo-relative.
3. Else → `mode: "none"`.

Fail-safe: no diff base, or a lockfile/manifest that cannot be read or parsed → `mode: "full"` with
a `reason`. Always exit 0 (exit 4 only for a bad `--format` or config). JSON carries `mode`,
`files` and `reason` in the usual envelope; `--format lines` prints `full`, `none`, or one file
per line. Optional config: `"e2eSelect": {"specGlob": "e2e/**/*.spec.ts", "package": "@suite/ui"}`.

Wiring — the phase in `spec-sync.config.json`, listed in `gate.profiles.merge` right after
`e2e-smoke`:

```json
{ "name": "e2e-targeted", "cmd": "node scripts/e2e-targeted.mjs", "imageOnly": "gate image" }
```

and `scripts/e2e-targeted.mjs` (projects = the ones `main-check` runs for the full suite):

```js
import { execFileSync, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const FULL_PROJECTS = ["chromium"]; // the full suite's Playwright projects
const cli = fileURLToPath(import.meta.resolve("spec-sync-toolkit/dist/cli.js"));
const out = execFileSync(process.execPath, [cli, "e2e-select", "--format", "lines"], {
  encoding: "utf8",
});
const lines = out.split("\n").filter(Boolean);
if (lines.length === 0) {
  console.error("e2e-select returned nothing");
  process.exit(1); // an empty selection is a non-run (PROC-REL-012)
}
if (lines[0] === "none") {
  console.log("e2e-targeted: nicht betroffen");
  process.exit(0);
}
const files = lines[0] === "full" ? [] : lines;
const projects = FULL_PROJECTS.flatMap((p) => ["--project", p]);
const run = spawnSync("npx", ["playwright", "test", ...projects, ...files], { stdio: "inherit" });
process.exit(run.status ?? 1);
```

No hook and no gate asks for a current `spec-pins.json` (`SST-DESIGN-025` rev 6): whether a repo
keeps a pin file at all is its lead's call.

### doctor

`doctor` checks exactly five things (`SST-DESIGN-022` rev 11) — the npx calls and npx cache
below; `review.riskGlobs` in `spec-sync.config.json` (finding `review-globs`: a missing or
unloadable config, a missing or empty list, an area without globs, a glob that matches no tracked
file — without the list the Codex pass on risk paths never runs, `PROC-DEV-002`; skipped when the
config's optional top-level `phase` is `"development"`, because `PROC-DEV-002` binds only in phase
`production` (`PROC-REL-009`) — `phase` takes `"development"` or `"production"`, any other value
is a config error, and an absent `phase` runs the check); a top-level `overlap` or `bundle` key in
the config (finding `config-retired`, one per key: both blocks are retired since 0.55.0, the config
still loads, delete the key); a
`spec-pins.json` that exists but is not a valid `{key: rev}` map; and a lying `.spec-sync-pause`
(reported, never removed) — plus the leftover worktrees and branches of aborted runs. Agent
types, skill tables, labels, norm revisions, `nightlyWorkflow`, legacy review keys and the
pre-push hook's content are the lead's business, not doctor's.

`doctor` reports each `npx spec-sync` — `npx` followed by `spec-sync`, whatever
flags stand between, `--no-install` included — in the pre-push hook and what it calls,
`.github/workflows/*.yml`, files under `scripts/`, and the root files agents act on (`CLAUDE.md`,
`AGENTS.md`, the whole `package.json`, `.claude/settings.json`, `.claude/settings.local.json` —
an allow rule `Bash(npx spec-sync *)` counts), by file and line. Own tools are never called
through npx: a bare `npx` downloads the unrelated public npm package `spec-sync` whenever the
local bin is missing, and `npx --no-install` still runs a copy of it that already lies in the npx
cache. Call `node_modules/.bin/spec-sync …` in shell, workflows, docs and allow rules,
`spawnSync(process.execPath, [fileURLToPath(import.meta.resolve("spec-sync-toolkit/dist/cli.js")), …])`
in Node, and bare `spec-sync …` inside a package.json script.

`doctor` also reads the npx cache of the current user (`$npm_config_cache` or
`$NPM_CONFIG_CACHE`, else `~/.npm`): every `_npx/<hash>/` folder whose `package.json` names the
package `spec-sync` (as its name or a dependency) is a finding (`npx-cache`) that names the
folder — delete it.

`review pr` reviews a draft PR exactly like a ready one; the pr-gate overrun is simply not measured while no check has run.

`ledger start <issue>` appends exactly one `work-started` event: run it when building a ticket
or a further increment of one begins, before a build agent starts. It is the
start the product quota of `queue` counts. It calls no `gh`; `--dry-run` writes nothing and returns
the event it would append. A start while the ticket's increment is still open — no `review` of mode
`pr`, no `merge-started`/`merge-completed` for it since its last real start (a new session
picking the ticket up again) — is a continuation: the event carries `resumed: true`, counts as no quota start and
keeps the build-agent count. `--new-increment` forces a fresh start (re-cut after the cap, no PR).

`ledger build <issue>` runs right before a build agent is spawned
(`impl`, `impl-fast`, `impl-deep`). It counts the `build-agent` events of the current increment
— after the newest `work-started` of the ticket — and appends one more. The third agent is the last:
a fourth is refused with exit 4 and nothing is written; the ticket is then re-cut into smaller
slices with their own acceptance criteria. A new `ledger start` for a further increment or slice
(after the PR review or merge, or with `--new-increment`) starts the count again; a continuation
does not.

**Fast lane**: `lenses` selects no lens and `review pr` makes no Codex call
(trigger `fast-lane`) for a diff of fewer than `fastLane.maxLines` changed lines (default 30) that
touches no product path. A file is a product path unless it matches `fastLane.toolingGlobs`
(tests, CI config, scripts, root tooling config); dependency manifests and lockfiles at any depth
(`package.json`, `package-lock.json`, `npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`, hidden
directories included — a fixed list), `fastLane.productGlobs` (an addition, default empty) and
every `review.riskGlobs` area always are, and a binary file keeps a diff out of the
lane. The gate always runs. `fastLane.maxLines: 0` turns the lane off. Optional `fastLane` block,
defaults as shown (`toolingGlobs` shortened here; the full list is in `src/config.ts`):

```jsonc
"fastLane": {
  "maxLines": 30,
  "toolingGlobs": ["**/*.test.*", "**/*.spec.*", "**/test/**", "**/e2e/**", ".github/**", "scripts/**", "…"],
  "productGlobs": []
}
```

**Cadence** (opt-in): the optional `cadence` block limits the
releases and Codex reviews of a repo per local day. `cadence tag` exits 4 once `tagsPerDay` tags
matching `tagPattern` (default `v*`) were made today. With `reviewsPerDay`, a `review tag` or
`review batch` run past the day's Codex reviews is `deferred` (exit 0, no call, no issue; the batch
marker stays, and the next `review tag` widens its range back to the end of the last reviewed one).
`cleanReviewIssue: false` opens no issue for a `review tag` run without any finding; the ledger
event (`tag`, `toSha`) stops a rerun. Without the block nothing changes.

```json
"cadence": { "tagsPerDay": 1, "reviewsPerDay": 1, "cleanReviewIssue": false }
```

`drift` compares the server's pins with `spec-pins.json` and writes nothing — a look-up for a
lead or the weekly review, never a gate (`SST-DESIGN-028` rev 3). It lists every moved key
(changed, added, removed). Exit 0 without moved keys, 1 with moved keys, 2 when
the spec server is unreachable (never "no drift"), 4 without a pin file (run `repin` first). Keys
matching `pinExclude` never count as drift.

`ledger close <issue> --reason "<text>"` ends an orphaned `merge-started` by hand — one that
`merge` cannot resume because its squash commit predates the current commit subject format. It
appends exactly one `merge-completed` with `closedByHand: true`, the reason and `ok: false` (not
a verified merge, so `budget` does not measure it); `handover` and `merge` then see the ticket
as closed. Exit 4 and nothing written unless the ledger holds a `merge-started` for the issue without
a later `merge-completed`, `gh issue view <issue> --json state` says `CLOSED`, and the reason is
non-empty. `--dry-run` writes nothing and returns the event it would append.

### Box slots (PROC-REL-060)

Every heavy local step on the dev Mac runs in one of N machine-wide slots (default 2): a third
waits. The slots are lock files `slot-<n>.lock` in `~/.spec-sync/box/` (`SPEC_SYNC_BOX_DIR`
overrides it), shared by all repos and worktrees; the count is `SPEC_SYNC_BOX_SLOTS`, else
`{"slots": n}` in `<box>/config.json`, else 2. Each slot carries the holder's pid and the
PROC-REL-040 holder line `repository=<owner/repo> run=<run id> started=<UTC ISO-8601> cap=<minutes>`.
A waiter prints one line per minute to stderr naming every holder, takes over the slot of a dead
pid, and ends with exit `75` when a holder outlived its cap by more than 5 min (look at that
holder) or its own wait passed the allowance — the largest holder cap plus 5 min — behind a chain
of holders (re-run). A holder line without a readable cap is printed raw and gets 40 min.

Load gate (owner decision 06.11.): a free slot is taken only while the 1-minute load
(`os.loadavg()[0]`) is below the ceiling — `SPEC_SYNC_BOX_LOAD_MAX` (a whole number ≥ 1), else 50.
While a slot is free but the load is at or above it, the waiter prints one line per minute
(`a slot is free, waiting … on load — 1-min load … ≥ ceiling …`) and polls. After 15 min held back
by load alone (time waiting for a busy slot does not count, and load wait does not count toward
the holders' deadlines) it takes the slot anyway: outcome `acquired-overload`.

Every acquire, and every expired wait, appends one line to `<box>/waits.jsonl` (`load` and
`load_waited_s` since 0.38; `outcome` is `acquired`, `acquired-overload`, `expired` or `chain`):

```json
{
  "at": "2026-11-05T10:00:00.000Z",
  "repository": "o/r",
  "step": "gate:merge",
  "run": "…",
  "waited_s": 12.3,
  "holders": ["repository=… run=… started=… cap=50"],
  "slots": 2,
  "load": 31.4,
  "load_waited_s": 0,
  "outcome": "acquired"
}
```

`gate` takes a slot right behind its `gate.lock` and holds it for exactly the phases (not on a CI
runner); its cap is 50 min (`GATE_CAP_MIN`, derived in `src/gate/lock.ts`). A wait is named in the
notes (`waited 12.3s for a box slot behind …`); an expired wait is a non-run — exit 2,
`reason: "no-run"`, the holder named. The `gate.lock` waiter follows the same rules (one line per
minute, exit 75 → gate exit 2) instead of a silent 30 min, and the lock carries the holder line
next to `pid` and `startedAt`.

`slot run` wraps any other heavy step (a gallery run, a pre-push build, an image build): it takes
a slot, runs the command under its cap in its own process group, releases the slot and passes the
command's exit code through. At the cap the command is killed — exit `124`; an expired wait is
exit `75` and nothing runs. `--cap` is required. The command's stdout and stderr go to stderr;
stdout carries only the response. `slot status` lists the slots (pid, alive, step, holder line),
the current 1-min `load` against `load_max`, and the last `--last <n>` (default 5) wait records.

`measure` changes a file a gate step measures against — size limits, coverage stock, hygiene
ratchet — and binds the change to a register decision (SST-DESIGN-002, PROC-DEV-047). The file
must be listed under `measureFiles` in `spec-sync.config.json`, every JSON pointer must resolve,
and decision `<n>` must be readable from the spec server (`GET /api/decisions/<n>`; server as
for `repin`); otherwise exit 4 and nothing is written. `--set <pointer>=<value>` and
`--remove <pointer>` add further changes to the same call, which applies as a whole or not at
all. `<value>` is JSON when it parses, a plain string otherwise; a removal from an array of
strings may name the string itself (`/entries/ad-catalog-filter-help`). The file is changed by
text edits of the touched values only, every other byte stays. Each call appends one
line to `.spec-sync/measure-changes.jsonl` — committed like `drift-coverage.jsonl`, so the
consuming repo re-includes it in its `.gitignore`. It never commits and never touches the gate.

`review` is the only way a repo calls Codex (SST-DESIGN-030, PROC-DEV-049): it triages the diff
(risk areas → `models.risk`, large diff or new module → `models.size`, else no call), runs
`codex exec --sandbox read-only -m <model> -c model_reasoning_effort=<effort>` with the prompt on stdin, and posts the strict result as
a PR comment (`pr`), as deduplicated issues (`batch`, over `review/last..origin/main`) or as one issue
per tag (`tag`). Every engine failure is a skip with exit 0 — never another model. Exit 1 means a
critical or high finding is open. Configuration lives in the optional `review` block of
`spec-sync.config.json`; unknown keys are ignored. Defaults as shown:

```jsonc
"review": {
  "riskGlobs": {},                 // {area: [glob]}: a touched area sends the diff to models.risk
  "models": { "risk": "gpt-6-astra", "size": "gpt-5.6-sol" },
  "effort": { "risk": "high", "size": "medium" }, // low | medium | high; xhigh is rejected
  "size": { "files": 15, "lines": 600 },          // at or above either → models.size
  "textGlobs": [],                 // files that do not count toward size, on top of *.md
  "modulesRoot": null,             // optional; a new directory directly under it is a new module
  "marker": "review/last",         // the tag `review batch` reviews from and moves
  "label": "review-codex",         // label of every finding issue
  "securityLabel": "security",     // added to an issue with a security finding; read by `queue`
  "priorityCap": null,             // optional: critical | high | medium, the highest priority label a finding issue gets
  "timeoutMs": 900000,             // per Codex call
  "maxDiffBytes": 400000           // larger batch diffs are split per commit
}
```

`modulesRoot` and `priorityCap` have no default; leave them out instead of writing `null`.

`budget` and `handover` are plain commands for a session that wants them (SST-DESIGN-023,
SST-DESIGN-024); no hook asks for either. `budget` measures a session's context level from its
transcript against `contextBudget` and returns the numbers — whether to go on is the session's
call. `handover` writes `.spec-sync-handover.md`, a snapshot for the next session: repo, `main`
HEAD, pin state, the last context measurement, the queue head, unfinished merges and `--note`.

`--reason budget` is bound to the measurement: it is only written when the writing session's
own context level reaches at least 75 % of the configured context budget —
otherwise `handover` writes nothing and ends with exit 1 (SST-DESIGN-024 rev 3).
The measurement is always the writing session's own: `--session` measures
that transcript freshly, like `budget --session`; without it the session the client names
(`CLAUDE_CODE_SESSION_ID`) is measured, falling back to that session's newest ledger event;
with no session known, parallel live transcripts end in exit 3 ("name one with --session"). A
ledger event of a foreign session never attests. `budget` records
the session id on every `context` event, and the handover carries it as `- Session: <id>`.

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

A red phase does not end a run (SST-DESIGN-016 rev 6): every phase of the profile runs, and a red
response carries `failures[]` — one `{ name, firstError }` per failed phase in run order — next to
`firstError` (that of the first failed phase). The exit is `1` when at least one failed phase is a
defect and `2` only when every failed phase is unprovable on its own. A phase that exits `75`
(lock deadline expired, PROC-REL-040 rev 7) never ran: it is unprovable whatever it printed, never
red, and the note says `phase <name>: lock deadline expired (exit 75) — not run`. The one early end is a phase
marked `blocking`: once it is red, the phases behind it are skipped with
`reason: "blocked by <phase>"`.

Every gate run that did run writes a `gate` ledger event (v0.28.0, SST-DESIGN-026) with `phases[]`
(`name`, `exit`, `durationMs`, `skipped`) and, when red, `failedPhase` (the first failed phase) and
`failedPhases` (all of them, run order). If the working tree was clean at the
start and at the end of the run (v0.29.0, SST-DESIGN-016 rev 5 "Beleg nach Baum"), the event carries `tree`
(`git rev-parse HEAD^{tree}`); `merge` accepts the latest green `merge`-profile run whose `tree` equals the
tree of the ticket branch head, with or without `--issue`. A run on a dirty tree without `--issue` is no
evidence; the `--issue`-based evidence stays valid as an alternative.

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
accident. `--preflight` on any other profile is exit 4 naming the flag. Like a gate run, a red
phase does not end the pre-run (SST-DESIGN-013 rev 5): it reports the full failure list, and
`blocking` phases behave the same way.

The two phase fields it reads, both optional:

```jsonc
{ "name": "unit", "cmd": "npm test", "imageOnly": "PROC-REL-030" },
{ "name": "audits", "cmd": "npm run audit:gate", "preflightCmd": "npm run audit:gate -- --no-build" }
```

`imageOnly` is the **reason** the phase stays out of the pre-run (it judges only in the gate
image, or a norm forbids it on the developer machine), never a boolean; `preflightCmd` is the
build-free part of the phase.

A third optional phase field, read by every gate run and the pre-run alike:

```jsonc
{ "name": "build", "cmd": "npm run build", "blocking": true }
```

`blocking: true` marks a phase whose red makes every later phase meaningless (an environment
preflight, `build` in front of browser phases); without it, a red phase never stops the run.

Everything project-specific lives in one file, `spec-sync.config.json`: gate phases and
profiles, path globs for review lenses, label names, log retention, context budget.
`contextBudget` defaults to **250 000** for `budget` and `handover` alike (SST-DESIGN-023 rev 5,
SST-DESIGN-014 rev 3); a repo sets it only to deviate on the owner's word — a missing entry never
means "no limit".

`queue` sorts by a priority class label first (SST-DESIGN-017 rev 6, PROC-DEV-039 rev 3 "sort
level ½"): `P1 must` → `P2 important` → `P3 polish`, then by the four tiers (audit · bug · build,
started before unstarted, phase, issue number) within each class. Every queue entry carries
`class` (`must`, `important`, `polish` or `unclassified`). A ticket without a class label sorts as
P2 and is listed in `unclassified` (`{ issue, title }`) for backfill — the class is never guessed;
a ticket with several class labels sorts by the highest and is reported as a `label-drift`
finding. A note names the count per class. The label names are configurable:

```jsonc
"labels": { "priority": { "must": "P1 must", "important": "P2 important", "polish": "P3 polish" } }
```

The product quota sits above the class (SST-DESIGN-017 rev 11, PROC-DEV-039 rev 5 level ¼). Every
entry carries a `slot`. `bypass` always goes first, and only three things go there (0.49.0, register
#2030): the audit ticket of a red `main` (`labels.mainRed`, default `main-red`, set by the ticket's
creator — never read from the title), a `P1 must` ticket with the security label
(`review.securityLabel`), and one with `labels.mergeBlocker`. Every other audit — a failing nightly,
night-security, night-ux, an image scan — stays P1 but takes the third slot. The rest is split into
`product` (`labels.product`) and `third` (everything else; inside it `labels.pipeline` first, then
the escalated sweep, then the due sweep, then the levels). The two are interleaved start by start:
when one of the last two starts was not product and a product ticket is buildable, the product head
comes next; with no buildable product ticket, the third-slot head; otherwise the better head by the
levels. That yields T, P, P — at least two of every three starts product. A start is a
`work-started` ledger event (`ledger start`); a ledger without one yet falls back to the older,
lagging signals for the lines before its first `work-started`: a `merge-started` event or the first
`review` event of mode `pr` per PR number. Its kind comes from the ticket's labels (a closed ticket costs one `gh issue view`, an
unreadable one is `unknown` and counts as not product). The output carries `quota`
(`starts`, `nonProduct`, `forced`, `head`) and a note. `--check` and `--health` do not read the
ledger. A sweep entry carries `sweep: "escalated" | "due"`; a sweep ticket without a `Phase:`
comment counts to the current phase. A ticket in its merge gate is finished before the head.

```jsonc
"labels": {
  "product": "product",
  "mergeBlocker": "merge-blocker",
  "mainRed": "main-red",
  "pipeline": "pipeline",
  "sweep": "sweep",
  "nonProduct": []
}
```

`queue --health` (SST-DESIGN-017 rev 7) runs the same sweep and judges it like a gate: exit 0 when
nothing is found, exit 1 with one `health` finding per failed check. The checks: `unclassified`
(a swept ticket without a class label), `several-classes` (more than one class label),
`p1-share` (P1 tickets above `p1MaxShare` of the swept queue, judged only from `p1MinQueue`
tickets on; a sweep ticket never counts as P1 here) and `stale-block` (a ticket with the block label whose newest comment is older than
`staleBlockDays`; without any comment the issue's `updatedAt` stands in); a block whose newest comment names a still-open ticket of the repo (`#<n>`) waits on that ticket and is skipped (rev 8). A fifth check, `quota-unclassified`, is a warning only (`warnings`, never the exit): swept tickets with neither the product label nor a non-product marker (pipeline, sweep, merge-blocker, audit, security, review label, `labels.nonProduct`) above `quotaUnclassifiedMax`. Each finding carries
`check`, `tickets` (at most 10 numbers, `more` counts the rest), `value` and `threshold`. It writes
nothing — no label, comment or ledger event — and does not call the nightly. `--health` together
with `--check` exits 4. Thresholds live in an optional `health` block, defaults as shown:

```jsonc
"health": { "p1MaxShare": 0.25, "p1MinQueue": 8, "staleBlockDays": 7, "quotaUnclassifiedMax": 0 }
```

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
{ "name": "map", "cmd": "node_modules/.bin/spec-sync map check" }
```

Exit codes: `0` the meaning layer is complete (`check`) or the model was written (`extract`) ·
`1` unmapped keys or nodes (`check` only) · `4` no meaning layer at the given path, no project
id, an unknown subcommand or an unknown option.

Both read a repo checkout: the positional `<repo-root>` (default: the repo the CLI runs in) and
`--meaning` for a meaning layer that does not yet live in that repo. Model schema and the
meaning layer in full: `docs/map-model-schema.md` in the spec repo (PROC-SPEC-002).

## Requirements

Node ≥ 22, `git`, and `gh` on the `PATH`. Some commands read a spec server over HTTP; its
endpoint comes from the `spec` entry in `.mcp.json` (`--server` overrides, both accept the
full endpoint or the base URL). On this setup the spec server is `http://localhost:8787/mcp`.

## Install and build on a new machine

```bash
git clone https://github.com/patrickblattner/spec-sync-toolkit.git ~/projects/spec-sync-toolkit
cd ~/projects/spec-sync-toolkit
mise install            # Node 26.12.1, pinned in mise.toml
mise x -- npm install   # the prepare script runs tsup and builds dist/
```

`npm install` builds `dist/cli.js`, the `spec-sync` binary. The toolkit ships no Stop or
SubagentStop hook (SST-DESIGN-015 rev 6). After a pull, rebuild with `mise x -- npm run build`.

## Licence

None. No licence is granted; all rights reserved. If that matters to you, do not use it.
