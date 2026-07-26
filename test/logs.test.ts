import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_LOG_RETENTION,
  STATE_DIR,
  createLogDir,
  firstError,
  logDirName,
  protectedLogDirs,
  pruneLogs,
  writePhaseLog,
} from "../src/logs.js";

describe("log placement (spec §3, logs-never-stdout)", () => {
  it("names the directory after the ISO timestamp, path-safe", () => {
    expect(logDirName(new Date("2026-07-26T15:04:11.482Z"))).toBe("2026-07-26T15-04-11Z");
  });

  it("creates .spec-sync/logs/<timestamp>/ and returns the repo-relative path", () => {
    const root = mkdtempSync(join(tmpdir(), "spec-sync-logs-"));
    const logDir = createLogDir(root, { at: new Date("2026-07-26T15:04:11.000Z") });
    expect(logDir).toBe(join(STATE_DIR, "logs", "2026-07-26T15-04-11Z"));
    expect(existsSync(join(root, logDir))).toBe(true);
  });

  it("writes one file per phase inside that directory", () => {
    const root = mkdtempSync(join(tmpdir(), "spec-sync-logs-"));
    const logDir = createLogDir(root);
    const file = writePhaseLog(root, logDir, "e2e-touched", "full playwright output\n");
    expect(file).toBe(join(logDir, "e2e-touched.log"));
    expect(readFileSync(join(root, file), "utf8")).toBe("full playwright output\n");
  });

  it("keeps a phase name with slashes from escaping the log directory", () => {
    const root = mkdtempSync(join(tmpdir(), "spec-sync-logs-"));
    const logDir = createLogDir(root);
    const file = writePhaseLog(root, logDir, "../escape", "x");
    expect(file).toBe(join(logDir, "---escape.log"));
    expect(existsSync(join(root, file))).toBe(true);
  });
});

describe("log retention (spec §3, logs-pruned-on-write)", () => {
  const locked: string[] = [];
  afterEach(() => {
    // Give the mode back, or the temp directory outlives the run.
    for (const path of locked.splice(0)) chmodSync(path, 0o700);
  });

  /** A run directory name at `15:04:<second>` — the shape `logDirName` produces. */
  function stamp(second: number): string {
    return `2026-07-26T15-04-${String(second).padStart(2, "0")}Z`;
  }

  function repoWithRuns(names: readonly string[]): string {
    const root = mkdtempSync(join(tmpdir(), "spec-sync-prune-"));
    for (const name of names) mkdirSync(join(root, STATE_DIR, "logs", name), { recursive: true });
    return root;
  }

  function runsIn(root: string): string[] {
    return readdirSync(join(root, STATE_DIR, "logs")).sort();
  }

  it("drops the oldest runs until logRetention are left, keeping the new one", () => {
    // Created newest-name-first, so the oldest name carries the newest mtime:
    // whatever gets deleted here, it was not chosen by mtime.
    const root = repoWithRuns([stamp(4), stamp(3), stamp(2), stamp(1), stamp(0)]);

    createLogDir(root, { at: new Date("2026-07-26T15:04:09.000Z"), retention: 3 });

    expect(runsIn(root)).toEqual([stamp(3), stamp(4), stamp(9)]);
  });

  it("keeps 20 runs when no retention is given", () => {
    const names = Array.from({ length: 25 }, (_, index) => stamp(index));
    const root = repoWithRuns(names);

    createLogDir(root, { at: new Date("2026-07-26T15:04:59.000Z") });

    expect(runsIn(root)).toHaveLength(DEFAULT_LOG_RETENTION);
    expect(runsIn(root)).toContain("2026-07-26T15-04-59Z");
    expect(runsIn(root)).not.toContain(stamp(0));
  });

  it("spares the run of a merge that started and never completed", () => {
    const root = repoWithRuns([stamp(0), stamp(1), stamp(2)]);
    const events = [
      { at: "t0", type: "gate", issue: 7, logDir: join(STATE_DIR, "logs", stamp(0)) },
      { at: "t1", type: "merge-started", issue: 7 },
      { at: "t2", type: "gate", issue: 8, logDir: join(STATE_DIR, "logs", stamp(1)) },
      { at: "t3", type: "merge-started", issue: 8 },
      { at: "t4", type: "merge-completed", issue: 8 },
    ];

    createLogDir(root, {
      at: new Date("2026-07-26T15:04:09.000Z"),
      retention: 1,
      keep: protectedLogDirs(events),
    });

    // #7 is unfinished, so its run stays although it is the oldest of them all;
    // #8 merged through and its run goes.
    expect(runsIn(root)).toEqual([stamp(0), stamp(9)]);
  });

  it("lets the run continue when a directory cannot be deleted", () => {
    const root = repoWithRuns([stamp(0), stamp(1)]);
    const stubborn = join(root, STATE_DIR, "logs", stamp(0));
    writePhaseLog(root, join(STATE_DIR, "logs", stamp(0)), "unit", "held open\n");
    chmodSync(stubborn, 0o000);
    locked.push(stubborn);

    expect(() =>
      createLogDir(root, { at: new Date("2026-07-26T15:04:09.000Z"), retention: 1 }),
    ).not.toThrow();

    // The undeletable one is skipped rather than retried into a younger run:
    // #1 goes, the new run is there, and the limit is missed by exactly the
    // directory that would not go.
    expect(runsIn(root)).toEqual([stamp(0), stamp(9)]);
  });

  it("never touches anything that is not a run directory", () => {
    const root = repoWithRuns([stamp(0), stamp(1), "scratch"]);
    writePhaseLog(root, join(STATE_DIR, "logs"), "notes", "someone else's file\n");

    pruneLogs(root, { retention: 1 });

    expect(runsIn(root)).toEqual([stamp(1), "notes.log", "scratch"].sort());
  });
});

describe("firstError (spec §3: at most 3 lines, truncated with …)", () => {
  it("starts at the first error line and stops after three", () => {
    const output = [
      "> npm run lint",
      "checked 120 files",
      "Error: 'foo' is defined but never used",
      "  at src/a.ts:12",
      "  at src/b.ts:44",
      "  at src/c.ts:8",
    ].join("\n");
    const result = firstError(output);
    expect(result?.split("\n").filter((line) => line !== "…")).toHaveLength(3);
    expect(result?.startsWith("Error: 'foo' is defined but never used")).toBe(true);
    expect(result?.endsWith("…")).toBe(true);
  });

  it("returns exactly the error when it fits", () => {
    expect(firstError("Error: boom")).toBe("Error: boom");
  });

  it("falls back to the last lines when nothing looks like an error", () => {
    expect(firstError("a\nb\nc\nd\ne")).toBe("c\nd\ne\n…");
  });

  it("returns undefined for empty output", () => {
    expect(firstError("   \n\n")).toBeUndefined();
  });

  it("truncates an over-long line", () => {
    const result = firstError(`Error: ${"x".repeat(400)}`);
    expect(result).toHaveLength(200);
    expect(result?.endsWith("…")).toBe(true);
  });
});
