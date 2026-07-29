import { describe, expect, it } from "vitest";
import {
  NORM_DEFAULTS,
  PINNED_NORM_SECTION,
  checkNormDrift,
  loadNorms,
  type SectionHashReader,
} from "../src/norms.js";

describe("norm fallback (spec §6, transitional state)", () => {
  it("serves the defaults transcribed from foundation.dev.process §Worker-Loop", () => {
    expect(NORM_DEFAULTS).toEqual({
      sortTiers: ["auto-audit", "type: bug", "started-first", "phase-asc", "issue-number-asc"],
      hold: "owner-hold",
      buildLabel: "spec-sync",
      startedLabel: "status: in-progress",
      mergeModel: "local-squash-single-push",
    });
  });

  it("declares the defaults as its source and carries the pinned hash", () => {
    const loaded = loadNorms();
    expect(loaded.source).toBe("defaults");
    expect(loaded.pinnedHash).toBe(PINNED_NORM_SECTION.hash);
    expect(loaded.norms).toEqual(NORM_DEFAULTS);
  });

  it("hands out a copy, so a caller cannot mutate the defaults", () => {
    loadNorms().norms.sortTiers.push("nonsense");
    expect(NORM_DEFAULTS.sortTiers).toHaveLength(5);
  });

  it("pins the section the defaults were read from", () => {
    expect(PINNED_NORM_SECTION.unit).toBe("foundation.dev.process");
    expect(PINNED_NORM_SECTION.section).toMatch(/worker-loop-spec-sync$/);
    expect(PINNED_NORM_SECTION.hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("hash drift against the pinned section (spec §6, §7.7)", () => {
  const readerFor = (hash: string | undefined): SectionHashReader => {
    return async (unit, section) => {
      expect(unit).toBe(PINNED_NORM_SECTION.unit);
      expect(section).toBe(PINNED_NORM_SECTION.section);
      return hash;
    };
  };

  it("reports no drift while the hash matches", async () => {
    const drift = await checkNormDrift(readerFor(PINNED_NORM_SECTION.hash));
    expect(drift.drifted).toBe(false);
    expect(drift.currentHash).toBe(PINNED_NORM_SECTION.hash);
    expect(drift.unreachable).toBeUndefined();
  });

  it("reports drift once the section moved", async () => {
    const moved = "a".repeat(64);
    const drift = await checkNormDrift(readerFor(moved));
    expect(drift.drifted).toBe(true);
    expect(drift.currentHash).toBe(moved);
    expect(drift.pinnedHash).toBe(PINNED_NORM_SECTION.hash);
  });

  it("treats a vanished section as unreachable, not as drift", async () => {
    const drift = await checkNormDrift(readerFor(undefined));
    expect(drift.drifted).toBe(false);
    expect(drift.unreachable).toContain("section not found");
  });

  it("treats an unreachable server as unreachable, not as drift", async () => {
    const drift = await checkNormDrift(async () => {
      throw new Error("spec-mcp unreachable at http://localhost:8787/mcp");
    });
    expect(drift.drifted).toBe(false);
    expect(drift.currentHash).toBeUndefined();
    expect(drift.unreachable).toContain("unreachable");
  });
});
