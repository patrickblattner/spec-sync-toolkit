/**
 * The Codex engine call (SST-DESIGN-030 §Engine call, PROC-DEV-049).
 *
 *   codex exec --sandbox read-only -m <model> --ephemeral
 *              --output-schema <schema> -o <last.json> -C <root> -
 *
 * The prompt goes over stdin, never as an argument (a large diff would hit
 * E2BIG). The sandbox flag is hard-coded and `-m` is always passed — the
 * user's own Codex default may be another model. `Tools.run` has neither stdin
 * nor a timeout, so the engine has its own child-process wrapper.
 *
 * Every failure is a class, and every class means `skipped` — never a fallback
 * to another model.
 */

import { spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { RESULT_SCHEMA } from "./prompt.js";

export type FailureClass = "unreachable" | "timeout" | "limit" | "model-switch" | "unparsable";

export interface EngineRequest {
  model: string;
  prompt: string;
  /** Working root Codex reads (`-C`). */
  root: string;
  /** Absolute directory the schema, the last message and the engine log go to. */
  logDir: string;
  timeoutMs: number;
  /** File-name prefix inside `logDir`, so batch chunks do not overwrite each other. */
  name?: string;
  /** Environment of the child (tests put a fake `codex` on PATH). Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
}

export type EngineResult =
  | { ok: true; raw: string; durationMs: number }
  | { ok: false; class: FailureClass; detail: string; durationMs: number };

/** Codex reports exhausted quota with these markers (stderr, or JSONL events). */
const LIMIT_PATTERN =
  /usage_limit_reached|rate_limit_exceeded|usageLimitExceeded|usage limit|rate limit|try again at/i;
/** Codex switching the model on its own, e.g. "Automatically switched to … due to usage limits". */
const SWITCH_PATTERN = /automatically switched to|switched (?:the )?model/i;

/** The arguments of the one permitted invocation. */
export function codexArgs(model: string, schemaFile: string, outFile: string, root: string) {
  return [
    "exec",
    "--sandbox",
    "read-only",
    "-m",
    model,
    "--ephemeral",
    "--output-schema",
    schemaFile,
    "-o",
    outFile,
    "-C",
    root,
    "-",
  ];
}

export function runCodex(request: EngineRequest): EngineResult {
  const name = request.name ?? "codex";
  const schemaFile = join(request.logDir, `${name}-schema.json`);
  const outFile = join(request.logDir, `${name}-last.json`);
  writeFileSync(schemaFile, `${JSON.stringify(RESULT_SCHEMA, null, 2)}\n`, "utf8");
  writeFileSync(join(request.logDir, `${name}-prompt.txt`), request.prompt, "utf8");

  const startedAt = Date.now();
  const result = spawnSync("codex", codexArgs(request.model, schemaFile, outFile, request.root), {
    cwd: request.root,
    input: request.prompt,
    encoding: "utf8",
    timeout: request.timeoutMs,
    killSignal: "SIGKILL",
    maxBuffer: 64 * 1024 * 1024,
    env: request.env ?? process.env,
  });
  const durationMs = Date.now() - startedAt;
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  writeFileSync(
    join(request.logDir, `${name}.log`),
    `exit ${String(result.status)} signal ${String(result.signal)}\n--- stdout\n${stdout}\n--- stderr\n${stderr}\n`,
    "utf8",
  );

  const fail = (cls: FailureClass, detail: string): EngineResult => ({
    ok: false,
    class: cls,
    detail,
    durationMs,
  });

  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (errorCode === "ENOENT") return fail("unreachable", "codex binary not found on PATH");
  if (errorCode === "ETIMEDOUT") return fail("timeout", `no answer within ${request.timeoutMs} ms`);
  if (result.error !== undefined) return fail("unreachable", result.error.message);

  // Codex echoes the prompt on stderr; strip it so a diff that merely mentions
  // a limit or a model is never read as the engine's own report.
  const own = `${stderr.split(request.prompt).join("")}\n${stdout.split(request.prompt).join("")}`;

  const reported = /^model:\s*(\S+)\s*$/m.exec(own)?.[1];
  if (reported !== undefined && reported !== request.model) {
    return fail("model-switch", `asked for ${request.model}, codex ran ${reported}`);
  }
  if (SWITCH_PATTERN.test(own)) return fail("model-switch", firstMatchLine(own, SWITCH_PATTERN));

  let raw: string | undefined;
  try {
    raw = readFileSync(outFile, "utf8");
  } catch {
    raw = undefined;
  }

  if (result.status !== 0 || raw === undefined) {
    if (LIMIT_PATTERN.test(own)) return fail("limit", firstMatchLine(own, LIMIT_PATTERN));
    return fail(
      "unparsable",
      result.status !== 0
        ? `codex exit ${String(result.status)} without a result`
        : "codex wrote no result file",
    );
  }
  return { ok: true, raw, durationMs };
}

function firstMatchLine(text: string, pattern: RegExp): string {
  const line = text.split("\n").find((entry) => pattern.test(entry)) ?? "";
  const trimmed = line.trim();
  return trimmed.length > 200 ? `${trimmed.slice(0, 199)}…` : trimmed;
}
