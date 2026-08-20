import { describe, expect, it } from "vitest";
import { callSpecTool } from "../src/norms.js";
import { type RunResult, type Tools } from "../src/pack/exec.js";
import { resolveKeys } from "../src/pack/spec.js";

/**
 * `pack` against `spec_get_many` (SMCP-DESIGN-012): one call for every key. A
 * v2 spec is already leaf-sized, so there is no separate outline step and no
 * section addressing — the whole block *is* what gets packed.
 */

const SPECS: Record<string, { title: string; status: string; rev: number; body: string }> = {
  "SST-DESIGN-018": {
    title: "Befehl: pack",
    status: "approved",
    rev: 2,
    body: "`pack` erzeugt das Wissenspaket, mit dem ein Sub-Agent ein Ticket beginnen kann.",
  },
  "SST-DESIGN-020": {
    title: "Befehl: lenses",
    status: "approved",
    rev: 2,
    body: "Leitet das Lens-Set aus dem Diff ab.",
  },
  "SST-ADR-001": {
    title: "CLI-Toolkit statt zweitem MCP-Server, eigenes Repo",
    status: "approved",
    rev: 3,
    body: "Normen kommen aus der Foundation, nicht aus dem Code.",
  },
};

function blockFor(key: string): string {
  const spec = SPECS[key];
  if (spec === undefined) return `Spec "${key}" nicht gefunden.`;
  return `# ${key} — ${spec.title}\n\nStatus: ${spec.status} · Art: design · rev ${spec.rev} · Projekt: spec-sync-toolkit\n\n${spec.body}`;
}

interface Recorded {
  tool: string;
  args: Record<string, unknown>;
}

/** Every spec call is recorded, so a test can count them and read the payload. */
function fakeTools(respond?: (keys: string[]) => string): { tools: Tools; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const tools: Tools = {
    run: (): RunResult => {
      throw new Error("no process should run here");
    },
    async spec(tool: string, args: Record<string, unknown>): Promise<string> {
      calls.push({ tool, args });
      expect(tool).toBe("spec_get_many");
      const keys = args.keys as string[];
      return respond !== undefined ? respond(keys) : keys.map(blockFor).join("\n\n---\n\n");
    },
  };
  return { tools, calls };
}

describe("resolveKeys over spec_get_many (SMCP-DESIGN-012, SST-DESIGN-018)", () => {
  it("asks once for all keys instead of once per key", async () => {
    const { tools, calls } = fakeTools();
    const resolution = await resolveKeys(["SST-DESIGN-018", "SST-DESIGN-020"], tools);

    expect(resolution.unknown).toEqual([]);
    expect(resolution.specs.map((spec) => `${spec.key}@${spec.rev}`)).toEqual([
      "SST-DESIGN-018@2",
      "SST-DESIGN-020@2",
    ]);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.args.keys).toEqual(["SST-DESIGN-018", "SST-DESIGN-020"]);
  });

  it("costs no roundtrip for an empty reference list", async () => {
    const { tools, calls } = fakeTools();
    const resolution = await resolveKeys([], tools);
    expect(resolution).toEqual({ specs: [], unknown: [] });
    expect(calls).toHaveLength(0);
  });

  it("carries the title, status and revision the server sends", async () => {
    const { tools } = fakeTools();
    const resolution = await resolveKeys(["SST-ADR-001"], tools);
    expect(resolution.specs[0]).toMatchObject({
      key: "SST-ADR-001",
      title: "CLI-Toolkit statt zweitem MCP-Server, eigenes Repo",
      status: "approved",
      rev: 3,
    });
    expect(resolution.specs[0]?.content).toContain("Normen kommen aus der Foundation");
  });

  it("reports an unknown key as unresolved, matched positionally", async () => {
    const { tools, calls } = fakeTools();
    const resolution = await resolveKeys(["NOPE-999", "SST-DESIGN-018"], tools);

    expect(resolution.unknown).toEqual(["NOPE-999"]);
    expect(resolution.specs.map((spec) => spec.key)).toEqual(["SST-DESIGN-018"]);
    expect(calls[0]?.args.keys).toEqual(["NOPE-999", "SST-DESIGN-018"]);
  });

  it("treats an alias-redirect block (no header, only a redirect line) as unresolved", async () => {
    const { tools } = fakeTools((keys) =>
      keys.map(() => "→ ersetzt durch: PROC-DEV-001, PROC-DEV-015").join("\n\n---\n\n"),
    );
    const resolution = await resolveKeys(["SMCP-DESIGN-999"], tools);
    expect(resolution.unknown).toEqual(["SMCP-DESIGN-999"]);
    expect(resolution.specs).toEqual([]);
  });

  it("keeps a key the ticket names twice out of the pack a second time (spec §7.3)", async () => {
    // The de-duplication itself lives in `parseSpecReferences`; this only
    // confirms `resolveKeys` does not itself invent a duplicate.
    const { tools } = fakeTools();
    const resolution = await resolveKeys(["SST-DESIGN-018"], tools);
    expect(resolution.specs).toHaveLength(1);
  });
});

/**
 * Against the running server — skipped, never faked as passing, when it is
 * not up (spec §2: an unproven claim is not a claim). Targets the read-only
 * redaction instance on :8788 explicitly — :8787 still serves v1 in
 * production until cutover, and this suite must never touch it.
 */
const LIVE_SERVER = "http://localhost:8788";

const liveTools: Tools = {
  run: (): RunResult => {
    throw new Error("no process should run here");
  },
  spec: (tool, args) => callSpecTool(tool, args, LIVE_SERVER),
};

const live = await callSpecTool("spec_pins", { project: "foundation" }, LIVE_SERVER)
  .then(() => true)
  .catch(() => false);

describe.skipIf(!live)("resolveKeys against the running server (:8788, read-only)", () => {
  it("resolves a real key end to end", async () => {
    const resolution = await resolveKeys(["PROC-DEV-010"], liveTools);
    expect(resolution.unknown).toEqual([]);
    expect(resolution.specs).toHaveLength(1);
    expect(resolution.specs[0]?.key).toBe("PROC-DEV-010");
    expect(resolution.specs[0]?.rev).toBeGreaterThan(0);
    expect(resolution.specs[0]?.content).not.toBe("");
  });
});
