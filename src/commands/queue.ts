/**
 * `queue` — assemble and sort the work queue (spec §7.2).
 *
 * The command **decides nothing** (spec §2). It sweeps the open tickets, drops
 * what `owner-hold` protects, sorts what carries a legible phase pin first by its
 * priority class label (`P1 must` → `P2 important` → `P3 polish`, `PROC-DEV-039`
 * rev 3 "sort level ½", `SST-DESIGN-017` rev 6), then by the four tiers of
 * `foundation.dev.process` §Worker-Loop within each class, and *reports*
 * everything else:
 *
 *   - a ticket without a legible phase pin is **not guessed** — it lands in
 *     `needsPin` with the reason it could not be placed;
 *   - the two nightly cases ("red without ticket", "not run for > 25 h despite
 *     new commits") are reported as `findings`, **not** turned into tickets;
 *   - tickets outside the sweep are listed so the mandatory closing line of the
 *     Zielabgleich can name them;
 *   - a **blocked** ticket is marked at its sort position, never filtered out —
 *     a stale label must not silently hide work, and the position itself is the
 *     anchor a path-clearer inherits its rank at (`PROC-DEV-039`, level 0);
 *   - a ticket without a class label sorts as P2 and is listed in
 *     `unclassified` — the class is never guessed; one with several class
 *     labels sorts by the highest and is a `label-drift` finding.
 *
 * `--check` answers in one line — open count and next number — from a **single**
 * `gh` call, so an empty tick costs one roundtrip.
 *
 * `--health` judges the same sweep like a gate (`SST-DESIGN-017` rev 7): exit 0
 * without a finding, exit 1 with one `health` finding per failed check. It
 * writes nothing.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { simpleGit } from "simple-git";
import { EXIT, ToolkitError, type ExitCode } from "../output.js";
import { loadNorms, type Norms } from "../norms.js";
import type { Command, CommandContext } from "../cli.js";
import type { Config } from "../config.js";

const execFileAsync = promisify(execFile);

/** Hours after which a nightly that has not run counts as a finding (§Worker-Loop step 0). */
export const NIGHTLY_STALE_HOURS = 25;

/** Login the nightly report jobs post under — the label-drift guard keys on it. */
export const BOT_LOGIN = "github-actions[bot]";

/** How many open issues one sweep asks for. Above this the queue is not the bottleneck. */
const ISSUE_LIMIT = 200;

/** Conclusions that make a nightly run red. */
const RED_CONCLUSIONS = new Set(["failure", "timed_out", "cancelled", "startup_failure"]);

/** Runs `gh <args>` and returns stdout. The seam every test replaces. */
export type GhRunner = (args: string[]) => Promise<string>;

export interface QueueDeps {
  gh: GhRunner;
  /** ISO timestamp of the newest commit on `main`, or undefined when unknown. */
  lastMainCommit: () => Promise<string | undefined>;
  now: () => Date;
}

/** The shape of `gh issue list --json number,title,labels,author,comments,updatedAt`. */
export interface GhIssue {
  number: number;
  title: string;
  labels?: { name: string }[];
  author?: { login: string } | null;
  /** `gh` returns full comment objects; `createdAt` dates them for `--health`. */
  comments?: { body: string; createdAt?: string }[];
  /** Last activity on the issue — the stale-block fallback when it has no comment. */
  updatedAt?: string;
}

/**
 * A comment documents a block when it carries a `Bedingung:`/`Condition:` line,
 * or names a condition together with a target phase — the two halves
 * `PROC-DEV-039` asks a deferral to write down.
 */
const CONDITION_LINE = /^\s*(?:Bedingung|Condition)\s*:/im;
const CONDITION_WORD = /\b(?:Bedingung|condition)\b/i;
const PHASE_WORD = /\bPhase\b/i;

/**
 * The last documented condition comment of a blocked ticket, verbatim, or `null`
 * when the ticket carries none.
 *
 * Last wins, over the comment order `gh` returns — the same rule and the same
 * assumption as `readPhasePin` right above: a deferral is changed by writing a
 * new comment, not by editing an old one.
 *
 * `null` is reported, never filled in (`SST-DESIGN-017` rev 4). The command does
 * not judge whether the condition still holds, and it must not invent one that
 * was never written: an unexplained block is a finding for the reader, and
 * substituting an unrelated comment would hide exactly that.
 */
export function readBlockedCondition(issue: GhIssue): string | null {
  let documented: string | null = null;
  for (const comment of issue.comments ?? []) {
    const body = comment.body;
    if (CONDITION_LINE.test(body) || (CONDITION_WORD.test(body) && PHASE_WORD.test(body))) {
      documented = body.trim();
    }
  }
  return documented;
}

/** The priority class of a queue entry (`SST-DESIGN-017` rev 6). */
export type PriorityClass = "must" | "important" | "polish" | "unclassified";

/** Sort order of the classes: an unclassified ticket sorts as P2, never guessed. */
const CLASS_ORDER: Record<PriorityClass, number> = {
  must: 0,
  important: 1,
  unclassified: 1,
  polish: 2,
};

export interface QueueEntry {
  issue: number;
  title: string;
  /** Priority class from the class label — the first sort key, ahead of tier 1. */
  class: PriorityClass;
  /** 0 = `auto-audit`, 1 = `type: bug`, 2 = ordinary build ticket. Tier 1. */
  rank: number;
  /** Increments already merged to `main` — tier 2, started before unstarted. */
  started: boolean;
  /** Resolved build phase — tier 3. */
  phase: number;
  /** The pin verbatim, e.g. `M3` or `aktuell`. */
  pin: string;
  /**
   * Set when the ticket carries the block label. Absent otherwise — it marks,
   * it never filters and never sorts: a blocked ticket keeps its position,
   * because that position is the anchor a path-clearer inherits its rank at
   * (`PROC-DEV-039`, sort level 0).
   */
  blocked?: true;
  /**
   * The last documented condition comment, or `null` when the block is
   * undocumented. Present exactly when `blocked` is.
   */
  blockedComment?: string | null;
  /** 1-based position in the sorted queue. */
  position: number;
}

export interface NeedsPinEntry {
  issue: number;
  title: string;
  /** Why it could not be placed — never a guessed phase. */
  reason: string;
  labels: string[];
}

export interface TicketRef {
  issue: number;
  title: string;
}

export type FindingKind =
  "nightly-red-without-ticket" | "nightly-stale" | "label-drift" | "nightly-unknown";

export interface Finding {
  kind: FindingKind;
  detail: string;
  issue?: number;
}

export interface Sweep {
  queue: QueueEntry[];
  needsPin: NeedsPinEntry[];
  /** `owner-hold` tickets. Reported, never worked — the hold beats everything. */
  held: TicketRef[];
  /** `status: deferred` tickets. Reported, never worked, never counted as outside the sweep. */
  deferred: TicketRef[];
  /** Open tickets outside the sweep — the mandatory closing line names these. */
  notSwept: TicketRef[];
  /** Queued tickets without a class label — sorted as P2, listed for backfill. */
  unclassified: TicketRef[];
  labelDrift: Finding[];
}

export interface QueueOptions {
  check: boolean;
  /** `--health`: judge the sweep like a gate (`SST-DESIGN-017` rev 7). Absent = off. */
  health?: boolean;
}

/**
 * Parses `queue`'s own options out of the leftover argv.
 *
 * `cli.ts` passes command-specific flags through untouched, so validating them
 * — and failing with exit 4 naming the offending field — is this command's job.
 * `--check` takes no value, so there is no `--check=…` spelling to accept.
 */
export function parseQueueOptions(args: string[]): QueueOptions {
  let check = false;
  let health = false;
  for (const token of args) {
    if (token === "--check") check = true;
    else if (token === "--health") health = true;
    else
      throw new ToolkitError(`unknown option for queue: ${token}`, EXIT.PRECONDITION, {
        field: token,
      });
  }
  // Two different answers — a one-line count and a verdict — never both at once.
  if (check && health) {
    throw new ToolkitError("--health cannot be combined with --check", EXIT.PRECONDITION, {
      field: "--health",
    });
  }
  return { check, health };
}

/**
 * Reads the phase pin from an issue's comments (§Worker-Loop step 4:
 * `Phase: <X> — <reason>`). The **last** such comment wins — the norm allows a
 * change only through a new, reasoned comment.
 */
export function readPhasePin(issue: GhIssue): string | undefined {
  let pin: string | undefined;
  for (const comment of issue.comments ?? []) {
    for (const line of comment.body.split("\n")) {
      const match = /^\s*Phase:\s*(.+)$/i.exec(line);
      if (match?.[1] === undefined) continue;
      // `M3 — Querschnitt` → `M3`: the reason after the dash is prose, not the pin.
      const token = match[1].split(/\s[—–-]\s/)[0]?.trim();
      if (token !== undefined && token !== "") pin = token;
    }
  }
  return pin;
}

/** A pin that names the current phase rather than a number (`Phase: aktuell`). */
const CURRENT_PHASE = Symbol("current-phase");

/**
 * Resolves a pin to a sortable phase. `M3`, `3` and `Phase 3` are the same
 * number; `aktuell` is the current phase and stays symbolic until the whole set
 * is known. Anything else is **not guessed** — the caller reports it.
 */
export function resolvePin(pin: string): number | typeof CURRENT_PHASE | undefined {
  const normalized = pin.trim().toLowerCase();
  if (normalized === "aktuell" || normalized === "current") return CURRENT_PHASE;
  const digits = /(\d+)/.exec(normalized);
  if (digits?.[1] === undefined) return undefined;
  return Number.parseInt(digits[1], 10);
}

function labelNames(issue: GhIssue): string[] {
  return (issue.labels ?? []).map((label) => label.name);
}

/**
 * The class a ticket's labels name, and every class label it carries. Several
 * class labels resolve to the highest — the caller reports the drift.
 */
function readClass(
  labels: string[],
  names: Config["labels"]["priority"],
): { class: PriorityClass; found: string[] } {
  const ordered: [Exclude<PriorityClass, "unclassified">, string][] = [
    ["must", names.must],
    ["important", names.important],
    ["polish", names.polish],
  ];
  const present = ordered.filter(([, name]) => labels.includes(name));
  return { class: present[0]?.[0] ?? "unclassified", found: present.map(([, name]) => name) };
}

/**
 * Sweeps the open issues into the five lists of §7.2. Pure over its input, so
 * the sorting rules are testable without touching a repo.
 */
export function sweepIssues(issues: GhIssue[], config: Config, norms: Norms): Sweep {
  const {
    audit,
    bug,
    build,
    started: startedLabel,
    blocked: blockedLabel,
    priority,
  } = config.labels;
  const hold = norms.hold;
  const deferredLabel = norms.deferred;

  const held: TicketRef[] = [];
  const deferred: TicketRef[] = [];
  const notSwept: TicketRef[] = [];
  const needsPin: NeedsPinEntry[] = [];
  const labelDrift: Finding[] = [];
  const pinned: {
    issue: GhIssue;
    class: PriorityClass;
    rank: number;
    started: boolean;
    pin: string;
    phase: number | typeof CURRENT_PHASE;
    blocked: boolean;
  }[] = [];

  for (const issue of issues) {
    const labels = labelNames(issue);

    // `owner-hold` beats everything — including `auto-audit`, `type: bug` and
    // the block label. The two are different statements: a hold is the owner
    // taking a ticket off the table, a block is a documented condition anyone
    // may find fulfilled. Only the hold excludes.
    if (labels.includes(hold)) {
      held.push({ issue: issue.number, title: issue.title });
      continue;
    }

    // The third state: `status: deferred` is the owner saying "planned, but not
    // now". Like the hold it excludes outright (a deferred ticket may still carry
    // `spec-sync`, `auto-audit` or `type: bug`), but it is neither an emergency
    // brake nor an orphan — so it is not held and not `notSwept` either.
    if (labels.includes(deferredLabel)) {
      deferred.push({ issue: issue.number, title: issue.title });
      continue;
    }

    // Label-drift guard: an open bot ticket without the audit label is itself a
    // finding — the sweep would never see it again.
    if (issue.author?.login === BOT_LOGIN && !labels.includes(audit)) {
      labelDrift.push({
        kind: "label-drift",
        issue: issue.number,
        detail: `open ${BOT_LOGIN} ticket without "${audit}" label — relabel so the sweep finds it`,
      });
    }

    const isAudit = labels.includes(audit);
    const isBug = labels.includes(bug);
    if (!isAudit && !isBug && !labels.includes(build)) {
      notSwept.push({ issue: issue.number, title: issue.title });
      continue;
    }

    const pin = readPhasePin(issue);
    if (pin === undefined) {
      needsPin.push({
        issue: issue.number,
        title: issue.title,
        reason: "no `Phase:` comment — pin it, the toolkit does not guess",
        labels,
      });
      continue;
    }

    const phase = resolvePin(pin);
    if (phase === undefined) {
      needsPin.push({
        issue: issue.number,
        title: issue.title,
        reason: `unreadable phase pin "${pin}" — expected a number or \`aktuell\``,
        labels,
      });
      continue;
    }

    const priorityClass = readClass(labels, priority);
    if (priorityClass.found.length > 1) {
      labelDrift.push({
        kind: "label-drift",
        issue: issue.number,
        detail: `several class labels (${priorityClass.found.map((name) => `"${name}"`).join(", ")}) — sorted by the highest, keep one`,
      });
    }

    pinned.push({
      issue,
      class: priorityClass.class,
      rank: isAudit ? 0 : isBug ? 1 : 2,
      started: labels.includes(startedLabel),
      pin,
      phase,
      blocked: labels.includes(blockedLabel),
    });
  }

  // `aktuell` means "counts to the current phase" (§Worker-Loop step 1). The
  // toolkit has no other source for which phase that is, so it is the lowest
  // phase pinned in the open set — the one the loop is working on.
  const numeric = pinned
    .map((entry) => entry.phase)
    .filter((phase): phase is number => typeof phase === "number");
  const currentPhase = numeric.length === 0 ? 0 : Math.min(...numeric);

  const queue = pinned
    .map((entry) => ({
      issue: entry.issue.number,
      title: entry.issue.title,
      class: entry.class,
      rank: entry.rank,
      started: entry.started,
      phase: typeof entry.phase === "number" ? entry.phase : currentPhase,
      pin: entry.pin,
      // The mark is an attribute, never a sort key and never a filter: the
      // comparator below does not see it, and the queue is exactly as long with
      // it as without.
      ...(entry.blocked
        ? { blocked: true as const, blockedComment: readBlockedCondition(entry.issue) }
        : {}),
    }))
    // Tier 2 sits ABOVE the phase, not below it: a started ticket already passed
    // the phase gate when it was begun, so finishing it cannot violate the phase
    // order. Half-integrated increments on `main` are a state, not a backlog.
    // Tiers 3 and 4 then order within each of the two groups, unchanged.
    // The class (sort level ½) sits above all four tiers; without class labels
    // every entry is P2 and the order is exactly the four-tier order.
    .sort(
      (a, b) =>
        CLASS_ORDER[a.class] - CLASS_ORDER[b.class] ||
        a.rank - b.rank ||
        Number(b.started) - Number(a.started) ||
        a.phase - b.phase ||
        a.issue - b.issue,
    )
    .map((entry, index) => ({ ...entry, position: index + 1 }));

  const unclassified = queue
    .filter((entry) => entry.class === "unclassified")
    .map((entry) => ({ issue: entry.issue, title: entry.title }));

  return { queue, needsPin, held, deferred, notSwept, unclassified, labelDrift };
}

/** One `gh` call: every open issue with the fields the sweep needs. */
export async function fetchIssues(gh: GhRunner): Promise<GhIssue[]> {
  const raw = await gh([
    "issue",
    "list",
    "--state",
    "open",
    "--limit",
    String(ISSUE_LIMIT),
    "--json",
    "number,title,labels,author,comments,updatedAt",
  ]);
  return parseJson<GhIssue[]>(raw, "gh issue list");
}

interface GhRun {
  status?: string;
  conclusion?: string;
  createdAt?: string;
}

/**
 * The two nightly cases of §Worker-Loop step 0 that the ticket sweep cannot see.
 * Both are **reported**; neither creates a ticket — that judgement is the
 * driver's (spec §2).
 */
export async function nightlyFindings(
  deps: QueueDeps,
  config: Config,
  sweep: Sweep,
): Promise<{ findings: Finding[]; notes: string[] }> {
  const workflow = config.nightlyWorkflow;
  if (workflow === undefined) {
    return { findings: [], notes: ["nightly not checked: no `nightlyWorkflow` in the config"] };
  }

  let runs: GhRun[];
  try {
    const raw = await deps.gh([
      "run",
      "list",
      "--workflow",
      workflow,
      "--limit",
      "1",
      "--json",
      "status,conclusion,createdAt",
    ]);
    runs = parseJson<GhRun[]>(raw, "gh run list");
  } catch (error) {
    return {
      findings: [
        {
          kind: "nightly-unknown",
          detail: `nightly status unreadable: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      notes: [],
    };
  }

  const findings: Finding[] = [];
  const notes: string[] = [];
  const lastCommit = await deps.lastMainCommit();
  const last = runs[0];

  if (last === undefined) {
    if (lastCommit !== undefined) {
      findings.push({
        kind: "nightly-stale",
        detail: `workflow "${workflow}" has never run, but \`main\` carries commits (newest ${lastCommit})`,
      });
    }
    return { findings, notes };
  }

  // (a) red, but no open audit ticket — the report job itself can fail.
  const isRed = last.conclusion !== undefined && RED_CONCLUSIONS.has(last.conclusion);
  const hasAuditTicket =
    sweep.queue.some((entry) => entry.rank === 0) ||
    sweep.needsPin.some((entry) => entry.labels.includes(config.labels.audit));
  if (isRed && !hasAuditTicket) {
    findings.push({
      kind: "nightly-red-without-ticket",
      detail: `last "${workflow}" run concluded "${last.conclusion}" but no open "${config.labels.audit}" ticket exists`,
    });
  }

  // (b) not run for > 25 h although `main` moved — guard/scheduler/Actions problem.
  const runAt = last.createdAt === undefined ? Number.NaN : Date.parse(last.createdAt);
  if (Number.isFinite(runAt)) {
    const ageHours = (deps.now().getTime() - runAt) / 3_600_000;
    const commitAt = lastCommit === undefined ? Number.NaN : Date.parse(lastCommit);
    const commitsAreNewer = Number.isFinite(commitAt) && commitAt > runAt;
    if (ageHours > NIGHTLY_STALE_HOURS && commitsAreNewer) {
      findings.push({
        kind: "nightly-stale",
        detail: `last "${workflow}" run is ${Math.floor(ageHours)} h old while \`main\` has newer commits (${lastCommit})`,
      });
    }
  } else {
    notes.push(`nightly run carries no readable createdAt — staleness not checked`);
  }

  return { findings, notes };
}

/** The four checks of `queue --health` (`SST-DESIGN-017` rev 7). */
export type HealthCheck = "unclassified" | "several-classes" | "p1-share" | "stale-block";

export interface HealthFinding {
  kind: "health";
  check: HealthCheck;
  /** At most `HEALTH_MAX_TICKETS` issue numbers; `more` counts the rest. */
  tickets: number[];
  more: number;
  /** Measured value and the threshold it is judged against. */
  value: number;
  threshold: number;
  detail: string;
}

/** Tickets named per health finding before the rest is only counted. */
export const HEALTH_MAX_TICKETS = 10;

const DAY_MS = 86_400_000;

function healthFinding(
  check: HealthCheck,
  numbers: number[],
  value: number,
  threshold: number,
  measured: string,
): HealthFinding {
  const tickets = numbers.slice(0, HEALTH_MAX_TICKETS);
  const more = numbers.length - tickets.length;
  const list = tickets.map((n) => `#${n}`).join(", ") + (more > 0 ? ` +${more} more` : "");
  return { kind: "health", check, tickets, more, value, threshold, detail: `${measured}: ${list}` };
}

/**
 * The newest activity a blocked ticket shows: its newest dated comment. Without
 * any dated comment the issue's own `updatedAt` stands in — a block label set
 * without a comment still moved `updatedAt`, so it is the closest available
 * date for "when was this last looked at"; `createdAt` of the issue would date
 * the ticket, not the block. `undefined` when neither is readable.
 */
function newestActivity(issue: GhIssue): number | undefined {
  const dates = (issue.comments ?? [])
    .map((comment) =>
      comment.createdAt === undefined ? Number.NaN : Date.parse(comment.createdAt),
    )
    .filter((at) => Number.isFinite(at));
  if (dates.length > 0) return Math.max(...dates);
  const updated = issue.updatedAt === undefined ? Number.NaN : Date.parse(issue.updatedAt);
  return Number.isFinite(updated) ? updated : undefined;
}

/**
 * A same-repo ticket reference: `#` plus number, not preceded by a word
 * character or `/` — so `org/repo#12` (another repo) and `abc#12` do not count.
 */
const SAME_REPO_REF = /(?<![\w/])#(\d+)\b/g;

/**
 * The newest comment of an issue: the latest by `createdAt`, or — when no
 * comment is dated — the last one in the order `gh` returns.
 */
function newestComment(issue: GhIssue): { body: string } | undefined {
  const comments = issue.comments ?? [];
  let newest: { body: string; at: number } | undefined;
  for (const comment of comments) {
    const at = comment.createdAt === undefined ? Number.NaN : Date.parse(comment.createdAt);
    if (Number.isFinite(at) && (newest === undefined || at >= newest.at)) {
      newest = { body: comment.body, at };
    }
  }
  return newest ?? comments.at(-1);
}

/**
 * Whether a blocked ticket waits on a still-open ticket (`SST-DESIGN-017`
 * rev 8): its newest comment names `#<n>` of this repo and `<n>` is open.
 *
 * Open/closed is read from the sweep's own issue list, which holds every OPEN
 * issue (`gh issue list --state open`) — no extra `gh` call per reference. A
 * number in that set is open; a number not in it counts as closed, so the
 * block is judged again. (Above `ISSUE_LIMIT` open issues a still-open ticket
 * beyond the limit would count as closed — the stricter side.) A reference to
 * the ticket itself is ignored.
 */
function waitsOnOpenTicket(issue: GhIssue, open: Set<number>): boolean {
  const body = newestComment(issue)?.body;
  if (body === undefined) return false;
  for (const match of body.matchAll(SAME_REPO_REF)) {
    const number = Number.parseInt(match[1] ?? "", 10);
    if (number !== issue.number && open.has(number)) return true;
  }
  return false;
}

/**
 * Judges a sweep mechanically (`SST-DESIGN-017` rev 7/8). Pure over its input;
 * it never decides how a finding is fixed and writes nothing. The swept queue
 * is the sorted `queue` — the same set the `unclassified` list and the class
 * counts are taken from.
 */
export function healthFindings(
  issues: GhIssue[],
  sweep: Sweep,
  config: Config,
  now: Date,
): { findings: HealthFinding[]; notes: string[] } {
  const { p1MaxShare, p1MinQueue, staleBlockDays } = config.health;
  const byNumber = new Map(issues.map((issue) => [issue.number, issue]));
  const findings: HealthFinding[] = [];
  const notes: string[] = [];
  const queue = sweep.queue;

  // (1) unclassified — any swept ticket without a class label.
  if (sweep.unclassified.length > 0) {
    findings.push(
      healthFinding(
        "unclassified",
        sweep.unclassified.map((ref) => ref.issue),
        sweep.unclassified.length,
        0,
        `${sweep.unclassified.length} ticket(s) without a class label (threshold 0)`,
      ),
    );
  }

  // (2) several-classes — more than one class label on one ticket.
  const several = queue
    .filter((entry) => {
      const issue = byNumber.get(entry.issue);
      return (
        issue !== undefined && readClass(labelNames(issue), config.labels.priority).found.length > 1
      );
    })
    .map((entry) => entry.issue);
  if (several.length > 0) {
    findings.push(
      healthFinding(
        "several-classes",
        several,
        several.length,
        0,
        `${several.length} ticket(s) with more than one class label (threshold 0)`,
      ),
    );
  }

  // (3) p1-share — only judged from `p1MinQueue` tickets on; strictly above the share.
  const p1 = queue.filter((entry) => entry.class === "must").map((entry) => entry.issue);
  if (queue.length >= p1MinQueue) {
    const share = p1.length / queue.length;
    if (share > p1MaxShare) {
      findings.push(
        healthFinding(
          "p1-share",
          p1,
          share,
          p1MaxShare,
          `P1 share ${Math.round(share * 100)} % (${p1.length} of ${queue.length}) > ${Math.round(p1MaxShare * 100)} %`,
        ),
      );
    }
  }

  // (4) stale-block — blocked, and the newest activity older than `staleBlockDays`.
  // A block waiting on a still-open ticket is a documented dependency, not stale (rev 8).
  const open = new Set(byNumber.keys());
  const stale: { issue: number; days: number }[] = [];
  const undated: number[] = [];
  for (const entry of queue) {
    if (entry.blocked !== true) continue;
    const issue = byNumber.get(entry.issue);
    if (issue !== undefined && waitsOnOpenTicket(issue, open)) continue;
    const at = issue === undefined ? undefined : newestActivity(issue);
    if (at === undefined) {
      undated.push(entry.issue);
      continue;
    }
    const days = (now.getTime() - at) / DAY_MS;
    if (days > staleBlockDays) stale.push({ issue: entry.issue, days });
  }
  if (stale.length > 0) {
    const oldest = Math.max(...stale.map((s) => s.days));
    findings.push(
      healthFinding(
        "stale-block",
        stale.map((s) => s.issue),
        Math.floor(oldest),
        staleBlockDays,
        `${stale.length} blocked ticket(s) without activity for more than ${staleBlockDays} days (oldest ${Math.floor(oldest)} days)`,
      ),
    );
  }
  if (undated.length > 0) {
    notes.push(
      `stale-block not measurable for ${undated.map((n) => `#${n}`).join(", ")} — no dated comment and no updatedAt`,
    );
  }

  return { findings, notes };
}

export interface QueueResult {
  ok: boolean;
  exit?: ExitCode;
  notes: string[];
  data: Record<string, unknown>;
}

/**
 * The whole command, over injected dependencies.
 *
 * `--check` deliberately stops after the issue list: one `gh` call, two numbers.
 * `open` counts everything the loop must act on — the sorted queue **plus** the
 * tickets waiting for a pin — so a driver polling `--check` can never see `0`
 * while work is waiting. `next` is the head of the sorted queue, or `null` when
 * nothing is placeable.
 */
export async function runQueue(
  deps: QueueDeps,
  config: Config,
  options: QueueOptions,
  norms: Norms = loadNorms().norms,
): Promise<QueueResult> {
  const issues = await fetchIssues(deps.gh);
  const sweep = sweepIssues(issues, config, norms);

  if (options.check) {
    return {
      ok: true,
      notes: [],
      data: {
        open: sweep.queue.length + sweep.needsPin.length,
        next: sweep.queue[0]?.issue ?? null,
      },
    };
  }

  // `--health` judges the same sweep like a gate and stops there: no nightly
  // call, nothing written (`SST-DESIGN-017` rev 7).
  if (options.health === true) {
    const health = healthFindings(issues, sweep, config, deps.now());
    const healthy = health.findings.length === 0;
    return {
      ok: healthy,
      exit: healthy ? EXIT.OK : EXIT.FAILED,
      notes: [
        ...health.notes,
        healthy
          ? `queue healthy: ${sweep.queue.length} swept ticket(s), no finding`
          : `${health.findings.length} health finding(s) — reported, nothing changed`,
      ],
      data: { swept: sweep.queue.length, findings: health.findings },
    };
  }

  const nightly = await nightlyFindings(deps, config, sweep);
  const findings = [...nightly.findings, ...sweep.labelDrift];
  const notes = [...nightly.notes];

  if (findings.length > 0) {
    notes.push(
      `${findings.length} finding(s) reported, no ticket created — that judgement is the driver's`,
    );
  }
  if (sweep.needsPin.length > 0) {
    notes.push(`${sweep.needsPin.length} ticket(s) need a \`Phase:\` comment before they can sort`);
  }
  if (sweep.held.length > 0) {
    notes.push(`${sweep.held.length} ticket(s) on \`${norms.hold}\` — excluded from the work list`);
  }
  if (sweep.deferred.length > 0) {
    notes.push(
      `${sweep.deferred.length} ticket(s) on \`${norms.deferred}\` — owner-deferred, excluded from the work list`,
    );
  }

  // Pass-through, not judgement: the count says how much of the queue carries a
  // condition, and the first buildable entry says where a reader can start
  // without having to check one. Whether a condition still holds is decided at
  // pick-up, never here (`SST-DESIGN-017` rev 4).
  const blocked = sweep.queue.filter((entry) => entry.blocked === true);
  if (blocked.length > 0) {
    const buildable = sweep.queue.find((entry) => entry.blocked !== true);
    const undocumented = blocked.filter((entry) => entry.blockedComment === null).length;
    notes.push(
      `${blocked.length} blocked ticket(s) carried at their position, not filtered; ` +
        `first buildable: ${buildable === undefined ? "none — every queued ticket is blocked" : `#${buildable.issue}`}` +
        (undocumented === 0
          ? ""
          : ` — ${undocumented} of them without a documented condition comment`),
    );
  }

  if (sweep.queue.length > 0) {
    const count = (cls: PriorityClass) => sweep.queue.filter((entry) => entry.class === cls).length;
    notes.push(
      `classes: ${count("must")} must, ${count("important")} important, ` +
        `${count("polish")} polish, ${count("unclassified")} unclassified (sorted as P2)`,
    );
  }

  return {
    ok: true,
    notes,
    data: {
      queue: sweep.queue,
      needsPin: sweep.needsPin,
      held: sweep.held,
      deferred: sweep.deferred,
      notSwept: sweep.notSwept,
      unclassified: sweep.unclassified,
      findings,
    },
  };
}

function parseJson<T>(raw: string, what: string): T {
  try {
    return JSON.parse(raw) as T;
  } catch (error) {
    throw new ToolkitError(`${what} returned no readable JSON`, EXIT.PRECONDITION, {
      cause: error,
    });
  }
}

/** The real `gh`, over `child_process` — no GitHub SDK dependency (spec §10). */
export function ghRunner(repoRoot: string): GhRunner {
  return async (args) => {
    try {
      const { stdout } = await execFileAsync("gh", args, {
        cwd: repoRoot,
        maxBuffer: 32 * 1024 * 1024,
      });
      return stdout;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new ToolkitError(`gh ${args[0] ?? ""} failed: ${message}`, EXIT.PRECONDITION, {
        field: "gh",
        cause: error,
      });
    }
  };
}

/** Newest commit on `main`, read locally — no network, no `gh`. */
export function lastMainCommitReader(repoRoot: string): () => Promise<string | undefined> {
  return async () => {
    try {
      const iso = await simpleGit(repoRoot).raw(["log", "-1", "--format=%cI", "main"]);
      const trimmed = iso.trim();
      return trimmed === "" ? undefined : trimmed;
    } catch {
      return undefined;
    }
  };
}

export function queueDeps(ctx: CommandContext): QueueDeps {
  return {
    gh: ghRunner(ctx.repoRoot),
    lastMainCommit: lastMainCommitReader(ctx.repoRoot),
    now: () => new Date(),
  };
}

export const queueCommand: Command = {
  name: "queue",
  summary: "Assemble and sort the work queue",
  needsConfig: true,
  async run(ctx) {
    const options = parseQueueOptions(ctx.args);
    const config = ctx.config;
    if (config === undefined) {
      throw new ToolkitError("queue needs a config", EXIT.PRECONDITION, { field: "config" });
    }
    return runQueue(queueDeps(ctx), config, options);
  },
};
