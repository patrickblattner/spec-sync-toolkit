/**
 * The gate mutex (spec §7.1, `DECISION (gate-mutex)`).
 *
 * A lockfile (`.spec-sync/gate.lock`, PID + timestamp) serialises gate runs on
 * the machine. Parallel sub-agents build at the same time and QUEUE for the
 * gate instead of saturating the CPU and provoking exit 2 — the mutex and the
 * saturation logic solve the same problem from two ends.
 *
 * An orphaned lock (the holding process is gone) is taken over rather than
 * waited on: an agent killed mid-gate must not block the machine until someone
 * notices. Waiting time and takeover both surface in the response's `notes`.
 */

import { mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { STATE_DIR } from "../logs.js";
import { EXIT, ToolkitError } from "../output.js";

/** Path of the lockfile, relative to the repo root. */
export const LOCK_FILE = join(STATE_DIR, "gate.lock");

/** How often a waiting run re-checks the lock. */
export const LOCK_POLL_MS = 500;

/**
 * How long a run queues before giving up. A full gate is minutes, not hours; a
 * wait beyond this is a stuck holder whose PID is still alive, and reporting a
 * violated precondition beats hanging a driver forever.
 */
export const LOCK_TIMEOUT_MS = 30 * 60 * 1000;

export interface GateLock {
  /** How long acquiring took. Only meaningful together with `queued`. */
  waitedMs: number;
  /** Whether this run actually had to queue behind a LIVE holder. */
  queued: boolean;
  /** Whether an orphaned lock had to be taken over. */
  takenOver: boolean;
  /** PID of the run we queued behind or took over, if there was one. */
  previousPid?: number;
  release(): void;
}

interface LockOptions {
  pollMs?: number;
  timeoutMs?: number;
  isAlive?: (pid: number) => boolean;
  pid?: number;
}

interface LockPayload {
  pid: number;
  startedAt: string;
}

/**
 * Acquires the gate lock, queueing while another run holds it. Resolves only
 * with the lock held; the caller must `release()` it in a `finally`.
 */
export async function acquireGateLock(
  repoRoot: string,
  options: LockOptions = {},
): Promise<GateLock> {
  const pollMs = options.pollMs ?? LOCK_POLL_MS;
  const timeoutMs = options.timeoutMs ?? LOCK_TIMEOUT_MS;
  const isAlive = options.isAlive ?? processAlive;
  const pid = options.pid ?? process.pid;

  const path = join(repoRoot, LOCK_FILE);
  mkdirSync(join(repoRoot, STATE_DIR), { recursive: true });

  const startedAt = Date.now();
  let takenOver = false;
  let queued = false;
  let previousPid: number | undefined;

  for (;;) {
    const payload: LockPayload = { pid, startedAt: new Date().toISOString() };
    try {
      // `wx` is the whole mutex: an atomic create-if-absent, so two runs racing
      // for the same lock cannot both win.
      writeFileSync(path, `${JSON.stringify(payload)}\n`, { flag: "wx", encoding: "utf8" });
      return {
        waitedMs: Date.now() - startedAt,
        queued,
        takenOver,
        ...(previousPid === undefined ? {} : { previousPid }),
        release: () => releaseLock(path, pid),
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
        throw new ToolkitError(
          `cannot write the gate lock ${LOCK_FILE}: ${(error as Error).message}`,
          EXIT.PRECONDITION,
          { field: LOCK_FILE, cause: error },
        );
      }
    }

    const holder = readLock(path);
    previousPid = holder?.pid;

    // An unreadable lock is treated like an orphan: it carries no evidence that
    // anyone is running, and leaving it in place would block the machine.
    if (holder === null || !isAlive(holder.pid)) {
      takenOver = true;
      try {
        unlinkSync(path);
      } catch {
        // Another waiter got there first — the next attempt sorts it out.
      }
      continue;
    }

    if (Date.now() - startedAt >= timeoutMs) {
      throw new ToolkitError(
        `another gate run (pid ${holder.pid}, since ${holder.startedAt}) still holds ${LOCK_FILE} ` +
          `after ${Math.round((Date.now() - startedAt) / 1000)}s`,
        EXIT.PRECONDITION,
        { field: LOCK_FILE },
      );
    }

    queued = true;
    await sleep(pollMs);
  }
}

/** Reads the current holder. Returns null when the lock is gone or unreadable. */
export function readLock(path: string): LockPayload | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null) return null;
    const { pid, startedAt } = parsed as Partial<LockPayload>;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) return null;
    return { pid, startedAt: typeof startedAt === "string" ? startedAt : "" };
  } catch {
    return null;
  }
}

/** Releases the lock, but only while it is still ours — a takeover must not be undone. */
function releaseLock(path: string, pid: number): void {
  const holder = readLock(path);
  if (holder !== null && holder.pid !== pid) return;
  try {
    unlinkSync(path);
  } catch {
    // Already gone; nothing to release.
  }
}

/** Whether a PID still exists. `EPERM` means it does and belongs to someone else. */
function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
