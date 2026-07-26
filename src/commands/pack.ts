/**
 * `pack` — Build the ticket context pack (spec §7).
 *
 * STUB: implemented in M4. The registration exists from the start so parallel
 * work never has to touch a shared file.
 */

import { EXIT, ToolkitError } from "../output.js";
import type { Command } from "../cli.js";

export const packCommand: Command = {
  name: "pack",
  summary: "Build the ticket context pack",
  needsConfig: true,
  run() {
    throw new ToolkitError("`pack` is not implemented yet (M4)", EXIT.PRECONDITION, {
      field: "pack",
    });
  },
};
