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

/** The six event types of spec §8. The list is closed; a seventh needs a spec change. */
export const LEDGER_EVENT_TYPES = [
  "drift",
  "section-mapped",
  "ticket-created",
  "gate",
  "merged",
  "blocked",
] as const;

export type LedgerEventType = (typeof LEDGER_EVENT_TYPES)[number];

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
    if (isLedgerEvent(parsed)) events.push(parsed);
    else malformedLines.push(index + 1);
  });

  return { events, malformedLines };
}

function isLedgerEvent(value: unknown): value is LedgerEvent {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.at !== "string") return false;
  return LEDGER_EVENT_TYPES.includes(candidate.type as LedgerEventType);
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
