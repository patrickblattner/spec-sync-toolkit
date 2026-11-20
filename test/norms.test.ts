import { describe, expect, it } from "vitest";
import { NORM_DEFAULTS, loadNorms, parsePins } from "../src/norms.js";

describe("norm defaults (SST-DESIGN-015 rev 5)", () => {
  it("serves the built-in defaults", () => {
    expect(NORM_DEFAULTS).toEqual({
      sortTiers: ["auto-audit", "type: bug", "started-first", "phase-asc", "issue-number-asc"],
      hold: "owner-hold",
      deferred: "status: deferred",
      buildLabel: "spec-sync",
      startedLabel: "status: in-progress",
      mergeModel: "local-squash-single-push",
    });
  });

  it("declares the defaults as its source and carries no pinned norm specs", () => {
    const loaded = loadNorms();
    expect(loaded).toEqual({ norms: NORM_DEFAULTS, source: "defaults" });
  });

  it("hands out a copy, so a caller cannot mutate the defaults", () => {
    loadNorms().norms.sortTiers.push("nonsense");
    expect(NORM_DEFAULTS.sortTiers).toHaveLength(5);
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
