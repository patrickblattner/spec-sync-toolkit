/**
 * Triage (SST-DESIGN-030 §Triage): which model, if any, reviews a diff.
 *
 * 1. Any `riskGlobs` area matches → the risk model, trigger `risk:<areas>`.
 * 2. Else ≥ `size.files` files, ≥ `size.lines` changed lines, or a new module
 *    → the size model, trigger `size`.
 * 3. Else `not-triaged` — no call.
 *
 * Binary files count as 0 lines. `*.md` and the configured `textGlobs` do not
 * count toward size at all (neither files nor lines). Pure — the git reads live
 * in the command.
 */

import picomatch from "picomatch";
import type { ReviewConfig } from "../config.js";

/** One line of `git diff --numstat`. */
export interface NumstatEntry {
  file: string;
  /** Added plus deleted lines; 0 for a binary file. */
  lines: number;
  binary: boolean;
}

/** Documentation files never count toward size, whatever the config says. */
const DOC_GLOBS = ["**/*.md"];

export type TriageDecision =
  | { triaged: true; model: string; effort: string; trigger: string; areas: string[] }
  | { triaged: false; trigger: "not-triaged"; areas: [] };

/**
 * Parses `git diff --numstat --no-renames`. A binary file shows `-\t-\t<path>`
 * and counts as 0 lines.
 */
export function parseNumstat(text: string): NumstatEntry[] {
  const entries: NumstatEntry[] = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const [added, deleted, ...rest] = line.split("\t");
    const file = rest.join("\t");
    if (file === "" || added === undefined || deleted === undefined) continue;
    const binary = added === "-" || deleted === "-";
    const lines = binary ? 0 : Number(added) + Number(deleted);
    entries.push({ file, lines: Number.isFinite(lines) ? lines : 0, binary });
  }
  return entries;
}

/** The risk areas a file set touches, in config order. */
export function riskAreas(files: readonly string[], riskGlobs: Record<string, string[]>): string[] {
  return Object.entries(riskGlobs)
    .filter(([, globs]) => globs.length > 0 && files.some((file) => picomatch.isMatch(file, globs)))
    .map(([area]) => area);
}

/** File and line count of a diff without documentation and text files. */
export function sizeOf(
  entries: readonly NumstatEntry[],
  textGlobs: readonly string[],
): { files: number; lines: number } {
  const excluded = [...DOC_GLOBS, ...textGlobs];
  const counted = entries.filter((entry) => !picomatch.isMatch(entry.file, excluded));
  return {
    files: counted.length,
    lines: counted.reduce((sum, entry) => sum + entry.lines, 0),
  };
}

/**
 * Is a file one of a new module? An added `package.json` anywhere, or a file
 * in a directory directly under `modulesRoot` that the base did not have
 * (`existingModules` names the directories present at the base).
 */
export function newModule(
  addedFiles: readonly string[],
  modulesRoot: string | undefined,
  existingModules: ReadonlySet<string>,
): boolean {
  if (addedFiles.some((file) => file === "package.json" || file.endsWith("/package.json"))) {
    return true;
  }
  return moduleDirsOf(addedFiles, modulesRoot).some((name) => !existingModules.has(name));
}

/** The directory names directly under `modulesRoot` the given files live in. */
export function moduleDirsOf(files: readonly string[], modulesRoot: string | undefined): string[] {
  if (modulesRoot === undefined) return [];
  const root = `${modulesRoot.replace(/\/+$/, "")}/`;
  const dirs = new Set<string>();
  for (const file of files) {
    if (!file.startsWith(root)) continue;
    const rest = file.slice(root.length);
    const slash = rest.indexOf("/");
    // A file directly in modulesRoot is not a module directory.
    if (slash > 0) dirs.add(rest.slice(0, slash));
  }
  return [...dirs];
}

/** PR triage: risk first, then size, else no call. */
export function decide(
  entries: readonly NumstatEntry[],
  isNewModule: boolean,
  review: ReviewConfig,
): TriageDecision {
  const areas = riskAreas(
    entries.map((entry) => entry.file),
    review.riskGlobs,
  );
  if (areas.length > 0) {
    return {
      triaged: true,
      model: review.models.risk,
      effort: review.effort.risk,
      trigger: `risk:${areas.join(",")}`,
      areas,
    };
  }
  const size = sizeOf(entries, review.textGlobs);
  if (size.files >= review.size.files || size.lines >= review.size.lines || isNewModule) {
    return {
      triaged: true,
      model: review.models.size,
      effort: review.effort.size,
      trigger: "size",
      areas: [],
    };
  }
  return { triaged: false, trigger: "not-triaged", areas: [] };
}

/** Batch and tag: the risk model if any risk area is touched, otherwise the size model. */
export function decideAlways(
  files: readonly string[],
  review: ReviewConfig,
): { model: string; effort: string; trigger: string; areas: string[] } {
  const areas = riskAreas(files, review.riskGlobs);
  return areas.length > 0
    ? {
        model: review.models.risk,
        effort: review.effort.risk,
        trigger: `risk:${areas.join(",")}`,
        areas,
      }
    : { model: review.models.size, effort: review.effort.size, trigger: "size", areas: [] };
}
