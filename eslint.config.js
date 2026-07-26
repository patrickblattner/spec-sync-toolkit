import eslint from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";

/**
 * The output contract (spec §3) says stdout carries exactly one JSON object.
 * `src/output.ts` owns the only writer; every other file is barred from stdout
 * at lint time, so a later command cannot break the contract by accident.
 */
export default tseslint.config(
  {
    // `.claude/**` for the same reason vitest.config.ts scopes its include:
    // agent worktrees live under `.claude/worktrees/` and carry their own
    // `dist/` and work-in-progress sources. Without this the linter in the main
    // tree reports on code that is not on main — measured: 37 errors, all of
    // them from another ticket's build output.
    ignores: ["dist/**", "coverage/**", "node_modules/**", ".claude/**"],
  },
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
    },
  },
  {
    files: ["src/**/*.ts"],
    ignores: ["src/output.ts"],
    rules: {
      "no-console": "error",
      "no-restricted-properties": [
        "error",
        {
          object: "process",
          property: "stdout",
          message:
            "stdout belongs to emit() in src/output.ts — spec §3 (stdout-json-only). Use progress() for diagnostics.",
        },
      ],
    },
  },
  prettier,
);
