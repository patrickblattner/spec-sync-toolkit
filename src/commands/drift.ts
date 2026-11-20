/**
 * `drift` — a write-free look-up (SST-DESIGN-028 rev 3), never a gate.
 *
 * `spec-sync drift [--server <url>]`
 *
 * Compares the server's `spec_pins` against `spec-pins.json` and names every
 * moved key — changed, added, removed.
 *
 * Hits ⇒ exit 1; no hits ⇒ exit 0 with an empty list; server
 * unreachable ⇒ exit 2, never "no drift"; missing pin file ⇒ exit 4
 * (bootstrap runs `repin` first).
 *
 * Keys matching `pinExclude` (SST-DESIGN-025 rev 5) are never drift — neither
 * on the server side nor as leftovers in an older pin file.
 */

import type { Command, CommandContext, CommandResult } from "../cli.js";
import type { Config } from "../config.js";
import { EXIT, ToolkitError } from "../output.js";
import { checkFlags } from "../pack/args.js";
import { computeMoved, excludeMatcher, PINS_FILE, readPinsFile, withoutExcluded } from "../pins.js";
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

  const isExcluded = excludeMatcher(config.pinExclude);
  const fetched = withoutExcluded(await fetchPins(config.project, server), isExcluded);
  const moved = computeMoved(withoutExcluded(pinned, isExcluded), fetched);

  return {
    ok: moved.length === 0,
    exit: moved.length === 0 ? EXIT.OK : EXIT.FAILED,
    notes:
      moved.length === 0 ? [] : [`${moved.length} moved key(s) — spec_diff shows what changed`],
    data: { moved, counts: { moved: moved.length } },
  };
}
