/**
 * `repin` — rewrite the pin file, without its content ever passing through a
 * model context (SST-DESIGN-025).
 *
 * `spec-sync repin [--ids <a,b>] [--server <url>]`
 *
 * The server endpoint comes from the repo's `.mcp.json` (`spec` entry);
 * `--server` overrides. Neither present ⇒ exit 4. Both are accepted in full
 * (`http://host:8787/mcp`) or base form — `toBaseUrl` normalizes, because
 * `callSpecTool` appends `/mcp` itself. The default is a full fetch
 * (`spec_pins` with the config's `project`) and an atomic replace of
 * `spec-pins.json` — only that way do deleted specs disappear from the pin.
 * `--ids` updates only the named entries of an *existing* pin file (the rest
 * stays byte-identical) and cannot remove an entry; `--ids` without an
 * existing pin file ⇒ exit 4.
 *
 * Server unreachable or handshake aborted ⇒ exit 2. The response carries
 * `pinsPath`, `mode` (`full`|`ids`) and `units` — counts and a path, never the
 * pin content itself.
 *
 * Coverage gate (SST-ADR-011, spec rev 4): a moved key without a valid receipt
 * in the coverage ledger blocks the write — exit 4, `uncovered` names the keys,
 * the pin file stays untouched. Only the bootstrap full run (no existing pin
 * file) is exempt; there is no bypass flag.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command, CommandContext, CommandResult } from "../cli.js";
import type { Config } from "../config.js";
import { computeMoved, isCovered, readReceipts } from "../coverage.js";
import { callSpecTool, parsePins } from "../norms.js";
import { EXIT, ToolkitError } from "../output.js";
import { checkFlags, valueFlag } from "../pack/args.js";
import { PINS_FILE, readPinsFile, writePinsFile, type PinsMap } from "../pins.js";

export const repinCommand: Command = {
  name: "repin",
  summary: "Rewrite spec-pins.json from spec_pins",
  needsConfig: true,
  run: (ctx) => runRepin(ctx),
};

export async function runRepin(ctx: CommandContext): Promise<CommandResult> {
  checkFlags(ctx.args, ["--ids", "--server"]);
  const config = ctx.config as Config;

  const idsFlag = valueFlag(ctx.args, "--ids");
  const server = resolveServer(ctx.repoRoot, ctx.args);

  const existing = readPinsFile(ctx.repoRoot);
  if (idsFlag !== undefined && existing === undefined) {
    throw new ToolkitError(`--ids needs an existing ${PINS_FILE}`, EXIT.PRECONDITION, {
      field: PINS_FILE,
    });
  }

  const fetched = await fetchPins(config.project, server);

  const notes: string[] = [];
  let pins: PinsMap;
  let units: number;
  const mode: "full" | "ids" = idsFlag === undefined ? "full" : "ids";
  const wanted =
    idsFlag === undefined
      ? []
      : idsFlag
          .split(",")
          .map((id) => id.trim())
          .filter((id) => id !== "");

  // Coverage gate (SST-ADR-011): bootstrap (no pin file) is the one exemption.
  if (existing !== undefined) {
    const moved = computeMoved(existing, fetched);
    // --ids cannot remove entries, so removed keys (`to: null`) never change there.
    const relevant =
      mode === "full" ? moved : moved.filter((m) => wanted.includes(m.key) && m.to !== null);
    if (relevant.length > 0) {
      const receipts = readReceipts(ctx.repoRoot);
      const uncovered = relevant.filter((m) => !isCovered(m, receipts)).map((m) => m.key);
      if (uncovered.length > 0) {
        return {
          ok: false,
          exit: EXIT.PRECONDITION,
          notes: [
            `coverage gate: ${uncovered.length} moved key(s) without a valid receipt — spec_diff and cover them first (SST-ADR-011)`,
          ],
          data: { pinsPath: PINS_FILE, mode, uncovered },
        };
      }
    }
  }

  if (mode === "full") {
    pins = Object.fromEntries(fetched);
    units = fetched.size;
  } else {
    pins = { ...(existing as PinsMap) };
    let updated = 0;
    for (const id of wanted) {
      const rev = fetched.get(id);
      if (rev === undefined) {
        notes.push(`${id}: not in the current spec_pins response — left as is`);
        continue;
      }
      pins[id] = rev;
      updated += 1;
    }
    units = updated;
  }

  const pinsPath = PINS_FILE;
  if (ctx.flags.dryRun) {
    notes.push(`dry run: ${PINS_FILE} was not written`);
  } else {
    writePinsFile(ctx.repoRoot, pins);
  }

  return { ok: true, notes, data: { pinsPath, mode, units } };
}

/**
 * `spec_pins` over HTTP. A network-layer failure (`reason: "unreachable"`,
 * set by `norms.ts`'s `post()`) is remapped to exit 2 — SST-DESIGN-025's own
 * exception to the toolkit's usual exit-4-for-unreachable default. A
 * well-formed JSON-RPC error stays whatever `callSpecTool` threw.
 */
export async function fetchPins(project: string, server: string): Promise<Map<string, number>> {
  try {
    const text = await callSpecTool("spec_pins", { project }, server);
    return parsePins(text);
  } catch (error) {
    if (error instanceof ToolkitError && error.reason === "unreachable") {
      throw new ToolkitError(error.message, EXIT.UNPROVABLE, {
        field: error.field,
        reason: error.reason,
        cause: error.cause,
      });
    }
    throw error;
  }
}

/**
 * Normalizes a spec-server URL to the **base** form `callSpecTool` expects — it
 * appends `/mcp` itself.
 *
 * Both sources carry the *full* endpoint: `.mcp.json` does by MCP convention
 * (`"url": "http://localhost:8787/mcp"`), and `--server` does whenever someone
 * copies that value out of the file. Without this, the request went to
 * `…/mcp/mcp` — 404, reported as exit 2 "unreachable", which made the
 * auto-detection useless in every repo (cockpit migration finding, 2026-08-21;
 * the workaround was passing `--server` in base form by hand).
 */
/** Endpoint resolution shared with `drift` and `cover`: `--server` beats `.mcp.json`. */
export function resolveServer(repoRoot: string, args: string[]): string {
  const endpoint = valueFlag(args, "--server") ?? readMcpServerUrl(repoRoot);
  if (endpoint === undefined) {
    throw new ToolkitError(
      "no spec server endpoint — set the `spec` entry in .mcp.json or pass --server",
      EXIT.PRECONDITION,
      { field: "server" },
    );
  }
  return toBaseUrl(endpoint);
}

export function toBaseUrl(url: string): string {
  return url
    .replace(/\/+$/, "")
    .replace(/\/mcp$/, "")
    .replace(/\/+$/, "");
}

/** The `spec` server entry of `.mcp.json`, or `undefined` when absent/unreadable. */
function readMcpServerUrl(repoRoot: string): string | undefined {
  const path = join(repoRoot, ".mcp.json");
  if (!existsSync(path)) return undefined;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as {
      mcpServers?: Record<string, { url?: string }>;
    };
    return parsed.mcpServers?.spec?.url;
  } catch {
    return undefined;
  }
}
