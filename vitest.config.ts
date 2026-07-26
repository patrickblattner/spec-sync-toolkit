import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Anchored to `test/` on purpose. The default `**/*.test.ts` reaches into
    // `.claude/worktrees/*/test/`, so a run in the main tree would execute the
    // in-progress tests of every parallel ticket — the main tree's gate would
    // then report on code that is not on main. (Measured: 51 own tests became
    // 205 with three worktrees open, including assertions that had already been
    // replaced on main.) `foundation.dev.process` §Worker-Loop names the same
    // failure mode for *leftover* worktrees; live ones cause it just as well.
    include: ["test/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", ".claude/**"],
  },
});
