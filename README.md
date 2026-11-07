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
spec-sync queue [--check | --health | --bundle]
spec-sync pack <issue>
spec-sync merge <issue> --branch <name> [--dry-run]
spec-sync lenses [--base main]
spec-sync report [--run <id>]
spec-sync doctor
spec-sync budget [--session <id|path>] [--label <text>]
spec-sync handover [--note <text>] [--reason <budget|done|red-2x|question-open|pause|unexpected>] [--session <id|path>]
spec-sync repin [--ids <a,b>] [--server <url>]
spec-sync repin --check [--server <url>]
spec-sync pr overlap <open-pr> --merged <merged-pr>
spec-sync ledger close <issue> --reason "<text>" [--dry-run]
spec-sync slot run --step <name> --cap <minutes> [--run <id>] -- <cmd> [args…]
spec-sync slot status [--last <n>]
<pre-push stdin> | spec-sync prepush [--cap-min <minutes>]
spec-sync map extract [<repo-root>] [--out <dir>] [--meaning <file>] [--project <id>]
spec-sync map check [<repo-root>] [--meaning <file>] [--project <id>]
spec-sync measure set <file> <pointer> <value> --register <n> [--server <url>]
spec-sync measure remove <file> <pointer> --register <n> [--server <url>]
spec-sync review pr <n> [--issue <t>] [--recheck]
spec-sync review batch [--dry-run]
spec-sync review tag <from>..<to>
spec-sync review verdict <pr|issue> <n> <id> (accepted (fixed|ticket <t>|collected <c>) | rejected "<reason>") [--source claude:<lens>]
spec-sync licence-inventory [--allowlist <file>]
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

### Push flow with little CI rework (PROC-DEV-005)

The pre-push hook of an app repo runs the merge pre-run and the pin check on the tree being
pushed (Node hook script, as `simple-git-hooks` calls it):

```js
const preflight = spawnSync("npx", ["spec-sync", "gate", "--profile", "merge", "--preflight"], {
  stdio: "inherit",
});
if (preflight.status !== 0) process.exit(preflight.status ?? 1);
const pins = spawnSync("npx", ["spec-sync", "repin", "--check"], { stdio: "inherit" });
if (pins.status === 2) console.error("• pre-push: spec server unreachable — pin check skipped");
else if (pins.status !== 0) process.exit(pins.status ?? 1);
```

`repin --check` is read-only (no file and no server write). Exit 0: the committed
`spec-pins.json` and `.spec-sync/drift-coverage.jsonl` are what this push needs. Exit 1, listing
`stale` keys and `uncommitted` files: either file differs from `HEAD` (uncommitted or untracked),
or a moved key already carries a valid receipt but is not pinned — `repin` would write it now, so
it belongs in the same commit as the change. A moved key without a receipt is fresh server drift
for the loop, not stale for the push: it is counted in `uncovered` and a note, never a red. Exit 2:
the spec server is unreachable and nothing local is stale — the hook passes with a line. Exit 4:
no pin file, or `--check` with `--ids`.

`doctor` checks the push flow in a repo that lands through PRs (one with `.github/workflows`):
the pre-push hook (`.husky/pre-push`, `.githooks/pre-push`, or `simple-git-hooks` / `husky.hooks`
in `package.json`, followed one step into the script or npm script it calls) must run
`spec-sync gate --profile merge --preflight` — otherwise a finding names the file and the line to
add; `.gitattributes` must carry `.spec-sync/drift-coverage.jsonl merge=union` (finding); and the
merge profile should carry a `unit-static` phase — a **warning**, listed under `warnings`, which
never turns the exit red.

`pr overlap <open-pr> --merged <merged-pr>` decides after a merge whether an open PR is put onto
the new main. It reads both file lists (`gh pr diff --name-only`). Exit 1 (update): the PRs share
a file that is not generated, or the merged PR touched visual baselines, registries, translations
or the schema. Exit 0 (no update): neither. The reason is one line in `notes`. A lockfile counts
like any other file — only when both PRs touch it; a generated file never counts. The globs
(picomatch) live in an optional `overlap` block; each key defaults on its own:

```jsonc
"overlap": {
  "generated": [".spec-sync/drift-coverage.jsonl"],
  "visualBaselines": ["**/*-snapshots/**", "**/__screenshots__/**", "**/__image_snapshots__/**"],
  "registries": ["**/*registry*", "**/*-manifest.json", "**/*-allowlist.json"],
  "translations": ["**/i18n/**", "**/locales/**", "**/translations/**"],
  "schema": ["**/migrations/**", "**/schema.sql", "**/*_schema.sql", "**/schema.prisma", "**/data/schema.ts", "**/db/schema.ts"]
}
```

`queue --bundle` proposes a bundle from the head of the sorted queue; the order itself is
untouched. Up to `maxTickets` tickets that stand next to each other, share the same area, are
each small (the `labels.bug` or `labels.priority.polish` label, or one of `smallLabels`), are not
blocked, and carry none of `excludeKeywords` (word prefix, case-insensitive) in title or labels.
The area is the ticket's one area label (`areaPrefix`); the label wins when present. Without one,
it is the area of the spec keys in title and body (the key shape `pack` parses, bare or
backticked): the segments between kind and number — `COM-FEATURE-CONT-100` → `CONT`,
`CPT-FEATURE-TPL-061` → `TPL`, while a foundation key keeps its kind, `GL-UI-034` → `GL-UI`. A
ticket whose keys span several areas, include a key without an area (`COM-FEATURE-591`), or that
has no key stands alone. A label area and a key area never count as the same area. The first
follower that fails ends the run and is listed in `excluded` with its reason; an unbundleable head
stands alone with its reason. The payload carries `bundle` (ticket numbers, head first), `area`,
`areaSource` (`label` or `keys`), `lineCap` and `excluded`. The ~300-line cap is
printed, not enforced — the worker measures the diff after building and splits a bundle that
grows past it; whether a ticket is an intended visual change beyond its keywords is also the
worker's call. No nightly call, nothing written; with `--check` or `--health` exit 4. Optional
`bundle` block, defaults as shown:

```jsonc
"bundle": {
  "maxTickets": 3,
  "maxLines": 300,
  "areaPrefix": "area: ",
  "smallLabels": ["bug", "fix", "i18n", "translation", "a11y", "accessibility"],
  "excludeKeywords": ["schema", "migration", "ratchet", "baseline", "measure", "registry", "registries", "visual"]
}
```

`review pr` reviews a draft PR exactly like a ready one — PRs open as drafts and Codex runs before
ready; the pr-gate overrun is simply not measured while no check has run.

`ledger close <issue> --reason "<text>"` ends an orphaned `merge-started` by hand — one that
`merge` cannot resume because its squash commit predates the current commit subject format. It
appends exactly one `merge-completed` with `closedByHand: true`, the reason and `ok: false` (not
a verified merge, so `budget` does not measure it); `doctor` and `handover` then see the ticket as
closed. Exit 4 and nothing written unless the ledger holds a `merge-started` for the issue without
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

`prepush` is the light preflight a repo's pre-push hook calls (PROC-DEV-005 rev 7), with git's
pre-push stdin handed on. A push that changes no code passes with exit 0 and one line saying why:
only tags, only branch deletes, or commits that change nothing but `spec-pins.json` and
`.spec-sync/drift-coverage.jsonl` (diffed against the remote sha, or the merge-base with
`origin/main` for a new branch). Every other push runs `gate --profile merge --preflight --changed`
in the repo root, under a hard cap (`--cap-min`, default 10). Past the cap the gate's whole process
group is ended (SIGTERM, SIGKILL after 5 s), the `gate.lock` and box slot it held are released,
and the run exits 0 with a notice: the push goes through and the runner's required check decides.
Within the cap the gate's exit code, `failures`, `error`, `notes` and `logDir` pass through. No ref
lines on stdin means the preflight runs. The WIP escape and the secret guard stay in the hook.

Before the preflight, `prepush` refuses a push onto a running or green ready PR (PROC-DEV-005
rev 8). For each pushed branch (not tags or deletes) it asks
`gh pr list --head <branch> --state open --json number,isDraft`; for an open non-draft PR it reads
the required checks with `gh pr checks <n> --required --json name,bucket` (what branch protection
requires). Any `fail`/`cancel` bucket means the last verdict is red and the push goes through;
otherwise a `pending` bucket (running) or all `pass`/`skipping` (green) refuses it with exit 4,
naming the PR and the escapes: `gh pr ready <n> --undo`, or `SPEC_SYNC_REGATE=1 git push` for an
overlap update (`--regate`; git gives hooks no flags). A push whose every changed path is an
existing PNG with status M goes through. Draft PRs and branches without a PR are never refused.
If `gh` fails, times out (20 s) or reports no required check, the push goes through with one line.

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
`spec-sync.config.json`.

`--reason budget` is bound to the measurement: it is only written when the writing session's
own context level reaches at least 75 % of the configured context budget —
otherwise `handover` writes nothing and ends with exit 1 (SST-DESIGN-024 rev 3, PROC-DEV-037).
The measurement is always the writing session's own (PROC-DEV-037 rev 10): `--session` measures
that transcript freshly, like `budget --session`; without it the session the client names
(`CLAUDE_CODE_SESSION_ID`) is measured, falling back to that session's newest ledger event;
with no session known, parallel live transcripts end in exit 3 ("name one with --session"). A
ledger event of a foreign session never attests. The stop hook's budget block names its own
session and dictates `npx spec-sync handover --reason budget --session <id>`. `budget` records
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
`contextBudget` defaults to **250 000** for the CLI and all hooks alike (PROC-DEV-036 rev 10,
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

`queue --health` (SST-DESIGN-017 rev 7) runs the same sweep and judges it like a gate: exit 0 when
nothing is found, exit 1 with one `health` finding per failed check. The checks: `unclassified`
(a swept ticket without a class label), `several-classes` (more than one class label),
`p1-share` (P1 tickets above `p1MaxShare` of the swept queue, judged only from `p1MinQueue`
tickets on) and `stale-block` (a ticket with the block label whose newest comment is older than
`staleBlockDays`; without any comment the issue's `updatedAt` stands in); a block whose newest comment names a still-open ticket of the repo (`#<n>`) waits on that ticket and is skipped (rev 8). Each finding carries
`check`, `tickets` (at most 10 numbers, `more` counts the rest), `value` and `threshold`. It writes
nothing — no label, comment or ledger event — and does not call the nightly. `--health` together
with `--check` exits 4. Thresholds live in an optional `health` block, defaults as shown:

```jsonc
"health": { "p1MaxShare": 0.25, "p1MinQueue": 8, "staleBlockDays": 7 }
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
node <toolkit>/dist/hooks/subagent-stop-check.js   # SubagentStop hook: budget (agent's own transcript) + completion acceptance of the build agents
node <toolkit>/dist/hooks/architect-stop-check.js  # stop hook: budget boundary of the architect inbox (75 %, once)
```

`subagent-stop-check` measures the sub-agent's own transcript (`agent_transcript_path` of the
SubagentStop input, the parent's `transcript_path` only as a fallback) against `contextBudget` and
keeps its block counter per agent run; at 100 % it blocks once and orders `CONTEXT LOW` (v0.27.0, register #1707); the agent finishes its
ticket, and the next ticket gets a fresh agent anyway (register #1741).

`architect-stop-check` (owner's word 08/22, PROC-DEV-020 rev 4 / PROC-DEV-036 rev 5) is the
architect variant: pause flag → fresh handover (with attest verification) → budget stage at
**75 %** of `contextBudget` from the spec repo's `spec-sync.config.json`, exactly once per
session. No workbench, no checker. The block dictates the handover with the measured number
(the session does not know its window, the hook does); if an owner conversation is running
(the worker-harness hook's state file `session-state.js`, field `last_owner_prompt_at`), it
forces the announcement "please /handover" instead of the handover. The owner's `/handover`
is a pure release (field `last_release_at`, register #1186/#1187): it writes no handover, and
the conversation counts again only with an owner prompt newer than the release — so the next
turn end hits the `budget` stage. The claim also expires at `owner_claim_expires_at` (#1188). A freshly written
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
