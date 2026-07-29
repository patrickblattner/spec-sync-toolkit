/**
 * The environment a gate run needs (spec §7.1, decision register #67).
 *
 * Two mechanisms, both about the machine staying awake, and deliberately of
 * different kinds:
 *
 * - **Wake lock** — prevention. Where the platform has one, the phases run under
 *   it from the start. It is the normal path, not a safety net.
 * - **AC precondition** — exclusion. On battery the box may sleep with the lid
 *   closed, and a run interrupted that way says nothing about the code. That
 *   case is not detected, it is ruled out: no run, no classification.
 *
 * Detection was specified once (build-spec 0.9.0, monotonic clock against the
 * wall clock) and dropped again on measurement: on this fleet real sleep is
 * disabled on AC, so `production-cockpit#776` — the incident the rule was
 * written for — was deep idle, where both clocks keep running. The detector had
 * no target. What actually fixed #776 was the wake lock (register #67).
 */

import { spawn, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

/** Where the machine draws its power, as far as we can tell. */
export type PowerSource = "ac" | "battery" | "unknown";

/** State of the wake lock over a run, as the response reports it. */
export type WakeLockState = "held" | "unavailable";

export interface WakeLock {
  state: WakeLockState;
  /** Ends the lock. Safe to call twice; a no-op when nothing is held. */
  release(): void;
}

/**
 * macOS ships both binaries at fixed paths. Checking the path instead of
 * shelling out to `command -v` keeps the preflight free of a second process —
 * and of a shell, which is what the phase spawn goes out of its way to avoid.
 */
const CAFFEINATE = "/usr/bin/caffeinate";
const PMSET = "/usr/bin/pmset";

/**
 * Reads `pmset -g batt`, whose first line states the source verbatim:
 * `Now drawing from 'AC Power'`.
 *
 * Anything else is `unknown` — including a future wording. Unknown never blocks
 * a run: the precondition exists to rule out one specific hazard, and a parser
 * that cannot see it must not turn every run on every platform into exit 2.
 */
export function parsePowerSource(output: string): PowerSource {
  const match = /Now drawing from '([^']+)'/.exec(output);
  const source = match?.[1]?.toLowerCase();
  if (source === undefined) return "unknown";
  if (source.includes("ac")) return "ac";
  if (source.includes("battery")) return "battery";
  return "unknown";
}

/** The machine's power source, or `unknown` where `pmset` does not exist. */
export function readPowerSource(): PowerSource {
  if (process.platform !== "darwin" || !existsSync(PMSET)) return "unknown";
  const probe = spawnSync(PMSET, ["-g", "batt"], { encoding: "utf8" });
  if (probe.status !== 0 || typeof probe.stdout !== "string") return "unknown";
  return parsePowerSource(probe.stdout);
}

/**
 * Holds a wake lock for the caller's lifetime.
 *
 * `-w <pid>` ties `caffeinate` to this process, so a hard kill of the gate
 * releases it too — `release()` is the clean path, not the only one. This is no
 * daemon (`DECISION (no-headless)`, §2): the lock cannot outlive the run that
 * took it.
 *
 * Note what it does NOT cover: closing the lid still sleeps the machine, on any
 * setting. That gap is what the AC precondition rules out.
 */
export function holdWakeLock(): WakeLock {
  if (process.platform !== "darwin" || !existsSync(CAFFEINATE)) {
    return { state: "unavailable", release: () => {} };
  }
  const child = spawn(CAFFEINATE, ["-dimsu", "-w", String(process.pid)], { stdio: "ignore" });
  // The lock must not keep the process alive on its own — it follows the run,
  // never the other way round.
  child.unref();
  let released = false;
  return {
    state: "held",
    release: () => {
      if (released) return;
      released = true;
      child.kill();
    },
  };
}

/** What `gate` needs from the machine. Injected so tests do not read the real box. */
export interface Environment {
  readPowerSource: () => PowerSource;
  holdWakeLock: () => WakeLock;
}

export const DEFAULT_ENVIRONMENT: Environment = { readPowerSource, holdWakeLock };
