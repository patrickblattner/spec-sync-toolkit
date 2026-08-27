import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  COVERAGE_FILE,
  appendReceipts,
  computeMoved,
  isCovered,
  readReceipts,
  type Receipt,
} from "../src/coverage.js";
import { ToolkitError } from "../src/output.js";

const receipt = (overrides: Partial<Receipt>): Receipt => ({
  ts: "2026-08-27T00:00:00.000Z",
  key: "A",
  from: 1,
  to: 2,
  disposition: "ticket",
  ref: "16",
  ...overrides,
});

describe("computeMoved (SST-DESIGN-028)", () => {
  it("names changed, added and removed keys, sorted, and skips unchanged ones", () => {
    const moved = computeMoved(
      { A: 1, B: 2, D: 4 },
      new Map([
        ["A", 3],
        ["B", 2],
        ["C", 1],
      ]),
    );
    expect(moved).toEqual([
      { key: "A", from: 1, to: 3 },
      { key: "C", from: null, to: 1 },
      { key: "D", from: 4, to: null },
    ]);
  });

  it("returns an empty list when nothing moved", () => {
    expect(computeMoved({ A: 1 }, new Map([["A", 1]]))).toEqual([]);
  });
});

describe("isCovered (SST-DESIGN-029 §Matching)", () => {
  it("counts a receipt only for the exact target revision", () => {
    const receipts = [receipt({ key: "A", to: 2 })];
    expect(isCovered({ key: "A", from: 1, to: 2 }, receipts)).toBe(true);
    // Stale: the server moved on to rev 3 after the receipt was written.
    expect(isCovered({ key: "A", from: 1, to: 3 }, receipts)).toBe(false);
    expect(isCovered({ key: "B", from: 1, to: 2 }, receipts)).toBe(false);
  });

  it("matches a removal receipt (`to: null`) for a removed key", () => {
    const receipts = [receipt({ key: "A", to: null })];
    expect(isCovered({ key: "A", from: 2, to: null }, receipts)).toBe(true);
  });
});

describe("coverage ledger file", () => {
  it("appendReceipts creates the directory and appends one JSON line per receipt", () => {
    const repo = mkdtempSync(join(tmpdir(), "coverage-"));
    appendReceipts(repo, [receipt({ key: "A" })]);
    appendReceipts(repo, [receipt({ key: "B", disposition: "editorial", ref: "no code effect" })]);

    const lines = readFileSync(join(repo, COVERAGE_FILE), "utf8").trim().split("\n");
    expect(lines).toHaveLength(2);
    expect(readReceipts(repo).map((r) => r.key)).toEqual(["A", "B"]);
  });

  it("readReceipts returns [] for a missing ledger", () => {
    const repo = mkdtempSync(join(tmpdir(), "coverage-"));
    expect(readReceipts(repo)).toEqual([]);
  });

  it("readReceipts surfaces a malformed line as exit 4 instead of skipping it", () => {
    const repo = mkdtempSync(join(tmpdir(), "coverage-"));
    mkdirSync(join(repo, ".spec-sync"), { recursive: true });
    writeFileSync(join(repo, COVERAGE_FILE), '{"ok": true}\nnot json\n');
    expect(() => readReceipts(repo)).toThrowError(ToolkitError);
  });
});
