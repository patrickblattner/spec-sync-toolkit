/**
 * Log storage (spec §3, `DECISION (logs-never-stdout)`).
 *
 * Full output of executed commands lands under
 * `.spec-sync/logs/<ISO-timestamp>/<phase>.log`. The JSON response carries only
 * the directory path and, on failure, the first relevant error — at most three
 * lines, truncated with `…`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** Directory the toolkit keeps its runtime state in, relative to the repo root. */
export const STATE_DIR = ".spec-sync";

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

/**
 * Creates this run's log directory and returns its repo-relative path — the
 * value that goes into the response's `logDir`.
 */
export function createLogDir(repoRoot: string, at: Date = new Date()): string {
  const relative = join(STATE_DIR, "logs", logDirName(at));
  mkdirSync(join(repoRoot, relative), { recursive: true });
  return relative;
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

/**
 * Reduces command output to the first relevant error for the response
 * (spec §3: at most 3 lines, truncated with `…`).
 *
 * "Relevant" means: start at the first line that looks like an error and take
 * the lines that follow. Without such a marker the last non-empty lines are the
 * best available answer — a failing command usually says why at the end.
 */
export function firstError(output: string, maxLines = 3): string | undefined {
  const lines = output.split("\n").map((line) => line.trimEnd());
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

  const truncated = selected.map((line) => (line.length > 200 ? `${line.slice(0, 199)}…` : line));
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
