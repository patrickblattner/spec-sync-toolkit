import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../src/cli.js";
import { MEASURE_LEDGER, runMeasure } from "../src/commands/measure.js";
import type { Config } from "../src/config.js";
import { EXIT } from "../src/output.js";

const MEASURE_FILE = "quality/size-limits.json";
const ORIGINAL = `{\n    "limits": {\n        "server/app.ts": 400,\n        "client/big.tsx": 900\n    },\n    "entries": [\n        "ad-catalog-filter-help",\n        "other-entry"\n    ]\n}\n`;

/** The register read route: decision 1073 exists, every other id is 404. */
function fakeFetch(calls: string[] = []): typeof globalThis.fetch {
  return ((url: string) => {
    calls.push(url);
    if (url.endsWith("/api/decisions/1073")) {
      return Promise.resolve(
        Response.json({
          decision: { id: 1073, project: "foundation", title: "Blocks never idle" },
        }),
      );
    }
    return Promise.resolve(Response.json({ error: "decision not found" }, { status: 404 }));
  }) as unknown as typeof globalThis.fetch;
}

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "measure-"));
  writeFileSync(
    join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: { spec: { type: "http", url: "http://localhost:8787/mcp" } } }),
  );
  mkdirSync(join(root, "quality"));
  writeFileSync(join(root, MEASURE_FILE), ORIGINAL);
  writeFileSync(join(root, "other.json"), "{}\n");
  return root;
}

const ctxFor = (root: string, args: string[], dryRun = false): CommandContext => ({
  flags: { human: false, dryRun },
  args,
  repoRoot: root,
  config: { project: "production-cockpit", measureFiles: [MEASURE_FILE] } as Config,
});

const read = (root: string): string => readFileSync(join(root, MEASURE_FILE), "utf8");

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("measure (SST-DESIGN-002)", () => {
  it("sets a value, keeps indentation and trailing newline, appends one receipt", async () => {
    const calls: string[] = [];
    vi.stubGlobal("fetch", fakeFetch(calls));
    const root = repo();

    const result = await runMeasure(
      ctxFor(root, ["set", MEASURE_FILE, "/limits/server~1app.ts", "450", "--register", "1073"]),
    );

    expect(calls).toEqual(["http://localhost:8787/api/decisions/1073"]);
    expect(result.data).toMatchObject({
      file: MEASURE_FILE,
      register: 1073,
      title: "Blocks never idle",
      changes: [{ op: "set", pointer: "/limits/server~1app.ts", from: 400, to: 450 }],
    });
    expect(read(root)).toBe(ORIGINAL.replace("400", "450"));

    const lines = readFileSync(join(root, MEASURE_LEDGER), "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] as string)).toMatchObject({
      file: MEASURE_FILE,
      register: 1073,
      changes: [{ op: "set", pointer: "/limits/server~1app.ts", from: 400, to: 450 }],
    });
  });

  it("removes an array string by its value", async () => {
    vi.stubGlobal("fetch", fakeFetch());
    const root = repo();

    await runMeasure(
      ctxFor(root, ["remove", MEASURE_FILE, "/entries/ad-catalog-filter-help", "--register=1073"]),
    );

    expect(JSON.parse(read(root)).entries).toEqual(["other-entry"]);
    const receipt = JSON.parse(readFileSync(join(root, MEASURE_LEDGER), "utf8"));
    expect(receipt.changes).toEqual([
      {
        op: "remove",
        pointer: "/entries/ad-catalog-filter-help",
        from: "ad-catalog-filter-help",
        to: null,
      },
    ]);
  });

  it("applies repeated --set/--remove as one call with one receipt", async () => {
    vi.stubGlobal("fetch", fakeFetch());
    const root = repo();

    const result = await runMeasure(
      ctxFor(root, [
        "set",
        MEASURE_FILE,
        "--set",
        "/limits/client~1big.tsx=800",
        "--remove",
        "/entries/1",
        '--set=/limits/server~1app.ts="n/a"',
        "--register",
        "1073",
      ]),
    );

    expect(result.data?.changes).toHaveLength(3);
    expect(JSON.parse(read(root))).toEqual({
      limits: { "server/app.ts": "n/a", "client/big.tsx": 800 },
      entries: ["ad-catalog-filter-help"],
    });
    expect(readFileSync(join(root, MEASURE_LEDGER), "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("takes a value that is not JSON as a plain string", async () => {
    vi.stubGlobal("fetch", fakeFetch());
    const root = repo();
    await runMeasure(
      ctxFor(root, ["set", MEASURE_FILE, "/entries/0", "renamed", "--register", "1073"]),
    );
    expect(JSON.parse(read(root)).entries[0]).toBe("renamed");
  });

  it.each([
    ["a file not under measureFiles", ["set", "other.json", "/x", "1", "--register", "1073"]],
    ["a missing --register", ["set", MEASURE_FILE, "/limits/client~1big.tsx", "1"]],
    [
      "an unknown decision",
      ["set", MEASURE_FILE, "/limits/client~1big.tsx", "1", "--register", "9"],
    ],
    [
      "one unresolvable pointer among valid ones",
      [
        "set",
        MEASURE_FILE,
        "/limits/client~1big.tsx",
        "1",
        "--remove",
        "/nope",
        "--register",
        "1073",
      ],
    ],
    [
      "a string pointer on set",
      ["set", MEASURE_FILE, "/entries/other-entry", "1", "--register", "1073"],
    ],
  ])("refuses %s with exit 4 and writes nothing", async (_label, args) => {
    vi.stubGlobal("fetch", fakeFetch());
    const root = repo();
    await expect(runMeasure(ctxFor(root, args))).rejects.toMatchObject({
      exit: EXIT.PRECONDITION,
    });
    expect(read(root)).toBe(ORIGINAL);
    expect(existsSync(join(root, MEASURE_LEDGER))).toBe(false);
  });

  it("refuses with exit 4 when the server is unreachable or answers garbage", async () => {
    const root = repo();
    const args = ["set", MEASURE_FILE, "/limits/client~1big.tsx", "1", "--register", "1073"];

    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("fetch failed")));
    await expect(runMeasure(ctxFor(root, args))).rejects.toMatchObject({ exit: EXIT.PRECONDITION });

    vi.stubGlobal("fetch", () => Promise.resolve(new Response("<html>", { status: 200 })));
    await expect(runMeasure(ctxFor(root, args))).rejects.toMatchObject({ exit: EXIT.PRECONDITION });

    vi.stubGlobal("fetch", () => Promise.resolve(Response.json({}, { status: 500 })));
    await expect(runMeasure(ctxFor(root, args))).rejects.toMatchObject({ exit: EXIT.PRECONDITION });

    expect(read(root)).toBe(ORIGINAL);
    expect(existsSync(join(root, MEASURE_LEDGER))).toBe(false);
  });

  it("dry run validates but writes neither file nor ledger", async () => {
    vi.stubGlobal("fetch", fakeFetch());
    const root = repo();
    const result = await runMeasure(
      ctxFor(
        root,
        ["set", MEASURE_FILE, "/limits/client~1big.tsx", "1", "--register", "1073"],
        true,
      ),
    );
    expect(result.ok).toBe(true);
    expect(read(root)).toBe(ORIGINAL);
    expect(existsSync(join(root, MEASURE_LEDGER))).toBe(false);
  });
});

describe("measure writes text edits, not a reserialisation", () => {
  // Prettier shape: a short array on one line, a long one expanded.
  const SHAPED = `{\n  "path": ["a", "b", "c"],\n  "limits": { "x": 1, "y": 2 },\n  "list": [\n    "p",\n    "q",\n    "r"\n  ]\n}\n`;

  async function edit(args: string[]): Promise<string> {
    vi.stubGlobal("fetch", fakeFetch());
    const root = repo();
    writeFileSync(join(root, MEASURE_FILE), SHAPED);
    await runMeasure(ctxFor(root, [...args, "--register", "1073"]));
    return read(root);
  }

  it("changes only the set value", async () => {
    expect(await edit(["set", MEASURE_FILE, "/limits/x", "2"])).toBe(
      SHAPED.replace('"x": 1', '"x": 2'),
    );
  });

  it("changes only the removed element", async () => {
    expect(await edit(["remove", MEASURE_FILE, "/list/q"])).toBe(SHAPED.replace('    "q",\n', ""));
    expect(await edit(["remove", MEASURE_FILE, "/limits/x"])).toBe(SHAPED.replace('"x": 1, ', ""));
    expect(await edit(["remove", MEASURE_FILE, "/path"])).toBe(
      SHAPED.replace('"path": ["a", "b", "c"],\n  ', ""),
    );
    expect(await edit(["remove", MEASURE_FILE, "/list"])).toBe(
      SHAPED.replace(',\n  "list": [\n    "p",\n    "q",\n    "r"\n  ]', ""),
    );
  });

  it.each([
    ["/path/a", '["b", "c"]'],
    ["/path/b", '["a", "c"]'],
    ["/path/c", '["a", "b"]'],
  ])("removes %s from a one-line array without a dangling comma", async (pointer, expected) => {
    expect(await edit(["remove", MEASURE_FILE, pointer])).toBe(
      SHAPED.replace('["a", "b", "c"]', expected),
    );
  });

  it.each([
    ["/list/p", '[\n    "q",\n    "r"\n  ]'],
    ["/list/r", '[\n    "p",\n    "q"\n  ]'],
  ])("removes %s from a multi-line array without a dangling comma", async (pointer, expected) => {
    expect(await edit(["remove", MEASURE_FILE, pointer])).toBe(
      SHAPED.replace('[\n    "p",\n    "q",\n    "r"\n  ]', expected),
    );
  });
});
