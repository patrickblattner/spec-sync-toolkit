/**
 * `budget` — measure the driver session's context level (spec §7.8).
 *
 * `spec-sync budget [--session <id|path>] [--label <text>]`
 *
 * The command delivers **numbers, never a verdict** (spec §2): whether to keep
 * working or wrap up is the driver's call under the DoD ("a run ends … or on a
 * tight context"). The soft threshold is `forecastTickets < 1`; applying it
 * stays with the driver, which is why a tight budget is exit **0** — tight is a
 * finding, not a failure.
 */

import { homedir } from "node:os";
import type { Command, CommandContext, CommandResult } from "../cli.js";
import { derive, contextIncrements, readContext, resolveTranscript } from "../budget.js";
import { appendEvent, readLedger } from "../ledger.js";
import { EXIT, ToolkitError } from "../output.js";
import { checkFlags, valueFlag } from "../pack/args.js";

export interface BudgetOptions {
  session?: string;
  label?: string;
}

export interface BudgetDeps {
  /** Home directory holding `.claude/projects` — a seam for tests. */
  home: string;
  now: () => number;
}

export function parseBudgetOptions(args: string[]): BudgetOptions {
  checkFlags(args, ["--session", "--label"]);
  return { session: valueFlag(args, "--session"), label: valueFlag(args, "--label") };
}

export function runBudget(
  ctx: CommandContext,
  deps: BudgetDeps,
  options: BudgetOptions,
): CommandResult {
  const contextBudget = ctx.config?.contextBudget;
  if (contextBudget === undefined) {
    throw new ToolkitError("budget needs a config", EXIT.PRECONDITION, { field: "config" });
  }

  const resolved = resolveTranscript(ctx.repoRoot, deps.home, options.session, deps.now());
  const { context } = readContext(resolved.file);

  // Appended before the derived numbers are read back, so the measurement this
  // run reports is part of the history the next run computes from.
  appendEvent(ctx.repoRoot, {
    type: "context",
    context,
    ...(options.label === undefined ? {} : { label: options.label }),
  });

  const increments = contextIncrements(readLedger(ctx.repoRoot).events);
  const { p90PerTicket, forecastTickets } = derive(context, contextBudget, increments);

  const notes: string[] = [];
  if (resolved.note !== undefined) notes.push(resolved.note);
  if (p90PerTicket === null) {
    notes.push(
      `${increments.length} measured increment(s) — reach needs 5, so p90 and forecast stay null`,
    );
  }

  return {
    // Exit 0 even on a tight budget — the reach is reported, never acted on.
    ok: true,
    notes,
    data: {
      context,
      contextBudget,
      remaining: contextBudget - context,
      p90PerTicket,
      forecastTickets,
      sessionFile: resolved.file,
    },
  };
}

export const budgetCommand: Command = {
  name: "budget",
  summary: "Measure the driver session's context level from its transcript",
  needsConfig: true,
  run: (ctx) =>
    runBudget(ctx, { home: homedir(), now: () => Date.now() }, parseBudgetOptions(ctx.args)),
};
