/**
 * Leftovers of aborted runs (spec §7.7, `DECISION (doctor-finds-orphans)`).
 *
 * This is the class of finding no merge ritual can prevent, because it arises
 * when the merge **never happened**: a worktree nobody removed, a branch whose
 * ticket is long closed, and — the expensive one — a branch that still carries
 * work which never landed.
 *
 * The last one is why this module does not ask git whether a branch is
 * "merged". Under squash merges every merged branch looks unmerged, and a diff
 * against today's `main` cannot tell "never merged" from "`main` moved on".
 * So the question is asked about **content**: which of the symbols and test
 * titles this branch introduces are absent from `main`? What is absent has not
 * landed, no matter how the history looks.
 */

import { readFileSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Tools } from "./exec.js";

/** The ledger, addressed as a file: §8 fixes the path, `src/ledger.ts` owns the writing. */
const LEDGER_FILE = join(".spec-sync", "ledger.jsonl");

/** A branch or worktree is judged against `main` — the only branch a merge targets (§7.4). */
const BASE = "main";

/** Spec §7.7: a worktree older than this is a leftover. */
const MAX_WORKTREE_AGE_MS = 24 * 60 * 60 * 1000;

/** Cost bounds — a repo with 250 branches must not turn `doctor` into a build step. */
const MAX_CONTENT_BRANCHES = 20;
const MAX_MARKERS = 10;

/** How many examples a summarised finding names before pointing at the log. */
const MAX_EXAMPLES = 5;

export interface OrphanFinding {
  check: string;
  detail: string;
}

export interface OrphanReport {
  findings: OrphanFinding[];
  notes: string[];
  /** Full lists for the log file — the response only carries the summary. */
  details: string[];
}

export interface OrphanInput {
  tools: Tools;
  repoRoot: string;
  /** Open issue numbers. `undefined` when `gh` could not answer; then nothing is judged by ticket. */
  openIssues?: Set<number>;
  now?: number;
}

export function findOrphans(input: OrphanInput): OrphanReport {
  const report: OrphanReport = { findings: [], notes: [], details: [] };
  checkWorktrees(input, report);
  checkBranches(input, report);
  checkIncompleteMerges(input, report);
  return report;
}

/**
 * The ticket a branch belongs to: the number has to be the first segment after
 * an optional type prefix (`chore/304-seed`, `304-seed`). Anything looser would
 * read `chore/spec-lock-2451` as ticket 2451 and report a stranger's branch.
 */
export function ticketOfBranch(branch: string): number | undefined {
  const match = /^(?:[a-z][a-z0-9._-]*\/)?(\d+)(?:[-_/]|$)/u.exec(branch);
  return match?.[1] === undefined ? undefined : Number.parseInt(match[1], 10);
}

interface Worktree {
  path: string;
  branch?: string;
}

/** Worktrees other than the main checkout and the one `doctor` is running in. */
function checkWorktrees(input: OrphanInput, report: OrphanReport): void {
  const listed = input.tools.run("git", ["worktree", "list", "--porcelain"]);
  if (!listed.ok) return;

  const common = input.tools.run("git", [
    "rev-parse",
    "--path-format=absolute",
    "--git-common-dir",
  ]);
  const mainWorktree = common.ok ? dirname(common.stdout.trim()) : undefined;
  const now = input.now ?? Date.now();

  for (const worktree of parseWorktrees(listed.stdout)) {
    if (worktree.path === mainWorktree || worktree.path === input.repoRoot) continue;

    const reasons: string[] = [];
    const age = worktreeAge(worktree.path, now);
    if (age !== undefined && age > MAX_WORKTREE_AGE_MS) {
      reasons.push(`${Math.floor(age / MAX_WORKTREE_AGE_MS)}d old`);
    }

    const ticket = worktree.branch === undefined ? undefined : ticketOfBranch(worktree.branch);
    if (ticket !== undefined && input.openIssues?.has(ticket) === false) {
      reasons.push(`ticket #${ticket} is closed`);
    }

    if (reasons.length > 0) {
      report.findings.push({
        check: "orphan-worktree",
        detail: `${worktree.path} (${reasons.join(", ")}) — remove it, it breaks gates in the main checkout`,
      });
    }
  }
}

export function parseWorktrees(porcelain: string): Worktree[] {
  const worktrees: Worktree[] = [];
  let current: Worktree | undefined;

  for (const line of porcelain.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice("worktree ".length).trim() };
      worktrees.push(current);
    } else if (line.startsWith("branch ") && current !== undefined) {
      current.branch = line
        .slice("branch ".length)
        .trim()
        .replace(/^refs\/heads\//u, "");
    } else if (line.startsWith("bare") && current !== undefined) {
      worktrees.pop();
      current = undefined;
    }
  }
  return worktrees;
}

/**
 * Age of a worktree = how long it has existed. Its `.git` file is written when
 * the worktree is created, which makes it the closest thing to a birth date
 * that git offers without bookkeeping of our own.
 */
function worktreeAge(path: string, now: number): number | undefined {
  for (const candidate of [join(path, ".git"), path]) {
    try {
      return now - statSync(candidate).mtimeMs;
    } catch {
      continue;
    }
  }
  return undefined;
}

function checkBranches(input: OrphanInput, report: OrphanReport): void {
  if (!input.tools.run("git", ["rev-parse", "--verify", "--quiet", BASE]).ok) {
    report.notes.push(`no ${BASE} branch — leftover branches were not judged`);
    return;
  }
  if (input.openIssues === undefined) {
    report.notes.push("open tickets unknown — leftover branches were not judged");
    return;
  }

  const listed = input.tools.run("git", [
    "for-each-ref",
    "--format=%(refname:short)",
    "refs/heads",
  ]);
  if (!listed.ok) return;

  const current = input.tools.run("git", ["branch", "--show-current"]).stdout.trim();
  const closed: string[] = [];
  const unnumbered: string[] = [];
  let deepChecked = 0;

  for (const branch of listed.stdout.split("\n").map((line) => line.trim())) {
    if (branch === "" || branch === BASE || branch === current) continue;

    const ticket = ticketOfBranch(branch);
    if (ticket === undefined) {
      unnumbered.push(branch);
      continue;
    }

    if (!input.openIssues.has(ticket)) {
      closed.push(`${branch} (#${ticket})`);
      continue;
    }

    if (deepChecked >= MAX_CONTENT_BRANCHES) continue;
    deepChecked += 1;
    checkUnlandedWork(input, report, branch, ticket);
  }

  if (closed.length > 0) {
    report.findings.push({
      check: "orphan-branch",
      detail: `${closed.length} branch(es) whose ticket is closed: ${examples(closed)}`,
    });
    report.details.push(`branches of closed tickets:\n  ${closed.join("\n  ")}`);
  }
  if (unnumbered.length > 0) {
    report.notes.push(
      `${unnumbered.length} branch(es) carry no ticket number in their name and were not judged`,
    );
    report.details.push(`branches without a ticket number:\n  ${unnumbered.join("\n  ")}`);
  }
}

/**
 * Does this branch carry work that never landed? Compared by content, not by
 * ancestry (see the module comment).
 */
function checkUnlandedWork(
  input: OrphanInput,
  report: OrphanReport,
  branch: string,
  ticket: number,
): void {
  const ahead = input.tools.run("git", ["rev-list", "--count", `${BASE}..${branch}`]);
  if (!ahead.ok || Number.parseInt(ahead.stdout.trim(), 10) === 0) return;

  const diff = input.tools.run("git", ["diff", `${BASE}...${branch}`]);
  if (!diff.ok) return;

  const markers = introducedMarkers(diff.stdout);
  if (markers.length === 0) {
    report.details.push(`${branch}: has own commits but introduces no symbol or test title`);
    return;
  }

  const missing = markers.filter(
    (marker) => !input.tools.run("git", ["grep", "-q", "-F", "--", marker, BASE]).ok,
  );
  if (missing.length === 0) return;

  report.findings.push({
    check: "unlanded-work",
    detail: `${branch} (#${ticket} open): ${missing.length} of ${markers.length} introduced markers are absent from ${BASE} — ${examples(missing, 2)}`,
  });
  report.details.push(`${branch} (#${ticket}) missing from ${BASE}:\n  ${missing.join("\n  ")}`);
}

/**
 * What a diff introduces, in the two forms spec §7.7 names: test titles and
 * symbol declarations. Both are stable enough to be grepped for on `main` —
 * unlike arbitrary added lines, which get reformatted on the way.
 */
export function introducedMarkers(diff: string): string[] {
  const markers: string[] = [];
  const add = (marker: string | undefined): void => {
    if (marker === undefined) return;
    const trimmed = marker.trim();
    if (trimmed.length < 8 || markers.includes(trimmed)) return;
    if (markers.length < MAX_MARKERS) markers.push(trimmed);
  };

  for (const line of diff.split("\n")) {
    if (!line.startsWith("+") || line.startsWith("+++")) continue;
    const added = line.slice(1);

    const title = /\b(?:it|test|describe)\s*\(\s*["'`]([^"'`]+)["'`]/u.exec(added);
    if (title !== null) {
      add(title[1]);
      continue;
    }
    const symbol =
      /\b(?:export\s+)?(?:async\s+)?(?:function|class|interface|type|const|let)\s+([A-Za-z_$][\w$]*)/u.exec(
        added,
      );
    add(symbol?.[1]);
  }
  return markers;
}

/**
 * A `merge-started` without its `merge-completed` (spec §7.4/§7.7): the merge
 * sequence died between two mutating steps and left the rest undone.
 *
 * The ledger is read line by line here rather than through `src/ledger.ts`,
 * whose event list spec §8 keeps closed at six types — it drops both of these
 * as malformed. Reading the two field names §8 names (`type`, `issue`) keeps
 * this check working without editing a module that belongs to `merge`.
 */
function checkIncompleteMerges(input: OrphanInput, report: OrphanReport): void {
  const started = new Map<number, string>();
  const completed = new Set<number>();

  let raw: string;
  try {
    raw = readFileSync(join(input.repoRoot, LEDGER_FILE), "utf8");
  } catch {
    return; // no ledger yet — nothing to be incomplete
  }

  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let event: { type?: unknown; issue?: unknown; at?: unknown };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      continue;
    }
    if (typeof event.issue !== "number") continue;
    if (event.type === "merge-started") {
      started.set(event.issue, typeof event.at === "string" ? event.at : "");
    } else if (event.type === "merge-completed") {
      completed.add(event.issue);
    }
  }

  for (const [issue, at] of started) {
    if (completed.has(issue)) continue;
    report.findings.push({
      check: "merge-incomplete",
      detail: `#${issue}: merge-started${at === "" ? "" : ` at ${at}`} without merge-completed — re-run \`spec-sync merge\` to finish the sequence`,
    });
  }
}

function examples(entries: string[], limit = MAX_EXAMPLES): string {
  const shown = entries.slice(0, limit).join(", ");
  return entries.length > limit ? `${shown}, … (+${entries.length - limit})` : shown;
}
