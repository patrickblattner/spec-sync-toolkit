/**
 * `cover` — records the disposition of drifted keys: the receipt the repin
 * coverage gate demands (SST-DESIGN-029, SST-ADR-011).
 *
 * `spec-sync cover <key>[,<key>…] (--ticket <n> | --editorial "<reason>") [--server <url>]`
 *
 * Exactly one disposition flag; it applies to all named keys. Every named key
 * must currently be moved — any that is not ⇒ exit 4 and nothing is written
 * (no receipts on stock). The revisions in the receipt come from the
 * pin↔server comparison, never from the model.
 */

import type { Command, CommandContext, CommandResult } from "../cli.js";
import type { Config } from "../config.js";
import {
  COVERAGE_FILE,
  appendReceipts,
  computeMoved,
  type MovedEntry,
  type Receipt,
} from "../coverage.js";
import { EXIT, ToolkitError } from "../output.js";
import { checkFlags, positionals, valueFlag } from "../pack/args.js";
import { PINS_FILE, readPinsFile } from "../pins.js";
import { fetchPins, resolveServer } from "./repin.js";

export const coverCommand: Command = {
  name: "cover",
  summary: "Receipt drifted keys with a ticket or an editorial reason",
  needsConfig: true,
  run: (ctx) => runCover(ctx),
};

const VALUE_FLAGS = ["--ticket", "--editorial", "--server"];

export async function runCover(ctx: CommandContext): Promise<CommandResult> {
  checkFlags(ctx.args, VALUE_FLAGS);
  const config = ctx.config as Config;

  const ticket = valueFlag(ctx.args, "--ticket");
  const editorial = valueFlag(ctx.args, "--editorial");
  if ((ticket === undefined) === (editorial === undefined)) {
    throw new ToolkitError(
      "cover needs exactly one of --ticket or --editorial",
      EXIT.PRECONDITION,
      { field: "--ticket" },
    );
  }

  const keys = [
    ...new Set(
      positionals(ctx.args, VALUE_FLAGS)
        .flatMap((token) => token.split(","))
        .map((key) => key.trim())
        .filter((key) => key !== ""),
    ),
  ];
  if (keys.length === 0) {
    throw new ToolkitError("cover needs at least one spec key", EXIT.PRECONDITION, {
      field: "key",
    });
  }

  const pinned = readPinsFile(ctx.repoRoot);
  if (pinned === undefined) {
    throw new ToolkitError(
      `cover needs an existing ${PINS_FILE} — bootstrap with repin`,
      EXIT.PRECONDITION,
      { field: PINS_FILE },
    );
  }

  const server = resolveServer(ctx.repoRoot, ctx.args);
  const fetched = await fetchPins(config.project, server);
  const movedByKey = new Map(computeMoved(pinned, fetched).map((entry) => [entry.key, entry]));

  const notMoved = keys.filter((key) => !movedByKey.has(key));
  if (notMoved.length > 0) {
    throw new ToolkitError(
      `not moved: ${notMoved.join(", ")} — receipts exist only for drifted keys, nothing written`,
      EXIT.PRECONDITION,
      { field: "key" },
    );
  }

  const ts = new Date().toISOString();
  const disposition: Receipt["disposition"] = ticket !== undefined ? "ticket" : "editorial";
  const ref = (ticket ?? editorial) as string;
  const receipts: Receipt[] = keys.map((key) => {
    const moved = movedByKey.get(key) as MovedEntry;
    return { ts, key, from: moved.from, to: moved.to, disposition, ref };
  });

  const notes: string[] = [];
  if (ctx.flags.dryRun) {
    notes.push(`dry run: ${COVERAGE_FILE} was not written`);
  } else {
    appendReceipts(ctx.repoRoot, receipts);
  }

  return {
    ok: true,
    notes,
    data: { covered: keys.length, keys, disposition, ledger: COVERAGE_FILE },
  };
}
