/**
 * `ledger` — writes to the ledger that no other command makes.
 *
 *   spec-sync ledger start <issue> [--dry-run]
 *   spec-sync ledger close <issue> --reason "<text>" [--dry-run]
 *
 * `start` (0.49.0, register #2030) records that the worker begins building a
 * ticket or a further increment of it: exactly one `work-started` event. It is
 * the start the product quota of `queue` counts; the older signals
 * (`merge-started`, the first PR review) lag one unit behind. It reads nothing
 * and asks nothing — the worker knows which ticket it starts.
 *
 * `close` ends an orphaned `merge-started` by hand. Old ledgers carry starts
 * whose squash commit subject predates the current `commitMessage()` format, so
 * the resume path of `merge` cannot recognise the landed commit and would
 * squash again. When the ticket is CLOSED on GitHub, the operator closes the
 * start instead: exactly one `merge-completed` with `closedByHand: true` and
 * the reason, appended — the ledger stays append-only (`DECISION
 * (ledger-append-only)`), and every reader of the start/complete pair (`doctor`,
 * `handover`, `merge`) sees the ticket as done.
 *
 * `ok: false` on purpose: nothing was verified, and `budget` must not read the
 * hand close as a merge that frames a context measurement.
 *
 * Refuses with exit 4 unless the start is open, the issue is CLOSED and the
 * reason is non-empty. `--dry-run` writes nothing and returns the event.
 */

import type { Command, CommandContext, CommandResult } from "../cli.js";
import { appendEvent, interruptedMerge, readLedger, type LedgerEventInput } from "../ledger.js";
import { EXIT, ToolkitError } from "../output.js";
import { checkFlags, positionals, valueFlag } from "../pack/args.js";
import { defaultTools, failureLine, type Tools } from "../pack/exec.js";

const VALUE_FLAGS = ["--reason"];
const USAGE = 'usage: spec-sync ledger close <issue> --reason "<text>" [--dry-run]';
const START_USAGE = "usage: spec-sync ledger start <issue> [--dry-run]";

export interface LedgerDeps {
  tools: Tools;
}

export const ledgerCommand: Command = {
  name: "ledger",
  summary:
    "Ledger writes: start (work on a ticket or increment begins), close (end an orphaned merge-started of a CLOSED issue by hand)",
  needsConfig: false,
  run: (ctx) => runLedger(ctx, { tools: defaultTools(ctx.repoRoot) }),
};

export function runLedger(ctx: CommandContext, deps: LedgerDeps): CommandResult {
  if (positionals(ctx.args, VALUE_FLAGS)[0] === "start") return runStart(ctx);
  checkFlags(ctx.args, VALUE_FLAGS);
  const pos = positionals(ctx.args, VALUE_FLAGS);
  if (pos[0] !== "close") {
    throw new ToolkitError("ledger needs a subcommand — start or close", EXIT.PRECONDITION, {
      field: "subcommand",
    });
  }
  if (pos.length !== 2 || !/^\d+$/.test(pos[1] as string) || Number(pos[1]) < 1) {
    throw new ToolkitError(USAGE, EXIT.PRECONDITION, { field: "issue" });
  }
  const issue = Number(pos[1]);
  const reason = valueFlag(ctx.args, "--reason")?.trim() ?? "";
  if (reason === "") {
    throw new ToolkitError(`--reason must not be empty — ${USAGE}`, EXIT.PRECONDITION, {
      field: "--reason",
    });
  }

  const started = interruptedMerge(readLedger(ctx.repoRoot).events, issue);
  if (started === undefined) {
    throw new ToolkitError(
      `#${issue}: no merge-started without a later merge-completed in the ledger — nothing to close`,
      EXIT.PRECONDITION,
      { field: "issue" },
    );
  }

  const view = deps.tools.run("gh", ["issue", "view", String(issue), "--json", "state"]);
  if (!view.ok) {
    throw new ToolkitError(
      `gh issue view ${issue} failed: ${failureLine(view)}`,
      EXIT.PRECONDITION,
      { field: "issue" },
    );
  }
  const state = issueState(view.stdout);
  if (state !== "CLOSED") {
    throw new ToolkitError(
      `#${issue} is ${state ?? "of unknown state"} on GitHub — only a CLOSED issue is closed by hand`,
      EXIT.PRECONDITION,
      { field: "issue" },
    );
  }

  const event: LedgerEventInput = {
    type: "merge-completed",
    issue,
    ok: false,
    closedByHand: true,
    reason,
  };
  const startedAt = started.at;

  if (ctx.flags.dryRun) {
    return {
      ok: true,
      notes: [
        `dry run: would append merge-completed for #${issue} (closed by hand) — nothing written`,
      ],
      data: { issue, startedAt, dryRun: true, event },
    };
  }

  const written = appendEvent(ctx.repoRoot, event);
  return {
    ok: true,
    notes: [`#${issue}: merge-started at ${startedAt} closed by hand — ${reason}`],
    data: { issue, startedAt, dryRun: false, event: written },
  };
}

/** `ledger start <issue>`: one `work-started` event, nothing else. */
function runStart(ctx: CommandContext): CommandResult {
  checkFlags(ctx.args, []);
  const pos = positionals(ctx.args, []);
  if (pos.length !== 2 || !/^\d+$/.test(pos[1] as string) || Number(pos[1]) < 1) {
    throw new ToolkitError(START_USAGE, EXIT.PRECONDITION, { field: "issue" });
  }
  const issue = Number(pos[1]);
  const event: LedgerEventInput = { type: "work-started", issue };

  if (ctx.flags.dryRun) {
    return {
      ok: true,
      notes: [`dry run: would append work-started for #${issue} — nothing written`],
      data: { issue, dryRun: true, event },
    };
  }

  const written = appendEvent(ctx.repoRoot, event);
  return {
    ok: true,
    notes: [`#${issue}: work-started recorded`],
    data: { issue, dryRun: false, event: written },
  };
}

function issueState(stdout: string): string | undefined {
  try {
    const state = (JSON.parse(stdout) as { state?: unknown }).state;
    return typeof state === "string" ? state : undefined;
  } catch {
    return undefined;
  }
}
