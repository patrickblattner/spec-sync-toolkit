import { defineConfig } from "tsup";

/**
 * Single ESM bundle. The CLI is the only entry point — the toolkit is consumed
 * as a pinned devDependency and invoked as `spec-sync <command>` (spec §9), not
 * imported as a library.
 */
export default defineConfig({
  entry: ["src/cli.ts"],
  format: ["esm"],
  target: "node22",
  clean: true,
  dts: false,
  banner: {
    js: "#!/usr/bin/env node",
  },
});
