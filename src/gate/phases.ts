/**
 * Running one gate phase and reading its failure (spec §7.1).
 *
 * A phase is an opaque shell command, so the gate cannot ask a reporter what
 * broke — it has to read the output. The rule ported from the reference gate
 * survives that translation intact: a failure counts as an abort only when
 * EVERYTHING it reported is an abort. Anything else is content, and content is
 * never explained away by load.
 *
 * Both directions of doubt therefore land on exit 1 ("broken"), never on exit 2
 * ("unprovable"): an unreadable failure is a finding, not an excuse.
 */

import { spawn } from "node:child_process";
import { EXIT, type ExitCode } from "../output.js";
import { classifyFailures, verdict, type ReportedFailure } from "./saturation.js";

export interface PhaseOutcome {
  /** Exit code of the phase command; 1 when it died without one. */
  code: number;
  /** Set when the process was killed outright — the runner died, it did not fail. */
  signal: NodeJS.Signals | null;
  /** stdout and stderr, interleaved as they arrived. Goes to the log, never to stdout. */
  output: string;
}

/** Runs one phase command through the shell, capturing everything it writes. */
export function runPhase(cmd: string, cwd: string): Promise<PhaseOutcome> {
  return new Promise((resolve) => {
    const chunks: string[] = [];
    let settled = false;
    const finish = (code: number, signal: NodeJS.Signals | null): void => {
      if (settled) return;
      settled = true;
      resolve({ code, signal, output: chunks.join("") });
    };

    // stdin is /dev/null, never a pipe: a gate run is not interactive, so a
    // phase that reads stdin has nobody to wait for. Left as an open pipe it
    // waits anyway — `node scripts/guard-secrets.mjs` hung ten minutes without
    // a line of output, and a hang without a timeout is the worst exit there
    // is: it looks exactly like "still running".
    const child = spawn(cmd, {
      cwd,
      shell: true,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => chunks.push(chunk));
    child.stderr.on("data", (chunk: string) => chunks.push(chunk));
    child.on("error", (error: Error) => {
      chunks.push(`spec-sync: phase could not run: ${error.message}\n`);
      finish(127, null);
    });
    child.on("close", (code, signal) => finish(code ?? 1, signal));
  });
}

/**
 * Lines that NAME a failing item without saying why: `FAIL src/a.test.ts`,
 * `× adds up`, `1) [chromium] › login.spec.ts`. The reference gate never saw
 * these — it read structured failures whose `messages` were causes only. Read
 * as a message, a header like `FAIL src/slow.test.ts` counts as content simply
 * because the word "FAIL" is not the word "timeout", and exit 2 becomes
 * unreachable for every runner that prints one.
 */
const FAILURE_HEADER = /^(?:FAIL\b|FAILED\b|[✗×✘]|\d+\)\s)/i;

/**
 * Lines in which the RUNNER talks about the run instead of about a cause: its
 * summary counters (`Test Files  1 failed (1)`, `Tests  1 failed (1)`) and the
 * advice it appends to a timeout (`If this is a long-running test, ...`).
 *
 * The same failure as the header, one step worse: vitest prints BOTH on every
 * red run, so for that runner the content of a failure was never timeout-only
 * and exit 2 was unreachable — measured per line, not inferred
 * (`production-cockpit/worklogs/773-exit2-evidence.md`, cases E4/E5). A counter
 * says how MANY failed and never why; advice is the runner talking about
 * itself. The reference gate never had to exclude either: it read a failure's
 * `messages`, where the advice arrives glued to the timeout it belongs to and
 * the counters do not appear at all.
 */
const RUNNER_NOISE = /^(?:(?:Test Files|Tests|Snapshots)\s+\d|If this is a long-running test\b)/i;

/**
 * Lines that state a CAUSE — the analogue of a reported failure's `messages`.
 * Deliberately generous: a line too many costs at most a verdict of "broken"
 * where "unprovable" would also have been defensible, while a line missed could
 * turn a real defect into an excuse.
 */
const FAILURE_MESSAGE =
  /\w*(?:error|exception|assertion)\w*|\bfail(?:ed|ing|ure|ures|s)?\b|\btimed out\b|\btimeout\b|\bterminated\b|\bcannot\b|\bnot found\b|\bexpected\b/i;

/**
 * The failing phase's output read as the causes it reported, one per line.
 * Empty means the phase failed without saying anything legible about why.
 */
export function failureMessages(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) =>
        line !== "" &&
        !FAILURE_HEADER.test(line) &&
        !RUNNER_NOISE.test(line) &&
        FAILURE_MESSAGE.test(line),
    );
}

/**
 * The exit code a failed phase earns: 1 on the merits, or 2 when a timeout-only
 * red met a saturated box (spec §4, `DECISION (exit-2-inherited)`).
 */
export function phaseExit({
  output,
  signal,
  saturated,
}: {
  output: string;
  signal: NodeJS.Signals | null;
  saturated: boolean;
}): ExitCode {
  const messages = failureMessages(output);
  const runnerFailed = signal !== null;

  // Nothing legible about the cause: a process killed outright is the RUNNER
  // dying — the signature of a box that took itself away — while any other
  // silent non-zero exit is content, because unexplained is not excusable.
  const result =
    messages.length === 0
      ? verdict({ contentFailures: runnerFailed ? 0 : 1, runnerFailed, saturated })
      : verdictOf(messages, runnerFailed, saturated);

  return result === 2 ? EXIT.UNPROVABLE : EXIT.FAILED;
}

function verdictOf(
  messages: readonly string[],
  runnerFailed: boolean,
  saturated: boolean,
): 0 | 1 | 2 {
  const failures: ReportedFailure[] = messages.map((message) => ({ messages: [message] }));
  const { timeout, content } = classifyFailures(failures);
  return verdict({
    contentFailures: content.length,
    timeoutFailures: timeout.length,
    runnerFailed,
    saturated,
  });
}
