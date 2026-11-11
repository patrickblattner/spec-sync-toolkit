/**
 * `ledger` — writes to the ledger that no other command makes.
 *
 *   spec-sync ledger start <issue> [--dry-run]
 *   spec-sync ledger build <issue> [--agent impl|impl-fast|impl-deep] [--dry-run]
 *   spec-sync ledger close <issue> --reason "<text>" [--dry-run]
 *
 * `start` (0.49.0, register #2030) records that the worker begins building a
 * ticket or a further increment of it: exactly one `work-started` event. It is
 * the start the product quota of `queue` counts; the older signals
 * (`merge-started`, the first PR review) lag one unit behind. It reads nothing
 * and asks nothing — the worker knows which ticket it starts.
 *
 * `build` (train 2026-11-15, Fable C2) is run right before the worker spawns a
 * build agent. It counts the agents already spent on the current increment
 * (after the newest `work-started` of the ticket) and appends one `build-agent`
 * event — unless `MAX_BUILD_AGENTS` are already spent: then it writes nothing
 * and refuses with exit 4, naming the re-cut. A third agent is the last one.
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
import {
  appendEvent,
  buildAgentsOfIncrement,
  interruptedMerge,
  MAX_BUILD_AGENTS,
  readLedger,
  type LedgerEventInput,
} from "../ledger.js";
import { EXIT, ToolkitError } from "../output.js";
import { checkFlags, positionals, valueFlag } from "../pack/args.js";
import { defaultTools, failureLine, type Tools } from "../pack/exec.js";

const VALUE_FLAGS = ["--reason"];
const USAGE = 'usage: spec-sync ledger close <issue> --reason "<text>" [--dry-run]';
const START_USAGE = "usage: spec-sync ledger start <issue> [--dry-run]";
const BUILD_USAGE =
  "usage: spec-sync ledger build <issue> [--agent impl|impl-fast|impl-deep] [--dry-run]";
/** The agent types that build (spec-sync skill, effort table). */
const BUILD_AGENTS = ["impl", "impl-fast", "impl-deep"];

export interface LedgerDeps {
  tools: Tools;
}

export const ledgerCommand: Command = {
  name: "ledger",
  summary:
    "Ledger writes: start (work on a ticket or increment begins), build (a build agent is spawned; refuses past the cap), close (end an orphaned merge-started of a CLOSED issue by hand)",
  needsConfig: false,
  run: (ctx) => runLedger(ctx, { tools: defaultTools(ctx.repoRoot) }),
};

export function runLedger(ctx: CommandContext, deps: LedgerDeps): CommandResult {
  if (positionals(ctx.args, VALUE_FLAGS)[0] === "start") return runStart(ctx);
  if (positionals(ctx.args, ["--agent"])[0] === "build") return runBuild(ctx);
  checkFlags(ctx.args, VALUE_FLAGS);
  const pos = positionals(ctx.args, VALUE_FLAGS);
  if (pos[0] !== "close") {
    throw new ToolkitError("ledger needs a subcommand — start, build or close", EXIT.PRECONDITION, {
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

/**
 * `ledger build <issue>`: one `build-agent` event, or exit 4 once the current
 * increment has spent `MAX_BUILD_AGENTS`.
 */
function runBuild(ctx: CommandContext): CommandResult {
  checkFlags(ctx.args, ["--agent"]);
  const pos = positionals(ctx.args, ["--agent"]);
  if (pos.length !== 2 || !/^\d+$/.test(pos[1] as string) || Number(pos[1]) < 1) {
    throw new ToolkitError(BUILD_USAGE, EXIT.PRECONDITION, { field: "issue" });
  }
  const issue = Number(pos[1]);
  const agent = valueFlag(ctx.args, "--agent");
  if (agent !== undefined && !BUILD_AGENTS.includes(agent)) {
    throw new ToolkitError(
      `--agent must be one of ${BUILD_AGENTS.join(", ")} — ${BUILD_USAGE}`,
      EXIT.PRECONDITION,
      { field: "--agent" },
    );
  }

  const spent = buildAgentsOfIncrement(readLedger(ctx.repoRoot).events, issue);
  const increment =
    spent.since === undefined ? "since its first event" : `since work-started at ${spent.since}`;
  if (spent.count >= MAX_BUILD_AGENTS) {
    throw new ToolkitError(
      `#${issue}: ${spent.count} build agents already spent on this increment (${increment}) — ` +
        `stop and re-cut the ticket into smaller slices, each with its own acceptance criteria, ` +
        `instead of spawning build agent ${spent.count + 1}`,
      EXIT.PRECONDITION,
      { field: "issue" },
    );
  }

  const number = spent.count + 1;
  const event: LedgerEventInput = {
    type: "build-agent",
    issue,
    n: number,
    ...(agent === undefined ? {} : { agent }),
  };
  const notes =
    number === MAX_BUILD_AGENTS
      ? [
          `#${issue}: build agent ${number} of ${MAX_BUILD_AGENTS} — the last one for this increment; ` +
            `if it does not land, re-cut the ticket instead of spawning another`,
        ]
      : [`#${issue}: build agent ${number} of ${MAX_BUILD_AGENTS} for this increment`];

  if (ctx.flags.dryRun) {
    return {
      ok: true,
      notes: [`dry run: would append build-agent ${number} for #${issue} — nothing written`],
      data: { issue, count: number, max: MAX_BUILD_AGENTS, dryRun: true, event },
    };
  }

  const written = appendEvent(ctx.repoRoot, event);
  return {
    ok: true,
    notes,
    data: { issue, count: number, max: MAX_BUILD_AGENTS, dryRun: false, event: written },
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
