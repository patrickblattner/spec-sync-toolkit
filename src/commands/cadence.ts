/**
 * `cadence` — may a release tag be made today? (train 2026-11-15, Fable C4)
 *
 *   spec-sync cadence tag
 *
 * Counts the tags matching `cadence.tagPattern` made on the current local day.
 * Below `cadence.tagsPerDay` → exit 0 with `allowed: true`; at it → exit 4
 * naming today's tags: the next release goes out on a later day and carries
 * everything merged until then. Without `cadence.tagsPerDay` (every repo that
 * did not opt in) → exit 0, no limit. Reads git only, writes nothing.
 */

import type { Command, CommandContext, CommandResult } from "../cli.js";
import type { Config } from "../config.js";
import { localDay, tagsOfDay } from "../cadence.js";
import { EXIT, ToolkitError } from "../output.js";
import { checkFlags, positionals } from "../pack/args.js";
import { defaultTools, failureLine, type Tools } from "../pack/exec.js";

const USAGE = "usage: spec-sync cadence tag";

export interface CadenceDeps {
  tools: Tools;
  now: () => Date;
}

export const cadenceCommand: Command = {
  name: "cadence",
  summary: "Release cadence: tag (may a release tag be made today?)",
  needsConfig: true,
  run: (ctx) => runCadence(ctx, { tools: defaultTools(ctx.repoRoot), now: () => new Date() }),
};

export function runCadence(ctx: CommandContext, deps: CadenceDeps): CommandResult {
  checkFlags(ctx.args, []);
  const pos = positionals(ctx.args, []);
  if (pos.length !== 1 || pos[0] !== "tag") {
    throw new ToolkitError(USAGE, EXIT.PRECONDITION, { field: "subcommand" });
  }
  const cadence = (ctx.config as Config).cadence;
  const day = localDay(deps.now());
  const limit = cadence.tagsPerDay;
  if (limit === undefined) {
    return {
      ok: true,
      exit: EXIT.OK,
      notes: ["no tag cadence configured (cadence.tagsPerDay) — no limit"],
      data: { day, allowed: true, tagsPerDay: null, today: [] },
    };
  }

  const refs = deps.tools.run("git", [
    "for-each-ref",
    "--format=%(refname:short)%09%(creatordate:unix)",
    `refs/tags/${cadence.tagPattern}`,
  ]);
  if (!refs.ok) {
    throw new ToolkitError(`git for-each-ref failed: ${failureLine(refs)}`, EXIT.PRECONDITION, {
      field: "cadence.tagPattern",
    });
  }
  const today = tagsOfDay(refs.stdout, day);
  if (today.length >= limit) {
    throw new ToolkitError(
      `${today.join(", ")} already tagged today (${day}) — at most ${limit} release tag(s) per day; ` +
        `no tag now, the next release goes out on a later day with everything merged until then`,
      EXIT.PRECONDITION,
      { field: "cadence.tagsPerDay" },
    );
  }
  return {
    ok: true,
    exit: EXIT.OK,
    notes: [`${today.length} of ${limit} release tag(s) made today (${day}) — a tag may be made`],
    data: { day, allowed: true, tagsPerDay: limit, today },
  };
}
