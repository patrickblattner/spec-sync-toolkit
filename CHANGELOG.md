# Changelog

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
