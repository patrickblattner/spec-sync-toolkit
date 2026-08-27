/**
 * Drift coverage — the receipt ledger the repin gate checks (SST-ADR-011,
 * SST-DESIGN-029).
 *
 * `.spec-sync/drift-coverage.jsonl` is append-only and committed: one line per
 * receipt, written by `cover` at derivation time. A receipt covers exactly the
 * transition to its recorded `to`; a stale receipt (the server moved on) does
 * not count, so an unexamined diff can never slip through.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { EXIT, ToolkitError } from "./output.js";
import type { PinsMap } from "./pins.js";

export const COVERAGE_FILE = ".spec-sync/drift-coverage.jsonl";

export interface MovedEntry {
  key: string;
  /** Pinned revision; null when the key is new on the server. */
  from: number | null;
  /** Current server revision; null when the spec disappeared. */
  to: number | null;
}

/** Every key whose pinned and server revision differ — changed, added, removed. */
export function computeMoved(pinned: PinsMap, fetched: Map<string, number>): MovedEntry[] {
  const moved: MovedEntry[] = [];
  for (const [key, to] of fetched) {
    const from = pinned[key];
    if (from === undefined) moved.push({ key, from: null, to });
    else if (from !== to) moved.push({ key, from, to });
  }
  for (const [key, from] of Object.entries(pinned)) {
    if (!fetched.has(key)) moved.push({ key, from, to: null });
  }
  return moved.sort((a, b) => a.key.localeCompare(b.key));
}

export interface Receipt {
  ts: string;
  key: string;
  from: number | null;
  to: number | null;
  disposition: "ticket" | "editorial";
  /** Issue number (`ticket`) or the reason text (`editorial`). */
  ref: string;
}

/**
 * Reads the ledger. A malformed line surfaces as exit 4 instead of being
 * skipped — the file is machine-written, so damage means a hand edit and the
 * gate must not silently run against half a ledger.
 */
export function readReceipts(repoRoot: string): Receipt[] {
  const path = join(repoRoot, COVERAGE_FILE);
  if (!existsSync(path)) return [];
  const receipts: Receipt[] = [];
  readFileSync(path, "utf8")
    .split("\n")
    .forEach((line, index) => {
      if (line.trim() === "") return;
      try {
        receipts.push(JSON.parse(line) as Receipt);
      } catch {
        throw new ToolkitError(
          `${COVERAGE_FILE}:${index + 1} is not valid JSON — fix or remove the line by hand`,
          EXIT.PRECONDITION,
          { field: COVERAGE_FILE },
        );
      }
    });
  return receipts;
}

/** A receipt counts only for the exact target revision (SST-DESIGN-029 §Matching). */
export function isCovered(entry: MovedEntry, receipts: Receipt[]): boolean {
  return receipts.some((receipt) => receipt.key === entry.key && receipt.to === entry.to);
}

export function appendReceipts(repoRoot: string, receipts: Receipt[]): void {
  const path = join(repoRoot, COVERAGE_FILE);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, receipts.map((receipt) => `${JSON.stringify(receipt)}\n`).join(""), "utf8");
}
