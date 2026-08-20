import { describe, expect, it } from "vitest";
import {
  NORM_DEFAULTS,
  PINNED_NORM_PROJECT,
  PINNED_NORM_SPECS,
  checkNormDrift,
  loadNorms,
  parsePins,
  type PinsReader,
} from "../src/norms.js";

describe("norm fallback (spec §6, transitional state)", () => {
  it("serves the defaults transcribed from the PROC-DEV-015 subtree", () => {
    expect(NORM_DEFAULTS).toEqual({
      sortTiers: ["auto-audit", "type: bug", "started-first", "phase-asc", "issue-number-asc"],
      hold: "owner-hold",
      buildLabel: "spec-sync",
      startedLabel: "status: in-progress",
      mergeModel: "local-squash-single-push",
    });
  });

  it("declares the defaults as its source and carries the pinned specs", () => {
    const loaded = loadNorms();
    expect(loaded.source).toBe("defaults");
    expect(loaded.pinnedSpecs).toEqual(PINNED_NORM_SPECS);
    expect(loaded.norms).toEqual(NORM_DEFAULTS);
  });

  it("hands out a copy, so a caller cannot mutate the defaults", () => {
    loadNorms().norms.sortTiers.push("nonsense");
    expect(NORM_DEFAULTS.sortTiers).toHaveLength(5);
  });

  it("pins the four foundation specs SST-DESIGN-015 names", () => {
    expect(PINNED_NORM_SPECS.map((spec) => spec.key)).toEqual([
      "PROC-DEV-039",
      "PROC-DEV-010",
      "PROC-DEV-047",
      "PROC-DEV-044",
    ]);
    for (const spec of PINNED_NORM_SPECS) expect(spec.rev).toBeGreaterThan(0);
  });
});

describe("parsePins (SMCP-DESIGN-012, spec_pins response)", () => {
  it("reads `KEY=rev` lines into a map", () => {
    const pins = parsePins("PROC-DEV-010=3\nPROC-DEV-039=2\n\nGL-SEC-001=3");
    expect(pins.get("PROC-DEV-010")).toBe(3);
    expect(pins.get("PROC-DEV-039")).toBe(2);
    expect(pins.get("GL-SEC-001")).toBe(3);
    expect(pins.size).toBe(3);
  });

  it("skips unparsable lines instead of throwing", () => {
    expect(parsePins("not a pin line\nPROC-DEV-010=3").size).toBe(1);
  });
});

describe("revision drift against the pinned specs (spec §6, §7.7)", () => {
  const readerFor = (overrides: Record<string, number> = {}): PinsReader => {
    return async (project) => {
      expect(project).toBe(PINNED_NORM_PROJECT);
      const pins = new Map(PINNED_NORM_SPECS.map((spec) => [spec.key, spec.rev]));
      for (const [key, rev] of Object.entries(overrides)) pins.set(key, rev);
      return pins;
    };
  };

  it("reports no drift while every pinned revision still matches", async () => {
    const drift = await checkNormDrift(readerFor());
    expect(drift.drifted).toBe(false);
    expect(drift.moved).toEqual([]);
    expect(drift.unreachable).toBeUndefined();
  });

  it("reports drift once a pinned spec moved", async () => {
    const drift = await checkNormDrift(readerFor({ "PROC-DEV-039": 3 }));
    expect(drift.drifted).toBe(true);
    expect(drift.moved).toEqual([{ key: "PROC-DEV-039", pinnedRev: 2, currentRev: 3 }]);
  });

  it("reports one entry per moved spec", async () => {
    const drift = await checkNormDrift(readerFor({ "PROC-DEV-039": 3, "PROC-DEV-010": 4 }));
    expect(drift.moved.map((entry) => entry.key)).toEqual(["PROC-DEV-039", "PROC-DEV-010"]);
  });

  it("treats a vanished response as unreachable, not as drift", async () => {
    const drift = await checkNormDrift(async () => undefined);
    expect(drift.drifted).toBe(false);
    expect(drift.moved).toEqual([]);
    expect(drift.unreachable).toContain("spec_pins returned nothing");
  });

  it("treats an unreachable server as unreachable, not as drift", async () => {
    const drift = await checkNormDrift(async () => {
      throw new Error("spec-mcp unreachable at http://localhost:8787/mcp");
    });
    expect(drift.drifted).toBe(false);
    expect(drift.moved).toEqual([]);
    expect(drift.unreachable).toContain("unreachable");
  });
});
