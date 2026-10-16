# Changelog

## Unreleased

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

1. Bump the pin: `npm install -D github:patrickblattner/spec-sync-toolkit#v<new>` (an explicit
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
