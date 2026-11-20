/**
 * The defaults of the optional loop commands (`queue`, `merge`, `handover`):
 * sort tiers, labels and the merge model. They are code defaults, not a norm
 * the toolkit tracks against the spec server (SST-DESIGN-015 rev 5) — no lead
 * has to use these commands. Also the spec server's HTTP client; the read
 * path is HTTP — never local spec files (spec §10).
 */

import { ToolkitError, EXIT } from "./output.js";

/** The defaults the optional loop commands work with. */
export interface Norms {
  sortTiers: string[];
  hold: string;
  /** `status: deferred` — owner-deferred, planned but not to be built now (PROC-DEV-010 rev 5). */
  deferred: string;
  buildLabel: string;
  /**
   * The mechanical marker for "started": a ticket with increments already merged
   * to `main`. Tier 2 sorts on this label and nothing else — "started" is a
   * state, not a judgement.
   */
  startedLabel: string;
  mergeModel: string;
}

/** The built-in defaults. */
export const NORM_DEFAULTS: Norms = {
  sortTiers: ["auto-audit", "type: bug", "started-first", "phase-asc", "issue-number-asc"],
  hold: "owner-hold",
  deferred: "status: deferred",
  buildLabel: "spec-sync",
  startedLabel: "status: in-progress",
  mergeModel: "local-squash-single-push",
};

/** Default base URL of the spec server. */
export const SPEC_MCP_URL = "http://localhost:8787";

/** Where the effective norms came from. Only "defaults" exists today (§6). */
export type NormSource = "defaults" | "spec";

export interface LoadedNorms {
  norms: Norms;
  source: NormSource;
}

/** The effective norms for this run: always the code defaults. */
export function loadNorms(): LoadedNorms {
  return {
    norms: { ...NORM_DEFAULTS, sortTiers: [...NORM_DEFAULTS.sortTiers] },
    source: "defaults",
  };
}

/** Parses a `spec_pins` response: one `KEY=rev` pair per line (SMCP-DESIGN-012). */
export function parsePins(text: string): Map<string, number> {
  const pins = new Map<string, number>();
  for (const line of text.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    const eq = trimmed.indexOf("=");
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const rev = Number.parseInt(trimmed.slice(eq + 1).trim(), 10);
    if (key !== "" && Number.isFinite(rev)) pins.set(key, rev);
  }
  return pins;
}

/**
 * Minimal MCP client over streamable HTTP: initialize, then one `tools/call`.
 * Deliberately hand-rolled — the toolkit stays free of an SDK dependency
 * (spec §10, dependencies kept narrow).
 *
 * The spec server answers every tool in Markdown text, never nested JSON
 * (spec-server-v2 Bauplan §3) — this returns that text verbatim; callers parse
 * what they need (a `KEY=rev` map, a spec block, …).
 */
export async function callSpecTool(
  name: string,
  args: Record<string, unknown>,
  baseUrl: string = SPEC_MCP_URL,
): Promise<string> {
  const endpoint = `${baseUrl.replace(/\/$/, "")}/mcp`;
  const headers: Record<string, string> = {
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  };

  const init = await post(endpoint, headers, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "spec-sync-toolkit", version: "0.1.0" },
    },
  });
  const session = init.headers.get("mcp-session-id");
  if (session !== null) headers["mcp-session-id"] = session;
  await post(endpoint, headers, { jsonrpc: "2.0", method: "notifications/initialized" });

  const response = await post(endpoint, headers, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/call",
    params: { name, arguments: args },
  });
  const payload = parseJsonRpc(await response.text());
  const text = payload?.result?.content?.[0]?.text;
  if (typeof text !== "string") {
    throw new ToolkitError(`spec-mcp returned no content for ${name}`, EXIT.PRECONDITION);
  }
  return text;
}

/**
 * `reason: "unreachable"` marks the network layer specifically (connection
 * refused, non-2xx handshake) — the class `repin` maps to exit 2
 * (SST-DESIGN-025), as opposed to a well-formed JSON-RPC error, which stays
 * exit 4 like any other violated precondition.
 */
async function post(
  endpoint: string,
  headers: Record<string, string>,
  body: unknown,
): Promise<globalThis.Response> {
  let response: globalThis.Response;
  try {
    response = await fetch(endpoint, { method: "POST", headers, body: JSON.stringify(body) });
  } catch (error) {
    throw new ToolkitError(`spec-mcp unreachable at ${endpoint}`, EXIT.PRECONDITION, {
      cause: error,
      reason: "unreachable",
    });
  }
  if (!response.ok) {
    throw new ToolkitError(
      `spec-mcp answered ${response.status} at ${endpoint}`,
      EXIT.PRECONDITION,
      { reason: "unreachable" },
    );
  }
  return response;
}

interface JsonRpcResult {
  result?: { content?: { text?: string }[] };
  error?: { message?: string };
}

/**
 * The server answers as an SSE stream (`event: message` / `data: {…}`) even for
 * a single call, so the payload is extracted from the `data:` line.
 */
function parseJsonRpc(raw: string): JsonRpcResult | undefined {
  const trimmed = raw.trim();
  const line = trimmed.startsWith("{")
    ? trimmed
    : trimmed
        .split("\n")
        .find((l) => l.startsWith("data:"))
        ?.slice("data:".length)
        .trim();
  if (line === undefined) return undefined;
  const parsed = JSON.parse(line) as JsonRpcResult;
  if (parsed.error !== undefined) {
    throw new ToolkitError(
      `spec-mcp error: ${parsed.error.message ?? "unknown"}`,
      EXIT.PRECONDITION,
    );
  }
  return parsed;
}
