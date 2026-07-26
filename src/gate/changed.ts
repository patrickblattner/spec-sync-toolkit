/**
 * `--changed`: which phases the diff against `main` actually concerns
 * (spec §7.1, §5 `when`).
 *
 * The diff is the union of three things, because each of them can carry work
 * the gate must still cover: the branch's commits, the uncommitted working
 * tree, and untracked files. A file the gate cannot see is a phase wrongly
 * skipped, and skipping is the only direction in which this feature can be
 * wrong — so it errs towards running.
 */

import picomatch from "picomatch";
import { simpleGit } from "simple-git";
import { EXIT, ToolkitError } from "../output.js";

/** The branch a change set is measured against (spec §7.1). */
export const DIFF_BASE = "main";

/**
 * Files changed against `base`: commits on this branch, plus everything the
 * working tree carries on top (modified, staged, untracked).
 */
export async function changedFiles(repoRoot: string, base: string = DIFF_BASE): Promise<string[]> {
  const git = simpleGit(repoRoot);

  let committed: string;
  try {
    committed = await git.raw(["diff", "--name-only", `${base}...HEAD`]);
  } catch (error) {
    throw new ToolkitError(
      `--changed cannot diff against "${base}": ${(error as Error).message.split("\n")[0] ?? ""}`,
      EXIT.PRECONDITION,
      { field: "--changed", cause: error },
    );
  }

  const files = new Set(committed.split("\n").filter((line) => line.trim() !== ""));

  try {
    const status = await git.status();
    for (const file of status.files) files.add(file.path);
  } catch (error) {
    throw new ToolkitError(
      `--changed cannot read the working tree: ${(error as Error).message.split("\n")[0] ?? ""}`,
      EXIT.PRECONDITION,
      { field: "--changed", cause: error },
    );
  }

  return [...files].sort();
}

/**
 * Whether a phase runs for this diff. A phase without `when` always runs
 * (spec §5); one with `when` runs when at least one changed file matches at
 * least one glob.
 */
export function phaseRuns(when: readonly string[] | undefined, files: readonly string[]): boolean {
  if (when === undefined || when.length === 0) return true;
  const matches = picomatch([...when]);
  return files.some((file) => matches(file));
}
