/**
 * `slot` — the box slots of PROC-REL-060 for heavy steps outside the gate.
 *
 *   spec-sync slot run --step <name> --cap <minutes> [--run <id>] -- <cmd> [args…]
 *   spec-sync slot status [--last <n>]
 *
 * `run` takes a box slot (waiting as PROC-REL-040 says), runs the command under
 * its cap and releases the slot. The command's exit code passes through; at
 * its cap the command is killed and the run ends with 124 (as `timeout` does);
 * an expired wait ends with 75 and runs nothing. The command's stdout and
 * stderr both go to stderr — stdout carries only the response (SST-DESIGN-011).
 *
 * `status` names the current holders, the 1-min load against the load ceiling,
 * and the last records of the wait log.
 */

import { spawn } from "node:child_process";
import { constants } from "node:os";
import { basename } from "node:path";
import type { Command, CommandContext, CommandResult } from "../cli.js";
import { EXIT, ToolkitError, passedExit, progress } from "../output.js";
import { checkFlags, positionals, valueFlag } from "../pack/args.js";
import { repositoryOf } from "../gate/holder.js";
import {
  acquireBoxSlot,
  boxDir,
  currentLoad,
  lastWaits,
  loadCeiling,
  slotStates,
} from "../gate/slots.js";

const RUN_USAGE =
  "usage: spec-sync slot run --step <name> --cap <minutes> [--run <id>] -- <cmd> [args…]";
const STATUS_USAGE = "usage: spec-sync slot status [--last <n>]";
/** Exit code of a command killed at its cap — the one `timeout(1)` uses. */
export const CAP_EXIT = 124;
/** After SIGTERM at the cap, the command gets this long before SIGKILL. */
const KILL_GRACE_MS = 10_000;
const DEFAULT_LAST = 5;

export interface SlotDeps {
  /** Length of a cap minute; tests shorten it. */
  minuteMs: number;
}

export const slotCommand: Command = {
  name: "slot",
  summary: "Box slots (PROC-REL-060): run a heavy step under a slot, or show holders and waits",
  needsConfig: false,
  run: (ctx) => runSlot(ctx),
};

export async function runSlot(
  ctx: CommandContext,
  deps: SlotDeps = { minuteMs: 60_000 },
): Promise<CommandResult> {
  const end = ctx.args.indexOf("--");
  const own = end === -1 ? ctx.args : ctx.args.slice(0, end);
  const wrapped = end === -1 ? [] : ctx.args.slice(end + 1);
  const sub = positionals(own, ["--step", "--cap", "--run", "--last"])[0];
  if (sub === "status") return status(own);
  if (sub === "run") return runUnderSlot(ctx, own, wrapped, deps);
  throw new ToolkitError(
    `slot needs a subcommand — run or status\n${RUN_USAGE}`,
    EXIT.PRECONDITION,
    {
      field: "subcommand",
    },
  );
}

function status(own: string[]): CommandResult {
  checkFlags(own, ["--last"]);
  const last = valueFlag(own, "--last") ?? String(DEFAULT_LAST);
  if (!/^\d+$/.test(last)) {
    throw new ToolkitError(STATUS_USAGE, EXIT.PRECONDITION, { field: "--last" });
  }
  const slots = slotStates();
  return {
    ok: true,
    data: {
      box: boxDir(),
      slots,
      load: currentLoad(),
      load_max: loadCeiling(),
      waits: lastWaits(Number(last)),
    },
  };
}

async function runUnderSlot(
  ctx: CommandContext,
  own: string[],
  wrapped: string[],
  deps: SlotDeps,
): Promise<CommandResult> {
  checkFlags(own, ["--step", "--cap", "--run"]);
  const step = valueFlag(own, "--step");
  const cap = valueFlag(own, "--cap");
  if (step === undefined || step.trim() === "") {
    throw new ToolkitError(`--step is required — ${RUN_USAGE}`, EXIT.PRECONDITION, {
      field: "--step",
    });
  }
  // No locked step runs without a cap (PROC-REL-040 rev 7): the waiters'
  // deadline derives from it, and the command ends red at it.
  if (cap === undefined || !/^\d+$/.test(cap) || Number(cap) < 1) {
    throw new ToolkitError(
      `--cap <minutes> is required, a whole number ≥ 1 — ${RUN_USAGE}`,
      EXIT.PRECONDITION,
      {
        field: "--cap",
      },
    );
  }
  const [cmd, ...cmdArgs] = wrapped;
  if (cmd === undefined) {
    throw new ToolkitError(`no command behind -- — ${RUN_USAGE}`, EXIT.PRECONDITION, {
      field: "--",
    });
  }
  const capMin = Number(cap);
  const run = valueFlag(own, "--run") ?? `${process.pid}@${basename(ctx.repoRoot)}`;

  const slot = await acquireBoxSlot({
    repository: repositoryOf(ctx.repoRoot),
    step,
    run,
    cap: capMin,
  });
  const notes: string[] = [];
  if (slot.queued) {
    notes.push(
      `waited ${(slot.waitedMs / 1000).toFixed(1)}s for a box slot behind ${slot.waitedBehind.join("; ")}`,
    );
  }
  if (slot.takenOver) {
    notes.push(`took over box ${slot.slot} — pid ${slot.previousPid ?? "?"} no longer exists`);
  }

  let outcome: { code: number; capped: boolean; error?: string };
  try {
    progress(`slot ${slot.slot} → ${step}: ${wrapped.join(" ")}`);
    outcome = await runCapped(cmd, cmdArgs, ctx.repoRoot, capMin * deps.minuteMs);
  } finally {
    slot.release();
  }

  if (outcome.capped)
    notes.push(`${step} reached its cap of ${capMin} min and was killed (exit ${CAP_EXIT})`);
  if (outcome.error !== undefined) notes.push(`${step} could not run: ${outcome.error}`);
  return {
    ok: outcome.code === 0,
    exit: outcome.code === 0 ? EXIT.OK : passedExit(outcome.code),
    notes,
    data: {
      step,
      slot: slot.slot,
      cap: capMin,
      code: outcome.code,
      waited_s: Math.round(slot.waitedMs / 100) / 10,
    },
  };
}

/**
 * Runs the command in its own process group so the cap ends all of it, not
 * just the first process. Signals sent to this process are passed on to the
 * group — a detached group no longer gets the terminal's Ctrl-C by itself.
 */
function runCapped(
  cmd: string,
  args: string[],
  cwd: string,
  capMs: number,
): Promise<{ code: number; capped: boolean; error?: string }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd, detached: true, stdio: ["ignore", 2, 2] });
    let capped = false;
    let killTimer: NodeJS.Timeout | undefined;
    const signalGroup = (signal: NodeJS.Signals): void => {
      try {
        if (child.pid !== undefined) process.kill(-child.pid, signal);
      } catch {
        // the group is gone already
      }
    };
    const forward = (signal: NodeJS.Signals): void => signalGroup(signal);
    const forwarded: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
    for (const signal of forwarded) process.on(signal, forward);
    const capTimer = setTimeout(() => {
      capped = true;
      signalGroup("SIGTERM");
      killTimer = setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS);
    }, capMs);
    let settled = false;
    const done = (result: { code: number; capped: boolean; error?: string }): void => {
      if (settled) return;
      settled = true;
      clearTimeout(capTimer);
      if (killTimer !== undefined) clearTimeout(killTimer);
      for (const signal of forwarded) process.off(signal, forward);
      resolve(result);
    };
    child.on("error", (error) => done({ code: 127, capped: false, error: error.message }));
    child.on("exit", (code, signal) => {
      if (capped) {
        done({ code: CAP_EXIT, capped: true });
        return;
      }
      done({
        code: code ?? 128 + (signal === null ? 0 : (constants.signals[signal] ?? 0)),
        capped: false,
      });
    });
  });
}
