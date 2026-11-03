/**
 * `pr` — PR-level helpers of the remote flow (PROC-DEV-005).
 *
 *   spec-sync pr overlap <open-pr> --merged <merged-pr>
 *
 * `overlap` answers one question after a merge: does the open PR have to be
 * put onto the new main (§Update only on overlap)? It reads both file lists
 * with `gh pr diff --name-only` and decides mechanically:
 *
 *   - exit 1 (update) — the two PRs share a file that is not `overlap.generated`
 *     (a lockfile counts like any other file: only when both touch it), or the
 *     merged PR touched visual baselines, registries, translations or the
 *     schema (`overlap.visualBaselines`, `.registries`, `.translations`,
 *     `.schema`, picomatch globs);
 *   - exit 0 (no update) — neither.
 *
 * The reason is one line in `notes`. It writes nothing and never calls
 * `gh pr update-branch` itself — that stays the worker's step.
 */

import picomatch from "picomatch";
import type { Command, CommandContext, CommandResult } from "../cli.js";
import type { Config, OverlapConfig } from "../config.js";
import { EXIT, ToolkitError } from "../output.js";
import { checkFlags, positionals, valueFlag } from "../pack/args.js";
import { defaultTools, failureLine, type Tools } from "../pack/exec.js";

const VALUE_FLAGS = ["--merged"];
/** Files named per list in the response; the rest is counted. */
const MAX_LISTED = 10;

export interface PrDeps {
  tools: Tools;
}

export const prCommand: Command = {
  name: "pr",
  summary: "PR helpers: overlap (does an open PR need an update after a merge)",
  needsConfig: true,
  run: (ctx) => runPr(ctx, { tools: defaultTools(ctx.repoRoot) }),
};

export async function runPr(ctx: CommandContext, deps: PrDeps): Promise<CommandResult> {
  checkFlags(ctx.args, VALUE_FLAGS);
  const pos = positionals(ctx.args, VALUE_FLAGS);
  if (pos[0] !== "overlap") {
    throw new ToolkitError("pr needs a subcommand — overlap", EXIT.PRECONDITION, {
      field: "subcommand",
    });
  }
  if (pos.length !== 2) {
    throw new ToolkitError(
      "usage: spec-sync pr overlap <open-pr> --merged <merged-pr>",
      EXIT.PRECONDITION,
      { field: "pr" },
    );
  }
  const open = positiveInt(pos[1], "pr");
  const merged = positiveInt(valueFlag(ctx.args, "--merged"), "--merged");
  const config = ctx.config as Config;

  const decision = judgeOverlap(
    diffFiles(deps.tools, open, "pr"),
    diffFiles(deps.tools, merged, "--merged"),
    config.overlap,
  );
  const reason = decision.update
    ? decision.shared.length > 0
      ? `update #${open}: shares ${listed(decision.shared)} with merged #${merged}`
      : `update #${open}: merged #${merged} touched ${decision.categories.join(", ")} (${listed(decision.categoryFiles)})`
    : `no update for #${open}: no shared non-generated file with merged #${merged}, no baseline, registry, translation or schema change`;

  return {
    ok: !decision.update,
    exit: decision.update ? EXIT.FAILED : EXIT.OK,
    notes: [reason],
    data: {
      pr: open,
      merged,
      update: decision.update,
      shared: decision.shared.slice(0, MAX_LISTED),
      categories: decision.categories,
    },
  };
}

/** The four categories whose change in the merged PR forces an update on its own. */
const CATEGORIES = ["visualBaselines", "registries", "translations", "schema"] as const;
const CATEGORY_NAMES: Record<(typeof CATEGORIES)[number], string> = {
  visualBaselines: "visual baselines",
  registries: "registries",
  translations: "translations",
  schema: "the schema",
};

export interface OverlapDecision {
  update: boolean;
  /** Non-generated files both PRs touch. */
  shared: string[];
  /** Category names the merged PR touched. */
  categories: string[];
  /** The merged PR's files that fell into a category. */
  categoryFiles: string[];
}

/** Pure over both file lists — the rules of PROC-DEV-005 §Update only on overlap. */
export function judgeOverlap(
  openFiles: string[],
  mergedFiles: string[],
  overlap: OverlapConfig,
): OverlapDecision {
  const isGenerated = picomatch(overlap.generated, { dot: true });
  const mergedSet = new Set(mergedFiles);
  const shared = openFiles.filter((file) => mergedSet.has(file) && !isGenerated(file)).sort();

  const categories: string[] = [];
  const categoryFiles = new Set<string>();
  for (const category of CATEGORIES) {
    const matches = picomatch(overlap[category], { dot: true });
    const hits = mergedFiles.filter((file) => !isGenerated(file) && matches(file));
    if (hits.length > 0) {
      categories.push(CATEGORY_NAMES[category]);
      for (const hit of hits) categoryFiles.add(hit);
    }
  }

  return {
    update: shared.length > 0 || categories.length > 0,
    shared,
    categories,
    categoryFiles: [...categoryFiles].sort(),
  };
}

function diffFiles(tools: Tools, pr: number, field: string): string[] {
  const result = tools.run("gh", ["pr", "diff", String(pr), "--name-only"]);
  if (!result.ok) {
    throw new ToolkitError(`gh pr diff ${pr} failed: ${failureLine(result)}`, EXIT.PRECONDITION, {
      field,
    });
  }
  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
}

function listed(files: string[]): string {
  const head = files.slice(0, 3).join(", ");
  return files.length > 3 ? `${head} (+${files.length - 3} more)` : head;
}

function positiveInt(value: string | undefined, field: string): number {
  if (value === undefined || !/^\d+$/.test(value) || Number(value) < 1) {
    throw new ToolkitError(
      `${field} must be a positive number, got "${value ?? ""}"`,
      EXIT.PRECONDITION,
      { field },
    );
  }
  return Number(value);
}
