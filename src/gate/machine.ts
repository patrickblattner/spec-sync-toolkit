/**
 * The measurement condition of a gate run (spec §7.1, `foundation.testing.guideline`
 * §Teststufen "Lastabhängige Messungen").
 *
 * The norm is explicit: "der Lauf protokolliert den Load (z. B. `loadavg`
 * vor/nach) — ohne protokollierte Messbedingung ist die Zahl kein Beleg."
 * So this module samples the box around the phases and hands the numbers to the
 * pure logic in `saturation.ts`; the gate writes the rendered condition into the
 * run's log directory next to the phase logs.
 *
 * All probes are best-effort: a box without `uptime` or `ps` produces "not
 * measured", never an exception. An unmeasured box is simply never saturated —
 * which keeps a red red, the safe direction.
 */

import { execFileSync } from "node:child_process";
import { availableParallelism } from "node:os";
import {
  assessSaturation,
  foreignCpuShares,
  ownCpuCores,
  ownProcessIds,
  parseProcessTable,
  parseUptime,
  shortComm,
  type CpuSample,
  type ForeignShare,
  type LoadAverages,
} from "./saturation.js";

/** How often the box is sampled while phases run. */
export const SAMPLE_INTERVAL_MS = 5_000;

/** Everything the gate measured about the box — the logged measurement condition. */
export interface MeasurementCondition {
  ncpu: number;
  /** Load averages before the first phase started — purely foreign. */
  baseline: LoadAverages | null;
  /** Load averages after the last phase — the "nachher" half of the norm. */
  after: LoadAverages | null;
  wallSeconds: number;
  samples: number;
  /** Cores our own process tree managed to use; undefined when unmeasured. */
  ownCores: number | undefined;
  foreign: ForeignShare[];
  saturated: boolean;
  /**
   * We barely computed, but nothing else was busy — so the low own-CPU is
   * waiting, not starvation, and it does NOT excuse a red (see
   * `assessSaturation`). Reported separately so the log can say which of the two
   * quiet cases it was.
   */
  starvedOnly: boolean;
  reasons: string[];
}

interface ProbeOptions {
  readUptime?: () => string | null;
  readProcessTable?: () => string | null;
  ncpu?: number;
  selfPid?: number;
  now?: () => number;
}

/**
 * Samples the box across a gate run. `begin()` takes the baseline before the
 * first phase, `end()` closes the window and returns the condition; in between
 * an unref'd timer samples the process table so a long phase is covered even
 * without the gate calling in.
 */
export class MachineProbe {
  private readonly readUptime: () => string | null;
  private readonly readProcessTable: () => string | null;
  private readonly ncpu: number;
  private readonly selfPid: number;
  private readonly now: () => number;

  private readonly first = new Map<number, CpuSample>();
  private readonly last = new Map<number, CpuSample>();
  private readonly own = new Set<number>();

  private startedAt = 0;
  private baseline: LoadAverages | null = null;
  private after: LoadAverages | null = null;
  private samples = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(options: ProbeOptions = {}) {
    this.readUptime = options.readUptime ?? probeUptime;
    this.readProcessTable = options.readProcessTable ?? probeProcessTable;
    this.ncpu = options.ncpu ?? readCoreCount();
    this.selfPid = options.selfPid ?? process.pid;
    this.now = options.now ?? Date.now;
  }

  begin(): void {
    this.startedAt = this.now();
    this.baseline = parseUptime(this.readUptime());
    this.sample();
    this.timer = setInterval(() => this.sample(), SAMPLE_INTERVAL_MS);
    // A sampler must never be the reason the process stays alive.
    this.timer.unref();
  }

  /** Takes one process-table sample. Safe to call at any time; failures are ignored. */
  sample(): void {
    const rows = parseProcessTable(this.readProcessTable());
    if (rows.length === 0) return;
    this.samples += 1;
    for (const row of rows) {
      const sighting: CpuSample = { cpuSeconds: row.cpuSeconds, comm: row.comm };
      if (!this.first.has(row.pid)) this.first.set(row.pid, sighting);
      this.last.set(row.pid, sighting);
    }
    // Union across samples: a child of ours that died mid-run must stay OURS,
    // otherwise our own finished work reappears as foreign load.
    for (const pid of ownProcessIds(rows, this.selfPid)) this.own.add(pid);
  }

  end(): MeasurementCondition {
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    this.sample();
    this.after = parseUptime(this.readUptime());

    const wallSeconds = (this.now() - this.startedAt) / 1000;
    const ownCores =
      this.samples > 0
        ? ownCpuCores({ first: this.first, last: this.last, ownPids: this.own, wallSeconds })
        : undefined;
    const foreign = foreignCpuShares({
      first: this.first,
      last: this.last,
      ownPids: this.own,
      wallSeconds,
    });
    const { saturated, reasons, starvedOnly } = assessSaturation({
      baseline: this.baseline,
      ncpu: this.ncpu,
      hogs: foreign,
      ownCores,
      wallSeconds,
    });

    return {
      ncpu: this.ncpu,
      baseline: this.baseline,
      after: this.after,
      wallSeconds,
      samples: this.samples,
      ownCores,
      foreign,
      saturated,
      starvedOnly,
      reasons,
    };
  }
}

/**
 * Three states, not two. A reader who skims this line has to be able to tell
 * "the box was full" from "we waited on something while the box was idle" —
 * the second used to print SATURATED too, which reads like an excuse for a red
 * that it explicitly is not.
 */
function verdictLine(condition: MeasurementCondition): string {
  if (condition.saturated) return "SATURATED — a timeout-only red is unprovable (exit 2)";
  // The quiet lines say what the LOAD explains, which since
  // `DECISION (infra-is-not-the-code)` is no longer the whole verdict: a red
  // whose only cause is a transient infra signature is exit 2 on a quiet box
  // too. Claiming "exit 1" flatly would make this log contradict the response.
  if (condition.starvedOnly) {
    return (
      "quiet, but we barely computed — waiting, not starvation: " +
      "load excuses nothing (a red is exit 1 unless its only cause is a transient infra signature)"
    );
  }
  return "quiet — load excuses nothing (a red is exit 1 unless its only cause is a transient infra signature)";
}

/**
 * The measurement condition as a log file — the evidence the norm demands.
 * Never reaches stdout; it lands next to the phase logs (spec §3).
 */
export function renderMeasurement(
  condition: MeasurementCondition,
  wakeLock?: "held" | "unavailable",
): string {
  const load = (value: LoadAverages | null): string =>
    value === null
      ? "not measured"
      : `${value.load1.toFixed(2)} ${value.load5.toFixed(2)} ${value.load15.toFixed(2)}`;

  const lines = [
    "# measurement condition (foundation.testing.guideline §Lastabhängige Messungen)",
    "",
    `cores:          ${condition.ncpu}`,
    `wall seconds:   ${condition.wallSeconds.toFixed(1)}`,
    `samples:        ${condition.samples}`,
    `load before:    ${load(condition.baseline)}`,
    `load after:     ${load(condition.after)}`,
    `own cores:      ${condition.ownCores === undefined ? "not measured" : condition.ownCores.toFixed(2)}`,
    `verdict:        ${verdictLine(condition)}`,
  ];

  // The wake lock belongs to the measured CONDITION of a run, not to the answer:
  // held on darwin, unavailable everywhere else — a constant per platform, and
  // nothing a caller could act on. Here it sits next to the load it explains,
  // and a reader who wonders whether a run could have been interrupted finds it
  // in the same file (spec §7.1, register #67).
  if (wakeLock !== undefined) {
    lines.push(
      `wake lock:      ${wakeLock === "held" ? "held for the whole run" : "not available on this platform"}`,
    );
  }
  lines.push("");

  lines.push("foreign processes (share of one core across the whole run):");
  if (condition.foreign.length === 0) {
    lines.push(
      condition.wallSeconds < 30
        ? "  none measured — the run was shorter than the minimum window (30 s)"
        : "  none above the noise floor",
    );
  } else {
    for (const hog of condition.foreign.slice(0, 10)) {
      lines.push(`  ${hog.share.toFixed(1).padStart(6)} %  pid ${hog.pid}  ${shortComm(hog.comm)}`);
    }
  }

  if (condition.reasons.length > 0) {
    lines.push("", "reasons:");
    for (const reason of condition.reasons) lines.push(`  - ${reason}`);
  }

  return `${lines.join("\n")}\n`;
}

function probeUptime(): string | null {
  try {
    return execFileSync("uptime", { encoding: "utf8", timeout: 5_000 });
  } catch {
    return null;
  }
}

function probeProcessTable(): string | null {
  try {
    return execFileSync("ps", ["-Ao", "pid,ppid,time,comm"], {
      encoding: "utf8",
      timeout: 10_000,
      maxBuffer: 16 * 1024 * 1024,
    });
  } catch {
    return null;
  }
}

function readCoreCount(): number {
  try {
    return availableParallelism();
  } catch {
    return 0;
  }
}
