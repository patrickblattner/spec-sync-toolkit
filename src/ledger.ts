/**
 * Ledger and telemetry (spec §8).
 *
 * `DECISION (ledger-append-only)`: `.spec-sync/ledger.jsonl` is append-only.
 * Every line is one event with a timestamp, a ticket number and a type
 * (`drift`, `section-mapped`, `ticket-created`, `gate`, `merged`, `blocked`).
 *
 * Per ticket the ledger carries at least **four numbers**: turns · wall-clock
 * time · gate runs · retries. They are the only ground on which the toolkit's
 * effect can be shown — without them every claim about savings stays a guess.
 *
 * Three of the four are *derived* from the event stream (see `ticketMetrics`).
 * **Turns are not observable by a CLI** — they are the driver's model turns, so
 * an event may carry a `turns` increment and the aggregate sums what was
 * reported. The toolkit never estimates them.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { STATE_DIR } from "./logs.js";

/**
 * The event types of spec §8 — the ones a **writer** produces.
 *
 * `merge-started` is written before the first mutating step of the merge
 * sequence and `merge-completed` after the last confirmed postcondition
 * (§7.4, `DECISION (merge-resumable)`): a script is not a transaction, so the
 * pair is what lets a re-run tell "never merged" from "merge died halfway",
 * and what `doctor` looks for (§7.7).
 *
 * `merge-completed` replaces the former `merged`, which stays readable as an
 * alias (see `LEDGER_ALIASES`) so ledgers written before this change keep
 * their meaning.
 */
export const LEDGER_EVENT_TYPES = [
  "drift",
  "section-mapped",
  "ticket-created",
  "gate",
  "merge-started",
  "merge-completed",
  "blocked",
] as const;

export type LedgerEventType = (typeof LEDGER_EVENT_TYPES)[number];

/** Types no longer written, still understood on read. */
export const LEDGER_ALIASES: Record<string, LedgerEventType> = {
  merged: "merge-completed",
};

/**
 * One ledger line.
 *
 * `issue` is optional because `drift` is found *before* tickets exist
 * (worker loop steps 2–4 derive tickets from the drift); every other type
 * carries its ticket.
 */
export interface LedgerEvent {
  /** ISO 8601 timestamp. */
  at: string;
  type: LedgerEventType;
  /** Ticket number. Absent only for repo-wide `drift` events. */
  issue?: number;
  /** Groups the events of one worker-loop run, so `report --run <id>` can select them. */
  run?: string;
  /** Whether the event was green. Meaningful for `gate` and `merged`. */
  ok?: boolean;
  /** Gate profile the event belongs to — the merge precondition reads this. */
  profile?: string;
  /** Model turns spent since the last event of this ticket. Reported, never observed. */
  turns?: number;
  /** Free-form payload: spec unit, section, commit, reason, … */
  [key: string]: unknown;
}

/** The four numbers spec §8 requires per ticket. */
export interface TicketMetrics {
  issue: number;
  /** Sum of the `turns` increments the driver reported. 0 when nothing was reported. */
  turns: number;
  /** Wall-clock span from the ticket's first to its last event. */
  wallClockMs: number;
  /** Number of `gate` events recorded for the ticket. */
  gateRuns: number;
  /** Number of *red* gate runs — every one of them forced a retry. */
  retries: number;
  firstAt: string;
  lastAt: string;
}

/**
 * What `appendEvent` takes. `type` is restated because `LedgerEvent` carries an
 * index signature, and `Omit` over one erases the known keys.
 */
export type LedgerEventInput = Omit<LedgerEvent, "at"> & {
  type: LedgerEventType;
  at?: string;
};

/** Repo-relative path of the ledger file. */
export const LEDGER_FILE = join(STATE_DIR, "ledger.jsonl");

export function ledgerPath(repoRoot: string): string {
  return join(repoRoot, LEDGER_FILE);
}

/**
 * Appends one event. Append-only in the strict sense: the file is opened with
 * `a` and never read, rewritten or truncated, so a concurrent reader can never
 * observe a half-written history.
 */
export function appendEvent(repoRoot: string, event: LedgerEventInput): LedgerEvent {
  const complete: LedgerEvent = { at: event.at ?? new Date().toISOString(), ...event };
  const path = ledgerPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(complete)}\n`, "utf8");
  return complete;
}

export interface LedgerRead {
  events: LedgerEvent[];
  /** Line numbers that did not parse. `report` names them as a completeness finding. */
  malformedLines: number[];
}

/**
 * Reads the whole ledger. A line that does not parse is skipped and its number
 * reported rather than thrown on: a single corrupt line must not make the
 * history unreadable, but it must not vanish silently either.
 *
 * `DECISION (ledger-tolerant-reader)` (spec §8): a line is discarded **only for
 * broken JSON**, never for an unknown type — an unknown type is kept and passed
 * through. The earlier reader rejected it as malformed, which turned adding one
 * event type in §7.4 into a contradiction between two sections of the same spec
 * that a building agent was not allowed to resolve. Tolerance here makes
 * extending the type list additive instead of breaking.
 */
export function readLedger(repoRoot: string): LedgerRead {
  let raw: string;
  try {
    raw = readFileSync(ledgerPath(repoRoot), "utf8");
  } catch {
    return { events: [], malformedLines: [] };
  }

  const events: LedgerEvent[] = [];
  const malformedLines: number[] = [];

  raw.split("\n").forEach((line, index) => {
    if (line.trim() === "") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      malformedLines.push(index + 1);
      return;
    }
    const event = asLedgerEvent(parsed);
    if (event === undefined) malformedLines.push(index + 1);
    else events.push(event);
  });

  return { events, malformedLines };
}

/**
 * A line is an event when it has a timestamp and a type. The type is **not**
 * checked against the known list — see `DECISION (ledger-tolerant-reader)`.
 * A known alias is normalised on the way in, so readers only ever see current
 * type names.
 */
function asLedgerEvent(value: unknown): LedgerEvent | undefined {
  if (value === null || typeof value !== "object") return undefined;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.at !== "string" || typeof candidate.type !== "string") return undefined;
  const alias = LEDGER_ALIASES[candidate.type];
  return (alias === undefined ? candidate : { ...candidate, type: alias }) as LedgerEvent;
}

/** The events of one run, or all events when no run is named. */
export function eventsOfRun(events: LedgerEvent[], run?: string): LedgerEvent[] {
  if (run === undefined) return events;
  return events.filter((event) => event.run === run);
}

/** Run ids in order of first appearance — `report` defaults to the last one. */
export function runIds(events: LedgerEvent[]): string[] {
  const seen: string[] = [];
  for (const event of events) {
    if (typeof event.run === "string" && !seen.includes(event.run)) seen.push(event.run);
  }
  return seen;
}

/**
 * Derives the four numbers of spec §8 per ticket, keyed by issue number.
 *
 * - **turns** — sum of reported increments (a CLI cannot observe model turns).
 * - **wallClockMs** — first to last event of the ticket.
 * - **gateRuns** — count of `gate` events.
 * - **retries** — count of `gate` events that were not green; each red gate is
 *   one forced repetition.
 */
export function ticketMetrics(events: LedgerEvent[]): TicketMetrics[] {
  const byIssue = new Map<number, LedgerEvent[]>();
  for (const event of events) {
    if (typeof event.issue !== "number") continue;
    const bucket = byIssue.get(event.issue);
    if (bucket === undefined) byIssue.set(event.issue, [event]);
    else bucket.push(event);
  }

  return [...byIssue.entries()]
    .map(([issue, ticketEvents]) => {
      const times = ticketEvents.map((event) => Date.parse(event.at)).filter(Number.isFinite);
      const first = times.length === 0 ? 0 : Math.min(...times);
      const last = times.length === 0 ? 0 : Math.max(...times);
      const gates = ticketEvents.filter((event) => event.type === "gate");

      return {
        issue,
        turns: ticketEvents.reduce(
          (sum, event) => sum + (typeof event.turns === "number" ? event.turns : 0),
          0,
        ),
        wallClockMs: last - first,
        gateRuns: gates.length,
        retries: gates.filter((event) => event.ok !== true).length,
        firstAt: new Date(first).toISOString(),
        lastAt: new Date(last).toISOString(),
      };
    })
    .sort((a, b) => a.issue - b.issue);
}

/**
 * The `merge-started` of a merge that never reported its completion — the newest
 * start for the ticket with no `merge-completed` behind it (spec §7.4,
 * `DECISION (merge-resumable)`).
 *
 * This is the only marker that separates "never merged" from "merge died
 * halfway": `merge` branches into its resume path on it instead of re-running
 * the full sequence, and §7.7 makes it a finding for `doctor`.
 *
 * The scan follows file order, which for an append-only ledger *is* the order
 * the events happened in — no timestamp comparison can be more truthful than
 * that when two events share a millisecond.
 */
export function interruptedMerge(events: LedgerEvent[], issue: number): LedgerEvent | undefined {
  let started: LedgerEvent | undefined;
  for (const event of events) {
    if (event.issue !== issue) continue;
    if (event.type === "merge-started") started = event;
    else if (event.type === "merge-completed") started = undefined;
  }
  return started;
}

/**
 * The gate evidence `merge` checks as a precondition (spec §7.4, "Gate-Beleg
 * grün"): the newest `gate` event of the ticket. The caller decides what to do
 * with a missing or red one — this function only reports what the ledger holds.
 *
 * `profile` narrows the search to one gate profile; the merge precondition uses
 * `merge`, because foundation.dev.process §Worker-Loop merges only "erst,
 * nachdem das komplette lokale Merge-Gate grün ist".
 */
export function latestGate(
  events: LedgerEvent[],
  issue: number,
  profile?: string,
): LedgerEvent | undefined {
  const candidates = events.filter(
    (event) =>
      event.type === "gate" &&
      event.issue === issue &&
      (profile === undefined || event.profile === profile),
  );
  if (candidates.length === 0) return undefined;
  return candidates.reduce((newest, event) =>
    Date.parse(event.at) >= Date.parse(newest.at) ? event : newest,
  );
}
