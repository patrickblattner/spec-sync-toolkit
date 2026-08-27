import { describe, expect, it } from "vitest";
import { parseSpecReferences } from "../src/pack/refs.js";
import { extractAcceptance, readMachineBlock, renderPack } from "../src/pack/render.js";

describe("parseSpecReferences (spec §7.3, v2 key model, SST-DESIGN-018)", () => {
  it("reads backticked, key-shaped tokens as references", () => {
    expect(parseSpecReferences("See `PROC-DEV-039` and `GL-SEC-010`.")).toEqual([
      "PROC-DEV-039",
      "GL-SEC-010",
    ]);
  });

  it("matches two-segment and three-segment keys alike", () => {
    expect(parseSpecReferences("`VISION-001`, `PROC-010`, `ADR-CC-001`, `SST-DESIGN-018`")).toEqual(
      ["VISION-001", "PROC-010", "ADR-CC-001", "SST-DESIGN-018"],
    );
  });

  it("does not mistake file paths or file names for keys", () => {
    expect(
      parseSpecReferences("See `e2e/a11y.spec.ts`, `spec-pins.json`, `package-lock.json`."),
    ).toEqual([]);
  });

  it("does not mistake a lower-case or otherwise unshaped backticked token for a key", () => {
    expect(parseSpecReferences("`main`, `loadConfig`, `v3.2.1`, `M3`")).toEqual([]);
  });

  it("ignores a key-shaped token loose in prose, outside backticks", () => {
    expect(parseSpecReferences("See PROC-DEV-039 without backticks.")).toEqual([]);
  });

  it("drops the duplicate when a key is named twice", () => {
    expect(parseSpecReferences("`PROC-DEV-039` … again `PROC-DEV-039`.")).toEqual(["PROC-DEV-039"]);
  });
});

describe("extractAcceptance", () => {
  // Deliberately a German heading: `extractAcceptance`'s regex accepts both
  // "abnahmekriterien" and "acceptance criteria" (see src/pack/render.ts),
  // because it matches ticket bodies authored by others — external data, not
  // toolkit output — and those may still be in German.
  it("takes the acceptance block up to the next heading of the same level", () => {
    const body = [
      "## Befund",
      "Etwas ist kaputt.",
      "",
      "## Abnahmekriterien",
      "",
      "1. Erste Bedingung",
      "2. Zweite Bedingung",
      "",
      "## Spec-Bezug",
      "`PROC-DEV-039`",
    ].join("\n");
    expect(extractAcceptance(body)).toBe("1. Erste Bedingung\n2. Zweite Bedingung");
  });

  it("is undefined when the issue names no acceptance block", () => {
    expect(extractAcceptance("## Finding\nJust prose.")).toBeUndefined();
  });
});

describe("the machine block round-trips", () => {
  it("reads back the file set a later pack compares against", () => {
    const markdown = renderPack({
      issue: { number: 142, title: "T", body: "B", labels: ["spec-sync"] },
      specs: [],
      candidates: [{ path: "src/a.ts", via: "impact: a" }],
      gate: { command: "spec-sync gate --profile local", profile: "local", phases: [] },
      overlaps: [],
      notes: [],
      generatedAt: "2026-07-26T10:00:00.000Z",
    });
    expect(readMachineBlock(markdown)).toMatchObject({ issue: 142, files: ["src/a.ts"] });
  });

  it("treats a file without a machine block as no pack at all", () => {
    expect(readMachineBlock("# hand-written\n")).toBeUndefined();
  });
});
