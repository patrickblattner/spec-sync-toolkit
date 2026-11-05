/**
 * The gate mutex (spec §7.1, `DECISION (gate-mutex)`).
 *
 * A lockfile (`.spec-sync/gate.lock`) serialises gate runs of one checkout.
 * Parallel sub-agents build at the same time and QUEUE for the gate instead of
 * saturating the CPU and provoking exit 2 — the mutex and the saturation logic
 * solve the same problem from two ends. Across repos, the box slots
 * (`slots.ts`, PROC-REL-060) bound the machine; this lock stays in front of them.
 *
 * The record carries `pid` and `startedAt` (what a 0.36 reader reads) plus the
 * holder line of PROC-REL-040 rev 7. The waiter follows PROC-REL-040 (#31): one
 * line per minute naming the holder, and exit 75 when the holder outlived its
 * cap or the wait passed the allowance — never a silent 30 min.
 *
 * An orphaned lock (the holding process is gone) is taken over rather than
 * waited on: an agent killed mid-gate must not block the machine until someone
 * notices. Waiting time and takeover both surface in the response's `notes`.
 */

import { mkdirSync } from "node:fs";
import { basename, join } from "node:path";
import { STATE_DIR } from "../logs.js";
import { acquireOne, holderLine, readRecord, repositoryOf, type Acquired } from "./holder.js";

/** Path of the lockfile, relative to the repo root. */
export const LOCK_FILE = join(STATE_DIR, "gate.lock");

/** How often a waiting run re-checks the lock. */
export const LOCK_POLL_MS = 500;

/**
 * The cap of a gate run in minutes (PROC-REL-040 rev 7): the bound of the
 * locked work that every waiter's deadline derives from. The gate has no bound
 * of its own, so it is derived from the longest gate class measured on the dev
 * Mac — suite-ui's merge profile, whose last five green runs in its ledger
 * (`.spec-sync/ledger.jsonl`, read 2026-11-05) took 36.1, 22.5, 20.5, 19.3 and
 * 19.8 min: 36.1 plus a third is 48.1, rounded up to the next five minutes, 50.
 * Every other repo and profile measured there is shorter (largest: community
 * vorlauf 19.3, cockpit local 9.7), so for them it is a provisional upper bound,
 * not a measurement of their own class.
 */
export const GATE_CAP_MIN = 50;

export interface GateLock {
  /** How long acquiring took. Only meaningful together with `queued`. */
  waitedMs: number;
  /** Whether this run actually had to queue behind a LIVE holder. */
  queued: boolean;
  /** Whether an orphaned lock had to be taken over. */
  takenOver: boolean;
  /** PID of the run we queued behind or took over, if there was one. */
  previousPid?: number;
  /** Holder lines of the runs waited behind. */
  waitedBehind: string[];
  release(): void;
}

export interface LockOptions {
  pollMs?: number;
  isAlive?: (pid: number) => boolean;
  pid?: number;
  /** The holder line's `run`; `<pid>@<checkout>` by default. */
  run?: string;
  /** The holder line's `repository`; read from `origin` by default. */
  repository?: string;
  cap?: number;
  log?: (line: string) => void;
}

/**
 * Acquires the gate lock, queueing while another run holds it. Resolves only
 * with the lock held; the caller must `release()` it in a `finally`.
 */
export async function acquireGateLock(
  repoRoot: string,
  options: LockOptions = {},
): Promise<GateLock> {
  const pid = options.pid ?? process.pid;
  mkdirSync(join(repoRoot, STATE_DIR), { recursive: true });
  const repository = options.repository ?? repositoryOf(repoRoot);
  const lock: Acquired = await acquireOne(
    [join(repoRoot, LOCK_FILE)],
    (started) => ({
      pid,
      startedAt: started.toISOString(),
      holder: holderLine({
        repository,
        run: options.run ?? `${pid}@${basename(repoRoot)}`,
        started,
        cap: options.cap ?? GATE_CAP_MIN,
      }),
    }),
    {
      pollMs: options.pollMs ?? LOCK_POLL_MS,
      what: "gate.lock",
      ...(options.isAlive === undefined ? {} : { isAlive: options.isAlive }),
      ...(options.log === undefined ? {} : { log: options.log }),
    },
  );
  return {
    waitedMs: lock.waitedMs,
    queued: lock.queued,
    takenOver: lock.takenOver,
    ...(lock.previousPid === undefined ? {} : { previousPid: lock.previousPid }),
    waitedBehind: lock.waitedBehind,
    release: lock.release,
  };
}

/** Reads the current holder. Returns null when the lock is gone or unreadable. */
export function readLock(path: string): { pid: number; startedAt: string; holder: string } | null {
  const read = readRecord(path);
  return read.state === "held" ? read.record : null;
}
