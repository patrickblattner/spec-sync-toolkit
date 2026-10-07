import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../src/cli.js";
import type { Config } from "../src/config.js";
import { runRepin, toBaseUrl } from "../src/commands/repin.js";
import { COVERAGE_FILE } from "../src/coverage.js";
import { EXIT } from "../src/output.js";

describe("toBaseUrl (SST-DESIGN-025, endpoint vs. base URL)", () => {
  it("strips the endpoint suffix `callSpecTool` appends itself", () => {
    expect(toBaseUrl("http://localhost:8787/mcp")).toBe("http://localhost:8787");
  });

  it("leaves a URL that is already the base form untouched", () => {
    expect(toBaseUrl("http://localhost:8787")).toBe("http://localhost:8787");
  });

  it("tolerates trailing slashes on either form", () => {
    expect(toBaseUrl("http://localhost:8787/mcp/")).toBe("http://localhost:8787");
    expect(toBaseUrl("http://localhost:8787/")).toBe("http://localhost:8787");
  });

  it("keeps a host whose path merely contains `mcp` elsewhere", () => {
    expect(toBaseUrl("https://mcp.example.com/spec")).toBe("https://mcp.example.com/spec");
  });
});

/** A repo with the `.mcp.json` shape every impl repo really carries. */
function repoWithMcpJson(url: string): string {
  const repo = mkdtempSync(join(tmpdir(), "repin-"));
  writeFileSync(
    join(repo, ".mcp.json"),
    JSON.stringify({ mcpServers: { spec: { type: "http", url } } }),
  );
  return repo;
}

const ctxFor = (repo: string, args: string[] = []): CommandContext => ({
  flags: { human: false, dryRun: true },
  args,
  repoRoot: repo,
  config: { project: "production-cockpit" } as Config,
});

/** Answers the three POSTs of one `callSpecTool` round and records the URLs. */
function fakeFetch(seen: string[]): typeof globalThis.fetch {
  return ((input: string) => {
    seen.push(input);
    const body = seen.length === 3 ? `data: ${JSON.stringify(pinsPayload)}\n\n` : "";
    return Promise.resolve(
      new Response(body, { status: 200, headers: { "mcp-session-id": "s-1" } }),
    );
  }) as unknown as typeof globalThis.fetch;
}

const pinsPayload = {
  jsonrpc: "2.0",
  id: 2,
  result: { content: [{ type: "text", text: "PROC-DEV-031=2\nGL-CODE-010=1\n" }] },
};

describe("repin endpoint resolution (cockpit migration finding, 2026-08-21)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("calls `/mcp` once when .mcp.json carries the full endpoint", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", fakeFetch(seen));

    const result = await runRepin(ctxFor(repoWithMcpJson("http://localhost:8787/mcp")));

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ mode: "full", units: 2 });
    // The bug this test exists for: `…/mcp/mcp` answered 404 ⇒ exit 2.
    expect(new Set(seen)).toEqual(new Set(["http://localhost:8787/mcp"]));
  });

  it("normalizes an --server value copied out of .mcp.json the same way", async () => {
    const seen: string[] = [];
    vi.stubGlobal("fetch", fakeFetch(seen));

    const repo = repoWithMcpJson("http://localhost:8787/mcp");
    const result = await runRepin(ctxFor(repo, ["--server", "http://localhost:8788/mcp"]));

    expect(result.ok).toBe(true);
    expect(new Set(seen)).toEqual(new Set(["http://localhost:8788/mcp"]));
  });
});

/** Server state of `pinsPayload`: PROC-DEV-031 rev 2, GL-CODE-010 rev 1. */
describe("repin coverage gate (SST-ADR-011, spec rev 4)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const writingCtx = (repo: string, args: string[] = []): CommandContext => ({
    flags: { human: false, dryRun: false },
    args,
    repoRoot: repo,
    config: { project: "production-cockpit" } as Config,
  });

  const receiptLine = (key: string, from: number | null, to: number | null): string =>
    `${JSON.stringify({ ts: "t", key, from, to, disposition: "ticket", ref: "16" })}\n`;

  it("bootstrap without a pin file stays exempt and writes", async () => {
    vi.stubGlobal("fetch", fakeFetch([]));
    const repo = repoWithMcpJson("http://localhost:8787/mcp");

    const result = await runRepin(writingCtx(repo));
    expect(result.ok).toBe(true);
    expect(JSON.parse(readFileSync(join(repo, "spec-pins.json"), "utf8"))).toEqual({
      "PROC-DEV-031": 2,
      "GL-CODE-010": 1,
    });
  });

  it("blocks an unreceipted moved key: exit 4, names it, pin file untouched", async () => {
    vi.stubGlobal("fetch", fakeFetch([]));
    const repo = repoWithMcpJson("http://localhost:8787/mcp");
    const before = JSON.stringify({ "PROC-DEV-031": 1, "GL-CODE-010": 1 });
    writeFileSync(join(repo, "spec-pins.json"), before);

    const result = await runRepin(writingCtx(repo));
    expect(result).toMatchObject({ ok: false, exit: EXIT.PRECONDITION });
    expect(result.data).toMatchObject({ uncovered: ["PROC-DEV-031"] });
    expect(readFileSync(join(repo, "spec-pins.json"), "utf8")).toBe(before);
  });

  it("a stale receipt (server moved on) does not count", async () => {
    vi.stubGlobal("fetch", fakeFetch([]));
    const repo = repoWithMcpJson("http://localhost:8787/mcp");
    writeFileSync(join(repo, "spec-pins.json"), JSON.stringify({ "PROC-DEV-031": 1 }));
    mkdirSync(join(repo, ".spec-sync"), { recursive: true });
    // Receipted towards rev 3; the server now answers rev 2 — unexamined diff.
    writeFileSync(join(repo, COVERAGE_FILE), receiptLine("PROC-DEV-031", 1, 3));

    const result = await runRepin(writingCtx(repo));
    expect(result).toMatchObject({ ok: false, exit: EXIT.PRECONDITION });
  });

  it("writes once every moved key carries a matching receipt", async () => {
    vi.stubGlobal("fetch", fakeFetch([]));
    const repo = repoWithMcpJson("http://localhost:8787/mcp");
    // PROC-DEV-031 changes, GL-CODE-010 is new, GL-GONE-001 disappears.
    writeFileSync(
      join(repo, "spec-pins.json"),
      JSON.stringify({ "PROC-DEV-031": 1, "GL-GONE-001": 4 }),
    );
    mkdirSync(join(repo, ".spec-sync"), { recursive: true });
    writeFileSync(
      join(repo, COVERAGE_FILE),
      receiptLine("PROC-DEV-031", 1, 2) +
        receiptLine("GL-CODE-010", null, 1) +
        receiptLine("GL-GONE-001", 4, null),
    );

    const result = await runRepin(writingCtx(repo));
    expect(result.ok).toBe(true);
    expect(JSON.parse(readFileSync(join(repo, "spec-pins.json"), "utf8"))).toEqual({
      "PROC-DEV-031": 2,
      "GL-CODE-010": 1,
    });
  });

  it("--ids gates the named entries that would change", async () => {
    vi.stubGlobal("fetch", fakeFetch([]));
    const repo = repoWithMcpJson("http://localhost:8787/mcp");
    writeFileSync(join(repo, "spec-pins.json"), JSON.stringify({ "PROC-DEV-031": 1 }));

    const blocked = await runRepin(writingCtx(repo, ["--ids", "PROC-DEV-031"]));
    expect(blocked).toMatchObject({ ok: false, exit: EXIT.PRECONDITION });

    mkdirSync(join(repo, ".spec-sync"), { recursive: true });
    writeFileSync(join(repo, COVERAGE_FILE), receiptLine("PROC-DEV-031", 1, 2));
    vi.stubGlobal("fetch", fakeFetch([]));
    const result = await runRepin(writingCtx(repo, ["--ids", "PROC-DEV-031"]));
    expect(result.ok).toBe(true);
    expect(JSON.parse(readFileSync(join(repo, "spec-pins.json"), "utf8"))).toEqual({
      "PROC-DEV-031": 2,
    });
  });
});

/** Server state with a UI area the project declares as not applying. */
const uiPayload = {
  jsonrpc: "2.0",
  id: 2,
  result: {
    content: [{ type: "text", text: "PROC-DEV-031=2\nGL-UI-026=6\nGL-UI-030=1\nGL-020=3\n" }],
  },
};

function uiFetch(): typeof globalThis.fetch {
  let calls = 0;
  return (() => {
    calls += 1;
    const body = calls === 3 ? `data: ${JSON.stringify(uiPayload)}\n\n` : "";
    return Promise.resolve(
      new Response(body, { status: 200, headers: { "mcp-session-id": "s-1" } }),
    );
  }) as unknown as typeof globalThis.fetch;
}

describe("repin pinExclude (SST-DESIGN-025 rev 5)", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const ctxWith = (repo: string, pinExclude?: string[], args: string[] = []): CommandContext => ({
    flags: { human: false, dryRun: false },
    args,
    repoRoot: repo,
    config: { project: "production-cockpit", pinExclude } as Config,
  });
  const pinsOf = (repo: string): unknown =>
    JSON.parse(readFileSync(join(repo, "spec-pins.json"), "utf8"));

  it("without pinExclude writes every key and reports excluded 0", async () => {
    vi.stubGlobal("fetch", uiFetch());
    const repo = repoWithMcpJson("http://localhost:8787/mcp");

    const result = await runRepin(ctxWith(repo));
    expect(result.data).toMatchObject({ mode: "full", units: 4, excluded: 0 });
    expect(pinsOf(repo)).toEqual({
      "PROC-DEV-031": 2,
      "GL-UI-026": 6,
      "GL-UI-030": 1,
      "GL-020": 3,
    });
  });

  it("drops matching keys before writing and counts them", async () => {
    vi.stubGlobal("fetch", uiFetch());
    const repo = repoWithMcpJson("http://localhost:8787/mcp");

    const result = await runRepin(ctxWith(repo, ["GL-UI-*", "GL-020"]));
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ mode: "full", units: 1, excluded: 3 });
    expect(pinsOf(repo)).toEqual({ "PROC-DEV-031": 2 });
  });

  it("keys leaving the pin file only because of the list need no receipt", async () => {
    vi.stubGlobal("fetch", uiFetch());
    const repo = repoWithMcpJson("http://localhost:8787/mcp");
    // Old pin file still carries the UI area (one key even at an older rev,
    // one no longer on the server); only PROC-DEV-031 is unmoved.
    writeFileSync(
      join(repo, "spec-pins.json"),
      JSON.stringify({ "PROC-DEV-031": 2, "GL-UI-026": 5, "GL-UI-099": 1, "GL-020": 3 }),
    );

    const result = await runRepin(ctxWith(repo, ["GL-UI-*", "GL-020"]));
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ excluded: 3 });
    expect(pinsOf(repo)).toEqual({ "PROC-DEV-031": 2 });
  });

  it("still gates the keys the list does not cover", async () => {
    vi.stubGlobal("fetch", uiFetch());
    const repo = repoWithMcpJson("http://localhost:8787/mcp");
    const before = JSON.stringify({ "PROC-DEV-031": 1, "GL-UI-026": 6 });
    writeFileSync(join(repo, "spec-pins.json"), before);

    const result = await runRepin(ctxWith(repo, ["GL-UI-*"]));
    expect(result).toMatchObject({ ok: false, exit: EXIT.PRECONDITION });
    expect(result.data).toMatchObject({ uncovered: ["GL-020", "PROC-DEV-031"] });
    expect(readFileSync(join(repo, "spec-pins.json"), "utf8")).toBe(before);
  });

  it("--ids ignores an excluded id, counts it, and leaves the file as is", async () => {
    vi.stubGlobal("fetch", uiFetch());
    const repo = repoWithMcpJson("http://localhost:8787/mcp");
    writeFileSync(join(repo, "spec-pins.json"), JSON.stringify({ "PROC-DEV-031": 2 }));

    const result = await runRepin(ctxWith(repo, ["GL-UI-*"], ["--ids", "GL-UI-026,PROC-DEV-031"]));
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ mode: "ids", units: 1, excluded: 1 });
    expect(pinsOf(repo)).toEqual({ "PROC-DEV-031": 2 });
  });
});
