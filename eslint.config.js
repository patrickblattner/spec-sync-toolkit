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
    ignores: ["dist/**", "coverage/**", "node_modules/**"],
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
