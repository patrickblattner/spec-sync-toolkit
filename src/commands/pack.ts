/**
 * `pack` — the knowledge package a sub-agent starts from (spec §7.3).
 *
 * `spec-sync pack <issue> [--profile <gate profile>]`
 *
 * Writes `.spec-sync/ticket-<nr>.md` with the issue, its acceptance criteria,
 * the referenced spec sections **resolved** (each with `unit@version` and its
 * section hash), CodeGraph candidate files, the exact gate command for this
 * ticket, and a warning about file sets shared with other open tickets.
 *
 * The command resolves; it does not decide. A ticket that names no spec section
 * ends as exit 3 with a machine-readable reason and goes back to the driver —
 * inventing the missing reference is precisely the guess spec §2 forbids.
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Command, CommandContext, CommandResult } from "../cli.js";
import { phasesOfProfile, type Config } from "../config.js";
import { STATE_DIR } from "../logs.js";
import { EXIT, ToolkitError } from "../output.js";
import { checkFlags, positionals, valueFlag } from "../pack/args.js";
import { defaultTools, failureLine, type Tools } from "../pack/exec.js";
import { parseSpecReferences } from "../pack/refs.js";
import { SpecGateway, resolveReferences } from "../pack/spec.js";
import {
  extractAcceptance,
  packFileName,
  readMachineBlock,
  renderPack,
  type CandidateFile,
  type Overlap,
  type PackIssue,
} from "../pack/render.js";

/** Gate profile a ticket is built against unless the caller names another. */
const DEFAULT_GATE_PROFILE = "local";

/** Upper bounds — a pack is read by a model, so both lists stay surveyable. */
const MAX_TERMS = 8;
const MAX_CANDIDATES = 25;

export const packCommand: Command = {
  name: "pack",
  summary: "Build the ticket context pack",
  needsConfig: true,
  run: (ctx) => runPack(ctx, defaultTools(ctx.repoRoot)),
};

export async function runPack(ctx: CommandContext, tools: Tools): Promise<CommandResult> {
  const config = ctx.config as Config;
  checkFlags(ctx.args, ["--profile"]);
  const issueNumber = readIssueNumber(ctx.args);
  const notes: string[] = [];

  const issue = fetchIssue(tools, issueNumber);
  const text = [issue.title, issue.body, ...issue.comments].join("\n\n");

  const parsed = parseSpecReferences(text);
  const gateway = new SpecGateway(tools);
  const { sections, unresolved } = await resolveReferences(parsed.references, gateway);

  if (sections.length === 0) {
    throw await noSectionError(issueNumber, parsed.bareUnits, gateway, unresolved.length);
  }
  for (const reference of unresolved) {
    notes.push(`unresolved: ${reference.unit} §${reference.section} (${reference.reason})`);
  }
  for (const unit of parsed.bareUnits) {
    notes.push(`${unit} is mentioned without a section — not packed`);
  }

  const gate = selectGate(config, valueFlag(ctx.args, "--profile"), issueNumber);
  const candidates = collectCandidates(tools, ctx.repoRoot, text, notes);
  const overlaps = collectOverlaps(tools, ctx.repoRoot, issueNumber, candidates, notes);

  const relativePath = join(STATE_DIR, packFileName(issueNumber));
  const markdown = renderPack({
    issue: {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      url: issue.url,
      labels: issue.labels,
    },
    acceptance: extractAcceptance(issue.body),
    sections,
    candidates,
    gate,
    overlaps,
    notes,
    generatedAt: new Date().toISOString(),
  });

  if (ctx.flags.dryRun) {
    notes.push(`dry run: ${relativePath} was not written`);
  } else {
    mkdirSync(join(ctx.repoRoot, STATE_DIR), { recursive: true });
    writeFileSync(join(ctx.repoRoot, relativePath), markdown, "utf8");
  }

  return {
    ok: true,
    notes,
    data: {
      issue: issueNumber,
      pack: relativePath,
      sections: sections.map((section) => `${section.unit}@${section.version} §${section.slug}`),
      candidateFiles: candidates.length,
      overlaps: overlaps.map((overlap) => `#${overlap.issue}: ${overlap.files.length} file(s)`),
      gate: gate.command,
    },
  };
}

function readIssueNumber(args: string[]): number {
  const [first] = positionals(args, ["--profile"]);
  const parsed = Number.parseInt((first ?? "").replace(/^#/u, ""), 10);
  if (Number.isNaN(parsed) || parsed <= 0) {
    throw new ToolkitError(
      "pack needs an issue number: `spec-sync pack <issue>`",
      EXIT.PRECONDITION,
      { field: "issue" },
    );
  }
  return parsed;
}

interface FetchedIssue extends PackIssue {
  comments: string[];
}

/** `gh` over `child_process` (spec §10) — no GitHub SDK. */
function fetchIssue(tools: Tools, issue: number): FetchedIssue {
  const result = tools.run("gh", [
    "issue",
    "view",
    String(issue),
    "--json",
    "number,title,body,url,labels,comments",
  ]);
  if (!result.ok) {
    throw new ToolkitError(
      `gh issue view ${issue} failed: ${failureLine(result)}`,
      EXIT.PRECONDITION,
      { field: "issue" },
    );
  }

  let payload: {
    number?: number;
    title?: string;
    body?: string;
    url?: string;
    labels?: { name?: string }[];
    comments?: { body?: string }[];
  };
  try {
    payload = JSON.parse(result.stdout) as typeof payload;
  } catch (error) {
    throw new ToolkitError(`gh issue view ${issue} returned no JSON`, EXIT.PRECONDITION, {
      cause: error,
    });
  }

  return {
    number: payload.number ?? issue,
    title: payload.title ?? "",
    body: payload.body ?? "",
    url: payload.url,
    labels: (payload.labels ?? []).flatMap((label) =>
      label.name === undefined ? [] : [label.name],
    ),
    comments: (payload.comments ?? []).flatMap((comment) =>
      comment.body === undefined ? [] : [comment.body],
    ),
  };
}

/**
 * No section resolved. Which of the two exit-3 reasons applies depends on what
 * the ticket does carry: a unit without a section is a different job for the
 * driver (name the section) than a ticket without any spec reference at all
 * (find out what this ticket implements).
 */
async function noSectionError(
  issue: number,
  bareUnits: string[],
  gateway: SpecGateway,
  unresolvedCount: number,
): Promise<ToolkitError> {
  const known: string[] = [];
  for (const unit of bareUnits) {
    if (await gateway.knows(unit)) known.push(unit);
  }

  if (known.length > 0) {
    return new ToolkitError(
      `ticket #${issue} names ${known.join(", ")} without a section — decide which section applies and re-run`,
      EXIT.AMBIGUOUS,
      { reason: "unit-without-section" },
    );
  }
  const detail =
    unresolvedCount > 0
      ? "its spec references resolve to no section"
      : "it carries no `unit §section` reference";
  return new ToolkitError(`ticket #${issue}: ${detail}`, EXIT.AMBIGUOUS, {
    reason: "no-spec-reference",
  });
}

interface GateCommand {
  command: string;
  profile: string;
  phases: { name: string; cmd: string }[];
}

/**
 * The exact gate command for this ticket. `local` is the profile a ticket is
 * built against (the merge profile belongs to `merge`, spec §7.4); a config
 * without it is unambiguous only when it defines exactly one profile.
 */
function selectGate(config: Config, requested: string | undefined, issue: number): GateCommand {
  const available = Object.keys(config.gate.profiles);
  let profile = requested;

  if (profile === undefined) {
    if (available.includes(DEFAULT_GATE_PROFILE)) profile = DEFAULT_GATE_PROFILE;
    else if (available.length === 1) profile = available[0] as string;
    else {
      throw new ToolkitError(
        `ticket #${issue}: no "${DEFAULT_GATE_PROFILE}" gate profile — choose one of ${available.join(", ")} with --profile`,
        EXIT.AMBIGUOUS,
        { reason: "ambiguous-gate-profile" },
      );
    }
  }

  const phases = phasesOfProfile(config, profile).map((phase) => ({
    name: phase.name,
    cmd: phase.cmd,
  }));
  return { command: `spec-sync gate --profile ${profile}`, profile, phases };
}

/**
 * Candidate files. Backticked tokens in the ticket are the only honest input —
 * a path is taken as named (if it exists), an identifier goes to CodeGraph
 * `impact`, with `query` as the fallback when the symbol is unknown. What
 * CodeGraph cannot answer stays out: a wrong candidate costs the sub-agent more
 * than a short list does.
 */
function collectCandidates(
  tools: Tools,
  repoRoot: string,
  text: string,
  notes: string[],
): CandidateFile[] {
  const found = new Map<string, CandidateFile>();
  const add = (path: string, via: string): void => {
    if (found.size >= MAX_CANDIDATES || found.has(path)) return;
    found.set(path, { path, via });
  };

  let codegraphNoted = false;
  for (const term of backtickedTerms(text)) {
    if (found.size >= MAX_CANDIDATES) break;

    if (looksLikePath(term)) {
      if (existsSync(join(repoRoot, term))) add(term, "named in the issue");
      continue;
    }

    const impact = tools.run("codegraph", ["impact", "-j", "-d", "1", term]);
    if (impact.ok) {
      for (const file of impactFiles(impact.stdout)) add(file, `impact: ${term}`);
      continue;
    }
    if (impact.code === 127) {
      if (!codegraphNoted) notes.push(`codegraph unavailable: ${failureLine(impact)}`);
      break;
    }

    const query = tools.run("codegraph", ["query", "-j", "-l", "3", term]);
    if (query.ok) {
      for (const file of queryFiles(query.stdout)) add(file, `query: ${term}`);
    } else if (!codegraphNoted) {
      notes.push(`codegraph answered nothing for "${term}": ${failureLine(query)}`);
      codegraphNoted = true;
    }
  }

  return [...found.values()];
}

/** Backticked tokens, in issue order: `src/x.ts`, `loadConfig`, `spec.lock.json`. */
function backtickedTerms(text: string): string[] {
  const terms: string[] = [];
  for (const match of text.matchAll(/`([^`\n]{2,80})`/gu)) {
    const term = (match[1] ?? "").trim();
    if (term === "" || /\s/u.test(term) || term.startsWith("-")) continue;
    if (!terms.includes(term)) terms.push(term);
    if (terms.length >= MAX_TERMS) break;
  }
  return terms;
}

function looksLikePath(term: string): boolean {
  return term.includes("/") || /\.[a-z]{1,5}$/u.test(term);
}

function impactFiles(stdout: string): string[] {
  try {
    const parsed = JSON.parse(stdout) as { affected?: { filePath?: string }[] };
    return unique((parsed.affected ?? []).map((node) => node.filePath));
  } catch {
    return [];
  }
}

function queryFiles(stdout: string): string[] {
  try {
    const parsed = JSON.parse(stdout) as { node?: { filePath?: string } }[];
    return unique(parsed.map((hit) => hit.node?.filePath));
  } catch {
    return [];
  }
}

function unique(paths: (string | undefined)[]): string[] {
  return [...new Set(paths.filter((path): path is string => path !== undefined && path !== ""))];
}

/**
 * Overlap with other open tickets (spec §7.3). The file sets of the other
 * tickets come from their own packs — the only place the toolkit knows them
 * from — and are reported only while their issue is still open.
 */
function collectOverlaps(
  tools: Tools,
  repoRoot: string,
  issue: number,
  candidates: CandidateFile[],
  notes: string[],
): Overlap[] {
  const mine = new Set(candidates.map((candidate) => candidate.path));
  const stateDir = join(repoRoot, STATE_DIR);
  if (mine.size === 0 || !existsSync(stateDir)) return [];

  const packs: { issue: number; pack: string; files: string[] }[] = [];
  for (const entry of readdirSync(stateDir)) {
    if (!/^ticket-\d+\.md$/u.test(entry)) continue;
    let block;
    try {
      block = readMachineBlock(readFileSync(join(stateDir, entry), "utf8"));
    } catch {
      continue;
    }
    if (block === undefined || block.issue === issue) continue;
    const shared = block.files.filter((file) => mine.has(file));
    if (shared.length > 0) packs.push({ issue: block.issue, pack: entry, files: shared });
  }
  if (packs.length === 0) return [];

  const open = openIssues(tools, notes);
  return packs
    .filter((entry) => open === undefined || open.has(entry.issue))
    .sort((a, b) => a.issue - b.issue);
}

/** Open issue numbers; `undefined` when `gh` could not answer (then nothing is filtered). */
function openIssues(tools: Tools, notes: string[]): Set<number> | undefined {
  const result = tools.run("gh", [
    "issue",
    "list",
    "--state",
    "open",
    "--limit",
    "200",
    "--json",
    "number",
  ]);
  if (!result.ok) {
    notes.push(
      `open state unverified (${failureLine(result)}) — an overlap may name a closed ticket`,
    );
    return undefined;
  }
  try {
    const parsed = JSON.parse(result.stdout) as { number?: number }[];
    return new Set(parsed.flatMap((entry) => (entry.number === undefined ? [] : [entry.number])));
  } catch {
    return undefined;
  }
}
