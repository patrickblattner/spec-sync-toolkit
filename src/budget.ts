/**
 * Context measurement (spec §7.8) — the numbers behind `budget`, and the ones
 * `report` and `handover` render.
 *
 * The measurement reads the driver session's transcript, not the model: a CLI
 * cannot observe its caller's context window, but the client writes it down.
 *
 * `DECISION (usage-dedup)`: streaming writes **up to three transcript entries
 * per API call, each with a full usage block** (measured 2026-07-29; factor
 * 1.6–2.6, drifting across client versions). Counting is therefore deduplicated
 * by `message.id`. The context level is
 * `input_tokens + cache_read_input_tokens + cache_creation_input_tokens` of the
 * **youngest** assistant entry — the last call carries the whole window; a sum
 * over the session would be double counting.
 */

import { readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { EXIT, ToolkitError } from "./output.js";
import type { LedgerEvent } from "./ledger.js";

/** Where the client keeps its transcripts, below `$HOME`. */
const TRANSCRIPT_ROOT = join(".claude", "projects");

/**
 * How recently two transcripts must both have been touched for the automatic
 * choice to be ambiguous (spec §7.8). Parallel sessions write continuously; a
 * file nobody has written to for longer than this is not a live session.
 */
export const AMBIGUITY_WINDOW_MS = 5 * 60 * 1000;

/** Increments needed before a forecast is anything but a guess (spec §7.8). */
export const MIN_MEASUREMENTS = 5;

/** How many of the newest increments the p90 is taken over (spec §7.8). */
export const MEASUREMENT_WINDOW = 20;

/** Token level the reach is computed against when the config names none (spec §5). */
export const DEFAULT_CONTEXT_BUDGET = 800_000;

/**
 * The transcript directory name of a repo: the absolute path with `/` and `.`
 * replaced by `-` (spec §7.8).
 */
export function projectSlug(repoRoot: string): string {
  return resolve(repoRoot).replace(/[/.]/gu, "-");
}

export function transcriptDir(repoRoot: string, home: string): string {
  return join(home, TRANSCRIPT_ROOT, projectSlug(repoRoot));
}

export interface ResolvedTranscript {
  file: string;
  /** How the file was chosen — the automatic choice has to be visible (spec §7.8). */
  note?: string;
}

/**
 * Finds the session transcript. `--session` takes a session id or a file path;
 * without it the most recently modified `.jsonl` of the project directory wins
 * and the choice is reported.
 *
 * Ambiguity is **not** resolved by the toolkit (spec §2): were several files
 * modified within the last five minutes, several sessions are running and only
 * the caller knows which one is its own → exit 3 with the candidate list.
 */
export function resolveTranscript(
  repoRoot: string,
  home: string,
  session: string | undefined,
  now: number = Date.now(),
): ResolvedTranscript {
  const dir = transcriptDir(repoRoot, home);

  if (session !== undefined) {
    const file =
      session.includes("/") || session.endsWith(".jsonl")
        ? isAbsolute(session)
          ? session
          : resolve(repoRoot, session)
        : join(dir, `${session}.jsonl`);
    return { file };
  }

  let entries: string[];
  try {
    entries = readdirSync(dir).filter((name) => name.endsWith(".jsonl"));
  } catch (error) {
    throw new ToolkitError(`no transcript directory: ${dir}`, EXIT.PRECONDITION, {
      field: "--session",
      cause: error,
    });
  }

  const candidates = entries
    .flatMap((name) => {
      const file = join(dir, name);
      try {
        return [{ file, mtimeMs: statSync(file).mtimeMs }];
      } catch {
        return [];
      }
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (candidates.length === 0) {
    throw new ToolkitError(`no transcript in ${dir}`, EXIT.PRECONDITION, { field: "--session" });
  }

  const fresh = candidates.filter((entry) => now - entry.mtimeMs <= AMBIGUITY_WINDOW_MS);
  if (fresh.length > 1) {
    throw new ToolkitError(
      `${fresh.length} transcripts modified within the last 5 minutes — name one with --session: ${fresh
        .map((entry) => sessionIdOf(entry.file))
        .join(", ")}`,
      EXIT.AMBIGUOUS,
      { field: "--session", reason: "parallel sessions" },
    );
  }

  const chosen = candidates[0] as { file: string; mtimeMs: number };
  return {
    file: chosen.file,
    note: `session not named — chose the most recently modified transcript ${sessionIdOf(chosen.file)}`,
  };
}

/** `…/<id>.jsonl` → `<id>`; the candidate list names sessions, not paths. */
export function sessionIdOf(file: string): string {
  return (file.split("/").pop() ?? file).replace(/\.jsonl$/u, "");
}

export interface UsageEntry {
  messageId: string;
  /** `input_tokens + cache_read_input_tokens + cache_creation_input_tokens`. */
  context: number;
}

/**
 * The usage entries of a transcript, in file order, **deduplicated by
 * `message.id`** — the first entry of an id wins, the repeats of the same API
 * call are dropped (`DECISION (usage-dedup)`).
 *
 * A line that does not parse is skipped rather than thrown on: a transcript is
 * written live, so the last line can be half-written while this runs.
 */
export function usageEntries(raw: string): UsageEntry[] {
  const entries: UsageEntry[] = [];
  const seen = new Set<string>();

  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      continue;
    }
    const entry = asUsageEntry(parsed);
    if (entry === undefined || seen.has(entry.messageId)) continue;
    seen.add(entry.messageId);
    entries.push(entry);
  }

  return entries;
}

/** How many entries a raw count would have seen — the fixture's dedup evidence. */
export function rawUsageCount(raw: string): number {
  let count = 0;
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      if (asUsageEntry(JSON.parse(line)) !== undefined) count += 1;
    } catch {
      continue;
    }
  }
  return count;
}

function asUsageEntry(value: unknown): UsageEntry | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const line = value as Record<string, unknown>;
  if (line.type !== "assistant") return undefined;

  const message = line.message;
  if (message === null || typeof message !== "object") return undefined;
  const { id, usage } = message as Record<string, unknown>;
  if (typeof id !== "string" || usage === null || typeof usage !== "object") return undefined;

  const u = usage as Record<string, unknown>;
  const context =
    numberOf(u.input_tokens) +
    numberOf(u.cache_read_input_tokens) +
    numberOf(u.cache_creation_input_tokens);
  return { messageId: id, context };
}

function numberOf(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/**
 * The context level of a transcript: the **youngest** entry, not the sum. Reads
 * the file itself so the two failure modes — absent and unreadable — end in the
 * same exit 4 they mean to the caller (spec §7.8).
 */
export function readContext(file: string): { context: number; entries: UsageEntry[] } {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch (error) {
    throw new ToolkitError(`transcript not readable: ${file}`, EXIT.PRECONDITION, {
      field: "--session",
      cause: error,
    });
  }

  const entries = usageEntries(raw);
  if (entries.length === 0) {
    throw new ToolkitError(`transcript carries no usage entries: ${file}`, EXIT.PRECONDITION, {
      field: "--session",
    });
  }
  return { context: (entries[entries.length - 1] as UsageEntry).context, entries };
}

/**
 * The growth per ticket: the difference of the `context` values that **frame** a
 * `merge-completed` (spec §7.8). A merge with no measurement on one of its sides
 * contributes nothing — it is not estimated.
 *
 * The scan follows file order, which for an append-only ledger *is* the order
 * the events happened in.
 */
export function contextIncrements(events: LedgerEvent[]): number[] {
  const increments: number[] = [];
  let before: number | undefined;
  let pendingMerge = false;

  for (const event of events) {
    if (event.type === "context") {
      const value = numberOf(event.context);
      if (pendingMerge && before !== undefined) {
        increments.push(value - before);
        pendingMerge = false;
      }
      before = value;
    } else if (event.type === "merge-completed" && event.ok !== false) {
      pendingMerge = true;
    }
  }

  return increments;
}

/**
 * p90 by nearest rank over the newest `MEASUREMENT_WINDOW` increments. Below
 * `MIN_MEASUREMENTS` points the answer is `null` — never an estimate.
 */
export function p90PerTicket(increments: number[]): number | null {
  const window = increments.slice(-MEASUREMENT_WINDOW);
  if (window.length < MIN_MEASUREMENTS) return null;
  const sorted = [...window].sort((a, b) => a - b);
  const rank = Math.ceil(0.9 * sorted.length);
  return sorted[Math.max(0, rank - 1)] as number;
}

export interface Derived {
  p90PerTicket: number | null;
  forecastTickets: number | null;
}

/**
 * `forecastTickets = floor((contextBudget − context) / p90PerTicket)`.
 *
 * A p90 of zero has no reach to report — the division has no finite value, and
 * "infinitely many tickets" is not a measurement. It stays `null`, like every
 * other case the data does not carry.
 */
export function derive(context: number, contextBudget: number, increments: number[]): Derived {
  const p90 = p90PerTicket(increments);
  if (p90 === null || p90 <= 0) return { p90PerTicket: p90, forecastTickets: null };
  return { p90PerTicket: p90, forecastTickets: Math.floor((contextBudget - context) / p90) };
}

/** The newest `context` event, or `undefined` when the ledger holds none. */
export function latestContextEvent(events: LedgerEvent[]): LedgerEvent | undefined {
  let latest: LedgerEvent | undefined;
  for (const event of events) if (event.type === "context") latest = event;
  return latest;
}
