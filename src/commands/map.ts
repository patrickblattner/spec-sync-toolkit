/**
 * `map` — the architecture model of a repo (Map module, `docs/map-model-schema.md`,
 * PROC-SPEC-002).
 *
 *   spec-sync map extract [<repo-root>] [--out <dir>] [--meaning <file>] [--project <id>]
 *   spec-sync map check   [<repo-root>] [--meaning <file>] [--project <id>]
 *
 * `extract` writes `model.json`, `processes/<id>.json`, `unmapped.json` and a copy
 * of the meaning layer into the out directory and always succeeds — unmapped keys
 * are a finding, not a failure of the run. `check` is the gate phase: it runs the
 * same extraction, writes nothing, and answers exit 1 for every raw key or node
 * the meaning layer does not name. Both are deterministic and offline; neither
 * touches the network, the spec server or `.gitignore`.
 */

import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { Command, CommandContext, CommandResult } from "../cli.js";
import { extractModel, writeModel, type ExtractResult, type Meaning } from "../map/extract.js";
import { EXIT, ToolkitError, progress } from "../output.js";

/** Where the meaning layer lives in a registered repo (schema §3). */
export const MEANING_FILE = "docs/architecture/meaning.json";
/** Default out directory: toolkit runtime state, the caller's `.gitignore` covers it. */
export const MAP_OUT = ".spec-sync/map";

const VALUE_FLAGS = ["--out", "--meaning", "--project"];
const SUBCOMMANDS = ["extract", "check"];

export const mapCommand: Command = {
  name: "map",
  summary: "Extract the architecture model of a repo (extract) or gate its meaning layer (check)",
  needsConfig: false,
  run: (ctx) => runMap(ctx),
};

export function runMap(ctx: CommandContext): CommandResult {
  const args = ctx.args;
  const positional = args.filter((token, i) => {
    if (token.startsWith("-")) return false;
    const before = args[i - 1];
    return before === undefined || !VALUE_FLAGS.includes(before);
  });
  const subcommand = positional[0];
  if (subcommand === undefined || !SUBCOMMANDS.includes(subcommand)) {
    throw new ToolkitError(
      `map needs a subcommand — ${SUBCOMMANDS.join(" or ")}`,
      EXIT.PRECONDITION,
      { field: "subcommand" },
    );
  }
  // `checkFlags` after the subcommand check, so `map --out x` names the real problem.
  checkMapFlags(args);

  const repoRoot = positional[1] === undefined ? ctx.repoRoot : expand(positional[1]);
  const meaningPath =
    valueOf(args, "--meaning") === undefined
      ? join(repoRoot, MEANING_FILE)
      : expand(valueOf(args, "--meaning") as string);
  const meaningLabel = inside(repoRoot, meaningPath);

  if (!existsSync(meaningPath)) {
    throw new ToolkitError(
      `no meaning layer at ${meaningPath} (PROC-SPEC-002) — the Map module needs ${MEANING_FILE}`,
      EXIT.PRECONDITION,
      { field: "--meaning" },
    );
  }
  let meaning: Meaning;
  try {
    meaning = JSON.parse(readFileSync(meaningPath, "utf8")) as Meaning;
  } catch (error) {
    throw new ToolkitError(
      `${meaningPath} is not readable JSON — ${error instanceof Error ? error.message : String(error)}`,
      EXIT.PRECONDITION,
      { field: "--meaning", cause: error },
    );
  }

  const project = valueOf(args, "--project") ?? meaning.project?.id;
  if (project === undefined || project === "") {
    throw new ToolkitError(
      `no project id — ${meaningLabel} carries no project.id, so --project is required`,
      EXIT.PRECONDITION,
      { field: "--project" },
    );
  }

  const result = extractModel({ repoRoot, project, meaning });
  return subcommand === "extract"
    ? runExtract(ctx, { repoRoot, project, meaning, meaningPath, meaningLabel, result })
    : runCheck({ project, meaningLabel, result });
}

interface Run {
  repoRoot: string;
  project: string;
  meaning: Meaning;
  meaningPath: string;
  meaningLabel: string;
  result: ExtractResult;
}

function runExtract(ctx: CommandContext, run: Run): CommandResult {
  const { repoRoot, project, meaning, meaningPath, meaningLabel, result } = run;
  const flag = valueOf(ctx.args, "--out");
  const out = flag === undefined ? join(repoRoot, MAP_OUT) : expand(flag);

  const notes: string[] = [];
  if (ctx.flags.dryRun) notes.push(`dry run: nothing was written to ${out}`);
  else writeModel(out, result, meaning, meaningPath);

  report(project, result);
  progress(`wrote ${join(out, "model.json")}`);

  return {
    ok: true,
    notes,
    data: {
      project,
      out: inside(repoRoot, out),
      meaning: meaningLabel,
      ...summary(result),
    },
  };
}

function runCheck(run: Pick<Run, "project" | "meaningLabel" | "result">): CommandResult {
  const { project, meaningLabel, result } = run;
  const { raw, nodes } = result.unmapped;

  const notes = [
    ...raw.map((key) => `add a mapping for "${key}" in ${meaningLabel}`),
    ...nodes.map((id) => `add display facts for the node "${id}" in ${meaningLabel}`),
  ];
  const findings = raw.length + nodes.length;
  progress(
    findings === 0
      ? `${project}: meaning layer complete — ${result.model.nodes.length} nodes, ${result.processes.length} processes`
      : `${project}: ${raw.length} unmapped raw keys, ${nodes.length} nodes without display facts`,
  );
  for (const note of notes) progress(`  ${note}`);

  return {
    ok: findings === 0,
    exit: findings === 0 ? EXIT.OK : EXIT.FAILED,
    notes,
    data: { project, meaning: meaningLabel, ...summary(result) },
  };
}

/** The response fields both subcommands share — bounded by findings, never by file size. */
function summary(result: ExtractResult): Record<string, unknown> {
  return {
    nodes: result.model.nodes.length,
    edges: result.model.edges.length,
    processes: result.processes.length,
    counts: result.model.counts,
    unmapped: result.unmapped,
    networks: result.networks,
  };
}

/** The run summary of the original extractor — stderr, never stdout (spec §3). */
function report(project: string, result: ExtractResult): void {
  const { model, processes, unmapped, networks, composeFile } = result;
  progress(
    `${project}: ${model.nodes.length} nodes, ${model.edges.length} edges, ${processes.length} processes`,
  );
  progress(`counts ${JSON.stringify(model.counts)}`);
  if (composeFile !== null)
    progress(
      `compose networks (not in the model, §3.1 has no field): ${networks.join(", ") || "-"}`,
    );
  progress(`unmapped raw keys (${unmapped.raw.length}):`);
  for (const key of unmapped.raw) progress(`  ${key}`);
  progress(`nodes without display facts (${unmapped.nodes.length}):`);
  for (const id of unmapped.nodes) progress(`  ${id}`);
}

/**
 * Flag validation for a command with a positional subcommand: `pack/args.ts`
 * cannot be reused unchanged, because it reads `map extract` as a value for a
 * preceding value flag. Same contract though — an unknown option and a value
 * flag without a value are exit 4 naming the option.
 */
function checkMapFlags(args: string[]): void {
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] as string;
    if (!token.startsWith("-")) continue;
    const name = token.split("=")[0] as string;
    if (!VALUE_FLAGS.includes(name)) {
      throw new ToolkitError(
        `unknown option ${name} — map knows ${VALUE_FLAGS.join(", ")}`,
        EXIT.PRECONDITION,
        { field: name },
      );
    }
    const inlineValue = token.includes("=") ? token.slice(name.length + 1) : undefined;
    const value = inlineValue ?? args[i + 1];
    if (value === undefined || value === "" || value.startsWith("-")) {
      throw new ToolkitError(`${name} needs a value`, EXIT.PRECONDITION, { field: name });
    }
  }
}

/** `--meaning=x` and `--meaning x`; the last occurrence wins. */
function valueOf(args: string[], flag: string): string | undefined {
  let found: string | undefined;
  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] as string;
    if (token === flag) {
      const value = args[i + 1];
      if (value !== undefined && !value.startsWith("-")) found = value;
    } else if (token.startsWith(`${flag}=`)) {
      found = token.slice(flag.length + 1);
    }
  }
  return found;
}

/** Absolute path from a CLI argument, `~` expanded as the original extractor did. */
function expand(value: string): string {
  return resolve(value.replace(/^~/, process.env.HOME ?? "~"));
}

/** A path relative to the repo when it lies inside it, absolute otherwise. */
function inside(repoRoot: string, target: string): string {
  const rel = relative(repoRoot, target);
  return rel === "" || rel.startsWith("..") || isAbsolute(rel) ? target : rel;
}
