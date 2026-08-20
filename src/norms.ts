/**
 * Norm binding (spec §6, ADR "Entscheidung 3").
 *
 * Sort tiers, label taxonomy, `owner-hold` precedence and the merge model are
 * *not* the toolkit's to define — they come from the foundation's
 * `PROC-DEV-015` subtree (Worker-Loop): `PROC-DEV-039` (sort tiers),
 * `PROC-DEV-010` (label taxonomy), `PROC-DEV-047` (`owner-hold` precedence),
 * `PROC-DEV-044` (merge model) — SST-DESIGN-015.
 *
 * Target state: the toolkit reads them live over `spec_get`. Transitional
 * state (what this module implements): the defaults live here in code
 * **plus** the revision each was transcribed from. `doctor` reports a moved
 * revision as a finding, which makes the transitional state visible instead
 * of silent. The read path is HTTP — never local spec files (spec §10).
 */

import { ToolkitError, EXIT } from "./output.js";

/** The norms as of the pinned revisions. Kept in sync by `doctor`, not by hand. */
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

/** Defaults verbatim from the specs listed in `PINNED_NORM_SPECS`. */
export const NORM_DEFAULTS: Norms = {
  sortTiers: ["auto-audit", "type: bug", "started-first", "phase-asc", "issue-number-asc"],
  hold: "owner-hold",
  buildLabel: "spec-sync",
  startedLabel: "status: in-progress",
  mergeModel: "local-squash-single-push",
};

export interface PinnedNormSpec {
  key: string;
  rev: number;
}

/**
 * The foundation specs `NORM_DEFAULTS` was transcribed from, pinned by
 * revision (SST-DESIGN-015). A moved revision means the norm changed and the
 * defaults above may be stale.
 */
export const PINNED_NORM_SPECS: readonly PinnedNormSpec[] = [
  { key: "PROC-DEV-039", rev: 2 }, // Sortierstufen (1)-(4) & Wegbereiter-Erbung
  { key: "PROC-DEV-010", rev: 3 }, // Ticket-Tracking & Label-Taxonomie
  { key: "PROC-DEV-047", rev: 2 }, // Betriebsprofil: Autonomie, Label-Semantik, owner-hold
  { key: "PROC-DEV-044", rev: 3 }, // Ticket-Abschluss: Merge-Modell & Aufräumen
];

/** The project the pinned norm specs live in — always `foundation` (SST-DESIGN-015). */
export const PINNED_NORM_PROJECT = "foundation";

/** Default base URL of the spec server. */
export const SPEC_MCP_URL = "http://localhost:8787";

/** Where the effective norms came from. Only "defaults" exists today (§6). */
export type NormSource = "defaults" | "spec";

export interface LoadedNorms {
  norms: Norms;
  source: NormSource;
  pinnedSpecs: readonly PinnedNormSpec[];
}

/** The effective norms for this run. Transitional: always the code defaults. */
export function loadNorms(): LoadedNorms {
  return {
    norms: { ...NORM_DEFAULTS, sortTiers: [...NORM_DEFAULTS.sortTiers] },
    source: "defaults",
    pinnedSpecs: PINNED_NORM_SPECS,
  };
}

export interface NormDrift {
  /** Pinned specs whose current revision no longer matches the pinned one. */
  moved: { key: string; pinnedRev: number; currentRev: number }[];
  /** true once at least one pinned spec moved. */
  drifted: boolean;
  /** Set when the current revisions could not be determined (server down). */
  unreachable?: string;
}

/** Reads `{key: rev}` for every spec of one project. `undefined` when unreadable. */
export type PinsReader = (project: string) => Promise<Map<string, number> | undefined>;

/**
 * Compares the pinned revisions against the server's current ones — the
 * finding `doctor` reports (spec §6, SST-DESIGN-022). An unreachable server is
 * reported as `unreachable`, not as drift: absence of an answer is not a
 * changed norm.
 */
export async function checkNormDrift(read: PinsReader = readPinsOverHttp): Promise<NormDrift> {
  let pins: Map<string, number> | undefined;
  try {
    pins = await read(PINNED_NORM_PROJECT);
  } catch (error) {
    return {
      moved: [],
      drifted: false,
      unreachable: error instanceof Error ? error.message : String(error),
    };
  }

  if (pins === undefined) {
    return {
      moved: [],
      drifted: false,
      unreachable: `spec_pins returned nothing for ${PINNED_NORM_PROJECT}`,
    };
  }

  const moved = PINNED_NORM_SPECS.flatMap(({ key, rev }) => {
    const current = pins.get(key);
    if (current === undefined || current === rev) return [];
    return [{ key, pinnedRev: rev, currentRev: current }];
  });
  return { moved, drifted: moved.length > 0 };
}

async function readPinsOverHttp(project: string): Promise<Map<string, number> | undefined> {
  const text = await callSpecTool("spec_pins", { project });
  return parsePins(text);
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
