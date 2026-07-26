/**
 * Configuration (spec §5): `spec-sync.config.json` in the root of the consuming
 * repo, validated with zod. Missing or invalid → exit 4 naming the violated
 * field.
 *
 * The phase order is part of the config and is honoured as given.
 */

import { readFileSync } from "node:fs";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { EXIT, ToolkitError } from "./output.js";
import { NORM_DEFAULTS } from "./norms.js";

export const CONFIG_FILENAME = "spec-sync.config.json";

const phaseSchema = z.object({
  name: z.string().min(1),
  cmd: z.string().min(1),
  /** Restricts the phase to diffs matching at least one glob (picomatch). */
  when: z.array(z.string().min(1)).optional(),
});

const gateSchema = z.object({
  profiles: z.record(z.string(), z.array(z.string().min(1))),
  phases: z.array(phaseSchema).min(1),
});

const labelsSchema = z.object({
  build: z.string().min(1).default(NORM_DEFAULTS.buildLabel),
  audit: z.string().min(1).default("auto-audit"),
  bug: z.string().min(1).default("type: bug"),
  hold: z.string().min(1).default(NORM_DEFAULTS.hold),
});

const configSchema = z
  .object({
    project: z.string().min(1),
    gate: gateSchema,
    lenses: z.record(z.string(), z.array(z.string().min(1))).default({}),
    // prefault, not default: the empty object has to run through the schema so
    // the per-label norm defaults below it apply.
    labels: labelsSchema.prefault({}),
    nightlyWorkflow: z.string().min(1).optional(),
    codegraphProject: z.string().min(1).optional(),
  })
  .superRefine((config, ctx) => {
    // A profile may only name phases that exist — otherwise `gate --profile x`
    // would discover the typo minutes into the run instead of before it.
    const known = new Set(config.gate.phases.map((phase) => phase.name));
    for (const [profile, phases] of Object.entries(config.gate.profiles)) {
      phases.forEach((phase, index) => {
        if (!known.has(phase)) {
          ctx.addIssue({
            code: "custom",
            path: ["gate", "profiles", profile, index],
            message: `unknown phase "${phase}" — known: ${[...known].join(", ")}`,
          });
        }
      });
    }
  });

export type Config = z.infer<typeof configSchema>;
export type GatePhase = z.infer<typeof phaseSchema>;

/**
 * Loads and validates the config. Every failure path — missing file, broken
 * JSON, schema violation — ends as exit 4 with the offending field, because all
 * three are the same thing to the caller: a violated precondition it must fix.
 */
export function loadConfig(repoRoot: string, configPath?: string): Config {
  const path =
    configPath === undefined
      ? join(repoRoot, CONFIG_FILENAME)
      : isAbsolute(configPath)
        ? configPath
        : join(repoRoot, configPath);

  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    throw new ToolkitError(`config not found: ${path}`, EXIT.PRECONDITION, {
      field: CONFIG_FILENAME,
      cause: error,
    });
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new ToolkitError(`config is not valid JSON: ${path}`, EXIT.PRECONDITION, {
      field: CONFIG_FILENAME,
      cause: error,
    });
  }

  const result = configSchema.safeParse(parsed);
  if (!result.success) {
    const issue = result.error.issues[0];
    const field = issue === undefined ? CONFIG_FILENAME : formatPath(issue.path);
    const message = issue?.message ?? "invalid config";
    throw new ToolkitError(`config invalid at ${field}: ${message}`, EXIT.PRECONDITION, { field });
  }
  return result.data;
}

/** Renders a zod issue path as the field notation a human edits: `a.b[0].c`. */
export function formatPath(path: readonly PropertyKey[]): string {
  if (path.length === 0) return CONFIG_FILENAME;
  return path.reduce<string>((acc, segment) => {
    if (typeof segment === "number") return `${acc}[${segment}]`;
    return acc === "" ? String(segment) : `${acc}.${String(segment)}`;
  }, "");
}

/** The phases of a profile, in config order. Unknown profile → exit 4. */
export function phasesOfProfile(config: Config, profile: string): GatePhase[] {
  const names = config.gate.profiles[profile];
  if (names === undefined) {
    throw new ToolkitError(
      `unknown gate profile "${profile}" — known: ${Object.keys(config.gate.profiles).join(", ")}`,
      EXIT.PRECONDITION,
      { field: `gate.profiles.${profile}` },
    );
  }
  const byName = new Map(config.gate.phases.map((phase) => [phase.name, phase]));
  return names
    .map((name) => byName.get(name))
    .filter((phase): phase is GatePhase => phase !== undefined);
}
