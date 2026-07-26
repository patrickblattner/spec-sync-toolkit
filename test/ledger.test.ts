import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LEDGER_EVENT_TYPES,
  appendEvent,
  eventsOfRun,
  interruptedMerge,
  latestGate,
  ledgerPath,
  readLedger,
  runIds,
  ticketMetrics,
  type LedgerEvent,
} from "../src/ledger.js";

const roots: string[] = [];

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "spec-sync-ledger-"));
  roots.push(root);
  return root;
}

afterEach(() => {
  roots.length = 0;
});

describe("ledger storage (spec §8, DECISION ledger-append-only)", () => {
  it("writes one JSON line per event and keeps the file append-only", () => {
    const root = repo();
    appendEvent(root, { type: "ticket-created", issue: 1 });
    appendEvent(root, { type: "gate", issue: 1, ok: true, profile: "merge" });
    appendEvent(root, { type: "merge-completed", issue: 1, ok: true });

    const lines = readFileSync(ledgerPath(root), "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines.map((line) => (JSON.parse(line) as LedgerEvent).type)).toEqual([
      "ticket-created",
      "gate",
      "merge-completed",
    ]);
  });

  it("never rewrites earlier lines — the first line survives byte for byte", () => {
    const root = repo();
    appendEvent(root, { type: "drift", unit: "foundation.dev.process" });
    const first = readFileSync(ledgerPath(root), "utf8");
    appendEvent(root, { type: "ticket-created", issue: 7 });
    expect(readFileSync(ledgerPath(root), "utf8").startsWith(first)).toBe(true);
  });

  it("stamps a timestamp and a ticket number, the two fields §8 names", () => {
    const root = repo();
    const event = appendEvent(root, { type: "blocked", issue: 42, reason: "gate red" });
    expect(event.at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(event.issue).toBe(42);
    expect(LEDGER_EVENT_TYPES).toContain(event.type);
  });

  it("reads back nothing at all when no run has happened yet", () => {
    expect(readLedger(repo())).toEqual({ events: [], malformedLines: [] });
  });

  it("skips an unreadable line and reports its number instead of throwing", () => {
    const root = repo();
    appendEvent(root, { type: "ticket-created", issue: 1 });
    const path = ledgerPath(root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${readFileSync(path, "utf8")}{ not json\n{"at":"x","type":"gate"}\n`);

    const read = readLedger(root);
    expect(read.events).toHaveLength(2);
    expect(read.malformedLines).toEqual([2]);
  });

  // DECISION (ledger-tolerant-reader), spec §8. The reader used to reject an
  // unknown type as malformed — which turned adding `merge-started` in §7.4 into
  // a contradiction between two sections of the same spec. Tolerance makes
  // extending the type list additive.
  it("keeps a line whose type it does not know instead of calling it malformed", () => {
    const root = repo();
    const path = ledgerPath(root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `{"at":"2026-07-26T10:00:00Z","type":"invented","issue":1}\n`);

    const read = readLedger(root);
    expect(read.malformedLines).toEqual([]);
    expect(read.events[0]?.type).toBe("invented");
  });

  it("still rejects a line that carries no type at all", () => {
    const root = repo();
    const path = ledgerPath(root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `{"at":"2026-07-26T10:00:00Z","issue":1}\n`);
    expect(readLedger(root).malformedLines).toEqual([1]);
  });

  it("normalises the retired `merged` type to `merge-completed` on read", () => {
    const root = repo();
    const path = ledgerPath(root);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `{"at":"2026-07-26T10:00:00Z","type":"merged","issue":7,"ok":true}\n`);

    const read = readLedger(root);
    expect(read.malformedLines).toEqual([]);
    expect(read.events[0]?.type).toBe("merge-completed");
  });
});

describe("the four numbers per ticket (spec §8)", () => {
  const at = (minute: number): string => `2026-07-26T10:${String(minute).padStart(2, "0")}:00.000Z`;

  it("derives turns, wall-clock time, gate runs and retries per ticket", () => {
    const root = repo();
    appendEvent(root, { type: "ticket-created", issue: 11, at: at(0) });
    appendEvent(root, { type: "gate", issue: 11, ok: false, profile: "local", at: at(5) });
    appendEvent(root, { type: "gate", issue: 11, ok: false, profile: "local", at: at(9) });
    appendEvent(root, { type: "gate", issue: 11, ok: true, profile: "merge", at: at(14) });
    appendEvent(root, { type: "merge-completed", issue: 11, ok: true, turns: 12, at: at(20) });

    const [metrics] = ticketMetrics(readLedger(root).events);
    expect(metrics).toMatchObject({
      issue: 11,
      turns: 12,
      wallClockMs: 20 * 60_000,
      gateRuns: 3,
      retries: 2,
    });
  });

  it("keeps the tickets apart and sorts them by number", () => {
    const root = repo();
    appendEvent(root, { type: "gate", issue: 9, ok: true, at: at(0) });
    appendEvent(root, { type: "gate", issue: 3, ok: true, at: at(1) });
    expect(ticketMetrics(readLedger(root).events).map((m) => m.issue)).toEqual([3, 9]);
  });

  it("reports zero turns rather than estimating what a CLI cannot observe", () => {
    const root = repo();
    appendEvent(root, { type: "gate", issue: 5, ok: true, at: at(0) });
    expect(ticketMetrics(readLedger(root).events)[0]?.turns).toBe(0);
  });

  it("ignores events without a ticket, so repo-wide drift skews no metric", () => {
    const root = repo();
    appendEvent(root, { type: "drift", unit: "foundation.dev.process", at: at(0) });
    expect(ticketMetrics(readLedger(root).events)).toEqual([]);
  });
});

describe("run selection and gate evidence", () => {
  const event = (over: Partial<LedgerEvent> & { type: LedgerEvent["type"] }): LedgerEvent => ({
    at: "2026-07-26T10:00:00.000Z",
    ...over,
  });

  it("lists run ids in order of first appearance", () => {
    const events = [
      event({ type: "drift", run: "a" }),
      event({ type: "gate", run: "b" }),
      event({ type: "merge-completed", run: "a" }),
    ];
    expect(runIds(events)).toEqual(["a", "b"]);
  });

  it("selects one run, and all events when none is named", () => {
    const events = [event({ type: "drift", run: "a" }), event({ type: "gate", run: "b" })];
    expect(eventsOfRun(events, "a")).toHaveLength(1);
    expect(eventsOfRun(events)).toHaveLength(2);
  });

  it("finds the merge-started that never got its completion", () => {
    const events = [
      event({ type: "merge-started", issue: 1, at: "2026-07-26T10:00:00Z" }),
      event({ type: "merge-completed", issue: 1, at: "2026-07-26T11:00:00Z" }),
      event({ type: "merge-started", issue: 1, at: "2026-07-26T12:00:00Z" }),
    ];
    expect(interruptedMerge(events, 1)?.at).toBe("2026-07-26T12:00:00Z");
  });

  it("reports nothing for a complete pair or another ticket", () => {
    const events = [
      event({ type: "merge-started", issue: 1 }),
      event({ type: "merge-completed", issue: 1 }),
      event({ type: "merge-started", issue: 2 }),
    ];
    expect(interruptedMerge(events, 1)).toBeUndefined();
    expect(interruptedMerge(events, 3)).toBeUndefined();
    expect(interruptedMerge(events, 2)).toBeDefined();
  });

  it("picks the newest gate of a ticket, narrowed to one profile", () => {
    const events = [
      event({ type: "gate", issue: 1, profile: "merge", ok: false, at: "2026-07-26T10:00:00Z" }),
      event({ type: "gate", issue: 1, profile: "local", ok: true, at: "2026-07-26T12:00:00Z" }),
      event({ type: "gate", issue: 1, profile: "merge", ok: true, at: "2026-07-26T11:00:00Z" }),
    ];
    expect(latestGate(events, 1, "merge")?.at).toBe("2026-07-26T11:00:00Z");
    expect(latestGate(events, 1)?.at).toBe("2026-07-26T12:00:00Z");
    expect(latestGate(events, 2, "merge")).toBeUndefined();
  });
});
