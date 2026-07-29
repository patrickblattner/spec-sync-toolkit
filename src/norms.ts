/**
 * Norm binding (spec §6, ADR "Entscheidung 3").
 *
 * Sort tiers, label taxonomy, `owner-hold` precedence and the merge model are
 * *not* the toolkit's to define — they come from `foundation.dev.process`
 * §Worker-Loop.
 *
 * Target state: a fenced JSON block inside that section, read over the spec-mcp
 * HTTP API.
 *
 * Transitional state (what this module implements): the defaults live here in
 * code **plus** a pinned section hash. `doctor` reports a moved hash as a
 * finding, which makes the transitional state visible instead of silent. The
 * read path is HTTP — never the local spec files (spec §10).
 */

import { ToolkitError, EXIT } from "./output.js";

/** The norms as of the pinned section. Kept in sync by `doctor`, not by hand. */
export interface Norms {
  sortTiers: string[];
  hold: string;
  buildLabel: string;
  /**
   * The mechanical marker for "started": a ticket with increments already merged
   * to `main`. Tier 2 sorts on this label and nothing else — "started" is a
   * state, not a judgement.
   */
  startedLabel: string;
  mergeModel: string;
}

/** Defaults verbatim from spec §6. */
export const NORM_DEFAULTS: Norms = {
  sortTiers: ["auto-audit", "type: bug", "started-first", "phase-asc", "issue-number-asc"],
  hold: "owner-hold",
  buildLabel: "spec-sync",
  startedLabel: "status: in-progress",
  mergeModel: "local-squash-single-push",
};

/**
 * The section the defaults were transcribed from, pinned by hash. A moved hash
 * means the norm changed and the defaults above may be stale.
 */
export const PINNED_NORM_SECTION = {
  unit: "foundation.dev.process",
  version: "2.7.0",
  section: "entwicklungs-workflow-tickets-backlog-commits-specs/worker-loop-spec-sync",
  hash: "4d45abd6d9f521f1322311c2588397ee63c910937882904c2d61d7efb082f8f9",
} as const;

/** Default base URL of the spec-mcp server. */
export const SPEC_MCP_URL = "http://localhost:8787";

/** Where the effective norms came from. Only "defaults" exists today (§6). */
export type NormSource = "defaults" | "spec";

export interface LoadedNorms {
  norms: Norms;
  source: NormSource;
  pinnedHash: string;
}

/** The effective norms for this run. Transitional: always the code defaults. */
export function loadNorms(): LoadedNorms {
  return {
    norms: { ...NORM_DEFAULTS, sortTiers: [...NORM_DEFAULTS.sortTiers] },
    source: "defaults",
    pinnedHash: PINNED_NORM_SECTION.hash,
  };
}

export interface NormDrift {
  unit: string;
  section: string;
  pinnedHash: string;
  currentHash?: string;
  /** true when the current hash is known and differs from the pinned one. */
  drifted: boolean;
  /** Set when the current hash could not be determined (server down, unknown id). */
  unreachable?: string;
}

/** Reads the current section hash of the pinned norm section. */
export type SectionHashReader = (unit: string, section: string) => Promise<string | undefined>;

/**
 * Compares the pinned section hash against the server's current one — the
 * finding `doctor` reports (spec §7.7). An unreachable server is reported as
 * `unreachable`, not as drift: absence of an answer is not a changed norm.
 */
export async function checkNormDrift(
  read: SectionHashReader = readSectionHashOverHttp,
): Promise<NormDrift> {
  const base: NormDrift = {
    unit: PINNED_NORM_SECTION.unit,
    section: PINNED_NORM_SECTION.section,
    pinnedHash: PINNED_NORM_SECTION.hash,
    drifted: false,
  };

  let currentHash: string | undefined;
  try {
    currentHash = await read(PINNED_NORM_SECTION.unit, PINNED_NORM_SECTION.section);
  } catch (error) {
    return { ...base, unreachable: error instanceof Error ? error.message : String(error) };
  }

  if (currentHash === undefined) {
    return { ...base, unreachable: `section not found: ${PINNED_NORM_SECTION.section}` };
  }
  return { ...base, currentHash, drifted: currentHash !== PINNED_NORM_SECTION.hash };
}

/**
 * The HTTP read path (spec §10). `get_manifest` returns a spec.lock/v3 snapshot
 * whose entries carry per-section subtree hashes — the one value we need.
 */
async function readSectionHashOverHttp(unit: string, section: string): Promise<string | undefined> {
  const project = unit.split(".")[0] ?? unit;
  const snapshot = await callSpecTool<{
    snapshot?: { entries?: { id: string; sections?: Record<string, string> }[] };
  }>("get_manifest", { project });
  const entry = snapshot.snapshot?.entries?.find((e) => e.id === unit);
  return entry?.sections?.[section];
}

/**
 * Minimal MCP client over streamable HTTP: initialize, then one `tools/call`.
 * Deliberately hand-rolled — the toolkit stays free of an SDK dependency
 * (spec §10, dependencies kept narrow).
 */
export async function callSpecTool<T>(
  name: string,
  args: Record<string, unknown>,
  baseUrl: string = SPEC_MCP_URL,
): Promise<T> {
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
  return JSON.parse(text) as T;
}

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
    });
  }
  if (!response.ok) {
    throw new ToolkitError(
      `spec-mcp answered ${response.status} at ${endpoint}`,
      EXIT.PRECONDITION,
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
