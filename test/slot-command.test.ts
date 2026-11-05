/**
 * `slot run` / `slot status` (PROC-REL-060): a heavy step outside the gate runs
 * under a box slot and its cap; its exit code passes through, 124 at the cap,
 * 75 on an expired wait.
 */

import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { parseArgv, type CommandContext } from "../src/cli.js";
import { CAP_EXIT, runSlot } from "../src/commands/slot.js";
import { BOX_DIR_ENV } from "../src/gate/slots.js";
import { EXIT, LOCK_DEADLINE_EXIT, ToolkitError } from "../src/output.js";

let box: string;
let root: string;
beforeEach(() => {
  box = mkdtempSync(join(tmpdir(), "spec-sync-slot-box-"));
  root = mkdtempSync(join(tmpdir(), "spec-sync-slot-repo-"));
  process.env[BOX_DIR_ENV] = box;
});

const ctx = (args: string[]): CommandContext => ({
  flags: { human: false, dryRun: false },
  args,
  repoRoot: root,
});

describe("slot run", () => {
  it("runs the command under a slot and passes its exit code through", async () => {
    const result = await runSlot(
      ctx(["run", "--step", "gallery", "--cap", "1", "--", "sh", "-c", "touch ran; exit 3"]),
    );

    expect(existsSync(join(root, "ran"))).toBe(true);
    expect(result.ok).toBe(false);
    expect(result.exit).toBe(3);
    expect(result.data).toMatchObject({ step: "gallery", slot: "slot-1", cap: 1, code: 3 });
    expect(existsSync(join(box, "slot-1.lock"))).toBe(false);
  });

  it("answers a green command with exit 0", async () => {
    const result = await runSlot(ctx(["run", "--step", "s", "--cap", "1", "--", "true"]));
    expect(result).toMatchObject({ ok: true, exit: EXIT.OK });
  });

  it("kills the command at its cap and ends red with 124", async () => {
    const started = Date.now();
    const result = await runSlot(
      ctx(["run", "--step", "slow", "--cap", "1", "--", "sh", "-c", "sleep 5; touch late"]),
      { minuteMs: 200 },
    );

    expect(Date.now() - started).toBeLessThan(3_000);
    expect(result.exit).toBe(CAP_EXIT);
    expect(result.notes?.join("\n")).toContain("reached its cap of 1 min");
    expect(existsSync(join(box, "slot-1.lock"))).toBe(false);
  });

  it("ends with 75 and runs nothing when the wait expires", async () => {
    const old = new Date(Date.now() - 60 * 60_000).toISOString();
    for (const n of [1, 2]) {
      writeFileSync(
        join(box, `slot-${n}.lock`),
        `${JSON.stringify({ pid: process.pid, startedAt: old, holder: `repository=o/r run=h${n} started=${old} cap=10` })}\n`,
      );
    }
    const error = await runSlot(
      ctx(["run", "--step", "s", "--cap", "1", "--", "sh", "-c", "touch ran"]),
    ).catch((e: unknown) => e);

    expect((error as ToolkitError).exit).toBe(LOCK_DEADLINE_EXIT);
    expect((error as Error).message).toMatch(/run=h1 .*look at that holder/);
    expect(existsSync(join(root, "ran"))).toBe(false);
  });

  it("refuses a step without a cap — no locked step runs without one", async () => {
    const error = await runSlot(ctx(["run", "--step", "s", "--", "true"])).catch((e: unknown) => e);
    expect((error as ToolkitError).exit).toBe(EXIT.PRECONDITION);
    expect((error as ToolkitError).field).toBe("--cap");
  });

  it("leaves the wrapped command's own flags to it (args behind --)", () => {
    const parsed = parseArgv([
      "slot",
      "run",
      "--step",
      "s",
      "--",
      "node",
      "--repo",
      "x",
      "--human",
    ]);
    expect(parsed.flags).toEqual({ human: false, dryRun: false });
    expect(parsed.args).toEqual(["run", "--step", "s", "--", "node", "--repo", "x", "--human"]);
  });
});

describe("slot status", () => {
  it("names the holders and the last waits", async () => {
    await runSlot(ctx(["run", "--step", "s", "--cap", "1", "--", "true"]));
    writeFileSync(
      join(box, "slot-2.lock"),
      `${JSON.stringify({ pid: process.pid, startedAt: "", holder: "repository=o/r run=x started=2026-11-05T10:00:00.000Z cap=35", step: "gallery" })}\n`,
    );

    const result = await runSlot(ctx(["status", "--last", "1"]));

    expect(result.data?.slots).toEqual([
      { slot: "slot-1", free: true },
      {
        slot: "slot-2",
        free: false,
        pid: process.pid,
        alive: true,
        step: "gallery",
        holder: "repository=o/r run=x started=2026-11-05T10:00:00.000Z cap=35",
      },
    ]);
    expect(result.data?.waits).toEqual([
      expect.objectContaining({ step: "s", outcome: "acquired" }),
    ]);
  });
});
