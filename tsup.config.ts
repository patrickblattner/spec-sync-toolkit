import { defineConfig } from "tsup";

/**
 * ESM bundle. The CLI is the one `spec-sync <command>` entry (spec §9); the
 * toolkit ships no Stop or SubagentStop hook (SST-DESIGN-015 rev 6).
 */
export default defineConfig({
  entry: {
    cli: "src/cli.ts",
  },
  format: ["esm"],
  target: "node22",
  clean: true,
  dts: false,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
