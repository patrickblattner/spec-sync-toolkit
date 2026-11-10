/**
 * `e2e-select` — the selection behind the merge-gate phase `e2e-targeted`
 * (`PROC-REL-071`, register #2024).
 *
 * `spec-sync e2e-select [--format json|lines]`
 *
 * JSON (default): the envelope carries `mode` (`full` | `files` | `none`),
 * `files` for `files`, `reason` when the full suite was chosen. `--format
 * lines` prints `full`, `none`, or one repo-relative file per line, for shell
 * wiring. Always exit 0: a selection that cannot judge answers `full`.
 */

import type { Command, CommandContext, CommandResult } from "../cli.js";
import type { Config } from "../config.js";
import { selectE2e } from "../gate/e2e-select.js";
import { EXIT, ToolkitError } from "../output.js";
import { checkFlags, valueFlag } from "../pack/args.js";

export const e2eSelectCommand: Command = {
  name: "e2e-select",
  summary: "Which E2E specs e2e-targeted runs for this diff — full, files or none",
  needsConfig: true,
  run: (ctx) => runE2eSelect(ctx),
};

export async function runE2eSelect(ctx: CommandContext): Promise<CommandResult> {
  checkFlags(ctx.args, ["--format"]);
  const format = valueFlag(ctx.args, "--format") ?? "json";
  if (format !== "json" && format !== "lines") {
    throw new ToolkitError(`--format must be json or lines, got "${format}"`, EXIT.PRECONDITION, {
      field: "--format",
    });
  }

  const config = ctx.config as Config;
  const { base, ...selection } = await selectE2e(ctx.repoRoot, config.e2eSelect);
  const lines = selection.mode === "files" ? selection.files : [selection.mode];

  return {
    ok: true,
    exit: EXIT.OK,
    notes: base === undefined ? [] : [`diff base ${base}`],
    data: { ...selection },
    text: format === "lines" ? `${lines.join("\n")}\n` : undefined,
  };
}
