import { defineConfig } from "tsup";

/**
 * ESM bundles. The CLI stays the one `spec-sync <command>` entry (spec §9);
 * the hook entries under `dist/hooks/` are separate binaries speaking the
 * Claude-Code hook protocol on stdout (Turn-Ende-Abnahme, Entscheid #193) —
 * the worker repos register them by absolute path in their tracked
 * `.claude/settings.json`, so one rebuilt dist changes every repo at once.
 */
export default defineConfig({
  entry: {
    cli: "src/cli.ts",
    "hooks/stop-check": "src/hooks/stop-check.ts",
    "hooks/subagent-stop-check": "src/hooks/subagent-stop-check.ts",
    "hooks/architect-stop-check": "src/hooks/architect-stop-check.ts",
  },
  format: ["esm"],
  target: "node22",
  clean: true,
  dts: false,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
