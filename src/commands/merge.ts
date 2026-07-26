/**
 * `merge` — Run the mechanical merge sequence after approval (spec §7).
 *
 * STUB: implemented in M3. The registration exists from the start so parallel
 * work never has to touch a shared file.
 */

import { EXIT, ToolkitError } from "../output.js";
import type { Command } from "../cli.js";

export const mergeCommand: Command = {
  name: "merge",
  summary: "Run the mechanical merge sequence after approval",
  needsConfig: true,
  run() {
    throw new ToolkitError("`merge` is not implemented yet (M3)", EXIT.PRECONDITION, {
      field: "merge",
    });
  },
};
