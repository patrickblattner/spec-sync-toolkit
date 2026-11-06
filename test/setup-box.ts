/**
 * Every test file gets its own box directory (PROC-REL-060): a gate run under
 * test takes a box slot, and must never take — or wait for — one of the real
 * machine-wide slots in `~/.spec-sync/box/`. Nor may it wait on the real
 * machine load: the load gate is opened wide unless a test injects a load.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BOX_DIR_ENV, BOX_LOAD_MAX_ENV, BOX_SLOTS_ENV } from "../src/gate/slots.js";

process.env[BOX_DIR_ENV] = mkdtempSync(join(tmpdir(), "spec-sync-box-"));
delete process.env[BOX_SLOTS_ENV];
process.env[BOX_LOAD_MAX_ENV] = "1000000";
