/**
 * `report` — Render the Zielabgleich from the ledger (spec §7).
 *
 * STUB: implemented in M3. The registration exists from the start so parallel
 * work never has to touch a shared file.
 */

import { EXIT, ToolkitError } from "../output.js";
import type { Command } from "../cli.js";

export const reportCommand: Command = {
  name: "report",
  summary: "Render the Zielabgleich from the ledger",
  needsConfig: true,
  run() {
    throw new ToolkitError("`report` is not implemented yet (M3)", EXIT.PRECONDITION, {
      field: "report",
    });
  },
};
