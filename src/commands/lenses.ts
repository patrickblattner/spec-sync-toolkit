/**
 * `lenses` — the review lens set for a diff (spec §7.5).
 *
 * `spec-sync lenses [--base main]`
 *
 * Matches the changed files against the `lenses` globs of the config. The point
 * is where the skip happens: deciding *before* the spawn costs nothing, while a
 * review agent that starts up only to report `SKIPPED` costs a full run-up.
 *
 * The command reports applicability, never a verdict (spec §2) — an applicable
 * lens still says nothing about what the review will find.
 */

import picomatch from "picomatch";
import type { Command, CommandContext, CommandResult } from "../cli.js";
import type { Config } from "../config.js";
import { EXIT, ToolkitError } from "../output.js";
import { checkFlags, valueFlag } from "../pack/args.js";
import { defaultTools, failureLine, type Tools } from "../pack/exec.js";

/** Branch a ticket is reviewed against unless the caller names another. */
const DEFAULT_BASE = "main";

export const lensesCommand: Command = {
  name: "lenses",
  summary: "Derive the review lens set from the diff",
  needsConfig: true,
  run: (ctx) => runLenses(ctx, defaultTools(ctx.repoRoot)),
};

export function runLenses(ctx: CommandContext, tools: Tools): CommandResult {
  const config = ctx.config as Config;
  checkFlags(ctx.args, ["--base"]);
  const base = valueFlag(ctx.args, "--base") ?? DEFAULT_BASE;
  const notes: string[] = [];

  const files = changedFiles(tools, base);
  const configured = Object.entries(config.lenses);

  if (configured.length === 0) notes.push("no lenses configured (spec §5, `lenses`)");
  if (files.length === 0) notes.push(`no file differs from ${base} — every lens is skipped`);
  if (dirtyWorkingTree(tools)) {
    notes.push("uncommitted changes are not part of the diff — commit them before reviewing");
  }

  const applicable: string[] = [];
  const skipped: string[] = [];
  for (const [lens, globs] of configured) {
    if (files.some((file) => picomatch.isMatch(file, globs))) applicable.push(lens);
    else skipped.push(lens);
  }

  return {
    ok: true,
    notes,
    data: {
      base,
      changedFiles: files.length,
      lenses: applicable,
      skipped,
    },
  };
}

/**
 * The files this branch changes against its base — the three-dot form, so
 * commits that only landed on the base afterwards do not pull a lens in.
 */
function changedFiles(tools: Tools, base: string): string[] {
  const diff = tools.run("git", ["diff", "--name-only", `${base}...HEAD`]);
  if (!diff.ok) {
    throw new ToolkitError(
      `git diff against ${base} failed: ${failureLine(diff)}`,
      EXIT.PRECONDITION,
      {
        field: "--base",
      },
    );
  }
  return diff.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function dirtyWorkingTree(tools: Tools): boolean {
  const status = tools.run("git", ["status", "--porcelain"]);
  return status.ok && status.stdout.trim() !== "";
}
