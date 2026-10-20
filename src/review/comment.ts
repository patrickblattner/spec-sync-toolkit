/**
 * Review and verdict comments (SST-DESIGN-030 §Output, §Subcommands).
 *
 * A review comment opens with the JSON marker
 * `<!-- spec-sync-review {v, pr, head, model, trigger, round, findings} -->`;
 * `--recheck` reads it back to re-ask the same model about the same findings,
 * and `batch` skips PRs that carry it. A verdict comment carries the
 * `review-verdict` marker — Codex and Claude lenses alike (`--source`).
 */

import type { FailureClass } from "./engine.js";
import { isTicketed } from "./findings.js";
import type { Area, Counts, Finding, RecheckEntry, Severity } from "./findings.js";

export const REVIEW_MARKER = "spec-sync-review";
export const VERDICT_MARKER = "review-verdict";
const MARKER_VERSION = 1;

/** What the marker remembers of a finding — enough to build PRIOR for a recheck. */
export interface MarkerFinding {
  id: string;
  area: Area;
  severity: Severity;
  file: string;
  line: number;
  claim: string;
}

export interface ReviewMarker {
  v: number;
  pr: number;
  head: string;
  model: string;
  /** Reasoning effort of the run; absent in markers written before it existed. */
  effort?: string;
  trigger: string;
  round: number;
  findings: MarkerFinding[];
}

/** JSON that cannot close the HTML comment it sits in. */
function markerJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, "\\u003c").replace(/>/g, "\\u003e");
}

export function markerFindings(findings: readonly Finding[]): MarkerFinding[] {
  return findings.map(({ id, area, severity, file, line, claim }) => ({
    id,
    area,
    severity,
    file,
    line,
    claim,
  }));
}

/** The newest review marker among comment bodies, oldest first. */
export function latestReviewMarker(bodies: readonly string[]): ReviewMarker | undefined {
  let latest: ReviewMarker | undefined;
  for (const body of bodies) {
    const marker = parseReviewMarker(body);
    if (marker !== undefined) latest = marker;
  }
  return latest;
}

export function parseReviewMarker(body: string): ReviewMarker | undefined {
  const match = new RegExp(`<!-- ${REVIEW_MARKER} (\\{.*?\\}) -->`, "s").exec(body);
  if (match === null) return undefined;
  try {
    const data = JSON.parse(match[1] as string) as ReviewMarker;
    if (typeof data.model !== "string" || !Array.isArray(data.findings)) return undefined;
    return data;
  } catch {
    return undefined;
  }
}

export function hasReviewMarker(body: string): boolean {
  return parseReviewMarker(body) !== undefined;
}

const cell = (text: string): string =>
  text
    .replace(/\|/g, "\\|")
    .replace(/\s*\n\s*/g, " ")
    .trim();

function location(file: string, line: number): string {
  return line > 0 ? `\`${file}:${line}\`` : `\`${file}\``;
}

function formatDuration(ms: number): string {
  const seconds = Math.round(ms / 1000);
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m${seconds % 60}s`;
}

export interface ReviewCommentInput {
  pr: number;
  head: string;
  model: string;
  effort: string;
  trigger: string;
  round: number;
  range: string;
  files: number;
  lines: number;
  durationMs: number;
  findings: Finding[];
  downgraded: string[];
}

/** Findings as a Markdown table (shared by PR comment and tag issue). */
export function findingsTable(findings: readonly Finding[]): string[] {
  if (findings.length === 0) return ["No findings."];
  return [
    "| ID | Severity | Area | Location | Claim | Scenario | Fix |",
    "|---|---|---|---|---|---|---|",
    ...findings.map(
      (f) =>
        `| ${f.id} | ${f.severity} | ${f.area} | ${location(f.file, f.line)} | ${cell(f.claim)} | ${cell(f.scenario)} | ${cell(f.fix)} |`,
    ),
  ];
}

export function renderReviewComment(input: ReviewCommentInput): string {
  const marker: ReviewMarker = {
    v: MARKER_VERSION,
    pr: input.pr,
    head: input.head,
    model: input.model,
    effort: input.effort,
    trigger: input.trigger,
    round: input.round,
    findings: markerFindings(input.findings),
  };
  return [
    `<!-- ${REVIEW_MARKER} ${markerJson(marker)} -->`,
    `**Codex review · ${input.model} · ${input.trigger}**`,
    "",
    `Range \`${input.range}\` · ${input.files} files · ${input.lines} lines · ${formatDuration(input.durationMs)}`,
    "",
    ...findingsTable(input.findings),
    ...(input.downgraded.length === 0
      ? []
      : ["", `Downgraded to medium (no line or no scenario): ${input.downgraded.join(", ")}`]),
    "",
    "Findings are premises, not truths — check each against the code and record `spec-sync review verdict`.",
    "",
  ].join("\n");
}

export interface RecheckCommentInput {
  prior: ReviewMarker;
  /** Effort the recheck ran with. */
  effort: string;
  head: string;
  range: string;
  durationMs: number;
  recheck: RecheckEntry[];
  /** The prior findings still open after the recheck. */
  open: MarkerFinding[];
}

export function renderRecheckComment(input: RecheckCommentInput): string {
  const round = input.prior.round + 1;
  const marker: ReviewMarker = {
    v: MARKER_VERSION,
    pr: input.prior.pr,
    head: input.head,
    model: input.prior.model,
    effort: input.effort,
    trigger: input.prior.trigger,
    round,
    findings: input.open,
  };
  const byId = new Map(input.recheck.map((entry) => [entry.id, entry]));
  return [
    `<!-- ${REVIEW_MARKER} ${markerJson(marker)} -->`,
    `**Codex review · ${input.prior.model} · ${input.prior.trigger} · recheck round ${round}**`,
    "",
    `Range \`${input.range}\` · ${input.prior.findings.length} prior findings · ${formatDuration(input.durationMs)}`,
    "",
    ...(input.prior.findings.length === 0
      ? ["No prior findings."]
      : [
          "| ID | Severity | Location | Claim | Status | Note |",
          "|---|---|---|---|---|---|",
          ...input.prior.findings.map((f) => {
            const entry = byId.get(f.id);
            const status = entry?.resolved === true ? "resolved" : "open";
            return `| ${f.id} | ${f.severity} | ${location(f.file, f.line)} | ${cell(f.claim)} | ${status} | ${cell(entry?.note ?? "no answer")} |`;
          }),
        ]),
    "",
  ].join("\n");
}

/** The one line a skipped run posts. */
export function renderSkipLine(cls: FailureClass, model: string): string {
  return `Codex review skipped — ${cls} (${model}). No Claude fallback; nightly batch catches up.\n`;
}

export type Verdict =
  | { verdict: "accepted"; resolution: "fixed" }
  | { verdict: "accepted"; resolution: "ticket"; ticket: number }
  | { verdict: "rejected"; reason: string };

export interface VerdictInput {
  target: "pr" | "issue";
  number: number;
  finding: string;
  source: string;
  verdict: Verdict;
}

export function renderVerdictComment(input: VerdictInput): string {
  const marker = {
    v: MARKER_VERSION,
    target: input.target,
    number: input.number,
    finding: input.finding,
    source: input.source,
    ...input.verdict,
  };
  const v = input.verdict;
  const summary =
    v.verdict === "rejected"
      ? `rejected — ${v.reason}`
      : v.resolution === "fixed"
        ? "accepted (fixed)"
        : `accepted (ticket #${v.ticket})`;
  return [
    `<!-- ${VERDICT_MARKER} ${markerJson(marker)} -->`,
    `Review verdict · ${input.finding} · ${summary} · source ${input.source}`,
    "",
  ].join("\n");
}

/** The tag-mode issue title — one issue per tag. */
export function tagIssueTitle(to: string): string {
  return `Codex review ${to}`;
}

export function renderTagIssue(input: {
  model: string;
  trigger: string;
  range: string;
  files: number;
  durationMs: number;
  counts: Counts;
  findings: Finding[];
  downgraded: string[];
}): string {
  return [
    `**Codex review · ${input.model} · ${input.trigger}**`,
    "",
    `Range \`${input.range}\` · ${input.files} files · ${formatDuration(input.durationMs)}`,
    `Counts: ${Object.entries(input.counts)
      .map(([severity, n]) => `${severity} ${n}`)
      .join(" · ")}`,
    "",
    ...findingsTable(input.findings),
    ...(input.downgraded.length === 0
      ? []
      : ["", `Downgraded to medium (no line or no scenario): ${input.downgraded.join(", ")}`]),
    "",
    ...input.findings.flatMap((f) => [
      `### ${f.id} · ${f.severity} · ${f.area}`,
      "",
      `Evidence: ${f.evidence}`,
      "",
    ]),
    ...(input.findings.some(isTicketed) ? acceptanceCriteria("<id>") : []),
    "Findings are premises, not truths — check each against the code and record `spec-sync review verdict`.",
    "",
  ].join("\n");
}

/** Batch issue for one finding, carrying its review key for dedupe. */
export function batchIssueTitle(finding: Finding): string {
  const claim = finding.claim.trim().replace(/\s+/g, " ");
  const short = claim.length > 90 ? `${claim.slice(0, 89)}…` : claim;
  return `[${finding.area}/${finding.severity}] ${finding.file}: ${short}`;
}

export function renderBatchIssue(
  finding: Finding,
  context: { model: string; range: string; key: string },
): string {
  return [
    `**Area:** ${finding.area} · **Severity:** ${finding.severity} · **Model:** ${context.model} · **ID:** ${finding.id}`,
    "",
    `**Location:** ${location(finding.file, finding.line)}`,
    `**Range:** \`${context.range}\``,
    "",
    "## Claim",
    finding.claim,
    "",
    "## Scenario",
    finding.scenario === "" ? "—" : finding.scenario,
    "",
    "## Evidence",
    finding.evidence,
    "",
    "## Fix",
    finding.fix === "" ? "—" : finding.fix,
    "",
    ...acceptanceCriteria(finding.id),
    "---",
    "",
    "Codex nightly batch review (`spec-sync review batch`). This is a premise, not a truth —",
    "check it against the code before building and record `spec-sync review verdict`.",
    "",
    `<!-- review-key: ${context.key} -->`,
    "",
  ].join("\n");
}

/**
 * The acceptance criteria of a batch or tag issue. The first one is always the
 * premise check (SST-DESIGN-030 rev 4): a finding is confirmed on current
 * `main` before anything is built, otherwise the issue closes it as rejected.
 */
function acceptanceCriteria(id: string): string[] {
  return [
    "## Acceptance criteria",
    "",
    `- [ ] Premise check: confirm the finding on current \`main\`; otherwise close it via \`spec-sync review verdict issue <n> ${id} rejected "<reason>"\`.`,
    `- [ ] The confirmed finding is fixed on \`main\` and recorded via \`spec-sync review verdict issue <n> ${id} accepted fixed\`.`,
    "",
  ];
}
