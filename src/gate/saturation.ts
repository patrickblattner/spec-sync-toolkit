/**
 * Saturation detection and the three-class verdict (spec §7.1), ported from
 * `production-cockpit/scripts/test-gate.lib.mjs`.
 *
 * WHY THIS EXISTS
 * A merge gate died red twice on 2026-07-19 without a single test breaking on
 * CONTENT: only timeouts, in changing files, while a package installation held
 * the box at 67–75 % CPU. The same suite then ran green in 53 s on a quiet box.
 * The suite was never the problem — the gate's HONESTY ABOUT ITSELF was: whoever
 * read "3 failed" concluded the code was broken and spent two hours looking in
 * the wrong place.
 *
 * So a gate run has three outcomes, not two (spec §4):
 *
 *   0 = green       — the phases ran and passed
 *   1 = FAILED      — something is actually broken; diagnose it
 *   2 = UNPROVABLE  — the run aborted under foreign load; it says NOTHING about
 *                     the code. Not a pass: it stops the merge exactly like 1,
 *                     but asks for a repeat on a quiet box instead of a hunt.
 *
 * Everything in this module is pure, so the gate's own correctness is provable
 * WITHOUT a saturated box — the saturated case is a fixture, not an accident.
 * The impure sampling lives in `machine.ts`.
 *
 * Not ported: `gateMaxWorkers` (worker sizing for vitest). The toolkit runs
 * opaque phase commands and does not own their concurrency; §7.1 asks for the
 * saturation detection and the verdict, nothing else.
 */

/** Load averages as `uptime` reports them. */
export interface LoadAverages {
  load1: number;
  load5: number;
  load15: number;
}

/** One row of the process table, with CUMULATIVE cpu time (never `%CPU`). */
export interface ProcessRow {
  pid: number;
  ppid: number;
  cpuSeconds: number;
  comm: string;
}

/** One sighting of a pid: its cpu time at that moment. */
export interface CpuSample {
  cpuSeconds: number;
  comm?: string;
}

/** A foreign process's share of one core across the whole run, in percent. */
export interface ForeignShare {
  pid: number;
  comm: string;
  share: number;
}

// ---- SATURATION THRESHOLDS ------------------------------------------------
// Every number here is a measurement on the reference box (16 cores), not a
// guess:
//   quiet box, suite fully green : load 2.21 / 4.86 / 12.48  -> 0.78 per core
//   the two red gate runs        : load 7.6 / 16.8 / 24.5    -> 1.53 per core
// 1.0 per core sits in that gap and means something defensible rather than
// arbitrary: before we add a single worker, the box already has a full core of
// FOREIGN work queued for every core it owns.
export const SATURATED_LOAD_PER_CORE = 1.0;

// How much of the WHOLE BOX foreign work must eat, across the run, before the
// run is unprovable.
//
// This is deliberately a capacity question, not a per-process one — that
// correction also came from a measurement. An earlier version tripped on "any
// single foreign process over 50 % of a core" and promptly fired on `installd`
// at 82 %: real, sustained, genuinely the installer from the incident — and yet
// 0.8 of 16 cores, with fifteen cores idle. What starves a run is the box being
// taken away from it, not one neighbour being busy.
//   quiet box, suite fully green : foreign ≈ 0.5–1 of 16 cores  -> ~0.05
//   the two red gate runs        : load 24.5, ≤16 of it ours     -> ~0.5
export const FOREIGN_SATURATION_FRACTION = 0.25;

/** Foreign processes at or above this share get NAMED. Purely presentational — the verdict is the sum, so a swarm of small consumers cannot hide under a per-process bar. */
export const FOREIGN_REPORT_PCPU = 20;

/** Noise floor for collecting shares at all; below this a process is rounding error. */
export const FOREIGN_NOISE_PCPU = 1;

// Shortest run over which a foreign CPU share means anything. Measured the hard
// way: on a 3-second run the gate reported `launchservicesd 205.7 %` and
// `installd 63.8 %` on an IDLE box. Both are real CPU-seconds — but a FIXED,
// ONE-OFF cost our own run induces (the OS registers the processes we spawn,
// reacts to the files we touch), and dividing a fixed cost by a tiny window
// makes it look like a permanent hog. Over a full run the same burst dilutes
// into the noise. The baseline load average still applies to short runs — it is
// measured before we spawn anything and needs no window.
export const MIN_HOG_WINDOW_S = 30;

// The third signal, and the one the first two cannot see. Both of them ask "who
// ELSE is eating the box" — a CPU-share question. But a run can be starved
// without anyone eating CPU at all: when the OS SUSPENDS our processes (macOS
// idle throttling was the measured case), the phase spends its time not running
// at all. Nobody shows up as a hog, the load average stays modest, and the gate
// concludes "quiet box, so a timeout is a real defect" — exactly backwards.
//
// The measured populations, on the 16-core reference box:
//   healthy full runs (green, 54–58 s) : 0.5 · 0.5 · 0.5 cores
//   the suspended run (355 s, exit 2)  : 0.08 cores
// 0.25 sits between them: 2x under healthy, 3x over suspended. Like the other
// two signals it NEVER turns a content failure green — it only decides whether
// a timeout-only red reads as "broken" or as "unprovable", so a threshold set
// too high costs at worst one extra re-run.
export const STARVED_OWN_CORES = 0.25;

/**
 * From how many distinct files on a timeout-only red counts as "scattered", i.e.
 * consistent with a slow box rather than a hang. One file is a hang; two or more
 * is the box. Deliberately low: the cost of the two mistakes is not symmetric —
 * a hang wrongly excused is retried forever, a slow box wrongly blamed costs one
 * fruitless look.
 */
export const SCATTERED_MIN_FILES = 2;

/** Below this many cores the reasoning above does not hold (a 2-core CI container legitimately runs under one core of parallelism). */
export const STARVATION_MIN_NCPU = 4;

// ---- LOAD -----------------------------------------------------------------

/**
 * `uptime` on macOS: "... load averages: 2.21 4.86 12.48"; GNU prints
 * "load average: 2.21, 4.86, 12.48". Both are accepted so the gate is not
 * silently blind on a Linux CI box.
 */
export function parseUptime(text: string | null | undefined): LoadAverages | null {
  // The number pattern is deliberately strict (digits with at most ONE
  // separator): a greedy `[\d.,]+` swallows the comma GNU uses BETWEEN the
  // averages and turns "0.52," into NaN.
  const num3 = String.raw`(\d+(?:[.,]\d+)?)`;
  const match = new RegExp(`load averages?:\\s*${num3}[\\s,]+${num3}[\\s,]+${num3}`, "i").exec(
    text ?? "",
  );
  if (match === null) return null;
  const num = (value: string | undefined): number => Number((value ?? "").replace(",", "."));
  const load1 = num(match[1]);
  const load5 = num(match[2]);
  const load15 = num(match[3]);
  if (![load1, load5, load15].every((n) => Number.isFinite(n))) return null;
  return { load1, load5, load15 };
}

// ---- PROCESS TABLE --------------------------------------------------------

/**
 * Reads the TIME column of `ps`: `[DD-][HH:]MM:SS[.ss]`, where the leading
 * field simply grows (macOS prints `2356:36.39` for 2356 minutes).
 *
 * WHY CUMULATIVE CPU TIME AND NOT `%CPU` (measured, not assumed): the first
 * version of this gate read `pcpu` and kept the peak per pid. On a demonstrably
 * quiet box (load 3.84) it reported `launchservicesd 279.5 %` — while `ps`
 * showed that process at 0.0 % moments later. macOS %CPU is a short-window
 * sample that spikes hard when a process is momentarily busy, and a
 * peak-of-instantaneous keeps every such spike forever. That gate would have
 * called almost every run "saturated" — as useless as one that always says
 * "failed". The difference between two cumulative readings, over the wall time
 * between them, IS the process's true average share of one core.
 */
export function parseCpuTime(text: string | null | undefined): number | null {
  const match = /^(?:(\d+)-)?([\d:]+(?:\.\d+)?)$/.exec(String(text ?? "").trim());
  if (match === null) return null;
  const parts = (match[2] ?? "").split(":");
  if (parts.length > 3) return null;
  // Horner over the colon-separated fields only; the day prefix is added
  // AFTERWARDS — folding it into the loop would multiply it by 60 per field.
  let seconds = 0;
  for (const part of parts) {
    const value = Number(part);
    if (!Number.isFinite(value)) return null;
    seconds = seconds * 60 + value;
  }
  return seconds + Number(match[1] ?? 0) * 86400;
}

/** Parses `ps -Ao pid,ppid,time,comm`. `comm` may contain spaces, so it is everything after the third column. */
export function parseProcessTable(text: string | null | undefined): ProcessRow[] {
  const rows: ProcessRow[] = [];
  for (const line of (text ?? "").split("\n").slice(1)) {
    const match = /^\s*(\d+)\s+(\d+)\s+([\d.:-]+)\s+(.*\S)\s*$/.exec(line);
    if (match === null) continue;
    const cpuSeconds = parseCpuTime(match[3]);
    if (cpuSeconds === null) continue;
    rows.push({
      pid: Number(match[1]),
      ppid: Number(match[2]),
      cpuSeconds,
      comm: match[4] ?? "",
    });
  }
  return rows;
}

/**
 * SELF-MATCH SAFETY — a hard requirement, not a nicety
 * (`foundation.testing.guideline` §Teststufen: "Ein vorgeschalteter Load-Guard
 * muss self-match-sicher sein — der naive Guard zählt sich selbst in der
 * Prozessliste"). A gate whose own workers count as "foreign load" would
 * declare every run saturated and therefore every red run unprovable — worse
 * than the bug it fixes.
 *
 * The guard is structural rather than a list of process names: everything BELOW
 * us in the tree (the phase command, its children) and everything ABOVE us
 * (npm, the shell, the agent, the terminal) is OURS. A name allowlist would rot
 * the moment the toolchain adds a binary; the tree cannot.
 */
export function ownProcessIds(rows: readonly ProcessRow[], selfPid: number): Set<number> {
  const byPid = new Map(rows.map((row) => [row.pid, row]));
  const children = new Map<number, number[]>();
  for (const row of rows) {
    const siblings = children.get(row.ppid);
    if (siblings === undefined) children.set(row.ppid, [row.pid]);
    else siblings.push(row.pid);
  }

  const own = new Set<number>([selfPid]);
  const queue = [selfPid];
  while (queue.length > 0) {
    const next = queue.pop() as number;
    for (const kid of children.get(next) ?? []) {
      if (own.has(kid)) continue; // defensive: a malformed table must not loop forever
      own.add(kid);
      queue.push(kid);
    }
  }

  let up = byPid.get(selfPid)?.ppid;
  while (up !== undefined && up > 0 && !own.has(up)) {
    own.add(up);
    up = byPid.get(up)?.ppid;
  }
  return own;
}

/**
 * How much of the box each FOREIGN process actually took while we ran, busiest
 * first.
 *
 * `share` is CPU-seconds consumed between the first and last sighting of that
 * pid, over the WHOLE run window — so 100 means "one full core for the entire
 * run", 50 means "half a core throughout, or a full core for half of it".
 * Dividing by the whole window rather than by the pid's own observed lifetime
 * is the honest choice: a process that hogged a core for the last 10 s of a
 * 5-minute run interfered with 3 % of that run, not with 100 % of it.
 *
 * A process that appears mid-run is counted from its first sighting, so an
 * installation that starts after the gate does is still seen; one that dies
 * mid-run keeps the work it did before it went.
 */
export function foreignCpuShares({
  first,
  last,
  ownPids,
  wallSeconds,
  minShare = FOREIGN_NOISE_PCPU,
}: {
  first: ReadonlyMap<number, CpuSample>;
  last: ReadonlyMap<number, CpuSample>;
  ownPids: ReadonlySet<number>;
  wallSeconds: number;
  minShare?: number;
}): ForeignShare[] {
  if (!(wallSeconds >= MIN_HOG_WINDOW_S)) return [];
  const out: ForeignShare[] = [];
  for (const [pid, end] of last) {
    if (ownPids.has(pid)) continue;
    const start = first.get(pid);
    if (start === undefined) continue;
    const share = ((end.cpuSeconds - start.cpuSeconds) / wallSeconds) * 100;
    if (share >= minShare) out.push({ pid, comm: end.comm ?? start.comm ?? "", share });
  }
  return out.sort((a, b) => b.share - a.share);
}

/**
 * The mirror image of `foreignCpuShares`: how many cores OUR OWN processes
 * actually managed to use across the run. Same differencing, same window rule;
 * only the pid filter flips.
 */
export function ownCpuCores({
  first,
  last,
  ownPids,
  wallSeconds,
}: {
  first: ReadonlyMap<number, CpuSample>;
  last: ReadonlyMap<number, CpuSample>;
  ownPids: ReadonlySet<number>;
  wallSeconds: number;
}): number {
  if (!(wallSeconds > 0)) return 0;
  let cpuSeconds = 0;
  for (const [pid, end] of last) {
    if (!ownPids.has(pid)) continue;
    const start = first.get(pid);
    // A pid first seen at its last sighting contributes its whole accumulated
    // time: it is a worker that lived entirely between two samples, and
    // dropping it would understate our usage.
    cpuSeconds += start === undefined ? end.cpuSeconds : end.cpuSeconds - start.cpuSeconds;
  }
  return cpuSeconds / wallSeconds;
}

/** Shortens a path to the binary name for readable output. */
export function shortComm(comm: string | null | undefined): string {
  const base = String(comm ?? "")
    .split("/")
    .pop();
  return base !== undefined && base !== "" ? base : String(comm ?? "");
}

/**
 * The verdict on the machine, from three INDEPENDENT signals, because they
 * catch different things:
 *   • baseline — the load averages sampled BEFORE we spawn anything, so they
 *     are purely foreign. Catches "the box was already busy". During the run
 *     this measure is useless: our own workers legitimately drive the load up,
 *     and a load average cannot be decomposed by owner.
 *   • hogs — foreign processes sampled DURING the run. Catches the case that
 *     actually happened: the box was quiet at the start and an installation
 *     began mid-run.
 *   • ownCores — whether WE got to compute at all.
 *
 * The first two are **load-bearing**: each is independent evidence that the box
 * was busy. `ownCores` is only **supporting**, and that distinction is the whole
 * point of this function.
 *
 * Low own-CPU has two causes that CPU numbers cannot tell apart: we were pushed
 * aside, or we sat waiting on I/O. A merge profile full of E2E lanes, database
 * integration tests and browser runs is I/O-bound by nature — there, low
 * `ownCores` is the normal case, not a symptom. Measured on an idle 16-core box
 * (~5 % total load): 0.16 own cores, and the old code called that SATURATED.
 *
 * Getting this wrong is not symmetric. A machine problem misreported as a defect
 * costs one fruitless investigation. A defect excused as a machine problem stays
 * invisible while the loop retries it forever — and a hanging test produces
 * timeouts AND low own-CPU, so it looks exactly like starvation. That nearly
 * happened: `production-cockpit#776` hangs 900 s in `db.destroy()` and was only
 * called a defect because a real assertion failure happened to sit beside it.
 *
 * Therefore: starvation alone never turns a red into "unprovable". It can only
 * corroborate a saturation that another signal already established.
 */
export function assessSaturation({
  baseline,
  ncpu,
  hogs = [],
  ownCores,
  wallSeconds = 0,
}: {
  baseline: LoadAverages | null;
  ncpu: number;
  hogs?: readonly ForeignShare[];
  ownCores?: number;
  wallSeconds?: number;
}): { saturated: boolean; reasons: string[]; starvedOnly: boolean } {
  /** Independent evidence the box was busy. Any one of these carries the verdict. */
  const bearing: string[] = [];
  /** Symptoms that prove nothing on their own. */
  const supporting: string[] = [];

  // The starvation signal, checked over the same window as the hog shares:
  // below it our own start-up cost dominates and the ratio says nothing.
  if (
    typeof ownCores === "number" &&
    ncpu >= STARVATION_MIN_NCPU &&
    wallSeconds >= MIN_HOG_WINDOW_S &&
    ownCores < STARVED_OWN_CORES
  ) {
    supporting.push(
      `the run itself barely computed: ${ownCores.toFixed(2)} cores over ` +
        `${wallSeconds.toFixed(0)} s (< ${STARVED_OWN_CORES.toFixed(2)}) on ${ncpu} available ` +
        `cores — it waited rather than ran. On its own this says nothing: waiting on I/O ` +
        `looks identical to being pushed aside`,
    );
  }

  if (baseline !== null && ncpu > 0) {
    const worst = Math.max(baseline.load5, baseline.load15);
    const perCore = worst / ncpu;
    if (perCore >= SATURATED_LOAD_PER_CORE) {
      bearing.push(
        `baseline load before the run ${worst.toFixed(2)} on ${ncpu} cores = ` +
          `${perCore.toFixed(2)}/core (>= ${SATURATED_LOAD_PER_CORE.toFixed(2)}) — the box was ` +
          `already full before the first phase started`,
      );
    }
  }

  const foreignCores = hogs.reduce((sum, hog) => sum + hog.share, 0) / 100;
  if (ncpu > 0 && foreignCores / ncpu >= FOREIGN_SATURATION_FRACTION) {
    const named = hogs
      .filter((hog) => hog.share >= FOREIGN_REPORT_PCPU)
      .map((hog) => `${shortComm(hog.comm)} (pid ${hog.pid}) ${hog.share.toFixed(0)} %`)
      .join(", ");
    bearing.push(
      `foreign processes took ${foreignCores.toFixed(1)} of ${ncpu} cores across the run ` +
        `(${((foreignCores / ncpu) * 100).toFixed(0)} % of the box, threshold ` +
        `${(FOREIGN_SATURATION_FRACTION * 100).toFixed(0)} %)${named === "" ? "" : ` — above all ${named}`}`,
    );
  }

  // `reasons` still carries everything observed — the log must show the
  // starvation note even when it did not carry the verdict, or a later reader
  // cannot tell a quiet box from an unexamined one.
  return {
    saturated: bearing.length > 0,
    reasons: [...bearing, ...supporting],
    starvedOnly: bearing.length === 0 && supporting.length > 0,
  };
}

// ---- FAILURE CLASSIFICATION -----------------------------------------------
// An assertion failure and a worker timeout are different STATES and must not
// look the same in the report. These patterns match how a runner ABORTS, never
// what a test asserts:
//   "Test timed out in 10000ms."   — testTimeout hit
//   "Hook timed out in 60000ms."   — a hook hit hookTimeout
//   "Timeout calling <rpc>"        — the worker RPC channel gave up
//   "Vitest worker terminated"     — the worker died outright
// Everything else — including a test that asserts on a timeout it produced
// itself — is CONTENT.
export const TIMEOUT_PATTERNS: readonly RegExp[] = [
  /\btimed out in\b/i,
  /\btimeout calling\b/i,
  /worker\b[^.\n]*\b(terminated|exited|closed)\b/i,
  /\bterminating worker thread\b/i,
];

export function isTimeoutFailure(messages: string | readonly (string | undefined)[]): boolean {
  const all = (Array.isArray(messages) ? messages : [messages]).filter(Boolean).join("\n");
  return TIMEOUT_PATTERNS.some((pattern) => pattern.test(all));
}

// A cause that belongs to the network rather than to the code (spec §4,
// `DECISION (infra-is-not-the-code)`). The list is CLOSED at four entries and
// takes no configuration: unlike the timeout patterns, this rule turns a
// REPORTED cause into an excuse, so every widening is a defect waiting to be
// excused — and it would grow exactly where the pressure to be green is
// highest. A fifth signature costs a spec bump and a measurement.
export const TRANSIENT_PATTERNS: readonly RegExp[] = [
  /\bECONNRESET\b/,
  /\bEPIPE\b/,
  /\bETIMEDOUT\b/,
  /\bsocket hang up\b/i,
];

// A line carrying the signature inside an ASSERTION is a test about network
// behaviour — the normal case in the repos this rule serves — and stays a
// defect. Unlike everywhere else in this file, erring toward "cause" is the
// safe direction here: it costs a re-run demanded as a diagnosis, while the
// other direction excuses a real bug.
const ASSERTION_SHAPE = /\bassert\w*|\bexpected\b/i;

/**
 * Tested per line, not over the joined blob: the assertion guard only means
 * anything next to the signature it qualifies. A blob would let an unrelated
 * `expected` three lines down disarm the guard, or an unrelated `ECONNRESET`
 * arm it.
 */
export function isTransientFailure(messages: string | readonly (string | undefined)[]): boolean {
  const lines = (Array.isArray(messages) ? messages : [messages]).filter(
    (line): line is string => typeof line === "string" && line !== "",
  );
  return lines.some(
    (line) =>
      TRANSIENT_PATTERNS.some((pattern) => pattern.test(line)) && !ASSERTION_SHAPE.test(line),
  );
}

/** One reported failure, as the gate reads it out of a phase's output. */
export interface ReportedFailure {
  messages: string[];
}

/**
 * Splits the reported failures into the three states. A failure carrying a
 * content error BESIDE a timeout or a transient signature counts as CONTENT: a
 * real defect must never be explainable away by something coincidental next to
 * it. A failure with no message at all is content too — unexplained is not
 * excusable.
 *
 * Transient beats timeout when a failure carries both, because the two reach
 * exit 2 by different routes: the timeout route asks whether the box was
 * saturated, the transient one does not. A reset connection that also produced
 * a timeout is still the network, on a quiet box as much as on a busy one.
 */
export function classifyFailures<T extends ReportedFailure>(
  failures: readonly T[] = [],
): { timeout: T[]; transient: T[]; content: T[] } {
  const timeout: T[] = [];
  const transient: T[] = [];
  const content: T[] = [];
  for (const failure of failures) {
    const messages = failure.messages ?? [];
    const unexplained = messages.filter(
      (message) => !isTimeoutFailure(message) && !isTransientFailure(message),
    );
    if (messages.length === 0 || unexplained.length > 0) content.push(failure);
    else if (messages.some((message) => isTransientFailure(message))) transient.push(failure);
    else timeout.push(failure);
  }
  return { timeout, transient, content };
}

// ---- THE VERDICT (three classes, deliberately not two) --------------------

/**
 * The single rule that makes the fuzzy edge of a load threshold safe: saturation
 * NEVER turns a red into a green and NEVER touches a content failure. It only
 * decides whether a TIMEOUT-ONLY red is reported as "broken" (1) or as
 * "unprovable" (2). The worst a misjudged threshold can cost is one re-run on a
 * quiet box — never a silently swallowed defect.
 */
export function verdict({
  contentFailures = 0,
  timeoutFailures = 0,
  transientFailures = 0,
  saturated = false,
  runnerFailed = false,
  failingFiles,
}: {
  contentFailures?: number;
  timeoutFailures?: number;
  /**
   * Failures whose only cause is a transient infrastructure signature. They
   * reach exit 2 WITHOUT consulting the load — see the branch below.
   */
  transientFailures?: number;
  saturated?: boolean;
  runnerFailed?: boolean;
  /**
   * Distinct files the failures are spread across. Omitted when the runner's
   * output does not name files — then the distribution says nothing and the
   * verdict falls back to the saturation signal alone.
   */
  failingFiles?: number;
}): 0 | 1 | 2 {
  if (contentFailures > 0) return 1;
  // Infrastructure named the cause, and it was not the code. The load is not
  // consulted: a connection the network reset does not become a defect because
  // the box happened to be quiet (spec §4, `DECISION (infra-is-not-the-code)`).
  // This is also why exit 2 on a quiet box identifies this route uniquely.
  if (transientFailures > 0) return 2;
  if (timeoutFailures > 0 || runnerFailed) {
    if (!saturated) return 1;
    // A busy box slows EVERYTHING; it does not pick one file and hang it. So a
    // timeout-only red confined to a single file is a hang — a defect — no
    // matter how loaded the machine was. Both signatures otherwise look the
    // same, and excusing a hang is the expensive mistake: the loop retries it
    // forever and nobody ever diagnoses it.
    if (failingFiles !== undefined && failingFiles > 0 && failingFiles < SCATTERED_MIN_FILES) {
      return 1;
    }
    return 2;
  }
  return 0;
}
