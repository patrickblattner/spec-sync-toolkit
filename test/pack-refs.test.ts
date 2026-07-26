import { describe, expect, it } from "vitest";
import { cleanSectionName, parseSpecReferences } from "../src/pack/refs.js";
import { matchSection, slugify } from "../src/pack/spec.js";
import { extractAcceptance, readMachineBlock, renderPack } from "../src/pack/render.js";

/** Sections in the shape `resolve_effective_spec` returns them. */
const sections = [
  {
    slug: "worker-loop-spec-sync",
    path: "entwicklungs-workflow/worker-loop-spec-sync",
    heading: "Worker-Loop (/spec-sync)",
    level: 2,
    content: "## Worker-Loop (/spec-sync)\n\nWorker holen ihre Arbeit selbst.",
  },
  {
    slug: "label-taxonomie",
    path: "entwicklungs-workflow/label-taxonomie",
    heading: "Label-Taxonomie",
    level: 2,
    content: "## Label-Taxonomie\n\n`owner-hold` schlägt alles.",
  },
  {
    slug: "73-pack",
    path: "build-spec/7-befehle/73-pack",
    heading: "7.3 `pack`",
    level: 3,
    content: "### 7.3 `pack`\n\nErzeugt das Wissenspaket.",
  },
  {
    slug: "qualitäts-wächter-foundation-kanon--pflicht",
    path: "qualitäts-wächter-foundation-kanon--pflicht",
    heading: "Qualitäts-Wächter (Foundation-Kanon — Pflicht)",
    level: 2,
    content: "## Qualitäts-Wächter\n\nAda prüft.",
  },
];

describe("parseSpecReferences (spec §7.3, ticket shape)", () => {
  it("reads `unit` §section as the tickets write it", () => {
    const parsed = parseSpecReferences(
      "`foundation.dev.process` §Worker-Loop (Effort-Tabelle) und §Label-Taxonomie (`owner-hold`).",
    );
    expect(parsed.references).toEqual([
      { unit: "foundation.dev.process", section: "Worker-Loop" },
      { unit: "foundation.dev.process", section: "Label-Taxonomie" },
    ]);
    expect(parsed.bareUnits).toEqual([]);
  });

  it("keeps a version marker and an arrow path out of the unit id", () => {
    const parsed = parseSpecReferences(
      "**Quelle:** `community-platform.personas` **0.15.0** §Qualitäts-Wächter → Ada (Entscheid 2026-07-23).",
    );
    expect(parsed.references).toEqual([
      { unit: "community-platform.personas", section: "Qualitäts-Wächter → Ada" },
    ]);
  });

  it("attaches a later § to the unit named before it", () => {
    const parsed = parseSpecReferences(
      "`foundation.design.guideline` §Tabellen fordert schon heute Pfeil-Navigation.\n" +
        "Später im Text: §Formulare bleibt unberührt.",
    );
    expect(parsed.references.map((reference) => reference.unit)).toEqual([
      "foundation.design.guideline",
      "foundation.design.guideline",
    ]);
  });

  it("does not mistake file paths or file names for unit ids", () => {
    const parsed = parseSpecReferences(
      "Siehe `e2e/a11y.spec.ts`, `seedProfiles.ts:3124`, `package-lock.json` und `nightly.yml`.",
    );
    expect(parsed.references).toEqual([]);
    expect(parsed.bareUnits).toEqual([]);
  });

  it("reports a unit named without a section as a bare mention, not a reference", () => {
    const parsed = parseSpecReferences("Reine Doku-Angleichung an `foundation.dev.process`.");
    expect(parsed.references).toEqual([]);
    expect(parsed.bareUnits).toEqual(["foundation.dev.process"]);
  });

  it("attaches a leading § only when the ticket names exactly one unit", () => {
    const single = parseSpecReferences(
      "§Worker-Loop ist gemeint — siehe `foundation.dev.process`.",
    );
    expect(single.references).toEqual([
      { unit: "foundation.dev.process", section: "Worker-Loop ist gemeint" },
    ]);

    const several = parseSpecReferences(
      "§Worker-Loop — `foundation.dev.process` und `foundation.testing.guideline`.",
    );
    expect(several.references).toEqual([]);
    expect(several.danglingSections).toEqual(["Worker-Loop"]);
  });

  it("drops the duplicate when a section is named twice", () => {
    const parsed = parseSpecReferences(
      "`foundation.dev.process` §Worker-Loop … erneut `foundation.dev.process` §Worker-Loop.",
    );
    expect(parsed.references).toHaveLength(1);
  });
});

describe("cleanSectionName", () => {
  it("cuts at brackets, quotes, conjunctions and a second §", () => {
    expect(cleanSectionName("Worker-Loop (Effort-Tabelle)")).toBe("Worker-Loop");
    expect(cleanSectionName("Worker-Loop und §Label-Taxonomie")).toBe("Worker-Loop");
    expect(cleanSectionName("Worker-Loop / §Label-Taxonomie")).toBe("Worker-Loop");
    expect(cleanSectionName("CI-Betriebsmodus: typecheck · lint")).toBe("CI-Betriebsmodus");
  });

  it("carries prose along at most eight words — the resolver narrows it", () => {
    expect(
      cleanSectionName("Tabellen fordert schon heute für alle Zeilen die Pfeil-Navigation"),
    ).toBe("Tabellen fordert schon heute für alle Zeilen die");
  });
});

describe("matchSection (heading in the ticket, slug in the spec)", () => {
  it("matches a heading prefix, which is how tickets abbreviate", () => {
    expect(matchSection(sections, "Worker-Loop").section?.slug).toBe("worker-loop-spec-sync");
  });

  it("shortens prose until a section matches", () => {
    expect(matchSection(sections, "Label-Taxonomie regelt owner-hold").section?.slug).toBe(
      "label-taxonomie",
    );
  });

  it("matches a numbered section the way `§7.3` is written", () => {
    expect(matchSection(sections, "7.3").section?.slug).toBe("73-pack");
  });

  it("falls back from an arrow path to its first part", () => {
    expect(matchSection(sections, "Qualitäts-Wächter → Ada").section?.slug).toBe(
      "qualitäts-wächter-foundation-kanon--pflicht",
    );
  });

  it("reports ambiguity instead of picking one", () => {
    const twins = [
      { slug: "gate-lokal", path: "a/gate-lokal", heading: "Gate lokal", level: 2, content: "" },
      { slug: "gate-merge", path: "a/gate-merge", heading: "Gate merge", level: 2, content: "" },
    ];
    const match = matchSection(twins, "Gate");
    expect(match.section).toBeUndefined();
    expect(match.candidates).toEqual(["a/gate-lokal", "a/gate-merge"]);
  });

  it("returns nothing for a section the unit does not have", () => {
    expect(matchSection(sections, "Zahlungsabwicklung")).toEqual({});
  });
});

describe("slugify", () => {
  it("matches the server's slugs, umlauts included", () => {
    expect(slugify("Qualitäts-Wächter")).toBe("qualitäts-wächter");
    expect(slugify("7.3 `pack`")).toBe("7-3-pack");
  });
});

describe("extractAcceptance", () => {
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
      "`x.y` §Z",
    ].join("\n");
    expect(extractAcceptance(body)).toBe("1. Erste Bedingung\n2. Zweite Bedingung");
  });

  it("is undefined when the issue names no acceptance block", () => {
    expect(extractAcceptance("## Befund\nNur Prosa.")).toBeUndefined();
  });
});

describe("the machine block round-trips", () => {
  it("reads back the file set a later pack compares against", () => {
    const markdown = renderPack({
      issue: { number: 142, title: "T", body: "B", labels: ["spec-sync"] },
      sections: [],
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
