/**
 * The measurement condition of a gate run (spec §7.1, `foundation.testing.guideline`
 * §Teststufen "load-dependent measurements").
 *
 * The norm is explicit: "the run logs the load (e.g. `loadavg` before/after) —
 * without a logged measurement condition, the number is no evidence."
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
import { Worker } from "node:worker_threads";
import {
  CAPACITY_SCALING_FRACTION,
  STARVATION_MIN_NCPU,
  assessSaturation,
  foreignCpuShares,
  ownCpuCores,
  ownProcessIds,
  parseProcessTable,
  parseUptime,
  shortComm,
  type CapacityProbe,
  type CapacityWhen,
  type CpuSample,
  type ForeignShare,
  type LoadAverages,
} from "./saturation.js";

/** How often the box is sampled while phases run. */
export const SAMPLE_INTERVAL_MS = 5_000;

// ---- CAPACITY PROBE -------------------------------------------------------
// The fixed work budget, chosen against the constraint that the probe must not
// become a cost of its own: one leg takes ~0.35 s on a healthy 16-core box, and
// a run takes four legs (single and parallel, before and after the phases), so
// ~1.4 s of a gate that otherwise runs for minutes. A capped machine takes
// proportionally longer — which is the finding, not a defect of the probe.
//
// The budget is FIXED and the time is measured, never the other way round: a
// fixed time window with a counted result would let a machine that schedules us
// late look identical to one that computes slowly.

/** Hash iterations each probe worker performs. */
export const CAPACITY_ITERATIONS = 12_000;

/** Bytes hashed per iteration. Large enough that the hash, not the call overhead, is the work. */
export const CAPACITY_BYTES = 64 * 1024;

/** Workers in the parallel leg, capped so the probe stays short on a big box. */
export const CAPACITY_MAX_WORKERS = 4;

/**
 * The worker body, inline rather than a second file: the toolkit ships as one
 * bundle, and a path to a sibling module would have to survive bundling,
 * `npx`, and a global install. `digest()[0]` is read so the optimiser cannot
 * delete the loop it is supposed to time.
 */
const CAPACITY_WORKER = `
const { createHash } = require("node:crypto");
const { workerData, parentPort } = require("node:worker_threads");
const buffer = Buffer.alloc(workerData.bytes, 7);
let sink = 0;
for (let i = 0; i < workerData.iterations; i++) sink = createHash("sha256").update(buffer).digest()[0];
parentPort.postMessage(sink);
`;

/** The seam: `gate` injects this so a test never burns a second of real CPU. */
export type CapacityMeasurer = (when: CapacityWhen, ncpu: number) => Promise<CapacityProbe>;

/** Runs one leg with `workers` parallel workers and returns its wall time in ms. */
function runCapacityLeg(workers: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const startedAt = performance.now();
    let pending = workers;
    let failed = false;
    for (let i = 0; i < workers; i += 1) {
      const worker = new Worker(CAPACITY_WORKER, {
        eval: true,
        workerData: { iterations: CAPACITY_ITERATIONS, bytes: CAPACITY_BYTES },
      });
      worker.on("error", (error: Error) => {
        if (failed) return;
        failed = true;
        reject(error);
      });
      // `exit` fires after `error` too, so the counter needs no special case —
      // only the already-rejected promise does, and settling twice is a no-op.
      worker.on("exit", () => {
        pending -= 1;
        if (pending === 0 && !failed) resolve(performance.now() - startedAt);
      });
    }
  });
}

/**
 * The capacity probe of `SST-DESIGN-012` rev 3: throughput with `k` workers over
 * throughput with one. Best-effort like every other probe here — a machine
 * without worker threads reports "not run", never an exception, and an
 * unmeasured machine is simply never saturated.
 *
 * Skipped below `STARVATION_MIN_NCPU`, the same floor the starvation signal
 * uses: there `k` would be under 2, and a ratio against a floor of `k/2 < 1`
 * says nothing.
 */
export async function measureCapacity(when: CapacityWhen, ncpu: number): Promise<CapacityProbe> {
  const k = Math.min(ncpu, CAPACITY_MAX_WORKERS);
  if (!(ncpu >= STARVATION_MIN_NCPU)) {
    return {
      when,
      k,
      factor: null,
      skipped: `${ncpu} cores is below the ${STARVATION_MIN_NCPU} this signal needs — k would be under 2 and the ratio meaningless`,
    };
  }
  try {
    // Single leg first: it is the reference, and taking it while the machine is
    // still untouched by our own parallel burst keeps the two comparable.
    const singleMs = await runCapacityLeg(1);
    const parallelMs = await runCapacityLeg(k);
    if (!(singleMs > 0) || !(parallelMs > 0)) {
      return { when, k, factor: null, skipped: "the probe legs took no measurable time" };
    }
    // Throughput is work units per second; the fixed budget cancels, which is
    // why the budget may change without moving the threshold.
    const single = CAPACITY_ITERATIONS / singleMs;
    const parallel = (k * CAPACITY_ITERATIONS) / parallelMs;
    return { when, k, factor: parallel / single };
  } catch (error) {
    return {
      when,
      k,
      factor: null,
      skipped: `worker threads unavailable: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * The one line the response carries about the machine's capacity — present even
 * when nothing carried, because a later reader has to be able to tell a quiet
 * machine from an unprobed one (`SST-DESIGN-012` rev 3).
 */
export function capacityNote(capacity: readonly CapacityProbe[]): string {
  if (capacity.length === 0) return "capacity probe: not taken";
  const measured = capacity.filter((probe) => probe.factor !== null);
  if (measured.length === 0) {
    const why = [...new Set(capacity.map((probe) => probe.skipped ?? "no result"))].join("; ");
    return `capacity probe: not run — ${why}`;
  }
  const k = measured[0]?.k ?? 0;
  const legs = capacity
    .map((probe) =>
      probe.factor === null ? `${probe.when} not run` : `${probe.when} ${probe.factor.toFixed(2)}`,
    )
    .join(", ");
  return (
    `capacity probe (k=${k}): ${legs} — under ${(k * CAPACITY_SCALING_FRACTION).toFixed(2)} ` +
    `the machine delivers fewer than half the cores it shows`
  );
}

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
  /** The capacity probes taken around the phases, in the order they were taken. */
  capacity: CapacityProbe[];
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
  measureCapacity?: CapacityMeasurer;
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
  private readonly measureCapacity: CapacityMeasurer;
  private readonly ncpu: number;
  private readonly selfPid: number;
  private readonly now: () => number;

  private readonly first = new Map<number, CpuSample>();
  private readonly last = new Map<number, CpuSample>();
  private readonly own = new Set<number>();
  private readonly capacity: CapacityProbe[] = [];

  private startedAt = 0;
  private baseline: LoadAverages | null = null;
  private after: LoadAverages | null = null;
  private samples = 0;
  private timer: NodeJS.Timeout | undefined;

  constructor(options: ProbeOptions = {}) {
    this.readUptime = options.readUptime ?? probeUptime;
    this.readProcessTable = options.readProcessTable ?? probeProcessTable;
    this.measureCapacity = options.measureCapacity ?? measureCapacity;
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

  /**
   * Takes one capacity probe. The caller places it immediately BEFORE the first
   * and AFTER the last phase — never between them, where the probe's own workers
   * would compete with the run's (`SST-DESIGN-012` rev 3 §Mechanik).
   */
  async probeCapacity(when: CapacityWhen): Promise<void> {
    this.capacity.push(await this.measureCapacity(when, this.ncpu));
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
      capacity: this.capacity,
    });

    return {
      ncpu: this.ncpu,
      baseline: this.baseline,
      after: this.after,
      wallSeconds,
      samples: this.samples,
      ownCores,
      foreign,
      capacity: [...this.capacity],
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
    "# measurement condition (foundation.testing.guideline §load-dependent measurements)",
    "",
    `cores:          ${condition.ncpu}`,
    `wall seconds:   ${condition.wallSeconds.toFixed(1)}`,
    `samples:        ${condition.samples}`,
    `load before:    ${load(condition.baseline)}`,
    `load after:     ${load(condition.after)}`,
    `own cores:      ${condition.ownCores === undefined ? "not measured" : condition.ownCores.toFixed(2)}`,
    `verdict:        ${verdictLine(condition)}`,
  ];

  // Both probes, always — a machine that was never probed must not read like a
  // machine that was probed and found whole.
  if (condition.capacity.length === 0) {
    lines.push("capacity:       not taken");
  } else {
    for (const probe of condition.capacity) {
      lines.push(
        `capacity ${probe.when.padEnd(6)}: ${
          probe.factor === null
            ? `not run — ${probe.skipped ?? "no result"}`
            : `${probe.factor.toFixed(2)} with k=${probe.k} workers (under ${(probe.k * CAPACITY_SCALING_FRACTION).toFixed(2)} carries)`
        }`,
      );
    }
  }

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
