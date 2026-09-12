/**
 * `queue` — assemble and sort the work queue (spec §7.2).
 *
 * The command **decides nothing** (spec §2). It sweeps the open tickets, drops
 * what `owner-hold` protects, sorts what carries a legible phase pin by the four
 * tiers of `foundation.dev.process` §Worker-Loop, and *reports* everything else:
 *
 *   - a ticket without a legible phase pin is **not guessed** — it lands in
 *     `needsPin` with the reason it could not be placed;
 *   - the two nightly cases ("red without ticket", "not run for > 25 h despite
 *     new commits") are reported as `findings`, **not** turned into tickets;
 *   - tickets outside the sweep are listed so the mandatory closing line of the
 *     Zielabgleich can name them;
 *   - a **blocked** ticket is marked at its sort position, never filtered out —
 *     a stale label must not silently hide work, and the position itself is the
 *     anchor a path-clearer inherits its rank at (`PROC-DEV-039`, level 0).
 *
 * `--check` answers in one line — open count and next number — from a **single**
 * `gh` call, so an empty tick costs one roundtrip.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { simpleGit } from "simple-git";
import { EXIT, ToolkitError } from "../output.js";
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

/** The shape of `gh issue list --json number,title,labels,author,comments`. */
export interface GhIssue {
  number: number;
  title: string;
  labels?: { name: string }[];
  author?: { login: string } | null;
  comments?: { body: string }[];
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

export interface QueueEntry {
  issue: number;
  title: string;
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
  /** Open tickets outside the sweep — the mandatory closing line names these. */
  notSwept: TicketRef[];
  labelDrift: Finding[];
}

export interface QueueOptions {
  check: boolean;
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
  for (const token of args) {
    if (token === "--check") check = true;
    else
      throw new ToolkitError(`unknown option for queue: ${token}`, EXIT.PRECONDITION, {
        field: token,
      });
  }
  return { check };
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
 * Sweeps the open issues into the five lists of §7.2. Pure over its input, so
 * the sorting rules are testable without touching a repo.
 */
export function sweepIssues(issues: GhIssue[], config: Config, norms: Norms): Sweep {
  const { audit, bug, build, started: startedLabel, blocked: blockedLabel } = config.labels;
  const hold = norms.hold;

  const held: TicketRef[] = [];
  const notSwept: TicketRef[] = [];
  const needsPin: NeedsPinEntry[] = [];
  const labelDrift: Finding[] = [];
  const pinned: {
    issue: GhIssue;
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

    pinned.push({
      issue,
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
    .sort(
      (a, b) =>
        a.rank - b.rank ||
        Number(b.started) - Number(a.started) ||
        a.phase - b.phase ||
        a.issue - b.issue,
    )
    .map((entry, index) => ({ ...entry, position: index + 1 }));

  return { queue, needsPin, held, notSwept, labelDrift };
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
    "number,title,labels,author,comments",
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

export interface QueueResult {
  ok: boolean;
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

  return {
    ok: true,
    notes,
    data: {
      queue: sweep.queue,
      needsPin: sweep.needsPin,
      held: sweep.held,
      notSwept: sweep.notSwept,
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
