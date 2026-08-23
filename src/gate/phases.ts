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
import { truncateLine } from "../logs.js";
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
 * `× adds up`, `1) [chromium] › login.spec.ts`, `❯ src/slow.test.ts`. The
 * reference gate never saw these — it read structured failures whose `messages`
 * were causes only. Read as a message, a header like `FAIL src/slow.test.ts`
 * counts as content simply because the word "FAIL" is not the word "timeout",
 * and exit 2 becomes unreachable for every runner that prints one.
 *
 * The last arm is the lesson of `production-cockpit#773`: enumerating bullets
 * (`✗ × ✘`) means every runner that picks a glyph we did not list leaks its
 * headers back in as causes — vitest's `❯` did exactly that. One decoration
 * glyph followed by whitespace is the SHAPE of a bullet, whichever glyph the
 * next release picks.
 */
const FAILURE_HEADER = /^(?:FAIL\b|FAILED\b|[✗×✘]|\d+\)\s|[^\w\s]\s)/i;

/**
 * A run of three or more identical NON-ASCII frame glyphs: `⎯⎯⎯`, `───`, `═══`.
 *
 * Runners draw banners around their summary blocks — vitest's
 * `⎯⎯⎯ Failed Tests 1 ⎯⎯⎯` carries the word "Failed" and so read as a cause on
 * every red run, which is the second half of why exit 2 was unreachable
 * (`production-cockpit/worklogs/773-exit2-evidence.md`). A banner is a shape,
 * not a vocabulary, so this needs no update when a runner changes its glyph.
 * Restricted to non-ASCII so that `...` in a truncated assertion and `///` in a
 * file URL stay causes — dropping one of those would be the dangerous
 * direction, a defect excused as noise.
 */
const FRAME_RUN = /([^\w\s\x20-\x7E])\1{2,}/u;

/** The source file a failure header names, e.g. ` FAIL  src/routes/llm.test.ts > …`. */
const HEADER_FILE = /(\S+\.(?:m|c)?[jt]sx?)\b/;

/**
 * How many distinct files the failures are spread across.
 *
 * This is the signal that tells a HANG from a SLOW BOX, and no CPU number can:
 * a hanging test times out in **one** file while everything else passes, whereas
 * a box under load times out **scattered** across many. Both produce timeouts and
 * near-zero own CPU, so without this they are indistinguishable — which is how a
 * real hang gets excused as a machine problem.
 */
export function failingFiles(output: string): string[] {
  const files = new Set<string>();
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (!FAILURE_HEADER.test(line)) continue;
    const match = HEADER_FILE.exec(line);
    if (match?.[1] !== undefined) files.add(match[1]);
  }
  return [...files];
}

/**
 * The runner's SUMMARY ROWS — the aligned label/value block it prints under a
 * finished run: `Test Files  1 failed (1)`, `Tests  1 failed (1)`,
 * `Snapshots  1 failed`, `Errors  1 error`.
 *
 * The same failure as the header, one step worse: vitest prints these on EVERY
 * red run, so for that runner the content of a failure was never timeout-only
 * and exit 2 was unreachable — measured per line, not inferred
 * (`production-cockpit/worklogs/773-exit2-evidence.md`, cases E4/E5). A counter
 * says how MANY failed and never why. The reference gate never had to exclude
 * them: it read a failure's `messages`, where counters do not appear at all.
 *
 * Matched by the SHAPE of the block rather than by the labels in it — a short
 * capitalised label, the column gutter of two or more spaces, then a number.
 * The three names this used to enumerate were the bug: vitest's unhandled-error
 * run adds a fourth row, `Errors  1 error`, and a list buys exactly one runner
 * release of quiet (spec §4, `DECISION (decoration-is-not-a-cause)`). A cause
 * never has this shape: every diagnostic measured across the five runners of
 * the phase lists breaks the label at a colon (`AssertionError: …`,
 * `Serialized Error: { … }`) or opens with a position or a path.
 *
 * The second arm is the PER-FILE counter, `(1 test | 1 failed)`, which vitest
 * appends to every file it summarises. It is the same species as the totals
 * above, so it is excluded for the same reason — and matched by its shape, a
 * parenthesised test count, rather than by the words around it. `(12,3)` in a
 * tsc diagnostic has no `test` in it and stays a cause.
 */
const RUNNER_NOISE = /^[A-Z][A-Za-z ]{0,14}\s{2,}\d|\(\d+\s+tests?\b[^)]*\)/i;

/**
 * Lines that state a CAUSE — the analogue of a reported failure's `messages`.
 * Deliberately generous: a line too many costs at most a verdict of "broken"
 * where "unprovable" would also have been defensible, while a line missed could
 * turn a real defect into an excuse.
 */
const FAILURE_MESSAGE =
  /\w*(?:error|exception|assertion)\w*|\bfail(?:ed|ing|ure|ures|s)?\b|\btimed out\b|\btimeout\b|\bterminated\b|\bcannot\b|\bnot found\b|\bexpected\b/i;

/**
 * Spans a line QUOTES instead of naming: `"src/upload.test.ts"`, `` `--flag` ``.
 *
 * Only double quotes and backticks, and that is a measurement rather than a
 * simplification: prose puts the artifact it talks ABOUT in double quotes
 * (`This error originated in "src/upload.test.ts"`), while tsc and eslint name
 * the identifier a diagnostic is about in SINGLE quotes (`Type 'string' is not
 * assignable`, `'unused' is assigned a value but never used`). Removing single
 * quotes too would strip a diagnostic of the very token that marks it as one.
 */
const QUOTED_SPAN = /"[^"]*"|`[^`]*`/g;

/**
 * An ordinary English word — letters with an internal apostrophe or hyphen
 * (`doesn't`, `might've`, `long-running`) or a bare number — with sentence
 * punctuation allowed to hang off the end. Anything else is a symbol token: a
 * colon head, a path, a position, a bracket, an operator, an identifier glued
 * to digits.
 */
const PROSE_WORD = /^(?:[A-Za-z]+(?:['’-][A-Za-z]+)*|\d+)[.,;:!?]*$/;

/** What a removed quoted span leaves behind, e.g. the lone `.` in `… is  .`. */
const PUNCTUATION_ONLY = /^[.,;:!?()'"-]+$/;

/**
 * Shortest sentence measured across the five runners of the phase lists
 * (vitest, tsc, eslint, prettier, playwright): vitest's
 * `Vitest caught 1 unhandled error during the test run.`, nine words. Set AT
 * the measurement rather than below it, because the two errors do not cost the
 * same: a shorter runner sentence that escapes costs a "broken" where
 * "unprovable" was also defensible, while a short diagnostic swallowed here
 * turns a defect into an excuse. `Module not found` must stay a cause.
 */
const PROSE_MIN_WORDS = 9;

/**
 * The RUNNER TALKING ABOUT ITS OWN FAILURE — the third species of decoration
 * (spec §4, `DECISION (decoration-is-not-a-cause)`), after the header and the
 * banner. vitest reports an `ECONNRESET` from a socket as an *Unhandled Error*
 * and prints four sentences around it (`Vitest caught 1 unhandled error during
 * the test run.` · `This might cause false positive tests. …` · `This error
 * originated in "…"` · `The latest test that might've caused the error is
 * "…"`). Read as causes they are four content failures against one transient
 * signature, and the run lands on exit 1 with nothing broken — measured against
 * v0.5.0, `community-platform` 2026-07-27, question #150.
 *
 * Grouping those lines onto one failure would not help: a failure counts as
 * content the moment ANY of its messages is unexplained. The prose has to stop
 * counting as a cause at all.
 *
 * The shape, measured against real output from all five runners rather than
 * derived:
 *
 *   • Once its quoted spans are removed, every token is an ordinary English
 *     word. Diagnostics NAME things, and naming costs a symbol token — a path,
 *     a position, a colon head, a quoted identifier, `2000ms`, `no-console`.
 *     Not one of the causes measured across the five runners is free of them.
 *   • It runs to at least `PROSE_MIN_WORDS` words. Diagnostics are short;
 *     narration is not.
 *   • Its cause word is NOT the first token. A diagnostic leads with its cause
 *     (`Error: read ECONNRESET`, `Cannot find module`, prettier's `Error
 *     occurred when checking code style …`); prose buries it inside a sentence
 *     about the run (`caught 1 unhandled error`, `might've caused the error`).
 *
 * The deliberate non-rule is the one already measured and rejected: "a cause
 * carries an error-type head (`Error:`, `AssertionError:`)" throws out eslint's
 * `12:5  error  Unexpected console statement  no-console` with the prose, and
 * excusing a real defect is the expensive direction here.
 */
export function isRunnerProse(line: string): boolean {
  const words = line
    .replace(QUOTED_SPAN, " ")
    .split(/\s+/)
    .filter((word) => word !== "" && !PUNCTUATION_ONLY.test(word));
  if (words.length < PROSE_MIN_WORDS) return false;
  if (!words.every((word) => PROSE_WORD.test(word))) return false;
  return !FAILURE_MESSAGE.test(words[0] ?? "");
}

/** One line of the output read as a CAUSE — see the four exclusions above. */
function isFailureCause(line: string): boolean {
  return (
    line !== "" &&
    !FAILURE_HEADER.test(line) &&
    !RUNNER_NOISE.test(line) &&
    !FRAME_RUN.test(line) &&
    !isRunnerProse(line) &&
    FAILURE_MESSAGE.test(line)
  );
}

/**
 * The failing phase's output read as the causes it reported, one per line.
 * Empty means the phase failed without saying anything legible about why.
 */
export function failureMessages(output: string): string[] {
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(isFailureCause);
}

/**
 * How a runner LISTS a failing test: vitest's and jest's `FAIL <file> > <test>`
 * in the "Failed Tests" block, playwright's and mocha's numbered
 * `1) <file> › <test>`.
 *
 * Narrower than `FAILURE_HEADER` on purpose. That one asks "does this line name
 * something that failed", which every progress bullet does; this one asks "is
 * this the runner's VERDICT LIST", and only an entry of that list may point the
 * triage at a test.
 */
const REPORTED_FAILURE = /^(?:FAIL(?:ED)?\b|\d+\)\s)/;

/** The frame a runner draws behind a list entry: `1) login.spec.js › … ─────`. */
const TRAILING_FRAME = /\s*([^\w\s\x20-\x7E])\1{2,}\s*$/u;

/**
 * The failing TEST as the runner reported it — file, test name and the cause
 * below it — or `undefined` where the output lists no failing test at all.
 *
 * This is the answer to `#10`: `firstError` scans the log for the first
 * error-shaped line, and in a repo whose negative-path tests assert on error
 * MESSAGES that line belongs to a test that PASSED. The measured incident
 * (community-platform #497) pointed the triage at `bookingWebhook.test.ts`,
 * ~50.000 log lines away from the failure in `webinarSync.test.ts`, and a wrong
 * pointer is worse than none because it is trusted.
 *
 * A phase is an opaque shell command, so there is no reporter to ask (see the
 * module header): the verdict list the runner prints is the closest thing to
 * one, and reading only THAT is what separates this from a log grep. Two lines,
 * because that is what the ticket asks for — the header carries file and test
 * name, the first cause under it carries the assertion.
 */
export function reportedFailure(output: string): string | undefined {
  const lines = output.split("\n").map((line) => line.trim());
  const index = lines.findIndex((line) => REPORTED_FAILURE.test(line));
  if (index === -1) return undefined;

  const header = truncateLine((lines[index] as string).replace(TRAILING_FRAME, ""));
  const cause = lines.slice(index + 1).find(isFailureCause);
  return cause === undefined ? header : `${header}\n${truncateLine(cause)}`;
}

/**
 * The exit code a failed phase earns: 1 on the merits, or 2 by one of the two
 * routes to "unprovable" (spec §4, `DECISION (exit-2-inherited)`) — a
 * timeout-only red that met a saturated box, or a red whose only cause is a
 * transient infrastructure signature, which does not consult the load at all.
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
      : verdictOf(messages, runnerFailed, saturated, failingFiles(output).length);

  return result === 2 ? EXIT.UNPROVABLE : EXIT.FAILED;
}

function verdictOf(
  messages: readonly string[],
  runnerFailed: boolean,
  saturated: boolean,
  failingFileCount: number,
): 0 | 1 | 2 {
  const failures: ReportedFailure[] = messages.map((message) => ({ messages: [message] }));
  const { timeout, transient, content } = classifyFailures(failures);
  return verdict({
    contentFailures: content.length,
    timeoutFailures: timeout.length,
    transientFailures: transient.length,
    runnerFailed,
    saturated,
    // Only meaningful once content failures are ruled out — then every failing
    // file is a timeout file.
    failingFiles: failingFileCount,
  });
}
