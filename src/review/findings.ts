/**
 * The findings contract (SST-DESIGN-030 §Prompt and result, PROC-DEV-049).
 *
 * The parser is strict and returns a reason instead of `[]` when in doubt: a
 * swallowed contract breach would be indistinguishable from "no findings",
 * and that difference is the point of the layer. The only tolerance is
 * surrounding whitespace and one Markdown code fence — the one deviation a
 * model reliably produces without changing the content (ported from
 * community-platform `mergeReview.mjs`).
 */

export const SEVERITIES = ["critical", "high", "medium", "low", "taste"] as const;
export const AREAS = ["code", "security"] as const;

export type Severity = (typeof SEVERITIES)[number];
export type Area = (typeof AREAS)[number];

export interface RawFinding {
  area: Area;
  severity: Severity;
  file: string;
  line: number;
  claim: string;
  scenario: string;
  evidence: string;
  fix: string;
}

export interface Finding extends RawFinding {
  /** CX1, CX2, … — assigned by the runner, never by the model. */
  id: string;
}

export interface RecheckEntry {
  id: string;
  resolved: boolean;
  note: string;
}

export type ParseResult =
  { ok: true; findings: RawFinding[]; recheck: RecheckEntry[] } | { ok: false; reason: string };

const FINDING_KEYS = ["area", "severity", "file", "line", "claim", "scenario", "evidence", "fix"];
const RECHECK_KEYS = ["id", "resolved", "note"];

export function parseResult(raw: string): ParseResult {
  const text = raw.trim();
  if (text === "") return { ok: false, reason: "empty output" };
  const unfenced = text
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/, "")
    .trim();

  let data: unknown;
  try {
    data = JSON.parse(unfenced);
  } catch (error) {
    return {
      ok: false,
      reason: `not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  if (!isObject(data)) return { ok: false, reason: "root is not an object" };
  const extra = Object.keys(data).filter((key) => key !== "findings" && key !== "recheck");
  if (extra.length > 0) return { ok: false, reason: `unknown root field ${extra.join(", ")}` };
  if (!Array.isArray(data.findings)) return { ok: false, reason: "`findings` is not an array" };
  if (!Array.isArray(data.recheck)) return { ok: false, reason: "`recheck` is not an array" };

  const findings: RawFinding[] = [];
  for (const [index, entry] of data.findings.entries()) {
    const problem = findingProblem(entry);
    if (problem !== undefined) return { ok: false, reason: `finding ${index}: ${problem}` };
    findings.push(entry as RawFinding);
  }
  const recheck: RecheckEntry[] = [];
  for (const [index, entry] of data.recheck.entries()) {
    const problem = recheckProblem(entry);
    if (problem !== undefined) return { ok: false, reason: `recheck ${index}: ${problem}` };
    recheck.push(entry as RecheckEntry);
  }
  return { ok: true, findings, recheck };
}

function findingProblem(entry: unknown): string | undefined {
  if (!isObject(entry)) return "not an object";
  const missing = FINDING_KEYS.filter((key) => !(key in entry));
  if (missing.length > 0) return `missing ${missing.join(", ")}`;
  const extra = Object.keys(entry).filter((key) => !FINDING_KEYS.includes(key));
  if (extra.length > 0) return `unknown field ${extra.join(", ")}`;
  if (!AREAS.includes(entry.area as Area)) return `unknown area \`${String(entry.area)}\``;
  if (!SEVERITIES.includes(entry.severity as Severity)) {
    return `unknown severity \`${String(entry.severity)}\``;
  }
  for (const key of ["file", "claim", "scenario", "evidence", "fix"]) {
    if (typeof entry[key] !== "string") return `\`${key}\` is not a string`;
  }
  for (const key of ["claim", "evidence"]) {
    if ((entry[key] as string).trim() === "") return `\`${key}\` is empty`;
  }
  if (!Number.isInteger(entry.line) || (entry.line as number) < 0) {
    return "`line` is not a line number";
  }
  return undefined;
}

function recheckProblem(entry: unknown): string | undefined {
  if (!isObject(entry)) return "not an object";
  const missing = RECHECK_KEYS.filter((key) => !(key in entry));
  if (missing.length > 0) return `missing ${missing.join(", ")}`;
  if (typeof entry.id !== "string" || entry.id.trim() === "") return "`id` is empty";
  if (typeof entry.resolved !== "boolean") return "`resolved` is not a boolean";
  if (typeof entry.note !== "string") return "`note` is not a string";
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * Assigns CX ids in order (starting at `CX<start>`, so batch chunks continue
 * the numbering) and applies the downgrade rule: a critical or high finding
 * without line ≥ 1 or without a scenario becomes medium and is listed.
 */
export function assignFindings(
  raw: readonly RawFinding[],
  start = 1,
): { findings: Finding[]; downgraded: string[] } {
  const downgraded: string[] = [];
  const findings = raw.map((entry, index) => {
    const id = `CX${start + index}`;
    const blocking = entry.severity === "critical" || entry.severity === "high";
    if (blocking && (entry.line < 1 || entry.scenario.trim() === "")) {
      downgraded.push(id);
      return { ...entry, id, severity: "medium" as const };
    }
    return { ...entry, id };
  });
  return { findings, downgraded };
}

export type Counts = Record<Severity, number>;

export function countFindings(findings: readonly { severity: Severity }[]): Counts {
  const counts: Counts = { critical: 0, high: 0, medium: 0, low: 0, taste: 0 };
  for (const finding of findings) counts[finding.severity] += 1;
  return counts;
}

/** Critical and high block the merge (exit 1). */
export function isBlocking(finding: { severity: Severity }): boolean {
  return finding.severity === "critical" || finding.severity === "high";
}

/** Critical, high and medium become an issue in batch mode. */
export function isTicketed(finding: { severity: Severity }): boolean {
  return isBlocking(finding) || finding.severity === "medium";
}

/**
 * Dedupe key against open review issues: file plus claim, normalised so a
 * reflowed claim is not a new finding (ported from production-cockpit
 * `codex-review.lib.mjs`).
 */
export function dedupeKey(finding: { file: string; claim: string }): string {
  // `-->` would close the HTML comment the key is stored in.
  return `${finding.file.trim()}::${finding.claim.trim().replace(/\s+/g, " ").toLowerCase()}`.replace(
    /-->/g,
    "-- >",
  );
}

const REVIEW_KEY = /<!-- review-key: (.*?) -->/g;

/** The review keys carried by issue bodies. */
export function reviewKeysOf(bodies: readonly string[]): string[] {
  return bodies.flatMap((body) => [...body.matchAll(REVIEW_KEY)].map((match) => match[1] ?? ""));
}

/** Splits fresh findings from those already open — and from repeats within one run. */
export function partitionFindings<T extends { file: string; claim: string }>(
  findings: readonly T[],
  openKeys: readonly string[],
): { fresh: T[]; duplicates: T[] } {
  const seen = new Set(openKeys);
  const fresh: T[] = [];
  const duplicates: T[] = [];
  for (const finding of findings) {
    const key = dedupeKey(finding);
    if (seen.has(key)) {
      duplicates.push(finding);
      continue;
    }
    seen.add(key);
    fresh.push(finding);
  }
  return { fresh, duplicates };
}

/** One compact line per finding for the JSON response. */
export function findingLine(finding: Finding): string {
  const claim = finding.claim.replace(/\s+/g, " ").trim();
  const short = claim.length > 120 ? `${claim.slice(0, 119)}…` : claim;
  const at = finding.line > 0 ? `${finding.file}:${finding.line}` : finding.file;
  return `${finding.id} ${finding.severity} ${finding.area} ${at} — ${short}`;
}
