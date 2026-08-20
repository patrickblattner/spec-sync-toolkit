# spec-sync-toolkit

CLI toolkit that executes the mechanical parts of the worker loop — `gate`, `queue`, `pack`,
`merge`, `lenses`, `report`, `doctor` — so the model spends turns on decisions, not on
sequences. Consumed as a pinned devDependency; `bin` name is `spec-sync`.

**The spec is authoritative, not this file.** Read it from the spec server
(`http://localhost:8788/mcp` during the v2 transition — the final flip puts it back on
`8787`; the URL lives in `.mcp.json`), project `spec-sync-toolkit`: `SST-VISION-001` with
its `SST-DESIGN-0xx` leaves, plus the `SST-ADR-0xx` subtree. Enter through `spec_usage`,
then `spec_tree`/`spec_search`, then `spec_get`/`spec_get_many` — leaves are small, so read
the ones you need instead of a whole level. Never from local files — the toolkit has no
spec directory.

## Runtime

Node comes from `mise.toml` (pinned `26.3.0`) — never install Node directly, no nvm, no
system Node. Prefix commands with `mise exec --` when your shell has no mise activation.

```
npm run build       # tsc --noEmit && tsup
npm run typecheck
npm run lint
npm run format:check
npm test            # vitest run
```

The local gate is `format · lint · typecheck · unit`, cheap to expensive, defined in
`spec-sync.config.json`. Everything must be green before a commit.

## The three rules that are easy to break

1. **stdout carries exactly one JSON object** (`SST-DESIGN-011`). `emit()` in `src/output.ts` is the
   only permitted stdout writer, ESLint bars `process.stdout` and `console` everywhere else,
   and `emit()` throws on a second call. Progress goes to stderr via `progress()`.
2. **Command output never reaches stdout.** It goes to `.spec-sync/logs/<ISO>/<phase>.log`;
   the response carries the path and, on failure, `firstError()` — at most three lines.
3. **The toolkit decides nothing on the merits** (ADR, Entscheidung 4). Ambiguity exits 3 and
   hands back to the interactive driver. No automation, no headless path, no daemons.

## Exit codes (`SST-DESIGN-012`, `SST-DESIGN-013`)

`0` ok · `1` red on the merits · `2` unprovable, aborted under foreign load (**not** green) ·
`3` ambiguous, the model decides · `4` precondition violated (missing config, `owner-hold`,
pause flag). They live as `EXIT` in `src/output.ts`; throw `ToolkitError` to end a run with
one, and pass `field` for a config violation.

## Module map

| File            | Owns                                                                                 |
| --------------- | ------------------------------------------------------------------------------------ |
| `src/cli.ts`    | flag parsing, command registry (`registerCommand`), the response envelope            |
| `src/output.ts` | `EXIT`, `ToolkitError`, `emit()`, `progress()`, JSON and `--human` rendering         |
| `src/config.ts` | zod schema of `spec-sync.config.json`, exit 4 naming the violated field              |
| `src/logs.ts`   | log directory layout, `firstError()`                                                 |
| `src/norms.ts`  | foundation norms (transitional defaults + pinned revisions), spec-server HTTP client |
| `src/pins.ts`   | `spec-pins.json` — the `{key: rev}` pin file `repin` writes                          |

A new command adds a file and one `registerCommand({…})` call — dispatch, timing, exit code
and emission are the dispatcher's job, not the command's.

## Norm binding (`SST-DESIGN-015`)

Sort tiers, labels, `owner-hold` precedence and the merge model belong to the foundation's
`PROC-DEV-015` subtree — `PROC-DEV-039` (sort tiers), `PROC-DEV-010` (labels),
`PROC-DEV-047` (`owner-hold`), `PROC-DEV-044` (merge model) — not to this code. Until the
toolkit reads them live, `src/norms.ts` holds the defaults **plus** the revision each was
transcribed from; `doctor` reports a moved revision as a finding. Do not silently edit the
defaults — move the pin with them.

## Conventions

- TypeScript strict, ESM, `.js` extensions on relative imports.
- Dependencies stay narrow: `zod`, `picomatch`, `simple-git`, otherwise Node builtins. `gh`
  is called through `child_process`, never through an SDK.
- Commits carry the ticket reference; stage named files, never `git add .`.
