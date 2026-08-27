import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CommandContext } from "../src/cli.js";
import { runCover } from "../src/commands/cover.js";
import { COVERAGE_FILE, type Receipt } from "../src/coverage.js";
import type { Config } from "../src/config.js";
import { EXIT } from "../src/output.js";

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
  const root = mkdtempSync(join(tmpdir(), "cover-"));
  writeFileSync(
    join(root, ".mcp.json"),
    JSON.stringify({ mcpServers: { spec: { type: "http", url: "http://localhost:8787/mcp" } } }),
  );
  if (pins !== undefined) writeFileSync(join(root, "spec-pins.json"), JSON.stringify(pins));
  return root;
}

const ctxFor = (root: string, args: string[], dryRun = false): CommandContext => ({
  flags: { human: false, dryRun },
  args,
  repoRoot: root,
  config: { project: "production-cockpit" } as Config,
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("cover (SST-DESIGN-029)", () => {
  it("needs exactly one of --ticket / --editorial", async () => {
    vi.stubGlobal("fetch", fakeFetch());
    const root = repo({ "PROC-DEV-031": 1 });
    await expect(runCover(ctxFor(root, ["PROC-DEV-031"]))).rejects.toMatchObject({
      exit: EXIT.PRECONDITION,
    });
    await expect(
      runCover(ctxFor(root, ["PROC-DEV-031", "--ticket", "16", "--editorial", "x"])),
    ).rejects.toMatchObject({ exit: EXIT.PRECONDITION });
  });

  it("refuses a key that is not moved and writes nothing (all-or-nothing)", async () => {
    vi.stubGlobal("fetch", fakeFetch());
    const root = repo({ "PROC-DEV-031": 1, "GL-CODE-010": 1 });
    // GL-CODE-010 is in sync — the whole call must fail, including the moved key.
    await expect(
      runCover(ctxFor(root, ["PROC-DEV-031,GL-CODE-010", "--ticket", "16"])),
    ).rejects.toMatchObject({ exit: EXIT.PRECONDITION });
    expect(existsSync(join(root, COVERAGE_FILE))).toBe(false);
  });

  it("writes one receipt per key, revisions from the comparison", async () => {
    vi.stubGlobal("fetch", fakeFetch());
    const root = repo({ "PROC-DEV-031": 1, "GL-GONE-001": 4 });

    const result = await runCover(ctxFor(root, ["PROC-DEV-031,GL-GONE-001", "--ticket", "16"]));
    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({ covered: 2, disposition: "ticket" });

    const lines = readFileSync(join(root, COVERAGE_FILE), "utf8").trim().split("\n");
    const receipts = lines.map((line) => JSON.parse(line) as Receipt);
    expect(receipts).toHaveLength(2);
    expect(receipts[0]).toMatchObject({ key: "PROC-DEV-031", from: 1, to: 2, ref: "16" });
    // Removed on the server: a removal receipt with `to: null`.
    expect(receipts[1]).toMatchObject({ key: "GL-GONE-001", from: 4, to: null });
  });

  it("dry run validates but leaves the ledger untouched", async () => {
    vi.stubGlobal("fetch", fakeFetch());
    const root = repo({ "PROC-DEV-031": 1 });
    const result = await runCover(
      ctxFor(root, ["PROC-DEV-031", "--editorial", "wording only"], true),
    );
    expect(result.ok).toBe(true);
    expect(existsSync(join(root, COVERAGE_FILE))).toBe(false);
  });
});
