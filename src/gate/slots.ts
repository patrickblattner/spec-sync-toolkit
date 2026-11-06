/**
 * Box slots (foundation `PROC-REL-060`): every heavy local step of every
 * worker on the dev Mac runs in one of N machine-wide slots (default 2), so a
 * third heavy step waits instead of saturating the machine.
 *
 * The slots are lock files `slot-<n>.lock` in one directory outside every repo
 * (`~/.spec-sync/box/`), with the waiter mechanics of `PROC-REL-040`
 * (`holder.ts`). Every acquire — and every expired wait — appends one record
 * to `waits.jsonl` in the same directory: the measurement the slot count
 * follows.
 *
 * The count is a configuration value, not code: `SPEC_SYNC_BOX_SLOTS`, else
 * `{"slots": n}` in `<box>/config.json`, else 2.
 *
 * Load gate (owner decision 06.11.): a free slot is taken only while the
 * 1-minute load is below the ceiling (`SPEC_SYNC_BOX_LOAD_MAX`, else 50). After
 * 15 minutes held back by load alone the slot is taken anyway — a step never
 * starves; the record says `acquired-overload`.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { homedir, loadavg } from "node:os";
import { join } from "node:path";
import { EXIT, ToolkitError, progress } from "../output.js";
import {
  LOCK_CHAIN,
  LockWaitError,
  WAIT_LINE_MS,
  acquireOne,
  holderLine,
  minutes,
  processAlive,
  readRecord,
  type Acquired,
} from "./holder.js";

/** Overrides the box directory (tests, a second box). */
export const BOX_DIR_ENV = "SPEC_SYNC_BOX_DIR";
/** Overrides the slot count of `<box>/config.json`. */
export const BOX_SLOTS_ENV = "SPEC_SYNC_BOX_SLOTS";
/** The start value of PROC-REL-060; the wait log decides whether it moves. */
export const DEFAULT_SLOTS = 2;
export const WAITS_FILE = "waits.jsonl";
/** A slot waiter re-checks once a second: a stat of N local files. */
export const SLOT_POLL_MS = 1_000;
/** Overrides the load ceiling. */
export const BOX_LOAD_MAX_ENV = "SPEC_SYNC_BOX_LOAD_MAX";
/** A free slot is taken only below this 1-minute load (owner decision 06.11.). */
export const DEFAULT_LOAD_MAX = 50;
/** Longest wait on load alone; then the free slot is taken anyway. */
export const LOAD_WAIT_MAX_MS = 15 * 60_000;

export function boxDir(): string {
  return process.env[BOX_DIR_ENV] ?? join(homedir(), ".spec-sync", "box");
}

export function slotCount(dir: string = boxDir()): number {
  const fromEnv = process.env[BOX_SLOTS_ENV];
  if (fromEnv !== undefined) return positive(fromEnv, BOX_SLOTS_ENV);
  let raw: string;
  try {
    raw = readFileSync(join(dir, "config.json"), "utf8");
  } catch {
    return DEFAULT_SLOTS;
  }
  try {
    const slots = (JSON.parse(raw) as { slots?: unknown } | null)?.slots;
    return slots === undefined ? DEFAULT_SLOTS : positive(String(slots), join(dir, "config.json"));
  } catch (error) {
    if (error instanceof ToolkitError) throw error;
    throw new ToolkitError(`${join(dir, "config.json")} is not JSON`, EXIT.PRECONDITION, {
      field: join(dir, "config.json"),
    });
  }
}

export function loadCeiling(): number {
  const fromEnv = process.env[BOX_LOAD_MAX_ENV];
  return fromEnv === undefined ? DEFAULT_LOAD_MAX : positive(fromEnv, BOX_LOAD_MAX_ENV);
}

/** The 1-minute load average, rounded to one decimal. */
export function currentLoad(read: () => number = () => loadavg()[0] ?? 0): number {
  return Math.round(read() * 10) / 10;
}

function positive(value: string, field: string): number {
  if (!/^\d+$/.test(value.trim()) || Number(value) < 1) {
    throw new ToolkitError(
      `${field} must be a whole number ≥ 1, got "${value}"`,
      EXIT.PRECONDITION,
      {
        field,
      },
    );
  }
  return Number(value);
}

export function slotPaths(dir: string, count: number): string[] {
  return Array.from({ length: count }, (_, index) => join(dir, `slot-${index + 1}.lock`));
}

/** One line of `waits.jsonl`. */
export interface WaitRecord {
  /** UTC, ISO-8601. */
  at: string;
  repository: string;
  step: string;
  run: string;
  waited_s: number;
  /** Holder lines of the live holders waited behind. */
  holders: string[];
  slots: number;
  /** 1-minute load when the record was written (absent before 0.38). */
  load?: number;
  /** Seconds a free slot was held back by the load gate (absent before 0.38). */
  load_waited_s?: number;
  /**
   * `acquired`; `acquired-overload` when the load stayed at or above the
   * ceiling for the whole load wait; or the lock deadline that ended the wait.
   */
  outcome: "acquired" | "acquired-overload" | "expired" | "chain";
}

export interface SlotRequest {
  repository: string;
  step: string;
  run: string;
  cap: number;
  pid?: number;
  pollMs?: number;
  isAlive?: (pid: number) => boolean;
  log?: (line: string) => void;
  /** The raw 1-minute load average; `os.loadavg()[0]` by default. */
  loadavg?: () => number;
}

export interface BoxSlot extends Acquired {
  /** `slot-<n>` */
  slot: string;
}

/**
 * Takes a box slot for one heavy step, waiting while all are held. Ends an
 * expired wait with a `ToolkitError` of exit 75; the caller `release()`s the
 * slot in a `finally`.
 */
export async function acquireBoxSlot(request: SlotRequest): Promise<BoxSlot> {
  const dir = boxDir();
  mkdirSync(dir, { recursive: true });
  const slots = slotCount(dir);
  const pid = request.pid ?? process.pid;
  const enteredAt = Date.now();
  const ceiling = loadCeiling();
  const readLoad = request.loadavg;
  const load = (): number => currentLoad(readLoad);
  const print = request.log ?? progress;
  const what = `box slot (${slots} slots, ${dir})`;
  let loadWaitedMs = 0;
  let overload = false;
  let lastLineAt: number | undefined;
  const admit = (heldBackMs: number): boolean => {
    loadWaitedMs = heldBackMs;
    const now = load();
    if (now < ceiling) {
      overload = false;
      return true;
    }
    if (heldBackMs >= LOAD_WAIT_MAX_MS) {
      overload = true;
      return true;
    }
    if (lastLineAt === undefined || heldBackMs - lastLineAt >= WAIT_LINE_MS) {
      lastLineAt = heldBackMs;
      print(
        `${what}: a slot is free, waiting ${minutes(heldBackMs)} on load — 1-min load ${now} ≥ ceiling ${ceiling}; takes the slot anyway after ${LOAD_WAIT_MAX_MS / 60_000} min`,
      );
    }
    return false;
  };
  const log = (outcome: WaitRecord["outcome"], holders: string[]): void => {
    const record: WaitRecord = {
      at: new Date().toISOString(),
      repository: request.repository,
      step: request.step,
      run: request.run,
      waited_s: Math.round((Date.now() - enteredAt) / 100) / 10,
      holders,
      slots,
      load: load(),
      load_waited_s: Math.round(loadWaitedMs / 100) / 10,
      outcome,
    };
    appendFileSync(join(dir, WAITS_FILE), `${JSON.stringify(record)}\n`, "utf8");
  };

  let slot: Acquired;
  try {
    slot = await acquireOne(
      slotPaths(dir, slots),
      (started) => ({
        pid,
        startedAt: started.toISOString(),
        holder: holderLine({
          repository: request.repository,
          run: request.run,
          started,
          cap: request.cap,
        }),
        step: request.step,
      }),
      {
        pollMs: request.pollMs ?? SLOT_POLL_MS,
        what,
        admit,
        ...(request.isAlive === undefined ? {} : { isAlive: request.isAlive }),
        ...(request.log === undefined ? {} : { log: request.log }),
      },
    );
  } catch (error) {
    if (error instanceof LockWaitError) {
      log(error.reason === LOCK_CHAIN ? "chain" : "expired", error.waitedBehind);
    }
    throw error;
  }
  log(overload ? "acquired-overload" : "acquired", slot.waitedBehind);
  return {
    ...slot,
    slot:
      slot.path
        .split(/[\\/]/)
        .pop()
        ?.replace(/\.lock$/, "") ?? slot.path,
  };
}

/** One slot as `slot status` reports it. */
export interface SlotState {
  slot: string;
  free: boolean;
  pid?: number;
  alive?: boolean;
  step?: string;
  holder?: string;
}

export function slotStates(dir: string = boxDir()): SlotState[] {
  return slotPaths(dir, slotCount(dir)).map((path) => {
    const slot =
      path
        .split(/[\\/]/)
        .pop()
        ?.replace(/\.lock$/, "") ?? path;
    const read = readRecord(path);
    if (read.state === "gone") return { slot, free: true };
    if (read.state === "unreadable") return { slot, free: false, holder: read.raw.trim() };
    const { pid, step, holder } = read.record;
    return { slot, free: false, pid, alive: processAlive(pid), ...(step ? { step } : {}), holder };
  });
}

/** The last `count` records of the wait log, oldest first. */
export function lastWaits(count: number, dir: string = boxDir()): WaitRecord[] {
  let raw: string;
  try {
    raw = readFileSync(join(dir, WAITS_FILE), "utf8");
  } catch {
    return [];
  }
  return raw
    .split("\n")
    .filter((line) => line.trim() !== "")
    .slice(-count)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as WaitRecord];
      } catch {
        return [];
      }
    });
}
