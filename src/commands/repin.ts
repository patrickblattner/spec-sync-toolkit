/**
 * `repin` — rewrite the pin file, without its content ever passing through a
 * model context (SST-DESIGN-025).
 *
 * `spec-sync repin [--ids <a,b>] [--server <url>]`
 * `spec-sync repin --check [--server <url>]` — read-only staleness check, see `runCheck`.
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
 * `pinsPath`, `mode` (`full`|`ids`), `units` and `excluded` — counts and a
 * path, never the pin content itself.
 *
 * `pinExclude` (spec rev 5) drops matching keys from the fetched map before
 * anything is compared or written; in `--ids` mode an excluded id is ignored.
 * `excluded` counts the dropped keys (full: fetched keys; ids: named ids).
 *
 * Coverage gate (SST-ADR-011, spec rev 4): a moved key without a valid receipt
 * in the coverage ledger blocks the write — exit 4, `uncovered` names the keys,
 * the pin file stays untouched. Only the bootstrap full run (no existing pin
 * file) and keys dropped by `pinExclude` are exempt; there is no bypass flag.
 */

import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Command, CommandContext, CommandResult } from "../cli.js";
import type { Config } from "../config.js";
import { COVERAGE_FILE, computeMoved, isCovered, readReceipts } from "../coverage.js";
import { callSpecTool, parsePins } from "../norms.js";
import { EXIT, ToolkitError } from "../output.js";
import { checkFlags, valueFlag } from "../pack/args.js";
import { failureLine, runProcess } from "../pack/exec.js";
import {
  excludeMatcher,
  PINS_FILE,
  readPinsFile,
  withoutExcluded,
  writePinsFile,
  type PinsMap,
} from "../pins.js";

export const repinCommand: Command = {
  name: "repin",
  summary: "Rewrite spec-pins.json from spec_pins",
  needsConfig: true,
  run: (ctx) => runRepin(ctx),
};

export async function runRepin(ctx: CommandContext): Promise<CommandResult> {
  checkFlags(ctx.args, ["--ids", "--server"], ["--check"]);
  const config = ctx.config as Config;

  const idsFlag = valueFlag(ctx.args, "--ids");
  if (ctx.args.includes("--check")) {
    if (idsFlag !== undefined) {
      throw new ToolkitError("--check cannot be combined with --ids", EXIT.PRECONDITION, {
        field: "--check",
      });
    }
    return runCheck(ctx, config);
  }
  const server = resolveServer(ctx.repoRoot, ctx.args);

  const existing = readPinsFile(ctx.repoRoot);
  if (idsFlag !== undefined && existing === undefined) {
    throw new ToolkitError(`--ids needs an existing ${PINS_FILE}`, EXIT.PRECONDITION, {
      field: PINS_FILE,
    });
  }

  const isExcluded = excludeMatcher(config.pinExclude);
  const rawFetched = await fetchPins(config.project, server);
  const fetched = withoutExcluded(rawFetched, isExcluded);

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
  const excluded =
    mode === "full" ? rawFetched.size - fetched.size : wanted.filter(isExcluded).length;

  // Coverage gate (SST-ADR-011): bootstrap (no pin file) and keys that leave
  // only because of `pinExclude` are the exemptions.
  if (existing !== undefined) {
    const moved = computeMoved(withoutExcluded(existing, isExcluded), fetched);
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
      if (isExcluded(id)) {
        notes.push(`${id}: matches pinExclude — ignored`);
        continue;
      }
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

  return { ok: true, notes, data: { pinsPath, mode, units, excluded } };
}

/**
 * `repin --check` (PROC-DEV-005 §Pins with the change): read-only, usable from
 * a pre-push hook. Stale means the push would leave pins or coverage behind:
 *
 *   - `spec-pins.json` or the coverage ledger differ from `HEAD` (uncommitted
 *     or untracked) — the change is not in the commit being pushed;
 *   - a moved key already carries a valid receipt but is not pinned — `repin`
 *     (full or `--ids`) would write it now, so it belongs in this commit.
 *
 * A moved key without a receipt is fresh server drift, not this push's
 * business — counted in a note, never a red. Exit 0 clean · 1 stale (keys and
 * files listed) · 2 server unreachable and nothing local stale (a hook passes
 * on 2 with a line) · 4 no pin file. Nothing is written, ever.
 */
async function runCheck(ctx: CommandContext, config: Config): Promise<CommandResult> {
  const notes: string[] = [];
  const existing = readPinsFile(ctx.repoRoot);
  if (existing === undefined) {
    throw new ToolkitError(
      `repin --check needs an existing ${PINS_FILE} — bootstrap with repin`,
      EXIT.PRECONDITION,
      { field: PINS_FILE },
    );
  }

  const status = runProcess(
    "git",
    ["status", "--porcelain", "--untracked-files=all", "--", PINS_FILE, COVERAGE_FILE],
    ctx.repoRoot,
  );
  let uncommitted: string[] = [];
  if (status.ok) {
    uncommitted = status.stdout
      .split("\n")
      .filter((line) => line.trim() !== "")
      .map((line) => line.slice(3).trim());
  } else {
    notes.push(`git status failed — uncommitted check skipped: ${failureLine(status)}`);
  }

  const server = resolveServer(ctx.repoRoot, ctx.args);
  const isExcluded = excludeMatcher(config.pinExclude);
  let fetched: Map<string, number>;
  try {
    fetched = withoutExcluded(await fetchPins(config.project, server), isExcluded);
  } catch (error) {
    // Unreachable is exit 2 — unless something local is already provably stale.
    if (!(error instanceof ToolkitError && error.exit === EXIT.UNPROVABLE)) throw error;
    if (uncommitted.length === 0) throw error;
    notes.push(`spec server unreachable — server comparison skipped: ${error.message}`);
    fetched = new Map(Object.entries(withoutExcluded(existing, isExcluded)));
  }

  const receipts = readReceipts(ctx.repoRoot);
  const moved = computeMoved(withoutExcluded(existing, isExcluded), fetched);
  const stale = moved.filter((m) => isCovered(m, receipts)).map((m) => m.key);
  const uncovered = moved.length - stale.length;
  if (uncovered > 0) {
    notes.push(
      `${uncovered} moved key(s) without a receipt — fresh drift for the loop, not stale for this push`,
    );
  }

  const ok = stale.length === 0 && uncommitted.length === 0;
  if (stale.length > 0) {
    notes.push(
      `${stale.length} receipted key(s) not pinned — run \`spec-sync repin --ids ${stale.join(",")}\` and commit with the change`,
    );
  }
  if (uncommitted.length > 0) {
    notes.push(`not committed: ${uncommitted.join(", ")} — commit it with the change`);
  }
  return {
    ok,
    exit: ok ? EXIT.OK : EXIT.FAILED,
    notes,
    data: { pinsPath: PINS_FILE, mode: "check", stale, uncommitted, uncovered },
  };
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
