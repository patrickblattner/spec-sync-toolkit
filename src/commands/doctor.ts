/**
 * `doctor` — Check the environment against the norm (spec §7).
 *
 * STUB: implemented in M4. The registration exists from the start so parallel
 * work never has to touch a shared file.
 */

import { EXIT, ToolkitError } from "../output.js";
import type { Command } from "../cli.js";

export const doctorCommand: Command = {
  name: "doctor",
  summary: "Check the environment against the norm",
  needsConfig: false,
  run() {
    throw new ToolkitError("`doctor` is not implemented yet (M4)", EXIT.PRECONDITION, {
      field: "doctor",
    });
  },
};
