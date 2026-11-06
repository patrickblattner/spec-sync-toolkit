/**
 * Box slots (PROC-REL-060) with the waiter mechanics of PROC-REL-040 rev 7:
 * two machine-wide slots, a third heavy step waits, prints one holder line per
 * minute, and ends with exit 75 on an expired wait; every acquire is logged.
 */

import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  LOCK_CHAIN,
  LOCK_EXPIRED,
  LockWaitError,
  judge,
  parseHolder,
  type Seen,
} from "../src/gate/holder.js";
import {
  BOX_DIR_ENV,
  BOX_LOAD_MAX_ENV,
  BOX_SLOTS_ENV,
  DEFAULT_LOAD_MAX,
  WAITS_FILE,
  acquireBoxSlot,
  lastWaits,
  loadCeiling,
  queueStates,
  slotCount,
  slotStates,
  type SlotRequest,
} from "../src/gate/slots.js";
import { LOCK_DEADLINE_EXIT } from "../src/output.js";

let box: string;
beforeEach(() => {
  box = mkdtempSync(join(tmpdir(), "spec-sync-box-test-"));
  process.env[BOX_DIR_ENV] = box;
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env[BOX_SLOTS_ENV];
});

const MIN = 60_000;
const alive = new Set<number>();
const request = (run: string, pid: number, extra: Partial<SlotRequest> = {}): SlotRequest => ({
  repository: "o/r",
  step: "gate:merge",
  run,
  cap: 10,
  pid,
  pollMs: 5,
  isAlive: (p) => alive.has(p),
  log: () => {},
  ...extra,
});

/** Writes a slot record by hand — a holder as another process would have left it. */
function holdSlot(n: number, pid: number, holder: string): void {
  const startedAt = parseHolder(holder).started;
  writeFileSync(
    join(box, `slot-${n}.lock`),
    `${JSON.stringify({ pid, startedAt: startedAt === undefined ? "" : new Date(startedAt).toISOString(), holder, step: "gallery" })}\n`,
  );
}

const line = (run: string, started: number, cap: number): string =>
  `repository=o/r run=${run} started=${new Date(started).toISOString()} cap=${cap}`;

describe("box slots", () => {
  it("lets two holders in and makes the third wait until one releases", async () => {
    alive.clear();
    [101, 102, 103].forEach((pid) => alive.add(pid));
    const a = await acquireBoxSlot(request("a", 101));
    const b = await acquireBoxSlot(request("b", 102));
    expect([a.slot, b.slot]).toEqual(["slot-1", "slot-2"]);
    expect(a.queued || b.queued).toBe(false);

    let held = false;
    const third = acquireBoxSlot(request("c", 103)).then((slot) => {
      held = true;
      return slot;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(held).toBe(false);

    a.release();
    const c = await third;
    expect(c.slot).toBe("slot-1");
    expect(c.queued).toBe(true);
    expect(c.waitedBehind).toHaveLength(2);
    expect(c.waitedBehind.join("\n")).toMatch(/run=a .*\n.*run=b /);
    b.release();
    c.release();
    expect(slotStates().every((slot) => slot.free)).toBe(true);
  });

  it("takes over the slot of a dead pid and never lets the old holder release it", async () => {
    alive.clear();
    [202, 203].forEach((pid) => alive.add(pid));
    const dead = await acquireBoxSlot(request("dead", 201));
    const live = await acquireBoxSlot(request("live", 202));
    const taker = await acquireBoxSlot(request("taker", 203));

    expect(taker.slot).toBe("slot-1");
    expect(taker.takenOver).toBe(true);
    expect(taker.previousPid).toBe(201);
    dead.release(); // the old holder finally notices — and must keep its hands off
    expect(slotStates()[0]).toMatchObject({ free: false, pid: 203 });
    live.release();
    taker.release();
  });

  it("prints one line per minute naming every holder (fake timers)", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    alive.clear();
    alive.add(1);
    const now = Date.now();
    holdSlot(1, 1, line("first", now, 10));
    holdSlot(2, 1, line("second", now, 10));
    const lines: string[] = [];
    const waiting = acquireBoxSlot(
      request("waiter", 2, { pollMs: 1_000, log: (text) => lines.push(text) }),
    );

    await vi.advanceTimersByTimeAsync(30_000);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("waiting 0m00s");
    expect(lines[0]).toContain(`slot-1 pid 1: ${line("first", now, 10)}`);
    expect(lines[0]).toContain(`slot-2 pid 1: ${line("second", now, 10)}`);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("waiting 1m00s");
    await vi.advanceTimersByTimeAsync(60_000);
    expect(lines).toHaveLength(3);

    rmSync(join(box, "slot-2.lock")); // the second holder releases
    await vi.advanceTimersByTimeAsync(1_000);
    const slot = await waiting;
    expect(slot.slot).toBe("slot-2");
    slot.release();
  });

  it("ends with exit 75 naming the holder that outlived its cap by more than 5 min", async () => {
    alive.clear();
    alive.add(1);
    holdSlot(1, 1, line("hung", Date.now() - 16 * MIN, 10));
    holdSlot(2, 1, line("fine", Date.now(), 10));
    const error = await acquireBoxSlot(request("waiter", 2)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(LockWaitError);
    expect((error as LockWaitError).exit).toBe(LOCK_DEADLINE_EXIT);
    expect((error as LockWaitError).reason).toBe(LOCK_EXPIRED);
    expect((error as Error).message).toMatch(
      /slot-1 pid 1: repository=o\/r run=hung .* outlived its cap .*look at that holder/,
    );
  });

  it("ends a chain of compliant holders with exit 75 once the wait passes the allowance", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    alive.clear();
    alive.add(1);
    const entered = Date.now();
    holdSlot(1, 1, line("one", entered, 10));
    holdSlot(2, 1, line("two", entered, 10));
    const waiting = acquireBoxSlot(request("waiter", 2, { pollMs: 1_000 })).catch(
      (e: unknown) => e,
    );

    // Every eight minutes both slots pass to fresh holders, each inside its cap.
    await vi.advanceTimersByTimeAsync(8 * MIN);
    holdSlot(1, 1, line("three", Date.now(), 10));
    holdSlot(2, 1, line("four", Date.now(), 10));
    await vi.advanceTimersByTimeAsync(8 * MIN);
    const error = await waiting;

    expect((error as LockWaitError).exit).toBe(LOCK_DEADLINE_EXIT);
    expect((error as LockWaitError).reason).toBe(LOCK_CHAIN);
    expect((error as Error).message).toMatch(/chain: waited 15m0\ds, past the 15 min allowance/);
    expect((error as Error).message).toMatch(/run=three .*run=four .*re-run$/);
  });

  it("appends one wait-log record per acquire and per expired wait", async () => {
    alive.clear();
    [301, 302, 303].forEach((pid) => alive.add(pid));
    const a = await acquireBoxSlot(request("a", 301, { step: "gallery" }));
    const b = await acquireBoxSlot(request("b", 302));
    const third = acquireBoxSlot(request("c", 303, { step: "image-build" }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    b.release();
    (await third).release();
    a.release();

    const records = lastWaits(10);
    expect(records).toHaveLength(3);
    expect(records[0]).toMatchObject({ step: "gallery", waited_s: 0, holders: [], slots: 2 });
    expect(records[2]).toMatchObject({
      repository: "o/r",
      step: "image-build",
      run: "c",
      outcome: "acquired",
      slots: 2,
    });
    expect(records[2]?.waited_s).toBeGreaterThan(0);
    expect(records[2]?.holders).toHaveLength(2);
    expect(Date.parse(records[2]?.at ?? "")).not.toBeNaN();
    expect(records[2]?.at).toMatch(/Z$/);

    holdSlot(1, 301, line("hung", Date.now() - 20 * MIN, 1));
    holdSlot(2, 301, line("fine", Date.now(), 10));
    await acquireBoxSlot(request("d", 304)).catch(() => {});
    const raw = readFileSync(join(box, WAITS_FILE), "utf8").trim().split("\n");
    expect(JSON.parse(raw[raw.length - 1] ?? "{}")).toMatchObject({
      run: "d",
      outcome: "expired",
    });
  });

  it("reads the slot count from SPEC_SYNC_BOX_SLOTS, then <box>/config.json, else 2", () => {
    expect(slotCount(box)).toBe(2);
    writeFileSync(join(box, "config.json"), '{"slots": 3}');
    expect(slotCount(box)).toBe(3);
    process.env[BOX_SLOTS_ENV] = "1";
    expect(slotCount(box)).toBe(1);
    process.env[BOX_SLOTS_ENV] = "0";
    expect(() => slotCount(box)).toThrow(/SPEC_SYNC_BOX_SLOTS/);
    expect(existsSync(join(box, WAITS_FILE))).toBe(false);
  });
});

describe("box load gate (PROC-REL-060, owner decision 06.11.)", () => {
  let ceilingBefore: string | undefined;
  beforeEach(() => {
    ceilingBefore = process.env[BOX_LOAD_MAX_ENV];
    delete process.env[BOX_LOAD_MAX_ENV]; // the default ceiling of 50
    alive.clear();
    alive.add(1);
  });
  afterEach(() => {
    if (ceilingBefore === undefined) delete process.env[BOX_LOAD_MAX_ENV];
    else process.env[BOX_LOAD_MAX_ENV] = ceilingBefore;
  });

  it("takes a free slot at once while the load is below the ceiling", async () => {
    const lines: string[] = [];
    const slot = await acquireBoxSlot(
      request("calm", 2, { loadavg: () => 49.94, log: (text) => lines.push(text) }),
    );
    slot.release();

    expect(slot.queued).toBe(false);
    expect(lines).toEqual([]);
    expect(lastWaits(1)[0]).toMatchObject({
      outcome: "acquired",
      load: 49.9,
      load_waited_s: 0,
      waited_s: 0,
    });
  });

  it("holds a free slot back while the load is at or above the ceiling, then takes it when the load drops", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    let load = 50;
    const lines: string[] = [];
    let held = false;
    const waiting = acquireBoxSlot(
      request("busy", 2, { pollMs: 1_000, loadavg: () => load, log: (text) => lines.push(text) }),
    ).then((slot) => {
      held = true;
      return slot;
    });

    await vi.advanceTimersByTimeAsync(30_000);
    expect(held).toBe(false);
    expect(slotStates().every((slot) => slot.free)).toBe(true);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/a slot is free, waiting 0m00s on load — 1-min load 50 ≥ ceiling 50/);
    await vi.advanceTimersByTimeAsync(31_000);
    expect(lines).toHaveLength(2);
    expect(lines[1]).toContain("waiting 1m00s on load");

    load = 12.34;
    await vi.advanceTimersByTimeAsync(1_000);
    const slot = await waiting;
    expect(held).toBe(true);
    slot.release();
    const record = lastWaits(1)[0];
    expect(record).toMatchObject({ outcome: "acquired", load: 12.3, holders: [] });
    expect(record?.load_waited_s).toBeGreaterThanOrEqual(61);
    expect(record?.load_waited_s).toBeLessThanOrEqual(62);
  });

  it("does not count the wait for a busy slot as load wait", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    const now = Date.now();
    holdSlot(1, 1, line("first", now, 30));
    holdSlot(2, 1, line("second", now, 30));
    let load = 80;
    const waiting = acquireBoxSlot(request("waiter", 2, { pollMs: 1_000, loadavg: () => load }));

    await vi.advanceTimersByTimeAsync(20 * MIN); // all slots held: a slot wait, not a load wait
    rmSync(join(box, "slot-2.lock"));
    await vi.advanceTimersByTimeAsync(2 * MIN); // a free slot, held back by load
    load = 3;
    await vi.advanceTimersByTimeAsync(1_000);
    (await waiting).release();

    const record = lastWaits(1)[0];
    expect(record?.outcome).toBe("acquired");
    expect(record?.load_waited_s).toBeGreaterThanOrEqual(120);
    expect(record?.load_waited_s).toBeLessThanOrEqual(122);
    expect(record?.waited_s).toBeGreaterThanOrEqual(22 * 60);
  });

  it("takes the free slot anyway after 15 min on load alone, as acquired-overload", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    const lines: string[] = [];
    const waiting = acquireBoxSlot(
      request("stuck", 2, { pollMs: 1_000, loadavg: () => 162, log: (text) => lines.push(text) }),
    );

    await vi.advanceTimersByTimeAsync(15 * MIN - 2_000);
    expect(slotStates().every((slot) => slot.free)).toBe(true);
    await vi.advanceTimersByTimeAsync(3_000);
    const slot = await waiting;
    slot.release();

    expect(lines).toHaveLength(15);
    const record = lastWaits(1)[0];
    expect(record).toMatchObject({ outcome: "acquired-overload", load: 162, holders: [] });
    expect(record?.load_waited_s).toBeGreaterThanOrEqual(15 * 60);
    expect(record?.load_waited_s).toBeLessThanOrEqual(15 * 60 + 1);
  });

  it("reads the ceiling from SPEC_SYNC_BOX_LOAD_MAX, else 50", async () => {
    expect(loadCeiling()).toBe(DEFAULT_LOAD_MAX);
    expect(DEFAULT_LOAD_MAX).toBe(50);
    process.env[BOX_LOAD_MAX_ENV] = "24";
    expect(loadCeiling()).toBe(24);
    const slot = await acquireBoxSlot(request("low", 2, { loadavg: () => 23.9 }));
    slot.release();
    expect(lastWaits(1)[0]).toMatchObject({ outcome: "acquired", load_waited_s: 0 });
    for (const bad of ["0", "-3", "abc", ""]) {
      process.env[BOX_LOAD_MAX_ENV] = bad;
      expect(() => loadCeiling()).toThrow(/SPEC_SYNC_BOX_LOAD_MAX must be a whole number ≥ 1/);
    }
  });
});

describe("box slot queue — first come, first served (PROC-REL-060 rev 4)", () => {
  const queueFiles = (): string[] => readdirSync(box).filter((name) => name.startsWith("queue-"));
  const pause = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
  const track = <T>(promise: Promise<T>): { done: () => boolean; promise: Promise<T> } => {
    let settled = false;
    void promise.then(
      () => (settled = true),
      () => (settled = true),
    );
    return { done: () => settled, promise };
  };
  beforeEach(() => {
    alive.clear();
    [1, 11, 12, 13].forEach((pid) => alive.add(pid));
  });

  it("never lets a later arrival overtake an earlier waiter when one slot frees", async () => {
    holdSlot(1, 1, line("one", Date.now(), 30));
    holdSlot(2, 1, line("two", Date.now(), 30));
    const lateLines: string[] = [];
    // The earlier waiter polls slowly, the later one fast: without a queue the
    // later one would win the freed slot.
    const early = track(acquireBoxSlot(request("early", 11, { pollMs: 80 })));
    await pause(20);
    const late = track(
      acquireBoxSlot(request("late", 12, { pollMs: 1, log: (text) => lateLines.push(text) })),
    );
    await pause(20);
    expect(queueStates(box, (pid) => alive.has(pid)).map((one) => one.pid)).toEqual([11, 12]);
    expect(lateLines[0]).toMatch(/waiting 0m00s, position 2 of 2 — slot-1 /);

    rmSync(join(box, "slot-2.lock"));
    const first = await early.promise;
    await pause(30);
    expect(first.slot).toBe("slot-2");
    expect(late.done()).toBe(false);
    rmSync(join(box, "slot-1.lock"));
    const second = await late.promise;
    expect(second.slot).toBe("slot-1");
    first.release();
    second.release();
    expect(lastWaits(2).map((one) => [one.run, one.queue_position_at_entry])).toEqual([
      ["early", 1],
      ["late", 2],
    ]);
    expect(queueFiles()).toEqual([]);
  });

  it("gives two free slots to the two oldest waiters", async () => {
    holdSlot(1, 1, line("one", Date.now(), 30));
    holdSlot(2, 1, line("two", Date.now(), 30));
    const a = track(acquireBoxSlot(request("a", 11, { pollMs: 40 })));
    await pause(10);
    const b = track(acquireBoxSlot(request("b", 12, { pollMs: 40 })));
    await pause(10);
    const c = track(acquireBoxSlot(request("c", 13, { pollMs: 1 })));
    await pause(10);

    rmSync(join(box, "slot-1.lock"));
    rmSync(join(box, "slot-2.lock"));
    const [first, second] = await Promise.all([a.promise, b.promise]);
    await pause(30);
    expect(c.done()).toBe(false);
    first.release();
    const third = await c.promise;
    second.release();
    third.release();
    expect(queueFiles()).toEqual([]);
  });

  it("skips and removes the entry of a dead waiter", async () => {
    const dead = "queue-000000000000001-0000000999-000001.json";
    writeFileSync(
      join(box, dead),
      `${JSON.stringify({ pid: 999, holder: line("gone", 1, 10), step: "s", enqueuedAt: new Date(1).toISOString() })}\n`,
    );
    const slot = await acquireBoxSlot(request("next", 11));
    slot.release();

    expect(slot.queued).toBe(false);
    expect(lastWaits(1)[0]?.queue_position_at_entry).toBe(1);
    expect(queueFiles()).toEqual([]);
  });

  it("removes the entry on acquire and on an expired wait (75), and leaves no signal handler behind", async () => {
    const before = process.listenerCount("SIGTERM");
    const slot = await acquireBoxSlot(request("quick", 11));
    expect(queueFiles()).toEqual([]);
    expect(process.listenerCount("SIGTERM")).toBe(before);
    slot.release();

    holdSlot(1, 1, line("one", Date.now(), 30));
    holdSlot(2, 1, line("two", Date.now(), 30));
    const waiting = track(acquireBoxSlot(request("w", 12, { pollMs: 5 })));
    await pause(20);
    expect(queueFiles()).toHaveLength(1);
    expect(process.listenerCount("SIGTERM")).toBe(before + 1);
    expect(process.listenerCount("SIGINT")).toBeGreaterThan(0);
    rmSync(join(box, "slot-1.lock"));
    (await waiting.promise).release();
    rmSync(join(box, "slot-2.lock"));

    holdSlot(1, 1, line("hung", Date.now() - 40 * MIN, 10));
    holdSlot(2, 1, line("fine", Date.now(), 10));
    const error = await acquireBoxSlot(request("x", 13)).catch((e: unknown) => e);
    expect((error as LockWaitError).exit).toBe(LOCK_DEADLINE_EXIT);
    expect(queueFiles()).toEqual([]);
    expect(process.listenerCount("SIGTERM")).toBe(before);
  });

  it("holds the queue head on load; after 15 min the head starts as overload and the order is kept", async () => {
    vi.useFakeTimers({ toFake: ["Date", "setTimeout"] });
    const ceilingBefore = process.env[BOX_LOAD_MAX_ENV];
    delete process.env[BOX_LOAD_MAX_ENV];
    try {
      holdSlot(1, 1, line("long", Date.now(), 60));
      const headLines: string[] = [];
      const laterLines: string[] = [];
      const head = track(
        acquireBoxSlot(
          request("head", 11, {
            pollMs: 10_000,
            loadavg: () => 162,
            log: (text) => headLines.push(text),
          }),
        ),
      );
      await vi.advanceTimersByTimeAsync(10_000);
      const later = track(
        acquireBoxSlot(
          request("later", 12, {
            pollMs: 10_000,
            loadavg: () => 162,
            log: (text) => laterLines.push(text),
          }),
        ),
      );

      await vi.advanceTimersByTimeAsync(10 * MIN);
      expect(head.done() || later.done()).toBe(false);
      expect(headLines[0]).toMatch(/on load — 1-min load 162 ≥ ceiling 50.* — position 1 of 1$/);
      expect(headLines.at(-1)).toMatch(/waiting 10m00s on load .* — position 1 of 2$/);
      expect(laterLines[0]).toMatch(/a slot is free, position 2 of 2 — waiting behind 1 earlier/);

      await vi.advanceTimersByTimeAsync(5 * MIN + 20_000);
      expect(head.done()).toBe(true);
      expect(later.done()).toBe(false);
      const headSlot = await head.promise;
      expect(headSlot.slot).toBe("slot-2");
      expect(lastWaits(1)[0]).toMatchObject({ run: "head", outcome: "acquired-overload" });

      // The later waiter's load wait starts only once it heads the queue at a free slot.
      rmSync(join(box, "slot-1.lock"));
      await vi.advanceTimersByTimeAsync(14 * MIN);
      expect(later.done()).toBe(false);
      await vi.advanceTimersByTimeAsync(MIN + 20_000);
      const laterSlot = await later.promise;
      headSlot.release();
      laterSlot.release();
      const record = lastWaits(1)[0];
      expect(record).toMatchObject({ run: "later", outcome: "acquired-overload" });
      expect(record?.load_waited_s).toBeGreaterThanOrEqual(15 * 60);
      expect(record?.load_waited_s).toBeLessThanOrEqual(15 * 60 + 20);
    } finally {
      if (ceilingBefore === undefined) delete process.env[BOX_LOAD_MAX_ENV];
      else process.env[BOX_LOAD_MAX_ENV] = ceilingBefore;
    }
  });
});

describe("judge (PROC-REL-040 rev 7 waiter deadline)", () => {
  const at = Date.parse("2026-11-05T10:00:00Z");
  const seen = (holder: string, startedAt?: string): Seen => ({
    label: "slot-1",
    pid: 7,
    holder,
    ...(startedAt === undefined ? {} : { startedAt }),
  });

  it("waits while every holder is inside its cap plus five minutes", () => {
    expect(judge([seen(line("x", at, 10))], at + 15 * MIN, at, 15).action).toBe("wait");
    expect(judge([seen(line("x", at, 10))], at + 15 * MIN + 1, at, 99).action).toBe("expired");
  });

  it("prints an unreadable holder raw and falls back to 40 min from entry", () => {
    expect(judge([seen("garbage")], at + 40 * MIN, at, 40).action).toBe("wait");
    const verdict = judge([seen("garbage")], at + 40 * MIN + 1, at, 99);
    expect(verdict).toMatchObject({ action: "expired" });
    expect(verdict.action !== "wait" && verdict.message).toContain(
      'holder line unreadable, 40 min fallback: "garbage"',
    );
  });
});
