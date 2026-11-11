import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../src/config.js";
import { decideFastLane, isProductPath } from "../src/review/fastlane.js";

/** The default product-path definition of the fast lane (train 2026-11-15, Fable B4). */

function config(extra: Record<string, unknown> = {}): Config {
  const root = mkdtempSync(join(tmpdir(), "spec-sync-fastlane-"));
  writeFileSync(
    join(root, "spec-sync.config.json"),
    JSON.stringify({
      project: "demo",
      gate: { profiles: { local: ["lint"] }, phases: [{ name: "lint", cmd: "true" }] },
      ...extra,
    }),
  );
  return loadConfig(root);
}

describe("fast lane product paths (defaults)", () => {
  const c = config({ review: { riskGlobs: { security: ["scripts/release.ts"] } } });
  const product = (file: string): boolean => isProductPath(file, c.fastLane, c.review.riskGlobs);

  it("treats tests, CI config, scripts and root tooling config as non-product", () => {
    for (const file of [
      "client/src/Table.test.tsx",
      "server/src/__tests__/a.ts",
      "test/fixtures/x.json",
      "e2e/login.spec.ts",
      ".github/workflows/ci.yml",
      "scripts/check.mjs",
      "vitest.config.ts",
      "spec-pins.json",
    ]) {
      expect(product(file), file).toBe(false);
    }
  });

  it("treats source, nested build config, manifests and risk paths as product", () => {
    for (const file of [
      "src/index.ts",
      "client/vite.config.ts",
      "package.json",
      "scripts/package.json",
      "package-lock.json",
      "scripts/release.ts",
      "README.md",
    ]) {
      expect(product(file), file).toBe(true);
    }
  });

  it("an empty toolingGlobs makes every file a product path", () => {
    const off = config({ fastLane: { toolingGlobs: [] } });
    expect(isProductPath("test/a.test.ts", off.fastLane, {})).toBe(true);
  });

  it("decides on fewer than maxLines, never on equal", () => {
    const entry = (lines: number) => [{ file: "test/a.test.ts", lines, binary: false }];
    expect(decideFastLane(entry(29), c.fastLane, {}).fast).toBe(true);
    expect(decideFastLane(entry(30), c.fastLane, {}).fast).toBe(false);
    const wider = config({ fastLane: { maxLines: 50 } });
    expect(decideFastLane(entry(49), wider.fastLane, {}).fast).toBe(true);
  });
});
