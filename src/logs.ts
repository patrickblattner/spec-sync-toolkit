/**
 * Log storage (spec §3, `DECISION (logs-never-stdout)`).
 *
 * Full output of executed commands lands under
 * `.spec-sync/logs/<ISO-timestamp>/<phase>.log`. The JSON response carries only
 * the directory path and, on failure, the first relevant error — at most three
 * lines, truncated with `…`.
 */

import { mkdirSync, readdirSync, rmSync, writeFileSync, type Dirent } from "node:fs";
import { basename, join } from "node:path";

/** Directory the toolkit keeps its runtime state in, relative to the repo root. */
export const STATE_DIR = ".spec-sync";

/** Runs kept under `.spec-sync/logs/` when the config names no `logRetention` (spec §5). */
export const DEFAULT_LOG_RETENTION = 20;

/**
 * The shape of a run directory's name — `logDirName` above, as a matcher.
 *
 * Only entries of this shape are ours. Anything else under `.spec-sync/logs/`
 * belongs to someone else and is never touched, whatever it is.
 */
const RUN_DIR_NAME = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}Z$/;

/**
 * Timestamp form used for log directories: ISO 8601 with the characters that
 * are awkward in a path (`:`, fractional seconds) removed —
 * `2026-07-26T15-04-11Z`.
 */
export function logDirName(at: Date = new Date()): string {
  return at
    .toISOString()
    .replace(/\.\d+Z$/, "Z")
    .replace(/:/g, "-");
}

/** What a caller may say about the log directory it is about to create. */
export interface CreateLogDirOptions {
  at?: Date;
  /** Runs to keep, including the one being created. Defaults to `DEFAULT_LOG_RETENTION`. */
  retention?: number;
  /** Run directory names that survive regardless of age — see `protectedLogDirs`. */
  keep?: ReadonlySet<string>;
}

/**
 * Creates this run's log directory and returns its repo-relative path — the
 * value that goes into the response's `logDir`.
 *
 * `DECISION (logs-pruned-on-write)`: the old runs are cleared out **here**, at
 * the moment a new one is created — not by a cleanup run. There is no cron, no
 * daemon and no command for it: the only moment the directory is known to grow
 * is the moment something writes to it, so that is the moment it is bounded.
 */
export function createLogDir(repoRoot: string, options: CreateLogDirOptions = {}): string {
  const { at = new Date(), retention = DEFAULT_LOG_RETENTION, keep } = options;
  const name = logDirName(at);
  const relative = join(STATE_DIR, "logs", name);
  mkdirSync(join(repoRoot, relative), { recursive: true });
  // The run that is starting is never a candidate for its own pruning — it is
  // the newest, but "newest" stops protecting it as soon as protected older
  // runs push the budget down the list.
  pruneLogs(repoRoot, { retention, keep: new Set([...(keep ?? []), name]) });
  return relative;
}

/**
 * Deletes the oldest runs until at most `retention` are left, and returns the
 * names it removed.
 *
 * Three properties this has to hold, because a log directory is bookkeeping and
 * bookkeeping must never be the reason a gate fails:
 *
 * - **Order comes from the name, not from `mtime`.** The name is the run's
 *   timestamp and never changes; `mtime` moves every time a phase appends its
 *   log, so the oldest run by `mtime` is merely the one that finished first.
 *   ISO 8601 sorts lexically, so sorting the names *is* sorting by time.
 * - **A directory that will not go is skipped, not thrown on.** Held open by a
 *   reader, owned by another user — none of that says anything about the run
 *   that is starting. The next run tries again.
 * - **Only run directories are candidates.** Foreign entries stay.
 */
export function pruneLogs(
  repoRoot: string,
  options: { retention?: number; keep?: ReadonlySet<string> } = {},
): string[] {
  const { retention = DEFAULT_LOG_RETENTION, keep } = options;
  const logsRoot = join(repoRoot, STATE_DIR, "logs");

  let entries: Dirent[];
  try {
    entries = readdirSync(logsRoot, { withFileTypes: true });
  } catch {
    return [];
  }

  const runs = entries
    .filter((entry) => entry.isDirectory() && RUN_DIR_NAME.test(entry.name))
    .map((entry) => entry.name)
    .sort();

  const excess = runs.length - Math.max(retention, 0);
  if (excess <= 0) return [];

  // The budget is spent on the oldest deletable runs, and a failed delete does
  // not hand its slot to a younger one: losing a newer log to compensate for an
  // older one that would not go is a worse outcome than staying one over the
  // limit until the next run.
  const targets = runs.filter((name) => keep === undefined || !keep.has(name)).slice(0, excess);

  const removed: string[] = [];
  for (const name of targets) {
    try {
      rmSync(join(logsRoot, name), { recursive: true, force: true });
      removed.push(name);
    } catch {
      // Skipped on purpose — see above.
    }
  }
  return removed;
}

/**
 * The minimum a ledger line has to look like for the protection below. Declared
 * structurally so this module keeps its one-way dependency: `ledger.ts` reads
 * `STATE_DIR` from here, so nothing here may import `ledger.ts` back.
 */
interface LedgerLine {
  type: string;
  issue?: number;
  logDir?: unknown;
}

/**
 * Run directories that must survive pruning: those of a ticket whose merge
 * started and never reported completion (spec §7.4, `DECISION (merge-resumable)`).
 *
 * Such a run belongs to an unfinished operation — `doctor` points at it and a
 * resumed `merge` is judged against it, so age is not a reason to drop it. This
 * is `interruptedMerge` of `ledger.ts` in its plural form: same scan, same
 * meaning, over every ticket at once.
 */
export function protectedLogDirs(events: readonly LedgerLine[]): Set<string> {
  const openMerges = new Set<number>();
  for (const event of events) {
    if (typeof event.issue !== "number") continue;
    if (event.type === "merge-started") openMerges.add(event.issue);
    else if (event.type === "merge-completed") openMerges.delete(event.issue);
  }

  const protectedNames = new Set<string>();
  for (const event of events) {
    if (typeof event.issue !== "number" || !openMerges.has(event.issue)) continue;
    if (typeof event.logDir === "string" && event.logDir !== "") {
      protectedNames.add(basename(event.logDir));
    }
  }
  return protectedNames;
}

/**
 * Writes one phase's full output. Returns the repo-relative file path so a
 * caller can name it without reading the content back.
 */
export function writePhaseLog(
  repoRoot: string,
  logDir: string,
  phase: string,
  content: string,
): string {
  const relative = join(logDir, `${sanitizePhase(phase)}.log`);
  writeFileSync(join(repoRoot, relative), content, "utf8");
  return relative;
}

/** The per-line budget of a response line (spec §3): the rest becomes `…`. */
export function truncateLine(line: string, max = 200): string {
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Removes the colour a runner writes around its own words (ANSI SGR sequences).
 *
 * Every form recognition of the gate reads the DECOLORED line (spec §7.1,
 * `SST-DESIGN-016` rev 4 — `#17`). vitest prints its verdict as
 * `ESC[41mESC[1m FAIL `, and an escape prefix survives `trim()`: a pattern
 * anchored at `^` then never fires on a coloured run, and the gate denied a
 * verdict that was right there — the note sent a triage 600 lines past the real
 * failure (community-platform Q&A `#692`, foundation `#694`). Colour is
 * decoration; a form must be read on the text under it.
 */
export function decolor(text: string): string {
  // eslint-disable-next-line no-control-regex -- an escape sequence IS a control character.
  return text.replace(/\x1b\[[0-9;]*m/g, "");
}

/**
 * Reduces command output to the first relevant error for the response
 * (spec §3: at most 3 lines, truncated with `…`).
 *
 * This is a LOG SCAN and nothing more — it believes the first line that looks
 * like an error, which for a suite whose negative-path tests print error
 * messages on purpose is the wrong line (#10). Where a runner LISTS its failures,
 * `reportedFailure` in `gate/phases.ts` answers from that list instead; this
 * stays the answer for everything that reports no failing test at all.
 *
 * "Relevant" means: start at the first line that looks like an error and take
 * the lines that follow. Without such a marker the last non-empty lines are the
 * best available answer — a failing command usually says why at the end.
 */
export function firstError(output: string, maxLines = 3): string | undefined {
  const lines = decolor(output)
    .split("\n")
    .map((line) => line.trimEnd());
  const nonEmpty = lines.filter((line) => line.trim() !== "");
  if (nonEmpty.length === 0) return undefined;

  const marker = /\b(error|failed|failing|exception|cannot|not found|✗|×)\b/i;
  const start = lines.findIndex((line) => marker.test(line));
  const selected =
    start === -1
      ? nonEmpty.slice(-maxLines)
      : lines
          .slice(start)
          .filter((line) => line.trim() !== "")
          .slice(0, maxLines);

  const truncated = selected.map((line) => truncateLine(line));
  const omitted =
    start === -1
      ? nonEmpty.length > maxLines
      : nonEmpty.length - nonEmpty.indexOf(selected[0] ?? "") > maxLines;

  return omitted ? `${truncated.join("\n")}\n…` : truncated.join("\n");
}

/** Keeps a phase name inside its log directory — no separators, no `..`. */
function sanitizePhase(phase: string): string {
  return phase.replace(/[^A-Za-z0-9_-]/g, "-");
}
