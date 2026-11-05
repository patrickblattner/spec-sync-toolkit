/**
 * The gate mutex (spec §7.1, `DECISION (gate-mutex)`): parallel agents queue for
 * the gate instead of saturating the box, and a lock whose holder is gone is
 * taken over rather than waited on.
 */

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { LOCK_FILE, acquireGateLock, readLock } from "../src/gate/lock.js";
import { LOCK_DEADLINE_EXIT, ToolkitError } from "../src/output.js";
import { LOCK_EXPIRED } from "../src/gate/holder.js";

const repo = (): string => {
  const root = mkdtempSync(join(tmpdir(), "spec-sync-lock-"));
  mkdirSync(join(root, ".spec-sync"));
  return root;
};
const fast = { pollMs: 5, repository: "o/r" };

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

  it("writes the PROC-REL-040 holder line next to pid and startedAt", async () => {
    const root = repo();
    const lock = await acquireGateLock(root, {
      ...fast,
      pid: 4343,
      repository: "o/r",
      run: "run-7",
      cap: 50,
    });
    const holder = readLock(join(root, LOCK_FILE));
    // What a 0.36 reader reads stays where it was.
    expect(holder?.pid).toBe(4343);
    expect(holder?.startedAt).toMatch(/Z$/);
    expect(holder?.holder).toBe(`repository=o/r run=run-7 started=${holder?.startedAt} cap=50`);
    lock.release();
  });

  it("prints one waiter line naming the holder instead of waiting silently (#31)", async () => {
    const root = repo();
    const first = await acquireGateLock(root, { ...fast, pid: 777, repository: "o/r", run: "a" });
    const lines: string[] = [];
    const second = acquireGateLock(root, {
      ...fast,
      pid: 778,
      isAlive: () => true,
      log: (line) => lines.push(line),
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    first.release();
    const lock = await second;

    // Polled every 5 ms for 50 ms, yet one line: the waiter prints once a minute.
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(
      /^gate\.lock: waiting 0m00s — gate\.lock pid 777: repository=o\/r run=a started=\S+Z cap=50$/,
    );
    expect(lock.waitedBehind).toEqual([expect.stringMatching(/^repository=o\/r run=a /)]);
    lock.release();
  });

  it("ends with exit 75 naming the holder once it outlived its cap — not exit 4 after 30 min", async () => {
    const root = repo();
    const started = new Date(Date.now() - 7 * 60_000).toISOString();
    writeFileSync(
      join(root, LOCK_FILE),
      `${JSON.stringify({ pid: 777, startedAt: started, holder: `repository=o/r run=hung started=${started} cap=1` })}\n`,
    );
    const error = await acquireGateLock(root, { ...fast, pid: 778, isAlive: () => true }).catch(
      (e: unknown) => e,
    );

    expect(error).toBeInstanceOf(ToolkitError);
    expect((error as ToolkitError).exit).toBe(LOCK_DEADLINE_EXIT);
    expect((error as ToolkitError).reason).toBe(LOCK_EXPIRED);
    expect((error as Error).message).toMatch(/run=hung .*outlived its cap .*look at that holder/);
  });

  it("reads a 0.36 lock without a holder line: printed raw, 40 min from its startedAt", async () => {
    const root = repo();
    const started = new Date(Date.now() - 41 * 60_000).toISOString();
    writeFileSync(join(root, LOCK_FILE), `${JSON.stringify({ pid: 777, startedAt: started })}\n`);
    const error = await acquireGateLock(root, { ...fast, pid: 778, isAlive: () => true }).catch(
      (e: unknown) => e,
    );

    expect((error as ToolkitError).exit).toBe(LOCK_DEADLINE_EXIT);
    expect((error as Error).message).toContain("holder line unreadable, 40 min fallback");
    expect((error as Error).message).toContain(`\\"startedAt\\":\\"${started}\\"`);
  });
});
