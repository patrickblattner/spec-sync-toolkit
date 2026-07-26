import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { STATE_DIR, createLogDir, firstError, logDirName, writePhaseLog } from "../src/logs.js";

describe("log placement (spec §3, logs-never-stdout)", () => {
  it("names the directory after the ISO timestamp, path-safe", () => {
    expect(logDirName(new Date("2026-07-26T15:04:11.482Z"))).toBe("2026-07-26T15-04-11Z");
  });

  it("creates .spec-sync/logs/<timestamp>/ and returns the repo-relative path", () => {
    const root = mkdtempSync(join(tmpdir(), "spec-sync-logs-"));
    const logDir = createLogDir(root, new Date("2026-07-26T15:04:11.000Z"));
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
