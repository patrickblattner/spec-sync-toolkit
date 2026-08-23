/**
 * `gate` — run the phases of a profile, cheapest first (spec §7.1).
 *
 *   spec-sync gate --profile local|merge|nightly [--changed]
 *                 [--issue <nr>] [--run <id>]
 *
 * Three promises hold this command together:
 *
 *   1. Phases run in CONFIG ORDER and stop at the first red. No walking on to
 *      more expensive phases once the answer is known.
 *   2. Full output never reaches stdout (spec §3). It lands in
 *      `.spec-sync/logs/<ISO>/<phase>.log`; the response carries the path and,
 *      on failure, `firstError` — at most three lines.
 *   3. A red is either broken (exit 1) or unprovable (exit 2), and which one it
 *      is follows from a LOGGED measurement of the box, never from a guess
 *      (`foundation.testing.guideline` §Lastabhängige Messungen).
 *
 * The response stays inside the line budget of spec §3 by carrying nothing
 * beyond what §7.1 asks for: `phases[]`, `firstError` when red, `logDir`.
 *
 * With `--issue` the run is recorded in the ledger as a `gate` event (spec §8).
 * That event is not bookkeeping on the side: `merge` checks it as its
 * `gate-evidence-green` precondition (§7.4), and two of the four numbers §8
 * demands per ticket — gate runs and retries — are counted from it. Without
 * `--issue` nothing is written, because a gate run without a ticket belongs to
 * no ticket and must not be counted against one.
 */

import { join } from "node:path";
import { EXIT, ToolkitError, progress } from "../output.js";
import { appendEvent, ledgerPath, readLedger, LEDGER_FILE } from "../ledger.js";
import { createLogDir, firstError, protectedLogDirs, writePhaseLog } from "../logs.js";
import { phasesOfProfile, type GatePhase } from "../config.js";
import { acquireGateLock } from "../gate/lock.js";
import { changedFiles, phaseRuns, DIFF_BASE } from "../gate/changed.js";
import { MachineProbe, renderMeasurement } from "../gate/machine.js";
import { phaseExit, reportedFailure, runPhase } from "../gate/phases.js";
import { DEFAULT_ENVIRONMENT, type Environment, type WakeLockState } from "../gate/environment.js";
import type { Command, CommandContext, CommandResult } from "../cli.js";

/** Log file carrying the measurement condition; underscored so no phase name collides. */
const MEASUREMENT_LOG = "_measurement";

export interface GateArgs {
  profile: string;
  changed: boolean;
  /** Ticket this run belongs to. Absent means: record nothing. */
  issue?: number;
  /** Groups the event with the rest of a worker-loop run (`report --run <id>`). */
  run?: string;
}

/**
 * Reads `--flag value` and `--flag=value` as the same thing, and refuses a
 * missing value with exit 4 naming the flag — an option swallowing the next
 * flag as its value is how a `--changed` run silently becomes a full one.
 */
function readValue(flag: string, args: readonly string[], index: number): [string, number] {
  const token = args[index] as string;
  const attached = token.startsWith(`${flag}=`);
  const value = attached ? token.slice(flag.length + 1) : args[index + 1];
  if (value === undefined || value === "" || value.startsWith("-")) {
    throw new ToolkitError(`${flag} needs a value`, EXIT.PRECONDITION, { field: flag });
  }
  return [value, attached ? 0 : 1];
}

/**
 * The command's own flags. The dispatcher owns the common ones (`--human`,
 * `--config`, `--repo`) and hands everything else through as `args`, so an
 * option this command does not know is a TYPO — and a typo ends the run with
 * exit 4 naming the field, never with a silently ignored flag.
 *
 * `--profile x` and `--profile=x` are the same thing.
 */
export function parseGateArgs(args: readonly string[]): GateArgs {
  let profile: string | undefined;
  let changed = false;
  let issue: number | undefined;
  let run: string | undefined;

  for (let i = 0; i < args.length; i += 1) {
    const token = args[i] as string;
    if (token === "--profile" || token.startsWith("--profile=")) {
      const [value, consumed] = readValue("--profile", args, i);
      profile = value;
      i += consumed;
    } else if (token === "--issue" || token.startsWith("--issue=")) {
      const [value, consumed] = readValue("--issue", args, i);
      const parsed = Number.parseInt(value.replace(/^#/, ""), 10);
      if (!Number.isInteger(parsed)) {
        throw new ToolkitError(`not an issue number: ${value}`, EXIT.PRECONDITION, {
          field: "--issue",
        });
      }
      issue = parsed;
      i += consumed;
    } else if (token === "--run" || token.startsWith("--run=")) {
      const [value, consumed] = readValue("--run", args, i);
      run = value;
      i += consumed;
    } else if (token === "--changed") {
      changed = true;
    } else {
      throw new ToolkitError(`gate: unexpected argument "${token}"`, EXIT.PRECONDITION, {
        field: token,
      });
    }
  }

  if (profile === undefined) {
    throw new ToolkitError("gate needs --profile <name>", EXIT.PRECONDITION, {
      field: "--profile",
    });
  }
  return { profile, changed, issue, run };
}

/** One entry of the response's `phases[]` (spec §7.1). */
interface PhaseReport {
  name: string;
  skipped: boolean;
  exit?: number;
  durationMs?: number;
}

export async function runGate(
  ctx: CommandContext,
  environment: Environment = DEFAULT_ENVIRONMENT,
): Promise<CommandResult> {
  const { profile, changed, issue, run: runId } = parseGateArgs(ctx.args);
  const config = ctx.config;
  if (config === undefined) {
    throw new ToolkitError("gate needs a config", EXIT.PRECONDITION, { field: "gate" });
  }
  const phases = phasesOfProfile(config, profile);
  const notes: string[] = [];

  // Before the lock, before the log directory, before anything is spawned: on
  // battery the box can sleep with the lid closed mid-suite, and a run that was
  // asleep says nothing about the code. It is exit 2 rather than exit 4 because
  // it is the same statement as any other unprovable run — not green, blocks the
  // merge, and the answer is to repeat it, here after plugging in (register #67).
  if (environment.readPowerSource() === "battery") {
    throw new ToolkitError(
      "gate: not a gate-capable environment — the machine runs on battery, where it can sleep mid-suite; plug in and repeat",
      EXIT.UNPROVABLE,
    );
  }

  // Read before queueing: an unusable `--changed` is a precondition the caller
  // must fix, and finding that out after a ten-minute wait helps nobody.
  const diff = changed ? await changedFiles(ctx.repoRoot) : undefined;

  progress(`gate ${profile} — ${phases.length} phases${changed ? ", --changed" : ""}`);
  const lock = await acquireGateLock(ctx.repoRoot);
  if (lock.queued) {
    notes.push(
      `queued ${(lock.waitedMs / 1000).toFixed(1)}s behind the gate run of pid ${lock.previousPid ?? "?"}`,
    );
  }
  if (lock.takenOver) {
    notes.push(`took over an orphaned gate.lock — pid ${lock.previousPid ?? "?"} no longer exists`);
  }

  // The clock starts behind the lock: what the ledger calls the duration of a
  // gate run is the work, not the queue in front of it — the wait is already in
  // `notes` and belongs to another run's phases.
  const startedAt = Date.now();
  // Prevention beats detection (§7.1 `DECISION (wake-lock-first)`): the phases
  // run under the lock from the start, and it lives exactly as long as they do.
  const wakeLock = environment.holdWakeLock();
  let result: CommandResult;
  try {
    result = await runPhases({ ctx, phases, diff, notes, wakeLock: wakeLock.state });
  } finally {
    wakeLock.release();
    lock.release();
  }

  if (issue !== undefined) {
    // Where the evidence went, whenever that is not where the caller stands: in
    // a linked worktree the ledger is the main checkout's (see `ledgerPath`), and
    // a reader looking into `<worktree>/.spec-sync/` would find nothing there.
    const evidence = ledgerPath(ctx.repoRoot);
    if (evidence !== join(ctx.repoRoot, LEDGER_FILE)) {
      notes.push(`gate evidence recorded in the main checkout's ledger: ${evidence}`);
    }
    appendEvent(ctx.repoRoot, {
      type: "gate",
      issue,
      run: runId,
      profile,
      ok: result.ok,
      exit: result.exit ?? EXIT.OK,
      durationMs: Date.now() - startedAt,
      // The only link from a run's logs back to its ticket — `protectedLogDirs`
      // reads it to keep the logs of an unfinished merge out of the pruning.
      logDir: result.logDir,
    });
  }
  return result;
}

async function runPhases({
  ctx,
  phases,
  diff,
  notes,
  wakeLock,
}: {
  ctx: CommandContext;
  phases: readonly GatePhase[];
  diff: string[] | undefined;
  notes: string[];
  wakeLock: WakeLockState;
}): Promise<CommandResult> {
  const logDir = createLogDir(ctx.repoRoot, {
    retention: ctx.config?.logRetention,
    keep: protectedLogDirs(readLedger(ctx.repoRoot).events),
  });
  const reports: PhaseReport[] = [];
  let failed: { name: string; output: string; signal: NodeJS.Signals | null } | undefined;

  const probe = new MachineProbe();
  probe.begin();

  for (const phase of phases) {
    if (diff !== undefined && !phaseRuns(phase.when, diff)) {
      reports.push({ name: phase.name, skipped: true });
      notes.push(
        `phase ${phase.name} skipped: nothing in the diff against ${DIFF_BASE} matches ${(phase.when ?? []).join(", ")}`,
      );
      continue;
    }

    progress(`gate → ${phase.name}: ${phase.cmd}`);
    const startedAt = Date.now();
    const outcome = await runPhase(phase.cmd, ctx.repoRoot);
    const durationMs = Date.now() - startedAt;
    probe.sample();

    writePhaseLog(ctx.repoRoot, logDir, phase.name, outcome.output);
    reports.push({ name: phase.name, skipped: false, exit: outcome.code, durationMs });

    if (outcome.code !== 0) {
      // Stop at the first red: the answer is known, and the phases behind it
      // are the expensive ones.
      failed = { name: phase.name, output: outcome.output, signal: outcome.signal };
      break;
    }
  }

  const condition = probe.end();
  writePhaseLog(ctx.repoRoot, logDir, MEASUREMENT_LOG, renderMeasurement(condition, wakeLock));

  if (failed === undefined) {
    return { ok: true, exit: EXIT.OK, notes, logDir, data: { phases: reports } };
  }

  const exit = phaseExit({
    output: failed.output,
    signal: failed.signal,
    saturated: condition.saturated,
  });
  if (exit === EXIT.UNPROVABLE) {
    // The reasons themselves are long and belong in the log — the response says
    // what to DO about it (spec §4: repeat, do not diagnose). Which of the two
    // routes got here is read off the load rather than re-derived: the transient
    // route is the only one that reaches exit 2 without saturation, so a quiet
    // box identifies it. Naming the wrong one would send the reader to a
    // measurement log that flatly contradicts the note.
    notes.push(
      condition.saturated
        ? `unprovable: ${failed.name} failed on a saturated box — repeat on a quiet one, do not diagnose (${MEASUREMENT_LOG}.log)`
        : `unprovable: ${failed.name} failed on a quiet box with only a transient infra signature — repeat, do not diagnose (${MEASUREMENT_LOG}.log)`,
    );
  }

  // The failing test, taken from the runner's verdict list — and only when it
  // has none does the answer fall back to the log scan (#10). That fallback is
  // right for a typecheck or a lint run, which report diagnostics and no tests
  // at all, and it is a weaker pointer for everything else — so it says so
  // rather than passing a scanned line off as a runner verdict.
  const named = reportedFailure(failed.output);
  if (named === undefined) {
    notes.push(
      `${failed.name}: no failing test in the output — firstError is a line of the log, not a runner verdict`,
    );
  }

  return {
    ok: false,
    exit,
    notes,
    logDir,
    data: { phases: reports, firstError: named ?? firstError(failed.output) },
  };
}

export const gateCommand: Command = {
  name: "gate",
  summary: "Run the gate phases of a profile, cheapest first",
  needsConfig: true,
  run: (ctx) => runGate(ctx),
};
