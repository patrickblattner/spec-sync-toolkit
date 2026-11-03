import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CommandContext } from "../src/cli.js";
import { judgeOverlap, runPr } from "../src/commands/pr.js";
import { loadConfig } from "../src/config.js";
import { EXIT, ToolkitError } from "../src/output.js";
import type { RunResult, Tools } from "../src/pack/exec.js";

/** PROC-DEV-005 §Update only on overlap. */

function repo(overlap?: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), "spec-sync-pr-"));
  writeFileSync(
    join(root, "spec-sync.config.json"),
    JSON.stringify({
      project: "demo",
      gate: { profiles: { local: ["unit"] }, phases: [{ name: "unit", cmd: "npm test" }] },
      ...(overlap === undefined ? {} : { overlap }),
    }),
  );
  return root;
}

function fakeTools(diffs: Record<number, string[] | "fail">, calls: string[][] = []): Tools {
  return {
    run(file, args): RunResult {
      calls.push([file, ...args]);
      expect(file).toBe("gh");
      expect(args.slice(0, 2)).toEqual(["pr", "diff"]);
      expect(args).toContain("--name-only");
      const files = diffs[Number(args[2])];
      if (files === undefined || files === "fail") {
        return { ok: false, code: 1, stdout: "", stderr: "no pull requests found" };
      }
      return { ok: true, code: 0, stdout: `${files.join("\n")}\n`, stderr: "" };
    },
    spec: () => {
      throw new Error("pr overlap never calls the spec server");
    },
  };
}

const ctx = (root: string, args: string[]): CommandContext => ({
  flags: { human: false, dryRun: false },
  args,
  repoRoot: root,
  config: loadConfig(root),
});

const defaults = () => loadConfig(repo()).overlap;

describe("pr overlap", () => {
  it("exit 1 when both PRs share a non-generated file, with a one-line reason", async () => {
    const root = repo();
    const calls: string[][] = [];
    const result = await runPr(ctx(root, ["overlap", "12", "--merged", "11"]), {
      tools: fakeTools(
        { 12: ["server/a.ts", "client/b.tsx"], 11: ["server/a.ts", "docs/x.md"] },
        calls,
      ),
    });
    expect(result).toMatchObject({ ok: false, exit: EXIT.FAILED });
    expect(result.data).toMatchObject({ update: true, shared: ["server/a.ts"], categories: [] });
    expect(result.notes).toEqual(["update #12: shares server/a.ts with merged #11"]);
    expect(calls.map((call) => call[3])).toEqual(["12", "11"]);
  });

  it("exit 0 when nothing is shared and the merged PR touched no forcing category", async () => {
    const result = await runPr(ctx(repo(), ["overlap", "12", "--merged", "11"]), {
      tools: fakeTools({ 12: ["client/b.tsx"], 11: ["server/a.ts"] }),
    });
    expect(result).toMatchObject({ ok: true, exit: EXIT.OK });
    expect(result.data).toMatchObject({ update: false, shared: [] });
    expect(result.notes?.[0]).toMatch(/^no update for #12/);
  });

  it("the coverage ledger never counts as overlap, even when both touch it", () => {
    const decision = judgeOverlap(
      [".spec-sync/drift-coverage.jsonl", "client/b.tsx"],
      [".spec-sync/drift-coverage.jsonl", "server/a.ts"],
      defaults(),
    );
    expect(decision).toMatchObject({ update: false, shared: [] });
  });

  it("a lockfile counts only when both PRs touch it", () => {
    expect(judgeOverlap(["client/b.tsx"], ["package-lock.json"], defaults()).update).toBe(false);
    expect(judgeOverlap(["package-lock.json"], ["package-lock.json"], defaults())).toMatchObject({
      update: true,
      shared: ["package-lock.json"],
    });
  });

  it.each([
    ["visual baselines", "e2e/visual/calendar.visual.spec.ts-snapshots/month-chromium.png"],
    ["registries", "server/src/domain/settings/registry.ts"],
    ["registries", "scripts/obligation-coverage-manifest.json"],
    ["translations", "client/src/i18n/flaechen/de.json"],
    ["the schema", "server/src/data/migrations/0231_add_column.ts"],
    ["the schema", "current_schema.sql"],
    ["the schema", "server/src/data/schema.ts"],
  ])("a merged change to %s forces the update on its own (%s)", (category, file) => {
    const decision = judgeOverlap(["client/unrelated.tsx"], [file], defaults());
    expect(decision).toMatchObject({ update: true, shared: [], categories: [category] });
  });

  it("names the category and the file in the reason", async () => {
    const result = await runPr(ctx(repo(), ["overlap", "12", "--merged", "11"]), {
      tools: fakeTools({ 12: ["client/b.tsx"], 11: ["client/src/i18n/de.json"] }),
    });
    expect(result.exit).toBe(EXIT.FAILED);
    expect(result.notes).toEqual([
      "update #12: merged #11 touched translations (client/src/i18n/de.json)",
    ]);
  });

  it("reads the category globs from the config; an overridden key keeps the other defaults", () => {
    const overlap = loadConfig(repo({ translations: ["lang/**"] })).overlap;
    expect(judgeOverlap(["a.ts"], ["client/src/i18n/de.json"], overlap).update).toBe(false);
    expect(judgeOverlap(["a.ts"], ["lang/de.json"], overlap).categories).toEqual(["translations"]);
    expect(judgeOverlap(["a.ts"], ["db/migrations/1.sql"], overlap).categories).toEqual([
      "the schema",
    ]);
  });

  it("a generated file in a forcing category does not force the update", () => {
    const overlap = loadConfig(repo({ generated: ["client/src/i18n/generated/**"] })).overlap;
    expect(judgeOverlap(["a.ts"], ["client/src/i18n/generated/keys.ts"], overlap).update).toBe(
      false,
    );
  });

  it("precondition violations end as exit 4 naming the field", async () => {
    const root = repo();
    const tools = fakeTools({ 12: ["a.ts"], 11: "fail" });
    const cases: [string[], string][] = [
      [["overlap", "12"], "--merged"],
      [["overlap", "x", "--merged", "11"], "pr"],
      [["overlap", "--merged", "11"], "pr"],
      [["nope", "12", "--merged", "11"], "subcommand"],
      [["overlap", "12", "--merged", "11", "--bogus"], "--bogus"],
      [["overlap", "12", "--merged", "11"], "--merged"],
    ];
    for (const [args, field] of cases) {
      let caught: unknown;
      try {
        await runPr(ctx(root, args), { tools });
      } catch (error) {
        caught = error;
      }
      expect(caught, args.join(" ")).toBeInstanceOf(ToolkitError);
      expect((caught as ToolkitError).exit).toBe(EXIT.PRECONDITION);
      expect((caught as ToolkitError).field).toBe(field);
    }
  });
});
