/**
 * `handover` — the bridge to the next session (spec §7.9).
 *
 * `spec-sync handover [--note <text>] [--reason <wert>]`
 *
 * Writes `.spec-sync-handover.md` into the repo root. Tiny, because the DoD
 * proves that all state lives outside it; the file is a **snapshot** and is
 * overwritten atomically (temp + rename), so a reader never sees half of one.
 *
 * Everything in it is mechanical — repo, ledger and queue logic. The single
 * non-mechanical part, `--note`, comes in as an argument: the judgement is the
 * model's (spec §2).
 *
 * Empty sets are **named**, never left out: a repo without a ledger or without
 * open tickets is not an error, and a missing line would read as an oversight
 * rather than as "nothing here".
 */

import { existsSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { simpleGit } from "simple-git";
import type { Command, CommandContext, CommandResult } from "../cli.js";
import type { Config } from "../config.js";
import { contextIncrements, derive, latestContextEvent } from "../budget.js";
import { readLedger, type LedgerEvent } from "../ledger.js";
import { loadNorms } from "../norms.js";
import { EXIT, ToolkitError } from "../output.js";
import { checkFlags, valueFlag } from "../pack/args.js";
import { queueDeps, runQueue, type QueueDeps } from "./queue.js";

export const HANDOVER_FILE = ".spec-sync-handover.md";

const PINS_FILE = "spec-pins.json";

/** Tickets of the queue head the file carries (spec §7.9). */
const QUEUE_HEAD = 3;

/** Sentences of `--note` that survive — the driver gets three, not an essay. */
const MAX_NOTE_SENTENCES = 3;

/**
 * The vocabulary of `--reason` (spec §7.9). The toolkit validates it and nothing
 * more — which of them a stop *is* stays the driver's judgement (spec §2).
 */
export const HANDOVER_REASONS = [
  "budget",
  "done",
  "rot-2x",
  "frage-offen",
  "pause",
  "unerwartet",
] as const;

export type HandoverReason = (typeof HANDOVER_REASONS)[number];

export interface HandoverOptions {
  note?: string;
  reason?: HandoverReason;
}

export interface HandoverDeps {
  queue: QueueDeps;
  /** `<short hash> <subject>` of `main`, or undefined when unreadable. */
  mainHead: () => Promise<string | undefined>;
  now: () => Date;
}

export function parseHandoverOptions(args: string[]): HandoverOptions {
  checkFlags(args, ["--note", "--reason"]);
  const reason = valueFlag(args, "--reason");
  // Spec §7.9 asks for exit 1 on an unknown *value*, where `checkFlags` answers
  // an unknown *option* with exit 4. The distinction is the spec's, not ours.
  if (reason !== undefined && !(HANDOVER_REASONS as readonly string[]).includes(reason)) {
    throw new ToolkitError(
      `unknown --reason ${reason} — the vocabulary is ${HANDOVER_REASONS.join(", ")}`,
      EXIT.FAILED,
      { field: "--reason" },
    );
  }
  return { note: valueFlag(args, "--note"), reason: reason as HandoverReason | undefined };
}

/**
 * The first three sentences of the note. Splitting on sentence enders rather
 * than truncating characters keeps the driver's last thought intact instead of
 * cutting it mid-word.
 */
export function trimNote(note: string): string {
  const sentences = note.match(/[^.!?]+[.!?]*/gu) ?? [];
  if (sentences.length <= MAX_NOTE_SENTENCES) return note.trim();
  return sentences.slice(0, MAX_NOTE_SENTENCES).join("").trim();
}

/** Every `merge-started` that never reported its completion, by ticket. */
export function openMerges(events: LedgerEvent[]): { issue: number; at: string }[] {
  const started = new Map<number, string>();
  for (const event of events) {
    if (typeof event.issue !== "number") continue;
    if (event.type === "merge-started") started.set(event.issue, event.at);
    else if (event.type === "merge-completed") started.delete(event.issue);
  }
  return [...started.entries()]
    .map(([issue, at]) => ({ issue, at }))
    .sort((a, b) => a.issue - b.issue);
}

interface PinsState {
  /** `spec-pins.json` carries no timestamp of its own (SST-DESIGN-025) — the file's mtime stands in. */
  pinnedAt: string;
  units: number;
}

function readPins(repoRoot: string): PinsState | undefined {
  try {
    const path = join(repoRoot, PINS_FILE);
    const pins = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    if (typeof pins !== "object" || pins === null || Array.isArray(pins)) return undefined;
    return { pinnedAt: statSync(path).mtime.toISOString(), units: Object.keys(pins).length };
  } catch {
    return undefined;
  }
}

/**
 * Renders the document. Pure over its inputs, so every field of §7.9 — and every
 * named empty set — is testable without a repo, a `gh` or a clock.
 */
export function renderHandover(input: {
  repoRoot: string;
  now: Date;
  mainHead?: string;
  pins?: PinsState;
  context?: {
    value: number;
    at: string;
    p90PerTicket: number | null;
    forecastTickets: number | null;
  };
  queueHead: { issue: number; title: string }[];
  needsPin: number;
  findings: number;
  queueError?: string;
  openMerges: { issue: number; at: string }[];
  note?: string;
  reason?: HandoverReason;
}): string {
  const lines: string[] = [
    // First line on purpose (spec §7.9): the observer harness reads the stop
    // reason without parsing Markdown. Absent without `--reason` — a handover
    // without one is no restart boundary for the harness.
    ...(input.reason === undefined ? [] : [`reason: ${input.reason}`, ""]),
    "# spec-sync handover",
    "",
    `- Repo: ${input.repoRoot}`,
    `- Zeit: ${input.now.toISOString()}`,
    `- \`main\`-HEAD: ${input.mainHead ?? "nicht lesbar"}`,
    "",
    "## spec-pins.json",
    "",
  ];

  if (input.pins === undefined) {
    lines.push(`Kein lesbares ${PINS_FILE} — Drift ist gegen nichts prüfbar.`);
  } else {
    lines.push(`- zuletzt gepinnt: ${input.pins.pinnedAt}`);
    lines.push(`- Einträge: ${input.pins.units}`);
  }

  lines.push("", "## Kontext", "");
  if (input.context === undefined) {
    lines.push("keine Messung — kein `context`-Ereignis im Ledger.");
  } else {
    lines.push(`- Stand: ${input.context.value} Tokens (gemessen ${input.context.at})`);
    lines.push(
      `- Zuwachs je Ticket (p90): ${input.context.p90PerTicket ?? "nicht berechenbar (unter 5 Messpunkten)"}`,
    );
    lines.push(
      `- Reichweite: ${input.context.forecastTickets === null ? "nicht berechenbar" : `${input.context.forecastTickets} Ticket(s)`}`,
    );
  }

  lines.push("", "## Queue", "");
  if (input.queueError !== undefined) {
    lines.push(`nicht lesbar: ${input.queueError}`);
  } else if (input.queueHead.length === 0) {
    lines.push("keine offenen Tickets in der sortierten Queue.");
  } else {
    for (const entry of input.queueHead) lines.push(`1. #${entry.issue} — ${entry.title}`);
  }
  if (input.queueError === undefined) {
    lines.push("", `- needsPin: ${input.needsPin}`, `- findings: ${input.findings}`);
  }

  lines.push("", "## Offene Vorgänge", "");
  if (input.openMerges.length === 0) {
    lines.push("keine — kein `merge-started` ohne `merge-completed`.");
  } else {
    for (const open of input.openMerges) {
      lines.push(`- #${open.issue}: \`merge-started\` ${open.at} ohne \`merge-completed\``);
    }
  }

  lines.push("", "## Notiz des Treibers", "");
  lines.push(input.note === undefined || input.note.trim() === "" ? "keine" : trimNote(input.note));
  lines.push("");

  return lines.join("\n");
}

/**
 * Writes the file atomically: a temp file next to the target, then `rename`.
 * Same directory on purpose — `rename` is only atomic within a filesystem, and
 * a temp directory can be on another one.
 */
export function writeAtomic(path: string, content: string): void {
  const temp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temp, content, "utf8");
    renameSync(temp, path);
  } catch (error) {
    if (existsSync(temp)) {
      try {
        unlinkSync(temp);
      } catch {
        // The rename failed; a leftover temp file is the smaller problem and
        // must not replace the real error.
      }
    }
    throw error;
  }
}

export async function runHandover(
  ctx: CommandContext,
  config: Config,
  deps: HandoverDeps,
  options: HandoverOptions,
): Promise<CommandResult> {
  const events = readLedger(ctx.repoRoot).events;
  const latest = latestContextEvent(events);

  let queueHead: { issue: number; title: string }[] = [];
  let needsPin = 0;
  let findings = 0;
  let queueError: string | undefined;
  try {
    const result = await runQueue(deps.queue, config, { check: false }, loadNorms().norms);
    const data = result.data as {
      queue: { issue: number; title: string }[];
      needsPin: unknown[];
      findings: unknown[];
    };
    queueHead = data.queue.slice(0, QUEUE_HEAD).map(({ issue, title }) => ({ issue, title }));
    needsPin = data.needsPin.length;
    findings = data.findings.length;
  } catch (error) {
    queueError = error instanceof Error ? error.message : String(error);
  }

  const context =
    latest === undefined
      ? undefined
      : {
          value: typeof latest.context === "number" ? latest.context : 0,
          at: latest.at,
          ...derive(
            typeof latest.context === "number" ? latest.context : 0,
            config.contextBudget,
            contextIncrements(events),
          ),
        };

  const document = renderHandover({
    repoRoot: ctx.repoRoot,
    now: deps.now(),
    mainHead: await deps.mainHead(),
    pins: readPins(ctx.repoRoot),
    context,
    queueHead,
    needsPin,
    findings,
    queueError,
    openMerges: openMerges(events),
    note: options.note,
    reason: options.reason,
  });

  const path = join(ctx.repoRoot, HANDOVER_FILE);
  writeAtomic(path, document);

  const notes: string[] = [];
  if (events.length === 0) notes.push("no ledger — the file names the empty sets");
  if (queueError !== undefined) notes.push(`queue not readable: ${queueError}`);

  return { ok: true, notes, data: { file: path } };
}

/** `<short hash> <subject>` of `main`, read locally — no network, no `gh`. */
export function mainHeadReader(repoRoot: string): () => Promise<string | undefined> {
  return async () => {
    try {
      const line = await simpleGit(repoRoot).raw(["log", "-1", "--format=%h %s", "main"]);
      const trimmed = line.trim();
      return trimmed === "" ? undefined : trimmed;
    } catch {
      return undefined;
    }
  };
}

export const handoverCommand: Command = {
  name: "handover",
  summary: "Write the session snapshot the next session reads first",
  needsConfig: true,
  async run(ctx) {
    const options = parseHandoverOptions(ctx.args);
    const config = ctx.config;
    if (config === undefined) {
      throw new ToolkitError("handover needs a config", EXIT.PRECONDITION, { field: "config" });
    }
    return runHandover(
      ctx,
      config,
      { queue: queueDeps(ctx), mainHead: mainHeadReader(ctx.repoRoot), now: () => new Date() },
      options,
    );
  },
};
