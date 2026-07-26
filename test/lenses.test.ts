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
};

function fakeTools(files: string[], options: { diffFails?: string; dirty?: boolean } = {}): Tools {
  const ok = (stdout: string): RunResult => ({ ok: true, code: 0, stdout, stderr: "" });
  return {
    run(file, args) {
      expect(file).toBe("git");
      if (args[0] === "status") return ok(options.dirty === true ? " M src/a.ts\n" : "");
      if (options.diffFails !== undefined) {
        return { ok: false, code: 128, stdout: "", stderr: options.diffFails };
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
