/**
 * `gate` — Run the gate phases of a profile, cheapest first (spec §7).
 *
 * STUB: implemented in M2. The registration exists from the start so parallel
 * work never has to touch a shared file.
 */

import { EXIT, ToolkitError } from "../output.js";
import type { Command } from "../cli.js";

export const gateCommand: Command = {
  name: "gate",
  summary: "Run the gate phases of a profile, cheapest first",
  needsConfig: true,
  run() {
    throw new ToolkitError("`gate` is not implemented yet (M2)", EXIT.PRECONDITION, {
      field: "gate",
    });
  },
};
