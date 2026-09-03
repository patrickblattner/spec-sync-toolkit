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
 *      (`foundation.testing.guideline` §load-dependent measurements).
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

import { existsSync } from "node:fs";
import { join } from "node:path";
import { EXIT, ToolkitError, progress } from "../output.js";
import { appendEvent, ledgerPath, readLedger, LEDGER_FILE } from "../ledger.js";
import { createLogDir, firstError, protectedLogDirs, writePhaseLog } from "../logs.js";
import { phasesOfProfile, type GatePhase } from "../config.js";
import { acquireGateLock } from "../gate/lock.js";
import { changeSet, phaseRuns, type ChangeSet } from "../gate/changed.js";
import { MachineProbe, renderMeasurement } from "../gate/machine.js";
import { phaseExit, reportedFailure, runPhase } from "../gate/phases.js";
import { DEFAULT_ENVIRONMENT, type Environment, type WakeLockState } from "../gate/environment.js";
import { MAIN_BRANCH, MERGE_GATE_PROFILE } from "./merge.js";
import type { Command, CommandContext, CommandResult } from "../cli.js";

/** Log file carrying the measurement condition; underscored so no phase name collides. */
const MEASUREMENT_LOG = "_measurement";

/** The profile that owes the full matrix, so `--changed` narrows nothing in it. */
const NIGHTLY_PROFILE = "nightly";

/**
 * `reason` of an abort BEFORE the first phase — the machine-readable half of
 * "this was not an attempt" (PROC-REL-015 rev 4, #11).
 *
 * Counting rule, and the loop's stop rule stands on it:
 *
 * - A run that never started is **no run**: no classification, no ledger entry,
 *   no consumed repetition. It is repeated once the precondition holds, and the
 *   repetition limit binds only runs that HAPPENED.
 * - A saturated box is the other direction: that run **took place** and counts,
 *   because saturation is a verdict about the run, not a precondition of it.
 *   The limit binds per INCIDENT — once the cause of the load is found, fixed
 *   and recorded in the ticket, the next run is a first run of that ticket.
 *
 * Both end in exit 2 and both say "repeat", so the exit code alone cannot tell
 * them apart. `reason: "no-run"` is what a counting reader goes by.
 */
const NO_RUN = "no-run";

/**
 * `reason` of the refusal to run the merge profile locally in remote mode
 * (`SST-DESIGN-013` rev 3). Exit 4, not 2: there is nothing to repeat, the
 * cause is the invocation itself.
 */
const REMOTE_MODE = "remote-mode";

/**
 * An abort before the first phase. Exit 2 like every other unprovable outcome —
 * not green, blocks the merge — but marked as the non-run it is.
 */
function notGateCapable(message: string): ToolkitError {
  return new ToolkitError(message, EXIT.UNPROVABLE, { reason: NO_RUN });
}

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
  const { profile, changed: changedFlag, issue, run: runId } = parseGateArgs(ctx.args);
  // The nightly is the net (foundation `PROC-REL-012`, spec §7.1 — `#15`): it
  // owes the full matrix, so there is nothing for `--changed` to narrow there.
  // Dropped here rather than in the parser, which reports back what was typed.
  const changed = changedFlag && profile !== NIGHTLY_PROFILE;
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
    throw notGateCapable(
      "gate: not a gate-capable environment — the machine runs on battery, where it can sleep mid-suite; plug in and repeat",
    );
  }

  // The same kind of exclusion, one level down: a fresh worktree does NOT
  // inherit the main checkout's `node_modules`, and every phase of a Node repo
  // runs through it. Without this the run dies wherever the first phase happens
  // to look for its tool — measured in `wt-489` (2026-08-23, #13): `npx` did not
  // find `spec-sync` in the tree, went to the registry and ended in an E404 that
  // says nothing about the cause, with no log to look at.
  if (
    existsSync(join(ctx.repoRoot, "package.json")) &&
    !existsSync(join(ctx.repoRoot, "node_modules"))
  ) {
    throw notGateCapable(
      `gate: not a gate-capable working tree — no node_modules in ${ctx.repoRoot}; a worktree does not inherit the main checkout's install, run \`npm install\` in THIS working tree and repeat`,
    );
  }

  // The third exclusion, and the one with teeth: in remote mode (`GATE_MODE`,
  // foundation PROC-DEV-044) the merge gate is the required check `pr-gate` on
  // CI, and a green LOCAL run of the same profile is exactly the evidence that
  // tempts a local merge. The first ticket after a consumer's switch to remote
  // went that way although the loop instruction said to read the mode first —
  // so the mode is read HERE, by the tool every merge passes through, not by
  // the reader. Only the merge profile: a local-profile run is a developer's
  // check in any mode. Inside the CI runner the check is void — that run IS
  // the remote gate. Last of the preconditions because it is the only one
  // that costs a network round trip.
  if (
    profile === MERGE_GATE_PROFILE &&
    !environment.isCiRunner() &&
    environment.readGateMode(ctx.repoRoot) === "remote"
  ) {
    throw new ToolkitError(
      `gate: the ${profile} profile does not run locally while GATE_MODE=remote — the merge gate is the required check "pr-gate" on CI (PROC-DEV-044): push the ticket branch, open a PR against ${MAIN_BRANCH}, wait for it (gh pr checks <nr> --watch) and merge with gh pr merge <nr> --squash --delete-branch`,
      EXIT.PRECONDITION,
      { reason: REMOTE_MODE },
    );
  }

  if (changedFlag && !changed) {
    notes.push(`--changed has no effect in the ${profile} profile — every phase runs`);
  }

  // Read before queueing: an unusable `--changed` is a precondition the caller
  // must fix, and finding that out after a ten-minute wait helps nobody.
  const diff = changed ? await changeSet(ctx.repoRoot) : undefined;

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
  diff: ChangeSet | undefined;
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
    if (diff !== undefined && !phaseRuns(phase.when, diff.files)) {
      reports.push({ name: phase.name, skipped: true });
      // The base belongs in the note: a skip is only checkable against the
      // state it was measured from (spec §7.1 — `#15`).
      notes.push(
        `phase ${phase.name} skipped: nothing in the diff against ${diff.base} matches ${(phase.when ?? []).join(", ")}`,
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
