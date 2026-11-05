# Changelog

## 0.37.0

Dev-box slots (PROC-REL-060, owner decision register #1960).

### Added

- Box slots: every heavy local step on the dev Mac takes one of N machine-wide slots (default 2;
  `SPEC_SYNC_BOX_SLOTS`, else `{"slots": n}` in `<box>/config.json`) in `~/.spec-sync/box/`
  (`SPEC_SYNC_BOX_DIR`). Waiter per PROC-REL-040 rev 7: holder line
  `repository=… run=… started=… cap=…`, one stderr line per minute naming every holder, dead-pid
  takeover, exit 75 when a holder outlived its cap by more than 5 min or the wait passed the
  allowance (largest holder cap + 5) behind a chain; an unreadable holder line is printed raw
  with a 40 min fallback. Every acquire and every expired wait appends one record to
  `<box>/waits.jsonl` (`at`, `repository`, `step`, `run`, `waited_s`, `holders`, `slots`,
  `outcome`).
- `slot run --step <name> --cap <minutes> [--run <id>] -- <cmd> [args…]` — runs any heavy step
  under a slot and its cap (own process group; killed at the cap, exit 124), passes the command's
  exit code through, exit 75 on an expired wait. `slot status [--last <n>]` — holders and the
  last wait records.

### Changed

- `gate` takes a box slot right behind `gate.lock`, for exactly the phases (not on a CI runner),
  with a cap of 50 min (`GATE_CAP_MIN`: suite-ui merge, longest of the last five green runs
  36.1 min + a third, rounded up). A wait is named in the notes; an expired wait is a non-run
  (exit 2, `reason: "no-run"`, holder named) and releases `gate.lock`.
- `gate.lock` waiter (#31): one line per minute naming the holder, exit 75 per PROC-REL-040
  (→ gate exit 2, non-run) instead of a silent 30 min ending in exit 4. The lock record carries
  the holder line next to `pid` and `startedAt`, which a 0.36 reader still reads; a 0.36 record
  without a holder line is waited on with the 40 min fallback. Locks now appear atomically
  (written aside, hard-linked into place), so no reader sees a half-written lock.
- Arguments behind `--` reach the command verbatim (the dispatcher no longer reads `--repo`,
  `--human` … there).

## 0.36.2

### Added

- `ledger close <issue> --reason "<text>" [--dry-run]` — ends an orphaned `merge-started` by hand
  when `merge` cannot resume it (its squash commit predates the current commit subject format).
  Appends exactly one `merge-completed` with `closedByHand: true`, the reason and `ok: false`, so
  `doctor` and `handover` see the ticket as closed and `budget` does not measure it. Exit 4 and
  nothing written unless the ledger holds a `merge-started` for the issue without a later
  `merge-completed`, `gh issue view` says `CLOSED`, and the reason is non-empty.

### Changed

- `gate`: a phase that exits `75` (lock deadline expired, `EX_TEMPFAIL`, PROC-REL-040 rev 7) is a
  non-run — exit 2 whatever its output says, never red; the note reads
  `phase <name>: lock deadline expired (exit 75) — not run`.

## 0.36.1

### Changed

- `queue --bundle` no longer needs an `area:` label (PROC-DEV-005 §Bundled tickets, register
  #1950): a ticket without one takes its area from the spec keys in title and body — the key
  shape `pack` parses, bare or backticked — as the segments between kind and number
  (`COM-FEATURE-CONT-100` → `CONT`, `CPT-FEATURE-TPL-061` → `TPL`, `GL-UI-034` → `GL-UI`). Keys of
  several areas, a key without an area, or no key at all ⇒ the ticket stands alone. The label wins
  when present; a label area and a key area never count as the same. The payload gains
  `areaSource` (`label`|`keys`); only `--bundle` fetches issue bodies.

## 0.36.0

PR flow with little CI rework (PROC-DEV-005, owner go register #1950).

### Added

- `repin --check` — read-only pre-push check: exit 0 when the committed `spec-pins.json` and
  `.spec-sync/drift-coverage.jsonl` are what the push needs; exit 1 listing `stale` keys (moved,
  already receipted, not pinned) and `uncommitted` files (pins or ledger differ from `HEAD`);
  exit 2 when the spec server is unreachable and nothing local is stale (the hook passes on 2);
  exit 4 without a pin file or with `--ids`. A moved key without a receipt is fresh drift, counted
  in `uncovered`, never a red. Writes nothing.
- `pr overlap <open-pr> --merged <merged-pr>` — after a merge, exit 1 when the open PR must be
  updated (shares a non-generated file with the merged PR, or the merged PR touched visual
  baselines, registries, translations or the schema), exit 0 otherwise; the reason in one line.
  Globs in the new optional `overlap` block (`generated`, `visualBaselines`, `registries`,
  `translations`, `schema`), each with its own default.
- `queue --bundle` — proposes a bundle from the head of the sorted queue (order untouched): up to
  `bundle.maxTickets` (3) adjacent tickets of one area label, each small (bug, polish or a
  `bundle.smallLabels` label), not blocked, none keyed by `bundle.excludeKeywords` (schema,
  migration, ratchet, baseline, measure, registry, visual). Payload `bundle`, `area`, `lineCap`
  (`bundle.maxLines`, 300 — printed, enforced by the worker after building) and `excluded` with
  the reason. `--bundle` with `--check` or `--health` → exit 4.
- `doctor`, in a repo with workflows: finding when the pre-push hook (`.husky/pre-push`,
  `.githooks/pre-push`, `simple-git-hooks`/`husky.hooks` in `package.json`, followed one step into
  the script or npm script it calls) does not run `spec-sync gate --profile merge --preflight` —
  naming the file and the line to add; finding when `.gitattributes` lacks
  `.spec-sync/drift-coverage.jsonl merge=union`; **warning** (new `warnings` list, exit stays 0)
  when the merge profile has no `unit-static` phase.

### Unchanged, now tested

- `review pr` reviews a draft PR like a ready one (it never read `isDraft`); a draft without
  checks leaves `overrunMs` unset.

## 0.35.0

### Changed

- **Breaking for callers:** `licence-allowlist.json` exceptions are now
  `{ package, licence, reason }` — every exception needs `licence`, the expression it was granted
  for (the read SPDX expression, `UNLICENSED`, or `unreadable`). An exception passes only while the
  package's read licence equals it (SPDX text compared up to case and whitespace; `unreadable`
  needs an unreadable package); otherwise it is a finding
  `exception granted for <X>, package now <Y>`. An exception without `licence` or `reason` → exit 4
  naming the entry (SST-FEATURE-001 rev 5).
- `licence-inventory` no longer judges nodes `npm ls` marks `extraneous`; they are not part of the
  closure and are counted as `skippedExtraneous` in the payload (always present, 0 if none).

## 0.34.0

### Added

- `licence-inventory [--allowlist <file>]` — shared licence inventory of the production closure
  (`npm ls --omit=dev --all --json`, workspaces included, own workspace packages skipped), replacing
  `license-checker` (GHSA-g3hv-75wg-m249 has no fixed version in its chain). Licence from the
  installed `package.json` (`license`, legacy `licenses`), else the LICENSE/LICENCE/COPYING file
  matched against common SPDX licence texts; unreadable = finding. Judged against
  `licence-allowlist.json` (allowed SPDX ids plus per-package exceptions with a reason;
  `UNLICENSED` passes only by exception). Offline, fail-closed; exit 0/1, missing allowlist exit 4.
  Payload: package count, finding count, first 10 findings, path of the full inventory JSON in the
  log directory. No new dependency (SST-FEATURE-001 rev 4).

## 0.33.2

### Changed

- Norm pin `PROC-DEV-039` raised to rev 4 (a toolkit pin raise is always `P1 must`). That is the
  worker's classification rule, so the queue defaults stay unchanged; `doctor` no longer reports
  the norm-hash finding.
- Spec pin `PROC-DEV-039` raised to rev 4.

## 0.33.1

### Changed

- `queue --health` `stale-block` skips a blocked ticket whose newest comment names a still-open
  ticket of the same repo (`#<n>`) — a documented dependency, not a stale block; once that ticket is
  closed the block counts again. Open means "in the sweep's open-issue list"; no extra `gh` call
  (SST-DESIGN-017 rev 8).
- Spec pin `SST-DESIGN-017` raised to rev 8.

## 0.33.0

### Added

- `queue --health` judges the sweep like a gate: exit 0 without a finding, exit 1 with one `health`
  finding per failed check — `unclassified`, `several-classes`, `p1-share` (above 25 % from 8
  swept tickets on) and `stale-block` (blocked, newest comment older than 7 days; `updatedAt` when
  there is no comment). Each finding names the check, up to 10 tickets plus a count, value and
  threshold. Writes nothing; `--health` with `--check` exits 4. Thresholds configurable in the new
  optional `health` block (`p1MaxShare`, `p1MinQueue`, `staleBlockDays`). The sweep now also
  fetches `updatedAt` (SST-DESIGN-017 rev 7).
- Spec pin `SST-DESIGN-017` raised to rev 7.

## 0.32.0

### Added

- `queue` sorts by a priority class label first — `P1 must` → `P2 important` → `P3 polish` —
  ahead of the four tiers, which stay unchanged within each class. Each entry carries `class`;
  a ticket without a class label sorts as P2 and is listed in the new `unclassified` list; several
  class labels sort by the highest and raise a `label-drift` finding; a note names the count per
  class. Label names configurable as `labels.priority.must|important|polish`. Without class
  labels the order is unchanged; `--check` is unchanged (SST-DESIGN-017 rev 6, PROC-DEV-039 rev 3).
- Norm pin `PROC-DEV-039` raised to rev 3.

## 0.31.0

### Changed

- `gate` and `gate --preflight` no longer stop at the first red phase: every phase of the profile
  runs and the response carries `failures[]` (`{ name, firstError }` per failed phase, run order);
  top-level `firstError` stays that of the first failed phase. Exit `1` when at least one failed
  phase is a defect, `2` only when every failed phase is unprovable; the unprovable note names
  the phases. The ledger `gate` event adds `failedPhases[]` next to `failedPhase` on red runs.
  Green runs are unchanged (SST-DESIGN-016 rev 6, SST-DESIGN-013 rev 5).

### Added

- Optional phase field `blocking`: a red blocking phase skips every later phase with
  `reason: "blocked by <phase>"`.

## 0.30.4

### Security

- `zod` raised to 4.6.7 (Dependabot alert 1, HIGH: memory exhaustion while validating oversized
  constrained collections; patched in 4.6.6). No API change.

## 0.30.3

### Changed

- `lenses`: files matching `review.textGlobs` select no lens, so a diff of only text or translation
  files gets none (PROC-DEV-002, SST-DESIGN-020 rev 3, Q#4843). Extglob workarounds in lens globs
  that only exist to skip text files can go back to plain globs.
- `doctor` reports a missing `nightlyWorkflow` when the repo has workflows under
  `.github/workflows/`; without it the red-main check of `queue` is silently off (SST-DESIGN-022
  rev 4, console-hub Q#4841).
- Node pinned to 26.12.1 (`mise.toml`).
- Norm pin PROC-DEV-010 rev 6 (review findings fixed in the same PR; no label change).

## 0.30.2

### Fixed

- `merge` resume counts only its own squash commit (subject = issue title + `#<n>`) as landed on
  `main`, never any subject that merely mentions the ticket. A spec repin `→ #622` after a stale
  `merge-started` made the resume skip squash, commit and push, then close the issue and delete the
  branch while `main` had not moved (suite-ui Q#4807).
- A resume that has to redo squash and commit also pushes, whatever `pushed` reported before the new
  commit existed.

## 0.30.1

### Fixed

- The turn-end acceptance check (`spec-sync hook stop`) calls `claude -p --model haiku` (family alias, newest Haiku) instead of the pinned old ID `claude-haiku-4-5-20251001`.

## 0.30.0

### Fixed

- `review batch` and `review tag` issues with findings carry the labels of SST-DESIGN-030 rev 4:
  `review-codex`, the control label `labels.bug` from the config (default `type: bug`), `priority:`
  of the highest critical/high/medium finding, `status: backlog`, and `securityLabel` for an area
  security finding; never `spec-sync` or `auto-audit`. Before, they carried only `review-codex` and
  the worker loop never picked them up (PROC-DEV-010: no ticket without a control label).
- The first acceptance criterion of every batch and tag issue body is the premise check: confirm the
  finding on current `main`, otherwise close it via `spec-sync review verdict issue <n> <id> rejected
"<reason>"`.
- A `review tag` run without a critical, high or medium finding (clean, or only low/taste) is a record:
  the issue carries only `review-codex`, no acceptance criteria, and closes at once; the closed issue
  still stops a rerun (SST-DESIGN-030 rev 5).

### Migration for the apps

- `gh issue create` fails on a label the repo does not have. Create the labels once in every repo that
  runs `review batch` or `review tag`: `priority: critical`, `priority: high`, `priority: medium`,
  `status: backlog` (and `type: bug`, or the configured `labels.bug`, if missing), e.g.
  `gh label create "status: backlog"`.
- Open finding tickets that carry only `review-codex` get `type: bug` by hand, once.

## 0.29.0

### Added

- Evidence by tree (SST-DESIGN-016 rev 5, SST-DESIGN-026 rev 7): a gate run whose working tree was
  clean at start and end records `tree` (`git rev-parse HEAD^{tree}`) in its ledger event. `merge`
  accepts the latest green `merge`-profile run whose `tree` equals the tree of the ticket branch head,
  with or without `--issue`. A dirty-tree run without `--issue` is no evidence; `--issue` evidence stays
  valid as an alternative.

No config migration.

## 0.28.2

### Fixed

- `merge`'s commit-on-main postcondition recognizes a landed ticket anywhere on main since
  `merge-started`, with a digit-boundary match (`#12` no longer matches `#125`) (SST-DESIGN-019 rev 5).

No config migration.

## 0.28.1

### Changed

- The norm pin for PROC-DEV-047 moves to rev 7 (`status: deferred` rule).

### Fixed

- `gate` compares the ledger path by realpath: no spurious main-checkout note through a symlink.
- `gate-changed` tests start the failing calls one at a time (no floating rejection).

No config migration.

## 0.28.0

### Added

- Every gate run that did run writes a `gate` ledger event (SST-DESIGN-026 rev 6) with `phases[]`
  (`name`, `exit`, `durationMs`, `skipped`) and, when red, `failedPhase`. Without `--issue` it carries no
  `issue` and is no evidence for `merge`.

No config migration.

## 0.27.0

### Changed

- The default context budget drops from 800,000 to 250,000 tokens (SST-DESIGN-023 rev 3,
  PROC-DEV-036 rev 10, owner register #1707). It applies to the CLI config and the hooks alike.

### Fixed

- The Stop, SubagentStop and architect stop hooks enforced no budget at all in repos whose
  `spec-sync.config.json` has no valid `contextBudget` (or no such file): `readContextBudget` now
  falls back to the toolkit default instead of returning null.
- The SubagentStop hook measured the parent session's transcript (`transcript_path`). It now
  measures the agent's own `agent_transcript_path` (falling back to `transcript_path` only when
  absent), and its counter and budget marker are keyed per agent run (agent transcript, else
  `agent_id`) instead of per parent session.

## 0.26.2

### Added

- New control label `status: deferred` (PROC-DEV-010 rev 5, owner register #1654): owner-deferred,
  planned but not to be built now. `queue` excludes such a ticket before the sweep even when it
  still carries `spec-sync`/`auto-audit`/`type: bug`, reports it in its own `deferred` list (and a
  note), and never counts it as `notSwept`. `merge` refuses it with the new precondition
  `no-status-deferred`. `owner-hold` stays the emergency brake and wins when both are set.

### Changed

- The `PROC-DEV-010` norm pin moves from rev 3 to rev 5.

## 0.26.1

### Fixed

- `handover --reason budget` no longer takes the newest ledger `context` event, which with two
  sessions in one repo slug could be the other session's (Q&A #3647/#3648): the attesting
  measurement is the writing session's own (PROC-DEV-037 rev 10). New option
  `--session <id|path>` measures that transcript freshly with the code of `budget --session`;
  without it the session named by `CLAUDE_CODE_SESSION_ID` is measured (fallback: its own newest
  ledger event), and with no session known parallel live transcripts end in exit 3. A foreign
  session's event never attests.
- The stop hook's budget block names its own session id and dictates
  `npx spec-sync handover --reason budget --session <id>`.

### Changed

- `budget` records `session` on every `context` ledger event; the handover's `## Context`
  block carries `- Session: <id>` (the `- State:` line the harness parses is unchanged).

### Migration for the apps

Bump the pin: `npm install -D github:patrickblattner/spec-sync-toolkit#v0.26.1`.

## 0.26.0

### Added

- `spec-sync review pr|batch|tag|verdict` — the Codex second opinion (SST-DESIGN-030,
  PROC-DEV-049). Triage by risk area and size, `codex exec --sandbox read-only -m <model>` with
  the prompt on stdin, strict result parsing with CX ids and the downgrade rule, PR comment with
  the `spec-sync-review` marker, nightly batch over `review/last..origin/main` with
  review-key dedupe and an `ls-remote`-checked marker move, one issue per release tag, and the
  `review-verdict` marker. Every engine failure (`unreachable`, `timeout`, `limit`,
  `model-switch`, `effort-mismatch`, `unparsable`) is a skip with exit 0 and no fallback model.
- Optional `review` block in `spec-sync.config.json`: `riskGlobs`, `models` {risk, size}, `effort` {risk: high, size: medium},
  `size` {files, lines}, `textGlobs`, `modulesRoot`, `marker`, `label`, `securityLabel`,
  `timeoutMs`, `maxDiffBytes`.
- Ledger event type `review`.
- `doctor` reports legacy `review` keys and `riskGlobs` that match no tracked file.

### Migration for the apps (production-cockpit, community-platform)

1. Bump the pin: `npm install -D github:patrickblattner/spec-sync-toolkit#v0.26.0` (an explicit
   install — a tag change in `package.json` alone does not refetch).
2. Rewrite the `review` block of `spec-sync.config.json`: keep `riskGlobs` (and `marker`,
   `label`, `securityLabel`, `timeoutMs` if they differ from the defaults); delete `engine`,
   `cmd`, `promptTemplate`, `batchLenses`, `uiLens` and `mark`; add `modulesRoot` (e.g.
   `server/src/domain`) and `textGlobs` for locale files where wanted. `spec-sync doctor`
   lists any legacy key that is left and any risk glob that matches no file.
3. Delete the old scripts and their wiring: production-cockpit `scripts/codex-review.mjs`,
   `codex-review.lib.mjs`, `codex-review.test.mjs`, `.spec-sync/review-prompt.md` and the
   `review:risk`/`review:batch` npm scripts; community-platform `scripts/mergeReview.mjs`,
   `mergeReview.test.mjs`, `reviewMark.mjs`, `.spec-sync/review-prompt.md`, the `review` and
   `review:mark` npm scripts, and the references in `flakeRepeat.test.mjs` and the nightly /
   flake-repeat workflow comments.
4. Reset the batch marker to the current main once, so the first batch does not review old
   history: `git fetch origin && git tag -f review/last origin/main && git push --force origin
refs/tags/review/last`, then check `git ls-remote --tags origin refs/tags/review/last`.
