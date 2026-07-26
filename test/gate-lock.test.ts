/**
 * The gate mutex (spec §7.1, `DECISION (gate-mutex)`): parallel agents queue for
 * the gate instead of saturating the box, and a lock whose holder is gone is
 * taken over rather than waited on.
 */

import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOCK_FILE, acquireGateLock, readLock } from "../src/gate/lock.js";
import { EXIT, ToolkitError } from "../src/output.js";

const repo = (): string => mkdtempSync(join(tmpdir(), "spec-sync-lock-"));
const fast = { pollMs: 5, timeoutMs: 2_000 };

describe("gate lock", () => {
  it("writes pid and timestamp, and removes the file on release", async () => {
    const root = repo();
    const lock = await acquireGateLock(root, { ...fast, pid: 4242 });

    const holder = readLock(join(root, LOCK_FILE));
    expect(holder?.pid).toBe(4242);
    expect(Date.parse(holder?.startedAt ?? "")).not.toBeNaN();
    expect(lock.queued).toBe(false);
    expect(lock.takenOver).toBe(false);

    lock.release();
    expect(existsSync(join(root, LOCK_FILE))).toBe(false);
  });

  it("serialises two concurrent runs — the second starts only once the first is done", async () => {
    const root = repo();
    const alive = new Set([111]);
    const first = await acquireGateLock(root, { ...fast, pid: 111, isAlive: (p) => alive.has(p) });

    let secondHeld = false;
    const second = acquireGateLock(root, { ...fast, pid: 222, isAlive: (p) => alive.has(p) }).then(
      (lock) => {
        secondHeld = true;
        return lock;
      },
    );

    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(secondHeld).toBe(false); // still queued behind the first run
    expect(readLock(join(root, LOCK_FILE))?.pid).toBe(111);

    first.release();
    const lock = await second;
    expect(secondHeld).toBe(true);
    expect(readLock(join(root, LOCK_FILE))?.pid).toBe(222);
    // The wait is what the response reports in `notes`.
    expect(lock.queued).toBe(true);
    expect(lock.waitedMs).toBeGreaterThan(0);
    expect(lock.takenOver).toBe(false);
    lock.release();
  });

  it("takes over an orphaned lock — a killed agent must not block the machine", async () => {
    const root = repo();
    const dead = await acquireGateLock(root, { ...fast, pid: 999 });
    expect(dead.takenOver).toBe(false);
    // The holder is gone without releasing; nobody is alive any more.
    const lock = await acquireGateLock(root, { ...fast, pid: 1000, isAlive: () => false });
    expect(lock.takenOver).toBe(true);
    expect(lock.previousPid).toBe(999);
    expect(readLock(join(root, LOCK_FILE))?.pid).toBe(1000);
    lock.release();
  });

  it("treats an unreadable lock as an orphan — it proves nobody is running", async () => {
    const root = repo();
    await acquireGateLock(root, { ...fast, pid: 1 });
    writeFileSync(join(root, LOCK_FILE), "half-written garbage", "utf8");

    const lock = await acquireGateLock(root, { ...fast, pid: 2, isAlive: () => true });
    expect(lock.takenOver).toBe(true);
    expect(readLock(join(root, LOCK_FILE))?.pid).toBe(2);
    lock.release();
  });

  it("a stale release never removes the lock of the run that took over", async () => {
    const root = repo();
    const orphan = await acquireGateLock(root, { ...fast, pid: 555 });
    const taker = await acquireGateLock(root, { ...fast, pid: 556, isAlive: () => false });

    orphan.release(); // the old holder finally notices — and must keep its hands off
    expect(readLock(join(root, LOCK_FILE))?.pid).toBe(556);
    taker.release();
    expect(existsSync(join(root, LOCK_FILE))).toBe(false);
  });

  it("gives up with exit 4 rather than queueing forever behind a live holder", async () => {
    const root = repo();
    await acquireGateLock(root, { ...fast, pid: 777 });
    const error = await acquireGateLock(root, {
      pollMs: 5,
      timeoutMs: 30,
      pid: 778,
      isAlive: () => true,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ToolkitError);
    expect((error as ToolkitError).exit).toBe(EXIT.PRECONDITION);
    expect((error as ToolkitError).field).toBe(LOCK_FILE);
    expect((error as Error).message).toMatch(/pid 777/);
  });
});
