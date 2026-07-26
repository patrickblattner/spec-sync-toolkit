/**
 * `doctor` — the environment against the norm (spec §7.7).
 *
 * `spec-sync doctor`
 *
 * Six checks, no repairs: the agent types of the effort table exist with a
 * valid `effort:` frontmatter, the skill tables match the spec's, the repo
 * knows the configured labels, `spec.lock.json` is present and schema v3, the
 * pinned norm section still hashes to its pinned value (spec §6), and the pause
 * flag is absent. Findings are reported, never fixed — repairing a drifted norm
 * would decide something the owner has not decided (spec §2).
 *
 * Exit 1 on at least one finding.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Command, CommandContext, CommandResult } from "../cli.js";
import { loadConfig, type Config } from "../config.js";
import { readLedger } from "../ledger.js";
import { createLogDir, protectedLogDirs, writePhaseLog } from "../logs.js";
import { PINNED_NORM_SECTION, checkNormDrift } from "../norms.js";
import { EXIT } from "../output.js";
import { checkFlags } from "../pack/args.js";
import { defaultTools, failureLine, type Tools } from "../pack/exec.js";
import { findOrphans } from "../pack/orphans.js";

/** Where the norm expects the agent definitions and the skill, below `$HOME`. */
const AGENTS_DIR = join(".claude", "agents");
const SKILL_FILE = join(".claude", "skills", "spec-sync", "SKILL.md");

const LOCK_FILE = "spec.lock.json";
const LOCK_SCHEMA = "spec.lock/v3";
const PAUSE_FILE = ".spec-sync-pause";

/** `effort:` values the agent loader accepts (foundation.dev.process §Worker-Loop). */
const EFFORT_VALUES = new Set(["low", "medium", "high", "xhigh", "max"]);

/** How many findings the response itself carries; the rest lives in the log. */
const MAX_LISTED_FINDINGS = 8;

export interface DoctorDeps {
  tools: Tools;
  /** Home directory holding `.claude/agents` and `.claude/skills` — a seam for tests. */
  home: string;
}

export const doctorCommand: Command = {
  name: "doctor",
  summary: "Check the environment against the norm",
  needsConfig: false,
  run: (ctx) => runDoctor(ctx, { tools: defaultTools(ctx.repoRoot), home: homedir() }),
};

export interface Finding {
  check: string;
  detail: string;
}

export async function runDoctor(ctx: CommandContext, deps: DoctorDeps): Promise<CommandResult> {
  checkFlags(ctx.args, []);

  const findings: Finding[] = [];
  const notes: string[] = [];
  const details: string[] = [];
  const add = (check: string, detail: string): void => void findings.push({ check, detail });

  const specSection = await readNormSection(deps.tools, add);
  if (specSection === undefined) {
    notes.push("agent-effort and skill-table checks need the spec-mcp server and were skipped");
  } else {
    const specTable = parseEffortTable(specSection);
    if (specTable.length === 0) {
      add("effort-table", `no effort table in ${PINNED_NORM_SECTION.unit} §Worker-Loop`);
    } else {
      checkAgentDefinitions(specTable, deps.home, add);
      checkSkillTable(specTable, deps.home, add);
    }
  }

  checkLabels(ctx, deps.tools, add, notes);
  checkLock(ctx.repoRoot, add);
  await checkNormHash(deps.tools, add);
  checkPause(ctx.repoRoot, add);

  // Leftovers of aborted runs (spec §7.7). They need to know which tickets are
  // still open, so this runs after the checks that already reported a broken `gh`.
  const orphans = findOrphans({
    tools: deps.tools,
    repoRoot: ctx.repoRoot,
    openIssues: openIssues(deps.tools),
  });
  findings.push(...orphans.findings);
  notes.push(...orphans.notes);
  details.push(...orphans.details);

  const logDir =
    findings.length === 0
      ? undefined
      : writeReport(ctx.repoRoot, findings, details, ctx.config?.logRetention);
  const listed = findings
    .slice(0, MAX_LISTED_FINDINGS)
    .map((finding) => `${finding.check}: ${finding.detail}`);
  if (findings.length > listed.length) {
    listed.push(`… ${findings.length - listed.length} more, see ${logDir}`);
  }

  return {
    ok: findings.length === 0,
    exit: findings.length === 0 ? EXIT.OK : EXIT.FAILED,
    notes,
    logDir,
    data: { findings: listed },
  };
}

type Add = (check: string, detail: string) => void;

/** The pinned norm section — source of the effort table the other checks compare against. */
async function readNormSection(tools: Tools, add: Add): Promise<string | undefined> {
  try {
    const payload = await tools.spec<{ content?: string }>("get_section", {
      id: PINNED_NORM_SECTION.unit,
      heading: PINNED_NORM_SECTION.section,
    });
    if (payload.content === undefined) {
      add("spec-mcp", `${PINNED_NORM_SECTION.unit} §Worker-Loop returned no content`);
      return undefined;
    }
    return payload.content;
  } catch (error) {
    add("spec-mcp", error instanceof Error ? error.message : String(error));
    return undefined;
  }
}

export interface EffortRow {
  agent: string;
  effort: string;
}

/**
 * The effort table of a markdown document: rows whose agent cell names an agent
 * in backticks. The row for "the worker itself" carries no such cell and is not
 * an agent type, so it drops out on its own — as do header and separator rows.
 */
export function parseEffortTable(markdown: string): EffortRow[] {
  const rows: EffortRow[] = [];

  for (const line of markdown.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("|")) continue;

    const cells = trimmed.split("|").slice(1, -1);
    if (cells.length < 3) continue;

    const agent = /`([a-z][a-z0-9-]*)`/u.exec(cells[1] ?? "")?.[1];
    if (agent === undefined) continue;

    const effort = (cells[2] ?? "").replace(/[`*]/gu, "").trim();
    if (!rows.some((row) => row.agent === agent)) rows.push({ agent, effort });
  }

  return rows;
}

/**
 * Every agent type of the table exists as a definition with a valid `effort:`
 * frontmatter. A file without frontmatter is not an agent type at all — it is
 * never registered, so a spawn against it silently runs at the parent's level.
 */
function checkAgentDefinitions(table: EffortRow[], home: string, add: Add): void {
  for (const row of table) {
    const relative = join(AGENTS_DIR, `${row.agent}.md`);
    const path = join(home, relative);

    if (!existsSync(path)) {
      add("agent-type", `${row.agent}: no ~/${relative}`);
      continue;
    }

    const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/u.exec(readFileSync(path, "utf8"))?.[1];
    if (frontmatter === undefined) {
      add("agent-type", `${row.agent}: ~/${relative} has no frontmatter — not an agent type`);
      continue;
    }

    const effort = /^effort:\s*(\S+)/mu.exec(frontmatter)?.[1];
    if (effort === undefined) {
      add("agent-type", `${row.agent}: ~/${relative} has no effort: field — not an agent type`);
      continue;
    }
    if (!EFFORT_VALUES.has(effort) && !/^\d+$/u.test(effort)) {
      add("agent-type", `${row.agent}: effort "${effort}" is not a valid level`);
      continue;
    }
    if (effort !== row.effort) {
      add(
        "agent-type",
        `${row.agent}: effort ${effort} in the definition, ${row.effort} in the spec`,
      );
    }
  }
}

/** The skill's table against the spec's — the drift the ADR names by example. */
function checkSkillTable(specTable: EffortRow[], home: string, add: Add): void {
  const path = join(home, SKILL_FILE);
  if (!existsSync(path)) {
    add("skill-table", `no ~/${SKILL_FILE}`);
    return;
  }

  const skillTable = parseEffortTable(readFileSync(path, "utf8"));
  if (skillTable.length === 0) {
    add("skill-table", `~/${SKILL_FILE} carries no effort table`);
    return;
  }

  const inSkill = new Map(skillTable.map((row) => [row.agent, row.effort]));
  const inSpec = new Map(specTable.map((row) => [row.agent, row.effort]));

  for (const row of specTable) {
    const effort = inSkill.get(row.agent);
    if (effort === undefined)
      add("skill-table", `${row.agent} is in the spec table, not in the skill`);
    else if (effort !== row.effort) {
      add("skill-table", `${row.agent}: ${effort} in the skill, ${row.effort} in the spec`);
    }
  }
  for (const row of skillTable) {
    if (!inSpec.has(row.agent))
      add("skill-table", `${row.agent} is in the skill table, not in the spec`);
  }
}

/** Does the repo know its configured labels? A missing config is itself a finding. */
function checkLabels(ctx: CommandContext, tools: Tools, add: Add, notes: string[]): void {
  let config: Config;
  try {
    config = loadConfig(ctx.repoRoot, ctx.flags.config);
  } catch (error) {
    add("config", error instanceof Error ? error.message : String(error));
    return;
  }

  const result = tools.run("gh", ["label", "list", "--limit", "200", "--json", "name"]);
  if (!result.ok) {
    add("labels", `gh label list failed: ${failureLine(result)}`);
    return;
  }

  let known: Set<string>;
  try {
    known = new Set(
      (JSON.parse(result.stdout) as { name?: string }[]).flatMap((label) =>
        label.name === undefined ? [] : [label.name],
      ),
    );
  } catch {
    add("labels", "gh label list returned no JSON");
    return;
  }

  const missing = Object.entries(config.labels).filter(([, label]) => !known.has(label));
  for (const [key, label] of missing) add("labels", `${key} label "${label}" does not exist here`);
  if (missing.length === 0)
    notes.push(`${Object.keys(config.labels).length} configured labels exist`);
}

function checkLock(repoRoot: string, add: Add): void {
  const path = join(repoRoot, LOCK_FILE);
  if (!existsSync(path)) {
    add("lock", `no ${LOCK_FILE} — pin it with get_manifest before deriving tickets`);
    return;
  }
  try {
    const schema = (JSON.parse(readFileSync(path, "utf8")) as { schema?: string }).schema;
    if (schema !== LOCK_SCHEMA) {
      add("lock", `${LOCK_FILE} is ${schema ?? "unversioned"}, not ${LOCK_SCHEMA}`);
    }
  } catch (error) {
    add("lock", `${LOCK_FILE} is not valid JSON: ${error instanceof Error ? error.message : ""}`);
  }
}

/** Has the pinned norm section moved? Transitional state, spec §6. */
async function checkNormHash(tools: Tools, add: Add): Promise<void> {
  const drift = await checkNormDrift(async (unit, section) => {
    // The lock manifest, not `ticket_context`: the pinned hash is a lock hash.
    const payload = await tools.spec<{
      snapshot?: { entries?: { id: string; sections?: Record<string, string> }[] };
    }>("get_manifest", { project: unit.split(".")[0] ?? unit });
    return payload.snapshot?.entries?.find((entry) => entry.id === unit)?.sections?.[section];
  });

  if (drift.unreachable !== undefined) {
    add("norm-hash", `not verifiable: ${drift.unreachable}`);
    return;
  }
  if (drift.drifted) {
    add(
      "norm-hash",
      `${drift.unit} §Worker-Loop moved to ${drift.currentHash?.slice(0, 12)}… — the defaults in src/norms.ts may be stale`,
    );
  }
}

function checkPause(repoRoot: string, add: Add): void {
  if (existsSync(join(repoRoot, PAUSE_FILE))) {
    add("pause", `${PAUSE_FILE} exists — the loop is paused`);
  }
}

/**
 * Open issue numbers, for the leftover checks. `undefined` when `gh` cannot
 * answer — the caller then judges nothing by ticket instead of guessing. A
 * failing `gh` is already a finding of the label check; it is not repeated here.
 */
function openIssues(tools: Tools): Set<number> | undefined {
  const result = tools.run("gh", [
    "issue",
    "list",
    "--state",
    "open",
    "--limit",
    "500",
    "--json",
    "number",
  ]);
  if (!result.ok) return undefined;
  try {
    const parsed = JSON.parse(result.stdout) as { number?: number }[];
    return new Set(parsed.flatMap((entry) => (entry.number === undefined ? [] : [entry.number])));
  } catch {
    return undefined;
  }
}

/** The full report goes to the log directory; the response carries the path (spec §3). */
function writeReport(
  repoRoot: string,
  findings: Finding[],
  details: string[],
  retention?: number,
): string {
  const logDir = createLogDir(repoRoot, {
    retention,
    keep: protectedLogDirs(readLedger(repoRoot).events),
  });
  const report = [
    `spec-sync doctor — ${findings.length} finding(s)`,
    "",
    ...findings.map((finding, index) => `${index + 1}. [${finding.check}] ${finding.detail}`),
    ...(details.length === 0 ? [] : ["", "--- details ---", "", ...details]),
    "",
  ].join("\n");
  writePhaseLog(repoRoot, logDir, "doctor", report);
  return logDir;
}
