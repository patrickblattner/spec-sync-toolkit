import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../src/cli.js";
import { runDrift } from "../src/commands/drift.js";
import { COVERAGE_FILE } from "../src/coverage.js";
import type { Config } from "../src/config.js";
import { EXIT, ToolkitError } from "../src/output.js";

/** Server state: PROC-DEV-031 rev 2, GL-CODE-010 rev 1. */
const pinsPayload = {
  jsonrpc: "2.0",
  id: 2,
  result: { content: [{ type: "text", text: "PROC-DEV-031=2\nGL-CODE-010=1\n" }] },
};

function fakeFetch(): typeof globalThis.fetch {
  let calls = 0;
  return (() => {
    calls += 1;
    const body = calls === 3 ? `data: ${JSON.stringify(pinsPayload)}\n\n` : "";
    return Promise.resolve(
      new Response(body, { status: 200, headers: { "mcp-session-id": "s-1" } }),
    );
  }) as unknown as typeof globalThis.fetch;
}

function repo(pins?: Record<string, number>): string {
  const root = mkdtempSync(join(tmpdir(), "drift-"));
  writeFileSync(
    join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: { spec: { type: "http", url: "http://localhost:8787/mcp" } } }),
  );
  if (pins !== undefined) writeFileSync(join(root, "spec-pins.json"), JSON.stringify(pins));
  return root;
}

const ctxFor = (root: string): CommandContext => ({
  flags: { human: false, dryRun: false },
  args: [],
  repoRoot: root,
  config: { project: "production-cockpit" } as Config,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("drift (SST-DESIGN-028)", () => {
  it("refuses without a pin file — bootstrap runs repin first", async () => {
    vi.stubGlobal("fetch", fakeFetch());
    await expect(runDrift(ctxFor(repo()))).rejects.toMatchObject({ exit: EXIT.PRECONDITION });
  });

  it("exit 0 and an empty list when nothing moved", async () => {
    vi.stubGlobal("fetch", fakeFetch());
    const result = await runDrift(ctxFor(repo({ "PROC-DEV-031": 2, "GL-CODE-010": 1 })));
    expect(result).toMatchObject({ ok: true, exit: EXIT.OK });
    expect(result.data).toMatchObject({ moved: [], counts: { moved: 0, covered: 0 } });
  });

  it("exit 1 on hits, entries annotated with their coverage state", async () => {
    vi.stubGlobal("fetch", fakeFetch());
    const root = repo({ "PROC-DEV-031": 1, "GL-CODE-010": 1, "GL-GONE-001": 4 });
    mkdirSync(join(root, ".spec-sync"), { recursive: true });
    writeFileSync(
      join(root, COVERAGE_FILE),
      `${JSON.stringify({ ts: "t", key: "PROC-DEV-031", from: 1, to: 2, disposition: "ticket", ref: "16" })}\n`,
    );

    const result = await runDrift(ctxFor(root));
    expect(result).toMatchObject({ ok: false, exit: EXIT.FAILED });
    expect(result.data).toMatchObject({
      moved: [
        { key: "GL-GONE-001", from: 4, to: null, covered: false },
        { key: "PROC-DEV-031", from: 1, to: 2, covered: true },
      ],
      counts: { moved: 2, covered: 1 },
    });
  });

  it("maps an unreachable server to exit 2, never to 'no drift'", async () => {
    vi.stubGlobal("fetch", (() =>
      Promise.reject(new Error("ECONNREFUSED"))) as unknown as typeof globalThis.fetch);
    await expect(runDrift(ctxFor(repo({ "PROC-DEV-031": 2 })))).rejects.toSatisfy(
      (error: unknown) => error instanceof ToolkitError && error.exit === EXIT.UNPROVABLE,
    );
  });
});
