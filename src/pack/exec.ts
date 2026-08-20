/**
 * The outside world, behind one seam.
 *
 * `pack`, `lenses` and `doctor` read from three places the toolkit does not
 * own: `gh`, the CodeGraph CLI and the spec-mcp HTTP API (spec §10 — `gh` runs
 * through `child_process`, spec content comes over HTTP, never from local spec
 * files). Everything goes through `Tools`, so a test hands in fakes instead of
 * patching globals — no test ever touches a real issue or the real server.
 */

import { spawnSync } from "node:child_process";
import { callSpecTool } from "../norms.js";

export interface RunResult {
  ok: boolean;
  /** Exit code of the process; 127 when it could not be started at all. */
  code: number;
  stdout: string;
  stderr: string;
}

export interface Tools {
  /** Runs a binary in the repo root and captures its output. Never throws. */
  run(file: string, args: string[]): RunResult;
  /**
   * One spec-mcp tool call over HTTP, answered as Markdown text (spec-server-v2
   * Bauplan §3 — never nested JSON). Throws `ToolkitError` (exit 4) if
   * unreachable.
   */
  spec(tool: string, args: Record<string, unknown>): Promise<string>;
}

export function defaultTools(repoRoot: string): Tools {
  return {
    run: (file, args) => runProcess(file, args, repoRoot),
    spec: (tool, args) => callSpecTool(tool, args),
  };
}

/**
 * A failing child process is data, not an exception: `doctor` reports a missing
 * `gh` as a finding and `pack` degrades to an empty candidate list when
 * CodeGraph has no index. Both need the failure, not a stack.
 */
export function runProcess(file: string, args: string[], cwd: string): RunResult {
  const result = spawnSync(file, args, {
    cwd,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024,
  });

  if (result.error !== undefined) {
    return { ok: false, code: 127, stdout: "", stderr: result.error.message };
  }
  const code = result.status ?? 1;
  return {
    ok: code === 0,
    code,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

/** First non-empty line of a failed run — enough to name the cause in a finding. */
export function failureLine(result: RunResult): string {
  const source = result.stderr.trim() === "" ? result.stdout : result.stderr;
  const line = source
    .split("\n")
    .map((entry) => entry.trim())
    .find((entry) => entry !== "");
  return line ?? `exit ${result.code}`;
}
