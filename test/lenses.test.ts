import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CommandContext } from "../src/cli.js";
import { loadConfig } from "../src/config.js";
import { runLenses } from "../src/commands/lenses.js";
import { EXIT, ToolkitError } from "../src/output.js";
import type { RunResult, Tools } from "../src/pack/exec.js";

/** The lens globs of spec §5 — the documented example, unchanged. */
const config = {
  project: "community-platform",
  gate: {
    profiles: { local: ["lint"] },
    phases: [{ name: "lint", cmd: "npm run lint" }],
  },
  lenses: {
    acceptance: ["**"],
    tests: ["**"],
    a11y: ["client/**", "public/**"],
    security: ["server/**", "worker/**", "package-lock.json", "**/auth/**"],
    migration: ["server/migrations/**"],
  },
  review: { textGlobs: ["client/src/i18n/locales/**"] },
};

/** `lines` maps a file to its changed lines in `--numstat` (default 10; "-" = binary). */
function fakeTools(
  files: string[],
  options: { diffFails?: string; dirty?: boolean; lines?: Record<string, number | "-"> } = {},
): Tools {
  const ok = (stdout: string): RunResult => ({ ok: true, code: 0, stdout, stderr: "" });
  return {
    run(file, args) {
      expect(file).toBe("git");
      if (args[0] === "status") return ok(options.dirty === true ? " M src/a.ts\n" : "");
      if (options.diffFails !== undefined) {
        return { ok: false, code: 128, stdout: "", stderr: options.diffFails };
      }
      if (args.includes("--numstat")) {
        expect(args).toContain("-z");
        return ok(
          files
            .map((file) => {
              const lines = options.lines?.[file] ?? 10;
              return lines === "-" ? `-\t-\t${file}\0` : `${lines}\t0\t${file}\0`;
            })
            .join(""),
        );
      }
      return ok(files.join("\n"));
    },
    spec: () => {
      throw new Error("lenses must not call the spec server");
    },
  };
}

function context(args: string[] = []): CommandContext {
  const root = mkdtempSync(join(tmpdir(), "spec-sync-lenses-"));
  writeFileSync(join(root, "spec-sync.config.json"), JSON.stringify(config));
  return { flags: { human: false, dryRun: false }, args, repoRoot: root, config: loadConfig(root) };
}

function expectPrecondition(call: () => unknown, field: string): void {
  try {
    call();
  } catch (error) {
    expect(error).toBeInstanceOf(ToolkitError);
    expect((error as ToolkitError).exit).toBe(EXIT.PRECONDITION);
    expect((error as ToolkitError).field).toBe(field);
    return;
  }
  throw new Error("expected the call to throw");
}

describe("lenses (spec §7.5)", () => {
  it("leaves a11y out of a diff without UI paths", () => {
    const result = runLenses(
      context(),
      fakeTools(["server/routes/auth.ts", "server/migrations/003_add_index.sql"]),
    );

    expect(result.data?.lenses).toEqual(["acceptance", "tests", "security", "migration"]);
    expect(result.data?.skipped).toEqual(["a11y"]);
  });

  it("pulls a11y in as soon as the diff touches the client", () => {
    const result = runLenses(context(), fakeTools(["client/pages/Table.tsx"]));
    expect(result.data?.lenses).toContain("a11y");
    expect(result.data?.skipped).toEqual(["security", "migration"]);
  });

  it("selects no lens for a diff of only textGlobs files (PROC-DEV-002)", () => {
    const result = runLenses(context(), fakeTools(["client/src/i18n/locales/de.ts"]));
    expect(result.data?.lenses).toEqual([]);
    expect(result.data?.changedFiles).toBe(1);
  });

  it("still selects lenses for the other files of a mixed diff", () => {
    const result = runLenses(
      context(),
      fakeTools(["client/src/i18n/locales/de.ts", "client/src/i18n/config.ts"]),
    );
    expect(result.data?.lenses).toEqual(["acceptance", "tests", "a11y"]);
  });

  it("skips every lens on an empty diff and says so", () => {
    const result = runLenses(context(), fakeTools([]));
    expect(result.data?.lenses).toEqual([]);
    expect(result.data?.changedFiles).toBe(0);
    expect(result.notes?.join(" ")).toContain("no file differs from main");
  });

  it("defaults to main and takes --base from the arguments", () => {
    expect(runLenses(context(), fakeTools(["client/a.tsx"])).data?.base).toBe("main");
    expect(runLenses(context(["--base", "develop"]), fakeTools(["client/a.tsx"])).data?.base).toBe(
      "develop",
    );
    expect(runLenses(context(["--base=develop"]), fakeTools(["client/a.tsx"])).data?.base).toBe(
      "develop",
    );
  });

  it("warns that uncommitted changes are not part of the diff", () => {
    const result = runLenses(context(), fakeTools(["client/a.tsx"], { dirty: true }));
    expect(result.notes?.join(" ")).toContain("uncommitted changes");
  });

  it("rejects a mistyped option instead of silently using the default", () => {
    expectPrecondition(
      () => runLenses(context(["--bse", "develop"]), fakeTools(["client/a.tsx"])),
      "--bse",
    );
  });

  it("rejects --base without a value", () => {
    expectPrecondition(() => runLenses(context(["--base"]), fakeTools(["client/a.tsx"])), "--base");
    expectPrecondition(
      () => runLenses(context(["--base="]), fakeTools(["client/a.tsx"])),
      "--base",
    );
  });

  it("ends as a violated precondition when the base does not exist", () => {
    try {
      runLenses(
        context(["--base", "nope"]),
        fakeTools([], { diffFails: "unknown revision 'nope'" }),
      );
    } catch (error) {
      expect(error).toBeInstanceOf(ToolkitError);
      expect((error as ToolkitError).exit).toBe(EXIT.PRECONDITION);
      expect((error as ToolkitError).field).toBe("--base");
      return;
    }
    throw new Error("expected the call to throw");
  });
});

describe("lenses — fast lane (train 2026-11-15, Fable B4)", () => {
  it("selects no lens for a small diff of tests, CI and tooling only", () => {
    const files = ["server/routes/auth.test.ts", ".github/workflows/ci.yml", "scripts/check.mjs"];
    const result = runLenses(
      context(),
      fakeTools(files, {
        lines: { [files[0] as string]: 20, [files[1] as string]: 5, [files[2] as string]: 4 },
      }),
    );
    expect(result.data?.lenses).toEqual([]);
    expect(result.data?.skipped).toEqual(["acceptance", "tests", "a11y", "security", "migration"]);
    expect(result.data?.fastLane).toMatchObject({ fast: true, lines: 29, maxLines: 30 });
    expect(result.notes?.join(" ")).toMatch(/fast lane: .*the gate still runs/);
  });

  it("stays out of the lane at 30 changed lines", () => {
    const result = runLenses(
      context(),
      fakeTools(["e2e/login.spec.ts"], { lines: { "e2e/login.spec.ts": 30 } }),
    );
    expect(result.data?.fastLane).toMatchObject({ fast: false, lines: 30 });
    expect(result.data?.lenses).toEqual(["acceptance", "tests"]);
  });

  it("stays out of the lane as soon as one product path is touched", () => {
    const result = runLenses(
      context(),
      fakeTools(["test/a.test.ts", "server/routes/users.ts"], { lines: { "test/a.test.ts": 1 } }),
    );
    expect(result.data?.fastLane).toMatchObject({
      fast: false,
      productFiles: ["server/routes/users.ts"],
    });
    expect(result.data?.lenses).toContain("security");
  });

  it("treats lockfiles, risk paths and binary files as outside the lane", () => {
    const lockfile = runLenses(context(), fakeTools(["scripts/package-lock.json"]));
    expect(lockfile.data?.fastLane).toMatchObject({ fast: false });
    const binary = runLenses(
      context(),
      fakeTools(["e2e/__screenshots__/a.png"], { lines: { "e2e/__screenshots__/a.png": "-" } }),
    );
    expect(binary.data?.fastLane).toMatchObject({ fast: false });
    expect(String((binary.data?.fastLane as { reason: string }).reason)).toMatch(/binary/);
  });

  it("a non-ASCII path under a risk glob keeps the diff out of the lane (numstat -z)", () => {
    const root = mkdtempSync(join(tmpdir(), "spec-sync-lenses-"));
    writeFileSync(
      join(root, "spec-sync.config.json"),
      JSON.stringify({
        ...config,
        review: { ...config.review, riskGlobs: { auth: ["server/auth/**"] } },
      }),
    );
    const ctx: CommandContext = {
      flags: { human: false, dryRun: false },
      args: [],
      repoRoot: root,
      config: loadConfig(root),
    };
    const file = "server/auth/über.test.ts";
    const result = runLenses(ctx, fakeTools([file], { lines: { [file]: 2 } }));
    expect(result.data?.fastLane).toMatchObject({ fast: false, productFiles: [file] });
    expect(result.data?.lenses).toContain("security");
  });

  it("is off with fastLane.maxLines 0", () => {
    const root = mkdtempSync(join(tmpdir(), "spec-sync-lenses-"));
    writeFileSync(
      join(root, "spec-sync.config.json"),
      JSON.stringify({ ...config, fastLane: { maxLines: 0 } }),
    );
    const ctx: CommandContext = {
      flags: { human: false, dryRun: false },
      args: [],
      repoRoot: root,
      config: loadConfig(root),
    };
    const result = runLenses(
      ctx,
      fakeTools(["test/a.test.ts"], { lines: { "test/a.test.ts": 1 } }),
    );
    expect(result.data?.fastLane).toMatchObject({ fast: false });
    expect(result.data?.lenses).toEqual(["acceptance", "tests"]);
  });
});
