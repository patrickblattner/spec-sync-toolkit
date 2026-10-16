/**
 * The batch marker `review/last` (SST-DESIGN-030 §batch, PROC-DEV-049).
 *
 * A lightweight tag, not a branch: a branch of that name would be read as a
 * work branch and cleaned up with landed branches. Moving it means `tag -f`
 * locally and `push --force` — and then checking the effect on `origin` with
 * `ls-remote`, because a push has ended with 0 without moving the ref before
 * (ported from community-platform `reviewMark.mjs`, #398 there).
 */

import { failureLine, type Tools } from "../pack/exec.js";

/** The commit the local marker points at, or `undefined` when it does not exist. */
export function readMarker(tools: Tools, marker: string): string | undefined {
  const result = tools.run("git", [
    "rev-parse",
    "--verify",
    "--quiet",
    `refs/tags/${marker}^{commit}`,
  ]);
  const sha = result.stdout.trim();
  return result.ok && sha !== "" ? sha : undefined;
}

/** Where the marker stands on `origin`, or `undefined`. */
export function remoteMarker(tools: Tools, marker: string): string | undefined {
  const result = tools.run("git", ["ls-remote", "--tags", "origin", `refs/tags/${marker}`]);
  if (!result.ok) return undefined;
  const sha = result.stdout.trim().split(/\s+/)[0] ?? "";
  return sha === "" ? undefined : sha;
}

export type MoveResult = { ok: true; remote: string } | { ok: false; detail: string };

/** Moves the marker to `target` locally and on origin, then verifies origin. */
export function moveMarker(tools: Tools, marker: string, target: string): MoveResult {
  const tag = tools.run("git", ["tag", "-f", marker, target]);
  if (!tag.ok) return { ok: false, detail: `git tag -f ${marker} failed: ${failureLine(tag)}` };
  const push = tools.run("git", ["push", "--force", "origin", `refs/tags/${marker}`]);
  if (!push.ok) return { ok: false, detail: `git push ${marker} failed: ${failureLine(push)}` };
  const remote = remoteMarker(tools, marker);
  if (remote !== target) {
    return {
      ok: false,
      detail: `marker ${marker} is not on ${target} at origin (there: ${remote ?? "—"})`,
    };
  }
  return { ok: true, remote };
}
