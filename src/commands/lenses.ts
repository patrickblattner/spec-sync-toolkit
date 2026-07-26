/**
 * `lenses` — Derive the review lens set from the diff (spec §7).
 *
 * STUB: implemented in M4. The registration exists from the start so parallel
 * work never has to touch a shared file.
 */

import { EXIT, ToolkitError } from "../output.js";
import type { Command } from "../cli.js";

export const lensesCommand: Command = {
  name: "lenses",
  summary: "Derive the review lens set from the diff",
  needsConfig: true,
  run() {
    throw new ToolkitError("`lenses` is not implemented yet (M4)", EXIT.PRECONDITION, {
      field: "lenses",
    });
  },
};
