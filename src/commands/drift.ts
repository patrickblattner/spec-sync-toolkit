/**
 * `drift` — the loop's drift detector as a write-free command (SST-DESIGN-028).
 *
 * `spec-sync drift [--server <url>]`
 *
 * Compares the server's `spec_pins` against `spec-pins.json` and names every
 * moved key — changed, added, removed — each annotated with `covered`: whether
 * a valid receipt for exactly this transition exists in the coverage ledger
 * (SST-DESIGN-029). It replaces the repin→`git diff`→checkout detection detour.
 *
 * Hits ⇒ exit 1 (gate-usable); no hits ⇒ exit 0 with an empty list; server
 * unreachable ⇒ exit 2, never "no drift"; missing pin file ⇒ exit 4
 * (bootstrap runs `repin` first).
 */

import type { Command, CommandContext, CommandResult } from "../cli.js";
import type { Config } from "../config.js";
import { computeMoved, isCovered, readReceipts } from "../coverage.js";
import { EXIT, ToolkitError } from "../output.js";
import { checkFlags } from "../pack/args.js";
import { PINS_FILE, readPinsFile } from "../pins.js";
import { fetchPins, resolveServer } from "./repin.js";

export const driftCommand: Command = {
  name: "drift",
  summary: "Write-free pin↔server comparison — names every moved key",
  needsConfig: true,
  run: (ctx) => runDrift(ctx),
};

export async function runDrift(ctx: CommandContext): Promise<CommandResult> {
  checkFlags(ctx.args, ["--server"]);
  const config = ctx.config as Config;
  const server = resolveServer(ctx.repoRoot, ctx.args);

  const pinned = readPinsFile(ctx.repoRoot);
  if (pinned === undefined) {
    throw new ToolkitError(
      `drift needs an existing ${PINS_FILE} — bootstrap with repin`,
      EXIT.PRECONDITION,
      { field: PINS_FILE },
    );
  }

  const fetched = await fetchPins(config.project, server);
  const receipts = readReceipts(ctx.repoRoot);
  const moved = computeMoved(pinned, fetched).map((entry) => ({
    ...entry,
    covered: isCovered(entry, receipts),
  }));
  const covered = moved.filter((entry) => entry.covered).length;

  return {
    ok: moved.length === 0,
    exit: moved.length === 0 ? EXIT.OK : EXIT.FAILED,
    notes:
      moved.length === 0
        ? []
        : [`${moved.length} moved key(s), ${covered} covered — spec_diff each, then cover`],
    data: { moved, counts: { moved: moved.length, covered } },
  };
}
