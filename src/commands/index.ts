/**
 * The one place that wires commands into the dispatcher.
 *
 * Every command lives in its own file and is listed here. The list is complete
 * from the start — an unimplemented command fails with a clear "not implemented
 * yet" instead of "unknown command", and parallel work on different commands
 * never has to touch a shared file.
 *
 * This module imports the `Command` type only (erased at runtime), so wiring
 * stays free of an import cycle with `cli.ts`.
 */

import type { Command } from "../cli.js";
import { gateCommand } from "./gate.js";
import { queueCommand } from "./queue.js";
import { mergeCommand } from "./merge.js";
import { packCommand } from "./pack.js";
import { lensesCommand } from "./lenses.js";
import { reportCommand } from "./report.js";
import { doctorCommand } from "./doctor.js";

export const ALL_COMMANDS: readonly Command[] = [
  gateCommand,
  queueCommand,
  packCommand,
  mergeCommand,
  lensesCommand,
  reportCommand,
  doctorCommand,
];
