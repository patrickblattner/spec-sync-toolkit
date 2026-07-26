import { describe, expect, it } from "vitest";
import { PINNED_NORM_SECTION, callSpecTool } from "../src/norms.js";
import { ToolkitError } from "../src/output.js";
import { defaultTools, type RunResult, type Tools } from "../src/pack/exec.js";
import { SpecGateway, resolveReferences } from "../src/pack/spec.js";

/**
 * `pack` against `ticket_context` (spec-mcp §21.2): one call for every unit,
 * carrying only the sections the ticket named. The outline that turns a
 * ticket's prose into those slugs comes from `get_spec` without a body.
 */

const BUILD = "spec-sync-toolkit.build-spec";
const ADR = "spec-sync-toolkit.cli-not-mcp.adr";

const PACK_HASH = "1".repeat(64);
const LENSES_HASH = "2".repeat(64);
const ADR_HASH = "3".repeat(64);

interface Outline {
  version: string;
  extends?: string;
  sections: { slug: string; path: string; heading: string }[];
}

interface Content {
  slug: string;
  path: string;
  heading: string;
  hash: string;
  content: string;
}

const outlines: Record<string, Outline> = {
  [BUILD]: {
    version: "0.1.1",
    sections: [
      { slug: "73-pack", path: "build-spec/7-befehle/73-pack", heading: "7.3 `pack`" },
      { slug: "75-lenses", path: "build-spec/7-befehle/75-lenses", heading: "7.5 `lenses`" },
      { slug: "77-doctor", path: "build-spec/7-befehle/77-doctor", heading: "7.7 `doctor`" },
    ],
  },
  [ADR]: {
    version: "1.0.0",
    sections: [{ slug: "entscheidung-3", path: "adr/entscheidung-3", heading: "Entscheidung 3" }],
  },
};

const contents: Record<string, Content[]> = {
  [BUILD]: [
    {
      slug: "73-pack",
      path: "build-spec/7-befehle/73-pack",
      heading: "7.3 `pack`",
      hash: PACK_HASH,
      content: "### 7.3 `pack`\n\nErzeugt das Wissenspaket.",
    },
    {
      slug: "75-lenses",
      path: "build-spec/7-befehle/75-lenses",
      heading: "7.5 `lenses`",
      hash: LENSES_HASH,
      content: "### 7.5 `lenses`\n\nLeitet das Lens-Set ab.",
    },
    {
      slug: "77-doctor",
      path: "build-spec/7-befehle/77-doctor",
      heading: "7.7 `doctor`",
      hash: "9".repeat(64),
      content: "### 7.7 `doctor`\n\nSechs Prüfungen.",
    },
  ],
  [ADR]: [
    {
      slug: "entscheidung-3",
      path: "adr/entscheidung-3",
      heading: "Entscheidung 3",
      hash: ADR_HASH,
      content: "## Entscheidung 3\n\nNormen kommen aus der Foundation.",
    },
  ],
};

interface Recorded {
  tool: string;
  args: Record<string, unknown>;
}

/** Every spec call is recorded, so a test can count them and read the payload. */
function fakeGateway(overrides: Partial<Record<string, unknown>> = {}): {
  gateway: SpecGateway;
  calls: Recorded[];
} {
  const calls: Recorded[] = [];
  const tools: Tools = {
    run: (): RunResult => {
      throw new Error("no process should run here");
    },
    async spec<T>(tool: string, args: Record<string, unknown>): Promise<T> {
      calls.push({ tool, args });
      if (tool in overrides) return overrides[tool] as T;

      if (tool === "get_spec") {
        const outline = outlines[args.id as string];
        if (outline === undefined) {
          return {
            code: "NOT_FOUND",
            message: `spec unit "${String(args.id)}" not found`,
          } as T;
        }
        return {
          id: args.id,
          version: outline.version,
          frontmatter:
            outline.extends === undefined
              ? { id: args.id }
              : { id: args.id, extends: outline.extends },
          sections: outline.sections,
        } as T;
      }

      if (tool === "ticket_context") {
        const requested = args.units as { id: string; sections?: string[] }[];
        return {
          units: requested.map((entry) => ({
            id: entry.id,
            version: outlines[entry.id]?.version ?? "?",
            hash: "0".repeat(64),
            effective: false,
            composed_from: [{ source: "spec-sync-toolkit", id: entry.id, version: "0.1.1" }],
            sections: (contents[entry.id] ?? []).filter(
              (section) => entry.sections === undefined || entry.sections.includes(section.path),
            ),
          })),
        } as T;
      }

      throw new Error(`unexpected spec tool: ${tool}`);
    },
  };
  return { gateway: new SpecGateway(tools), calls };
}

describe("resolveReferences over ticket_context (spec-mcp §21.2)", () => {
  it("asks once for all units instead of once per unit", async () => {
    const { gateway, calls } = fakeGateway();
    const resolution = await resolveReferences(
      [
        { unit: BUILD, section: "7.3" },
        { unit: BUILD, section: "7.5" },
        { unit: ADR, section: "Entscheidung 3" },
      ],
      gateway,
    );

    expect(resolution.unresolved).toEqual([]);
    expect(
      resolution.sections.map((section) => `${section.unit}@${section.version} §${section.slug}`),
    ).toEqual([
      `${BUILD}@0.1.1 §73-pack`,
      `${BUILD}@0.1.1 §75-lenses`,
      `${ADR}@1.0.0 §entscheidung-3`,
    ]);

    const context = calls.filter((call) => call.tool === "ticket_context");
    expect(context).toHaveLength(1);
    expect(calls.some((call) => call.tool === "resolve_effective_spec")).toBe(false);
    expect(context[0]?.args.units).toEqual([
      { id: BUILD, sections: ["build-spec/7-befehle/73-pack", "build-spec/7-befehle/75-lenses"] },
      { id: ADR, sections: ["adr/entscheidung-3"] },
    ]);
  });

  it("requests only the sections the ticket names, not the whole unit", async () => {
    const { gateway, calls } = fakeGateway();
    const resolution = await resolveReferences([{ unit: BUILD, section: "7.3" }], gateway);

    expect(resolution.sections).toHaveLength(1);
    const requested = (calls.find((call) => call.tool === "ticket_context")?.args.units ?? []) as {
      id: string;
      sections?: string[];
    }[];
    // The unit has three sections; the ticket named one.
    expect(requested[0]?.sections).toEqual(["build-spec/7-befehle/73-pack"]);
    expect(outlines[BUILD]?.sections).toHaveLength(3);
  });

  it("carries the section hash the server sends, unchanged", async () => {
    const { gateway } = fakeGateway();
    const resolution = await resolveReferences([{ unit: BUILD, section: "7.5" }], gateway);
    expect(resolution.sections[0]?.hash).toBe(LENSES_HASH);
  });

  it("reports an unknown unit as unresolved and never asks for it", async () => {
    const { gateway, calls } = fakeGateway();
    const resolution = await resolveReferences(
      [
        { unit: "spec-sync-toolkit.does-not-exist", section: "7.3" },
        { unit: BUILD, section: "7.3" },
      ],
      gateway,
    );

    expect(resolution.unresolved).toEqual([
      { unit: "spec-sync-toolkit.does-not-exist", section: "7.3", reason: "unknown-unit" },
    ]);
    const requested = calls.find((call) => call.tool === "ticket_context")?.args.units;
    expect(requested).toEqual([{ id: BUILD, sections: ["build-spec/7-befehle/73-pack"] }]);
  });

  it("passes a NOT_FOUND from ticket_context through instead of packing half a paket", async () => {
    const { gateway } = fakeGateway({
      ticket_context: { code: "NOT_FOUND", message: 'spec unit "x.y" not found' },
    });
    await expect(resolveReferences([{ unit: BUILD, section: "7.3" }], gateway)).rejects.toThrow(
      /NOT_FOUND/u,
    );
  });

  it("passes a SECTION_NOT_FOUND from ticket_context through, with the server's message", async () => {
    const { gateway } = fakeGateway({
      ticket_context: {
        code: "SECTION_NOT_FOUND",
        message: 'section "73-pack" not found in unit "spec-sync-toolkit.build-spec"',
      },
    });

    const error = await resolveReferences([{ unit: BUILD, section: "7.3" }], gateway).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(error).toBeInstanceOf(ToolkitError);
    expect((error as ToolkitError).reason).toBe("SECTION_NOT_FOUND");
    expect((error as ToolkitError).message).toContain("73-pack");
  });

  it("keeps a section the ticket names twice out of the pack a second time", async () => {
    const { gateway } = fakeGateway();
    const resolution = await resolveReferences(
      [
        { unit: BUILD, section: "7.3" },
        { unit: BUILD, section: "7.3 `pack`" },
      ],
      gateway,
    );
    expect(resolution.sections).toHaveLength(1);
  });

  /**
   * A unit that `extends` another has sections its own file does not carry, so
   * its outline cannot name them. It goes into the same call without a section
   * list and is matched against the composed answer.
   */
  it("asks a composed unit for whole, in the same call", async () => {
    const composed = "production-cockpit.coding.guideline";
    const calls: Recorded[] = [];
    const tools: Tools = {
      run: (): RunResult => {
        throw new Error("no process should run here");
      },
      async spec<T>(tool: string, args: Record<string, unknown>): Promise<T> {
        calls.push({ tool, args });
        if (tool === "get_spec") {
          return {
            id: composed,
            version: "2.2.1",
            // The overlay's own file — "Naming" comes from the base unit.
            frontmatter: { id: composed, extends: "foundation.coding.guideline@^2" },
            sections: [
              {
                slug: "coding-guideline-cockpit-overlay",
                path: "coding-guideline-cockpit-overlay",
                heading: "Coding-Guideline (Cockpit-Overlay)",
              },
            ],
          } as T;
        }
        return {
          units: [
            {
              id: composed,
              version: "2.2.1",
              effective: true,
              composed_from: [
                { source: "foundation", id: "foundation.coding.guideline", version: "2.2.0" },
                { source: "production-cockpit", id: composed, version: "2.2.1" },
              ],
              sections: [
                {
                  slug: "coding-guideline-cockpit-overlay",
                  path: "coding-guideline-cockpit-overlay",
                  heading: "Coding-Guideline (Cockpit-Overlay)",
                  hash: "a".repeat(64),
                  content: "# Coding-Guideline",
                },
                {
                  slug: "naming",
                  path: "coding-guideline-cockpit-overlay/naming",
                  heading: "Naming",
                  hash: "b".repeat(64),
                  content: "## Naming\n\nSprechende Namen.",
                },
              ],
            },
          ],
        } as T;
      },
    };

    const resolution = await resolveReferences(
      [{ unit: composed, section: "Naming" }],
      new SpecGateway(tools),
    );

    expect(calls.find((call) => call.tool === "ticket_context")?.args.units).toEqual([
      { id: composed },
    ]);
    expect(resolution.sections[0]?.slug).toBe("naming");
    expect(resolution.sections[0]?.hash).toBe("b".repeat(64));
    expect(resolution.sections[0]?.composedFrom).toEqual(["foundation.coding.guideline", composed]);
  });
});

/**
 * The claim §21.2 makes about the section hash — "same function as the lock" —
 * is only worth something against the running server, so this one is not faked.
 * It skips when the server is not up; it never invents a pass.
 */
const NORM_UNIT = PINNED_NORM_SECTION.unit;
const NORM_PATH = PINNED_NORM_SECTION.section;

const live = await callSpecTool<{ snapshot?: unknown }>("get_manifest", { project: "foundation" })
  .then(() => true)
  .catch(() => false);

describe.skipIf(!live)("ticket_context against the running server", () => {
  it("hashes a section exactly as the lock manifest does", async () => {
    const manifest = await callSpecTool<{
      snapshot?: { entries?: { id: string; sections?: Record<string, string> }[] };
    }>("get_manifest", { project: "foundation" });
    const fromLock = manifest.snapshot?.entries?.find((entry) => entry.id === NORM_UNIT)
      ?.sections?.[NORM_PATH];

    const context = await callSpecTool<{
      units?: { sections?: { path: string; hash: string }[] }[];
    }>("ticket_context", { units: [{ id: NORM_UNIT, sections: [NORM_PATH] }] });
    const fromContext = context.units?.[0]?.sections?.find(
      (section) => section.path === NORM_PATH,
    )?.hash;

    expect(fromLock).toMatch(/^[0-9a-f]{64}$/u);
    expect(fromContext).toBe(fromLock);
  });

  it("returns only the requested section, not the whole unit", async () => {
    const context = await callSpecTool<{ units?: { sections?: unknown[] }[] }>("ticket_context", {
      units: [{ id: NORM_UNIT, sections: [NORM_PATH] }],
    });
    const whole = await callSpecTool<{ units?: { sections?: unknown[] }[] }>("ticket_context", {
      units: [{ id: NORM_UNIT }],
    });

    expect(context.units?.[0]?.sections).toHaveLength(1);
    expect((whole.units?.[0]?.sections ?? []).length).toBeGreaterThan(1);
  });

  /**
   * The fakes can only be self-consistent: they cannot show that the paths an
   * outline reports are the ones `ticket_context` accepts. That round trip —
   * ticket prose → `get_spec` outline → section path → hash — only the real
   * server can answer, and its answer must be the pinned lock hash (§6).
   */
  it("resolves a ticket's prose to the pinned lock hash, end to end", async () => {
    const gateway = new SpecGateway(defaultTools(process.cwd()));
    const { sections, unresolved } = await resolveReferences(
      [{ unit: NORM_UNIT, section: "Worker-Loop" }],
      gateway,
    );

    expect(unresolved).toEqual([]);
    expect(sections).toHaveLength(1);
    expect(sections[0]?.path).toBe(NORM_PATH);
    expect(sections[0]?.hash).toBe(PINNED_NORM_SECTION.hash);
    expect(sections[0]?.content).not.toBe("");
  });
});
