/**
 * The waiter mechanics of a machine lock (foundation `PROC-REL-040` rev 7),
 * shared by the per-repo gate lock (`lock.ts`) and the machine-wide box slots
 * (`slots.ts`, `PROC-REL-060`).
 *
 * A lock is a file whose appearance is atomic: the record is written to a
 * temporary file first and hard-linked into place, so `link` both takes the
 * lock and makes a complete record visible in one step — no reader ever sees
 * a half-written lock. The record is JSON (`pid`, `startedAt`, `holder`, and
 * for a slot `step`); `pid` and `startedAt` keep a 0.36 reader of `gate.lock`
 * working during the transition, and `holder` carries the holder line in the
 * one syntax every repo reads:
 *
 *   repository=<owner/repo> run=<run id> started=<UTC ISO-8601> cap=<minutes>
 *
 * While every lock is held the waiter polls, prints one line per minute naming
 * every holder (stderr), and derives its deadline from the holders:
 *
 * - a holder that outlived its cap by more than five minutes ends the wait —
 *   exit 75, look at that holder, never re-run;
 * - a wait longer than the allowance (largest holder cap + 5 min) is a chain
 *   of compliant holders — exit 75, re-run;
 * - a holder line without a readable cap is printed raw and falls back to a
 *   40 min deadline.
 *
 * A lock whose pid is gone, or whose file is unreadable, is taken over: moved
 * aside in one atomic rename and dropped only if it is still the record judged
 * stale; anything else goes back.
 */

import { execFileSync } from "node:child_process";
import {
  existsSync,
  linkSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { LOCK_DEADLINE_EXIT, ToolkitError, EXIT, progress } from "../output.js";

/** Minutes a holder may outlive its cap before its waiters give up on it. */
export const GRACE_MIN = 5;
/** Deadline, from the holder's start, of a holder line without a readable cap. */
export const NO_CAP_MIN = 40;
/** A waiter prints at most one line per this interval. */
export const WAIT_LINE_MS = 60_000;
const MIN = 60_000;

/** `reason` of a wait whose holder outlived its cap. */
export const LOCK_EXPIRED = "lock-deadline-expired";
/** `reason` of a wait that passed the allowance behind a chain of holders. */
export const LOCK_CHAIN = "lock-chain";

/** An expired wait (exit 75), carrying the holders it waited behind. */
export class LockWaitError extends ToolkitError {
  readonly waitedBehind: string[];

  constructor(message: string, reason: string, waitedBehind: string[]) {
    super(message, LOCK_DEADLINE_EXIT, { reason });
    this.name = "LockWaitError";
    this.waitedBehind = waitedBehind;
  }
}

export interface HolderFields {
  repository: string;
  run: string;
  started: Date;
  /** Bound of the locked work in minutes. */
  cap: number;
}

export function holderLine({ repository, run, started, cap }: HolderFields): string {
  return `repository=${repository} run=${run} started=${started.toISOString()} cap=${cap}`;
}

/** Reads `started` and `cap` off a holder line; unknown keys are ignored, unreadable values are undefined. */
export function parseHolder(line: string): { started?: number; cap?: number } {
  const fields = new Map<string, string>();
  for (const pair of line.trim().split(/\s+/)) {
    const at = pair.indexOf("=");
    if (at > 0) fields.set(pair.slice(0, at), pair.slice(at + 1));
  }
  const started = Date.parse(fields.get("started") ?? "");
  const cap = fields.get("cap") ?? "";
  return {
    ...(Number.isNaN(started) ? {} : { started }),
    ...(/^\d+$/.test(cap) ? { cap: Number(cap) } : {}),
  };
}

/** `<owner>/<repo>` of the checkout's origin; `?` without one. */
export function repositoryOf(repoRoot: string): string {
  let url = "";
  try {
    url = execFileSync("git", ["-C", repoRoot, "remote", "get-url", "origin"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch {
    // No git, or no origin: the holder names the repository `?`.
  }
  return /github\.com[:/]([^/]+\/[^/]+?)(?:\.git)?$/.exec(url.trim())?.[1] ?? "?";
}

export interface LockRecord {
  pid: number;
  startedAt: string;
  holder: string;
  step?: string;
}

/** What a waiter saw in one held lock. */
export interface Seen {
  /** Which lock: `gate.lock`, `slot-2`. */
  label: string;
  pid: number;
  /** The holder line, or the raw record when it carries none (a 0.36 gate.lock). */
  holder: string;
  /** `startedAt` of the record, the start of a holder line without one. */
  startedAt?: string;
}

/** Minutes after its start at which a holder's waiters give up on it. */
function deadlineMin(holder: string): number {
  const { cap } = parseHolder(holder);
  return cap === undefined ? NO_CAP_MIN : cap + GRACE_MIN;
}

function startOf(seen: Seen, enteredAt: number): number {
  const fromLine = parseHolder(seen.holder).started;
  if (fromLine !== undefined) return fromLine;
  const fromRecord = Date.parse(seen.startedAt ?? "");
  return Number.isNaN(fromRecord) ? enteredAt : fromRecord;
}

/** One holder as a waiter names it; an unreadable line is printed raw. */
export function describe(seen: Seen): string {
  return parseHolder(seen.holder).cap === undefined
    ? `${seen.label} pid ${seen.pid}: holder line unreadable, ${NO_CAP_MIN} min fallback: ${JSON.stringify(seen.holder)}`
    : `${seen.label} pid ${seen.pid}: ${seen.holder}`;
}

export type Verdict =
  { action: "wait" } | { action: "expired" | "chain"; message: string; reason: string };

/**
 * The waiter's deadline, re-derived on every attempt because holders change.
 * `allowanceMin` is the largest holder cap seen during this wait plus five.
 */
export function judge(
  seen: readonly Seen[],
  now: number,
  enteredAt: number,
  allowanceMin: number,
): Verdict {
  for (const one of seen) {
    if (now > startOf(one, enteredAt) + deadlineMin(one.holder) * MIN) {
      return {
        action: "expired",
        reason: LOCK_EXPIRED,
        message: `lock deadline expired — ${describe(one)} ${parseHolder(one.holder).cap === undefined ? `outlived the ${NO_CAP_MIN} min fallback` : `outlived its cap by more than ${GRACE_MIN} min`}; look at that holder, do not re-run`,
      };
    }
  }
  if (now - enteredAt > allowanceMin * MIN) {
    return {
      action: "chain",
      reason: LOCK_CHAIN,
      message: `lock deadline expired — chain: waited ${minutes(now - enteredAt)}, past the ${allowanceMin} min allowance (largest holder cap + ${GRACE_MIN}), now behind ${seen.map(describe).join("; ")}; re-run`,
    };
  }
  return { action: "wait" };
}

export function minutes(ms: number): string {
  const total = Math.round(ms / 1000);
  return `${Math.floor(total / 60)}m${String(total % 60).padStart(2, "0")}s`;
}

export interface AcquireOptions {
  /** How often a waiter re-checks the locks. */
  pollMs: number;
  /** What is waited for, as the waiter line names it: `gate.lock`, `a box slot`. */
  what: string;
  isAlive?: (pid: number) => boolean;
  /** Where waiter lines go; stderr by default (stdout carries only the response). */
  log?: (line: string) => void;
  /**
   * Asked whenever a lock is free, right before taking it, with the time held
   * back by it so far; false holds back for one poll (the box load gate of
   * PROC-REL-060). Time held back never counts toward the holders' deadlines.
   */
  admit?: (heldBackMs: number) => boolean;
  /** Extra words for the waiter line, e.g. the queue position of a box slot waiter. */
  detail?: () => string;
}

export interface Acquired {
  /** The lock file now held. */
  path: string;
  waitedMs: number;
  /** Whether this run waited behind a live holder. */
  queued: boolean;
  /** Whether a lock of an ended holder (or an unreadable one) was taken over. */
  takenOver: boolean;
  /** PID of the last holder waited behind or taken over. */
  previousPid?: number;
  /** The live holders waited behind, each named once, in the order first seen. */
  waitedBehind: string[];
  release(): void;
}

type Read =
  | { state: "gone" }
  | { state: "unreadable"; raw: string }
  | { state: "held"; raw: string; record: LockRecord };

function readRaw(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** The record in a lock file, or why there is none. */
export function readRecord(path: string): Read {
  const raw = readRaw(path);
  if (raw === undefined) return { state: "gone" };
  try {
    const parsed = JSON.parse(raw) as Partial<LockRecord> | null;
    const pid = parsed?.pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 0) {
      return { state: "unreadable", raw };
    }
    return {
      state: "held",
      raw,
      record: {
        pid,
        startedAt: typeof parsed?.startedAt === "string" ? parsed.startedAt : "",
        holder: typeof parsed?.holder === "string" ? parsed.holder : "",
        ...(typeof parsed?.step === "string" ? { step: parsed.step } : {}),
      },
    };
  } catch {
    return { state: "unreadable", raw };
  }
}

let tmpSeq = 0;

/** Creates the lock with its full record in one atomic step; false when it is held. */
function tryCreate(path: string, content: string): boolean {
  const tmp = `${path}.${process.pid}.${(tmpSeq += 1)}.tmp`;
  try {
    writeFileSync(tmp, content, "utf8");
    linkSync(tmp, path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false;
    throw new ToolkitError(
      `cannot write the lock ${path}: ${(error as Error).message}`,
      EXIT.PRECONDITION,
      {
        field: path,
        cause: error,
      },
    );
  } finally {
    rmSync(tmp, { force: true });
  }
}

/** Moves a stale lock aside and drops it only if it is still the record judged stale. */
function takeOver(path: string, judged: string): boolean {
  const aside = `${path}.${process.pid}.${(tmpSeq += 1)}.stale`;
  try {
    renameSync(path, aside);
  } catch {
    return false; // someone else moved it first
  }
  const moved = readRaw(aside);
  if (moved !== judged) {
    // A fresh holder took the lock between our read and our rename: give it back,
    // unless yet another holder has the lock by now.
    try {
      linkSync(aside, path);
    } catch {
      // the lock is held again — nothing to restore
    }
  }
  rmSync(aside, { force: true });
  return moved === judged;
}

/** Releases a lock, but only while it is still this record — a takeover must not be undone. */
function releaseOwn(path: string, content: string): void {
  if (readRaw(path) !== content) return;
  try {
    unlinkSync(path);
  } catch {
    // already gone
  }
}

/**
 * Takes the first free lock of `paths`, waiting while all are held. Resolves
 * only with a lock held; the caller must `release()` it in a `finally`. Ends a
 * wait whose deadline expired with a `ToolkitError` of exit 75.
 */
export async function acquireOne(
  paths: readonly string[],
  record: (started: Date) => LockRecord,
  options: AcquireOptions,
): Promise<Acquired> {
  const isAlive = options.isAlive ?? processAlive;
  const log = options.log ?? progress;
  const enteredAt = Date.now();
  let lastLineAt: number | undefined;
  let allowanceMin = 0;
  let queued = false;
  let takenOver = false;
  let previousPid: number | undefined;
  const waitedBehind: string[] = [];
  let heldBackMs = 0;
  let heldBackAt: number | undefined;

  for (;;) {
    if (heldBackAt !== undefined) {
      heldBackMs += Date.now() - heldBackAt;
      heldBackAt = undefined;
    }
    const anyFree = paths.some((path) => !existsSync(path));
    if (options.admit !== undefined && anyFree && !options.admit(heldBackMs)) {
      heldBackAt = Date.now();
      await sleep(options.pollMs);
      continue;
    }
    // Written fresh on every attempt: the holder line's `started` is when the
    // lock was taken, since waiters count the cap from there.
    const content = `${JSON.stringify(record(new Date()))}\n`;
    // Under an admit gate a lock is taken only after admit said yes: one freed
    // after the check waits for the next attempt, so it is never taken unasked.
    const free =
      options.admit !== undefined && !anyFree
        ? undefined
        : paths.find((path) => tryCreate(path, content));
    if (free !== undefined) {
      return {
        path: free,
        waitedMs: Date.now() - enteredAt,
        queued,
        takenOver,
        ...(previousPid === undefined ? {} : { previousPid }),
        waitedBehind,
        release: () => releaseOwn(free, content),
      };
    }

    const seen: Seen[] = [];
    let retry = false;
    for (const path of paths) {
      const read = readRecord(path);
      if (read.state === "gone") {
        retry = true; // released between our attempt and our read
        break;
      }
      if (read.state === "unreadable" || !isAlive(read.record.pid)) {
        // An unreadable lock carries no evidence that anyone is running; a dead
        // pid's lock would block the machine until someone noticed.
        if (read.state === "held") previousPid = read.record.pid;
        if (takeOver(path, read.raw)) takenOver = true;
        retry = true;
        break;
      }
      const { record: held } = read;
      seen.push({
        label: labelOf(path),
        pid: held.pid,
        holder: held.holder === "" ? read.raw.trim() : held.holder,
        startedAt: held.startedAt,
      });
    }
    if (retry) continue;

    for (const one of seen) {
      allowanceMin = Math.max(allowanceMin, deadlineMin(one.holder));
      if (!waitedBehind.includes(one.holder)) waitedBehind.push(one.holder);
    }
    previousPid = seen[seen.length - 1]?.pid ?? previousPid;
    queued = true;

    const now = Date.now();
    const verdict = judge(seen, now, enteredAt + heldBackMs, allowanceMin);
    if (verdict.action !== "wait") {
      log(`${options.what}: ${verdict.message}`);
      throw new LockWaitError(`${options.what}: ${verdict.message}`, verdict.reason, waitedBehind);
    }
    if (lastLineAt === undefined || now - lastLineAt >= WAIT_LINE_MS) {
      lastLineAt = now;
      log(
        `${options.what}: waiting ${minutes(now - enteredAt)}${options.detail === undefined ? "" : `, ${options.detail()}`} — ${seen.map(describe).join("; ")}`,
      );
    }
    await sleep(options.pollMs);
  }
}

function labelOf(path: string): string {
  const name = path.split(/[\\/]/).pop() ?? path;
  return name.endsWith(".lock") && name.startsWith("slot-") ? name.slice(0, -".lock".length) : name;
}

/** Whether a PID still exists. `EPERM` means it does and belongs to someone else. */
export function processAlive(pid: number): boolean {
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
