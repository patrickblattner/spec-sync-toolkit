/**
 * `spec-pins.json` — the pin file `repin` writes (SST-DESIGN-025).
 *
 * Format is the compact `{key: rev}` map `spec_pins` itself uses — no wrapper
 * (no `schema`, `sources`, `entries`; that was the v1 `spec.lock.json` shape).
 * Its content never passes through a model context: `repin` reads it from the
 * server and writes it straight to disk.
 */

import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const PINS_FILE = "spec-pins.json";

export type PinsMap = Record<string, number>;

/** Reads `spec-pins.json`. `undefined` when absent or not a `{key: rev}` object. */
export function readPinsFile(repoRoot: string): PinsMap | undefined {
  const path = join(repoRoot, PINS_FILE);
  if (!existsSync(path)) return undefined;
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined;
    const entries = Object.entries(parsed as Record<string, unknown>);
    if (!entries.every(([, value]) => typeof value === "number")) return undefined;
    return Object.fromEntries(entries) as PinsMap;
  } catch {
    return undefined;
  }
}

/**
 * Writes `spec-pins.json` atomically (write-then-rename) and with sorted keys,
 * so an untouched pin file is byte-identical across `repin` runs — the
 * `--ids` mode's promise (SST-DESIGN-025).
 */
export function writePinsFile(repoRoot: string, pins: PinsMap): void {
  const path = join(repoRoot, PINS_FILE);
  const sorted = Object.fromEntries(
    Object.keys(pins)
      .sort()
      .map((key) => [key, pins[key]]),
  );
  const tmp = `${path}.tmp-${process.pid}`;
  writeFileSync(tmp, `${JSON.stringify(sorted, null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}
