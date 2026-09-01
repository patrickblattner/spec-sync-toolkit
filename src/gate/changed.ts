/**
 * `--changed`: which phases the diff against the chosen base actually concerns
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

/** The branch a change set is measured against FIRST — a candidate, not a setting. */
export const DIFF_BASE = "main";

/**
 * The base this run measures against — chosen, never hardwired (spec §7.1,
 * `SST-DESIGN-016` rev 3 — `#15`).
 *
 * `main` answers only for a state it does not already contain. Where it does —
 * a gate job on the trunk, a ticket already merged — `main...HEAD` is empty,
 * every `when:` phase selects nothing and the run reports itself as "skipped":
 * the silently empty selection foundation `PROC-REL-012` rev 3 forbids, dressed
 * up as a saving. That is what the hardwired base produced in
 * `production-cockpit#1221`, with no lever in the gate config to correct it.
 *
 * `HEAD^` answers there instead; `HEAD` never, because a diff against itself
 * restores exactly the emptiness this avoids. Where neither exists the gate
 * FAILS rather than skipping — such a non-run is class 1 (`PROC-REL-013` rev 4),
 * a deterministic ordering defect, and calling it green is the one answer that
 * cannot be recovered from later.
 */
export async function diffBase(repoRoot: string): Promise<string> {
  const git = simpleGit(repoRoot);
  // `--quiet` makes an unresolvable ref exit 1 with NO output and no stderr,
  // which reaches us as an empty string rather than as a throw: the empty
  // answer has to count as "does not exist", or `HEAD^` on a repo without a
  // parent commit would be handed on as a base and fail deep in the diff.
  const commit = async (ref: string): Promise<string | undefined> => {
    try {
      const sha = (await git.raw(["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).trim();
      return sha === "" ? undefined : sha;
    } catch {
      return undefined;
    }
  };

  const head = await commit("HEAD");
  if (head === undefined) {
    throw new ToolkitError(
      "--changed has nothing to measure: HEAD resolves to no commit",
      EXIT.PRECONDITION,
      { field: "--changed" },
    );
  }

  if ((await commit(DIFF_BASE)) !== undefined) {
    // Contained means the merge base IS `HEAD`. Histories with no merge base at
    // all cannot measure this HEAD either, and take the same way out.
    let mergeBase: string | undefined;
    try {
      mergeBase = (await git.raw(["merge-base", DIFF_BASE, "HEAD"])).trim();
    } catch {
      mergeBase = undefined;
    }
    if (mergeBase !== undefined && mergeBase !== head) return DIFF_BASE;
  }

  if ((await commit("HEAD^")) === undefined) {
    throw new ToolkitError(
      `--changed cannot determine a base: "${DIFF_BASE}" already contains HEAD, and HEAD has no parent to fall back to`,
      EXIT.PRECONDITION,
      { field: "--changed" },
    );
  }
  return "HEAD^";
}

/**
 * Files changed against `base`: commits on this branch, plus everything the
 * working tree carries on top (modified, staged, untracked). Without a `base`
 * the caller gets the chosen one (`diffBase`).
 */
export async function changedFiles(repoRoot: string, base?: string): Promise<string[]> {
  const git = simpleGit(repoRoot);
  const against = base ?? (await diffBase(repoRoot));

  let committed: string;
  try {
    committed = await git.raw(["diff", "--name-only", `${against}...HEAD`]);
  } catch (error) {
    throw new ToolkitError(
      `--changed cannot diff against "${against}": ${(error as Error).message.split("\n")[0] ?? ""}`,
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

/** A change set and the base it was measured against — a skip must name it. */
export interface ChangeSet {
  base: string;
  files: string[];
}

/** The change set of this run: the chosen base, and what differs against it. */
export async function changeSet(repoRoot: string): Promise<ChangeSet> {
  const base = await diffBase(repoRoot);
  return { base, files: await changedFiles(repoRoot, base) };
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
