/**
 * Fast lane (train 2026-11-15, Fable B4): a small diff that touches no product
 * path gets no review lens and no Codex pass. It never skips the gate — the
 * lane only decides what is spawned NEXT TO the gate.
 *
 * Mechanical, like the triage: changed lines from `git diff --numstat`, product
 * paths from globs. A binary file cannot be measured in lines and keeps the
 * diff out of the lane. Pure — the git reads live in the commands.
 */

import picomatch from "picomatch";
import type { FastLaneConfig } from "../config.js";
import { riskAreas, type NumstatEntry } from "./triage.js";

export interface FastLaneDecision {
  /** True: no review lens, no Codex pass; the gate still runs. */
  fast: boolean;
  /** Changed lines of the whole diff (added plus deleted). */
  lines: number;
  maxLines: number;
  /** Changed files that are product paths. */
  productFiles: string[];
  reason: string;
}

/** Is a file a product path? Risk areas and `productGlobs` always are. */
export function isProductPath(
  file: string,
  lane: FastLaneConfig,
  riskGlobs: Record<string, string[]>,
): boolean {
  if (riskAreas([file], riskGlobs).length > 0) return true;
  if (lane.productGlobs.length > 0 && picomatch.isMatch(file, lane.productGlobs)) return true;
  return lane.toolingGlobs.length === 0 || !picomatch.isMatch(file, lane.toolingGlobs);
}

export function decideFastLane(
  entries: readonly NumstatEntry[],
  lane: FastLaneConfig,
  riskGlobs: Record<string, string[]>,
): FastLaneDecision {
  const lines = entries.reduce((sum, entry) => sum + entry.lines, 0);
  const productFiles = entries
    .map((entry) => entry.file)
    .filter((file) => isProductPath(file, lane, riskGlobs));
  const base = { lines, maxLines: lane.maxLines, productFiles };
  const no = (reason: string): FastLaneDecision => ({ ...base, fast: false, reason });

  if (lane.maxLines === 0) return no("fast lane off (fastLane.maxLines 0)");
  if (entries.length === 0) return no("empty diff");
  const binary = entries.find((entry) => entry.binary);
  if (binary !== undefined) return no(`binary file ${binary.file} cannot be measured in lines`);
  if (productFiles.length > 0) {
    return no(`touches product path ${productFiles.slice(0, 3).join(", ")}`);
  }
  if (lines >= lane.maxLines)
    return no(`${lines} changed lines, the lane takes < ${lane.maxLines}`);
  return {
    ...base,
    fast: true,
    reason: `${lines} changed lines in tests, CI and tooling only — no review lens, no Codex pass; the gate still runs`,
  };
}
