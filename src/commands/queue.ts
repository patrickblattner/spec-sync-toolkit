/**
 * `queue` — Assemble and sort the work queue (spec §7).
 *
 * STUB: implemented in M3. The registration exists from the start so parallel
 * work never has to touch a shared file.
 */

import { EXIT, ToolkitError } from "../output.js";
import type { Command } from "../cli.js";

export const queueCommand: Command = {
  name: "queue",
  summary: "Assemble and sort the work queue",
  needsConfig: true,
  run() {
    throw new ToolkitError("`queue` is not implemented yet (M3)", EXIT.PRECONDITION, {
      field: "queue",
    });
  },
};
