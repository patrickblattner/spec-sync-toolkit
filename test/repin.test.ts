import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../src/cli.js";
import type { Config } from "../src/config.js";
import { runRepin, toBaseUrl } from "../src/commands/repin.js";

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

describe("repin endpoint resolution (Befund Cockpit-Migration 2026-08-21)", () => {
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
