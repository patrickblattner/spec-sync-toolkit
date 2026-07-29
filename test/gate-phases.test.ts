/**
 * Running a phase and reading its failure (spec §7.1, §4).
 *
 * The verdict rule survives the translation from "a reporter's failure list" to
 * "an opaque command's output": saturation only ever decides whether a
 * TIMEOUT-ONLY red reads as broken (1) or unprovable (2), and never touches a
 * content failure.
 */

import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { failingFiles, failureMessages, phaseExit, runPhase } from "../src/gate/phases.js";
import { EXIT } from "../src/output.js";

const cwd = (): string => mkdtempSync(join(tmpdir(), "spec-sync-phase-"));

/** Real output of a real runner, captured under `test/fixtures/runners/`. */
const fixture = (name: string): string =>
  readFileSync(new URL(`./fixtures/runners/${name}.txt`, import.meta.url), "utf8");

describe("runPhase", () => {
  it("reports a green command with its exit code and no signal", async () => {
    const outcome = await runPhase("exit 0", cwd());
    expect(outcome).toEqual({ code: 0, signal: null, output: "" });
  });

  it("captures stdout AND stderr — everything the log needs, nothing on our stdout", async () => {
    const outcome = await runPhase("echo out; echo err >&2; exit 3", cwd());
    expect(outcome.code).toBe(3);
    expect(outcome.output).toContain("out");
    expect(outcome.output).toContain("err");
  });

  it("survives a command that cannot run at all", async () => {
    const outcome = await runPhase("definitely-not-a-command-42", cwd());
    expect(outcome.code).not.toBe(0);
  });

  it("reports the signal when the command is killed outright", async () => {
    const outcome = await runPhase("kill -9 $$", cwd());
    expect(outcome.signal).toBe("SIGKILL");
  });

  it("gives a phase no stdin to wait on — a gate run is not interactive", async () => {
    // A phase that reads stdin waits for an EOF that an open pipe never
    // delivers, and the runner has no timeout: `guard-secrets.mjs` hung ten
    // minutes without a line of output. The self-kill after 3 s is what keeps
    // THIS test a matter of seconds instead of the hang it is about to prove —
    // the read must be async for the timer to survive it.
    const readsStdin =
      `"${process.execPath}" -e "process.stdin.resume();` +
      `process.stdin.on('end', () => process.exit(0));` +
      `setTimeout(() => process.exit(9), 3000)"`;
    const outcome = await runPhase(readsStdin, cwd());
    expect(outcome.signal).toBe(null);
    expect(outcome.code).toBe(0);
  });
});

describe("failureMessages", () => {
  it("picks the lines that state a CAUSE and ignores the noise around them", () => {
    const output = [
      "> npm test",
      "",
      "✓ src/a.test.ts (12 tests)",
      "FAIL src/b.test.ts > adds up",
      "AssertionError: expected 1 to be 2",
    ].join("\n");
    // The `FAIL <file>` header names the failing item; it says nothing about
    // why, so it is not a message. Reading it as one would make every runner
    // that prints such a header report content, and exit 2 unreachable.
    expect(failureMessages(output)).toEqual(["AssertionError: expected 1 to be 2"]);
  });

  it("finds nothing in output that reports nothing", () => {
    expect(failureMessages("all good\n42 passed\n")).toEqual([]);
  });

  it("ignores the runner's own counters and advice — they say how many, never why", () => {
    // Every one of these lines carries a word from FAILURE_MESSAGE, and vitest
    // prints them on EVERY red run. Read as causes, they make the content of a
    // timeout-only failure permanently non-empty.
    const output = [
      " Test Files  1 failed (1)",
      "      Tests  1 failed | 2 passed (3)",
      "  Snapshots  1 failed",
      'If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".',
    ].join("\n");
    expect(failureMessages(output)).toEqual([]);
  });
});

describe("failureMessages — vitest's own decoration (production-cockpit#773/#132)", () => {
  // Measured, not invented: three runs under `8x yes`, own cores 0.07, box
  // triply corroborated as saturated — and still exit 1, because these two
  // lines appear on EVERY red vitest run and both carry the word "failed".
  // v0.1.1 excluded the totals and the advice line but not these, so the
  // content of a timeout-only failure was never empty and exit 2 stayed
  // unreachable for the one runner every repo here uses.
  it("ignores the per-file summary, whatever glyph the runner bullets it with", () => {
    expect(failureMessages("❯ src/slow.test.ts (1 test | 1 failed) 35005ms")).toEqual([]);
  });

  it("ignores the banner drawn around the summary block", () => {
    expect(failureMessages("⎯⎯⎯⎯⎯⎯⎯⎯ Failed Tests 1 ⎯⎯⎯⎯⎯⎯⎯⎯")).toEqual([]);
  });

  // The guard rail for the fix itself. Excluding noise is only safe as long as
  // it cannot reach a cause: a line dropped here turns a defect into an excuse,
  // which is the one direction this gate must never fail in. Both shapes below
  // are ASCII runs that look like frames and are not.
  it("keeps causes that merely LOOK framed — the dangerous direction", () => {
    expect(failureMessages('AssertionError: expected "aaa..." to be "bbb"')).toHaveLength(1);
    expect(failureMessages("Error: cannot resolve file:///src/a.ts")).toHaveLength(1);
  });

  it("keeps a tsc diagnostic — its (12,3) is a position, not a test count", () => {
    expect(failureMessages("src/a.ts(12,3): error TS2345: Argument of type 'x'")).toHaveLength(1);
  });
});

describe("phaseExit — 1 on the merits, 2 unprovable (spec §4, exit-2-inherited)", () => {
  // Scattered across files — what a slow box actually looks like. A box under
  // load delays everything; it does not single out one file. The single-file
  // shape is the HANG signature and has its own cases below.
  const timeoutOnly =
    "FAIL src/slow.test.ts\nTest timed out in 10000ms.\n" +
    "FAIL src/other.test.ts\nTest timed out in 10000ms.\n";
  const timeoutOneFile = "FAIL src/slow.test.ts\nTest timed out in 10000ms.\n";
  const contentOut = "FAIL src/a.test.ts\nAssertionError: expected 1 to be 2\n";

  it("a content failure is RED even on a saturated box — load never excuses a defect", () => {
    expect(phaseExit({ output: contentOut, signal: null, saturated: true })).toBe(EXIT.FAILED);
  });

  it("timeouts on a QUIET box are a real finding", () => {
    expect(phaseExit({ output: timeoutOnly, signal: null, saturated: false })).toBe(EXIT.FAILED);
  });

  it("timeouts on a SATURATED box are unprovable — repeat, do not diagnose", () => {
    expect(phaseExit({ output: timeoutOnly, signal: null, saturated: true })).toBe(EXIT.UNPROVABLE);
  });

  // Owner decision 2026-07-27. Same load, same timeouts — but confined to one
  // file, which a slow box does not produce. `production-cockpit#776` is the
  // case: `llm.test.ts` hangs 900 s in `db.destroy()` while everything else
  // passes. It was only called a defect because a real assertion failure
  // happened to sit beside it; alone it would have been excused and retried
  // forever.
  it("the same timeouts confined to ONE file are a hang, not the box", () => {
    expect(phaseExit({ output: timeoutOneFile, signal: null, saturated: true })).toBe(EXIT.FAILED);
  });

  it("a timeout NEXT TO a content failure stays content — the mixed case", () => {
    expect(phaseExit({ output: timeoutOnly + contentOut, signal: null, saturated: true })).toBe(
      EXIT.FAILED,
    );
  });

  // `DECISION (infra-is-not-the-code)`: the second route to exit 2, and the one
  // `production-cockpit/AGENTS.md` has been promising since #775. Unlike the
  // timeout route it never asks about the load — which is exactly what these
  // cases pin, since a quiet box was the old guarantee of exit 1.
  describe("transient infra signatures — exit 2 without consulting the load", () => {
    const resetOut =
      "FAIL src/upload.test.ts\nError: read ECONNRESET\n" +
      "    at TLSWrap.onStreamRead (node:internal/stream_base_commons:218:20)\n";

    it("a reset connection is unprovable on a QUIET box", () => {
      expect(phaseExit({ output: resetOut, signal: null, saturated: false })).toBe(EXIT.UNPROVABLE);
    });

    it("and confined to a single file, where the scatter guard does not apply", () => {
      // One file may simply be the only one doing network I/O — the shape that
      // identifies a hang says nothing about a network that named itself.
      expect(phaseExit({ output: resetOut, signal: null, saturated: true })).toBe(EXIT.UNPROVABLE);
    });

    it("a socket hang up reads the same way", () => {
      const hangUp =
        "FAIL src/api.test.ts\n" +
        "FetchError: request to http://localhost:4100/api failed, reason: socket hang up\n";
      expect(phaseExit({ output: hangUp, signal: null, saturated: false })).toBe(EXIT.UNPROVABLE);
    });

    it("a test ASSERTING on the signature stays a defect — the expensive direction", () => {
      const asserted = "FAIL src/retry.test.ts\nAssertionError: expected 'ECONNRESET' to be 'ok'\n";
      expect(phaseExit({ output: asserted, signal: null, saturated: false })).toBe(EXIT.FAILED);
    });

    it("a signature NEXT TO a real failure stays a defect", () => {
      expect(phaseExit({ output: resetOut + contentOut, signal: null, saturated: false })).toBe(
        EXIT.FAILED,
      );
    });

    it("an unlisted errno is NOT excused — the list is closed on purpose", () => {
      // ECONNREFUSED means nothing is listening, which is a setup defect and a
      // finding. Widening the list is a spec change, never a code convenience.
      const refused = "FAIL src/api.test.ts\nError: connect ECONNREFUSED 127.0.0.1:4100\n";
      expect(phaseExit({ output: refused, signal: null, saturated: false })).toBe(EXIT.FAILED);
    });
  });

  // A real vitest timeout run, as measured (evidence #773, E2/E4/E5): the
  // cause arrives wrapped in a header, an advice line and the summary block.
  const vitestTimeout = [
    " FAIL  src/slow.test.ts > waits for the box",
    "Error: Test timed out in 34000ms.",
    'If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".',
    " FAIL  src/second.test.ts > also waits",
    "Error: Test timed out in 34000ms.",
    "",
    " Test Files  2 failed (2)",
    "      Tests  2 failed (2)",
    "   Start at  21:05:51",
    "   Duration  35.12s",
  ].join("\n");

  it("a vitest timeout run on a SATURATED box is unprovable, summary block and all", () => {
    expect(phaseExit({ output: vitestTimeout, signal: null, saturated: true })).toBe(
      EXIT.UNPROVABLE,
    );
  });

  it("the same run on a QUIET box stays a finding — the distinction must survive", () => {
    expect(phaseExit({ output: vitestTimeout, signal: null, saturated: false })).toBe(EXIT.FAILED);
  });

  it("an assertion among those same lines is content — excluding noise excuses nothing", () => {
    const withAssertion = vitestTimeout.replace(
      "Error: Test timed out in 34000ms.",
      "Error: Test timed out in 34000ms.\nAssertionError: expected 1 to be 2",
    );
    expect(phaseExit({ output: withAssertion, signal: null, saturated: true })).toBe(EXIT.FAILED);
  });

  // The reported run, reproduced line for line (production-cockpit#132): the
  // decoration vitest wraps a red run in, not a hand-written excerpt. Two files,
  // because one file is the HANG signature and has its own rule below — that
  // distinction is what the reporter's single-file fixture could not separate.
  const vitestReal = [
    " ❯ src/slow.test.ts (1 test | 1 failed) 35005ms",
    "   × waits for the box 35003ms",
    "     → Test timed out in 34000ms.",
    " ❯ src/other.test.ts (1 test | 1 failed) 35004ms",
    "   × also waits 35002ms",
    "     → Test timed out in 34000ms.",
    'If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".',
    "",
    "⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯ Failed Tests 2 ⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯⎯",
    "",
    " FAIL  src/slow.test.ts > waits for the box",
    " FAIL  src/other.test.ts > also waits",
    "Error: Test timed out in 34000ms.",
    "",
    " Test Files  2 failed (2)",
    "      Tests  2 failed (2)",
  ].join("\n");

  it("a REAL vitest timeout run on a saturated box reaches exit 2 at last", () => {
    expect(phaseExit({ output: vitestReal, signal: null, saturated: true })).toBe(EXIT.UNPROVABLE);
  });

  it("the same real run on a quiet box is still a finding", () => {
    expect(phaseExit({ output: vitestReal, signal: null, saturated: false })).toBe(EXIT.FAILED);
  });

  it("an assertion inside the real run outweighs all of it", () => {
    const withAssertion = vitestReal.replace(
      "Error: Test timed out in 34000ms.",
      "AssertionError: expected 1 to be 2",
    );
    expect(phaseExit({ output: withAssertion, signal: null, saturated: true })).toBe(EXIT.FAILED);
  });

  it("a failure that said nothing at all is content — unexplained is not excusable", () => {
    expect(phaseExit({ output: "", signal: null, saturated: true })).toBe(EXIT.FAILED);
    expect(phaseExit({ output: "compiled 40 files\n", signal: null, saturated: true })).toBe(
      EXIT.FAILED,
    );
  });

  it("a process killed outright follows the same rule as a dead runner", () => {
    expect(phaseExit({ output: "", signal: "SIGKILL", saturated: false })).toBe(EXIT.FAILED);
    expect(phaseExit({ output: "", signal: "SIGKILL", saturated: true })).toBe(EXIT.UNPROVABLE);
  });
});

/**
 * The third species of decoration (spec §4, `DECISION (decoration-is-not-a-cause)`):
 * the runner narrating its own failure. Every fixture under
 * `test/fixtures/runners/` is CAPTURED output, not a hand-written excerpt — the
 * spec requires the shape to be measured against all five runners of the phase
 * lists before it is pinned, because a rule derived from one runner's sentences
 * buys exactly one release of quiet.
 */
describe("runner prose — measured against the five runners of the phase lists", () => {
  // The reported case (community-platform 2026-07-27, question #150): vitest
  // reports an ECONNRESET from a socket as an Unhandled Error and prints four
  // sentences plus an `Errors  1 error` row around it. Read as causes that is
  // content against one transient signature, and exit 2 is out of reach for the
  // one output shape it exists for.
  const vitestUnhandled = fixture("vitest-unhandled-error");

  it("the reported case reaches exit 2 — the prose no longer counts as a cause", () => {
    expect(failureMessages(vitestUnhandled).filter((line) => !/ECONNRESET/.test(line))).toEqual([]);
    expect(phaseExit({ output: vitestUnhandled, signal: null, saturated: false })).toBe(
      EXIT.UNPROVABLE,
    );
  });

  it("a real defect BESIDE the prose is still a defect — the expensive direction", () => {
    const withDefect = `${vitestUnhandled}\nAssertionError: expected 1 to be 2\n`;
    expect(phaseExit({ output: withDefect, signal: null, saturated: false })).toBe(EXIT.FAILED);
  });

  // The trap the spec names because it was already measured: the obvious rule
  // "a cause carries an error-type head" throws this line out with the prose,
  // and a defect excused is the direction that costs.
  it("eslint's no-console finding stays a cause", () => {
    const eslint = fixture("eslint");
    expect(failureMessages(eslint)).toContain(
      "7:11  error  Unexpected console statement                 no-console",
    );
    expect(phaseExit({ output: eslint, signal: null, saturated: true })).toBe(EXIT.FAILED);
  });

  it.each([
    ["vitest-assertion", EXIT.FAILED],
    ["vitest-timeout", EXIT.FAILED],
    ["tsc", EXIT.FAILED],
    ["eslint", EXIT.FAILED],
    ["prettier", EXIT.FAILED],
    ["playwright", EXIT.FAILED],
  ])("%s keeps its verdict — the rule is not signature-specific", (name, expected) => {
    const output = fixture(name);
    expect(phaseExit({ output, signal: null, saturated: false })).toBe(expected);
    expect(phaseExit({ output, signal: null, saturated: true })).toBe(expected);
  });

  it("leaves the timeout route open — vitest's timeout is still read as one", () => {
    // Excluding prose must not sink the OTHER road to exit 2: scattered
    // timeouts on a saturated box stay unprovable.
    const scattered =
      fixture("vitest-timeout") + fixture("vitest-timeout").replace(/slow/g, "other");
    expect(phaseExit({ output: scattered, signal: null, saturated: true })).toBe(EXIT.UNPROVABLE);
  });

  it("drops the sentences by their shape, one by one", () => {
    for (const line of [
      "Vitest caught 1 unhandled error during the test run.",
      "This might cause false positive tests. Resolve unhandled errors to make sure your tests are not affected.",
      'This error originated in "src/upload.test.ts" test file. It doesn\'t mean the error was thrown inside the file itself, but while it was running.',
      'The latest test that might\'ve caused the error is "finance: read". It might mean one of the following:',
      'If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".',
    ]) {
      expect(failureMessages(line)).toEqual([]);
    }
  });

  // The summary block is matched by the shape of an aligned label/value row, so
  // the row vitest added for unhandled errors needs no entry of its own.
  it("reads the summary rows as a shape, not as three known labels", () => {
    expect(failureMessages("     Errors  1 error")).toEqual([]);
    expect(failureMessages(" Test Files  1 failed (1)")).toEqual([]);
  });

  // Prose is only safe to drop while it cannot reach a cause. Diagnostics are
  // short and they NAME things, and naming costs a symbol token — that is the
  // whole of the distinction, so these are the cases that pin it.
  it("keeps short symbol-free diagnostics — a sentence is not the same as a message", () => {
    expect(failureMessages("Module not found")).toHaveLength(1);
    expect(failureMessages("Cannot find module")).toHaveLength(1);
    expect(failureMessages("Test timeout of 2000ms exceeded.")).toHaveLength(1);
  });

  it("keeps a long diagnostic that names its subject in single quotes", () => {
    // tsc and eslint quote identifiers with SINGLE quotes where the prose above
    // quotes files and test names with double ones. Strip both and a diagnostic
    // like this one loses the very token that marks it as one, and reads as a
    // sentence about the run.
    expect(
      failureMessages("Type 'string' is not assignable to the expected type of property 'name'"),
    ).toHaveLength(1);
  });

  it("keeps a message that LEADS with its cause, however long the sentence", () => {
    expect(
      failureMessages("Error occurred when checking code style in the above file."),
    ).toHaveLength(1);
  });
});

describe("failingFiles — the distribution that separates a hang from a slow box", () => {
  it("names each distinct file once, however many tests failed in it", () => {
    const output = [
      " FAIL  src/routes/llm.test.ts > provider reachable",
      "   Error: Hook timed out in 60000ms.",
      " FAIL  src/routes/llm.test.ts > provider unreachable",
      "   Error: Test timed out in 10000ms.",
    ].join("\n");
    expect(failingFiles(output)).toEqual(["src/routes/llm.test.ts"]);
  });

  it("sees the spread when the box slowed everything down", () => {
    const output = [
      " FAIL  src/a.test.ts > one",
      " FAIL  src/b.test.ts > two",
      " FAIL  e2e/c.spec.ts > three",
    ].join("\n");
    expect(failingFiles(output)).toHaveLength(3);
  });

  it("reports nothing when the runner names no files, rather than guessing", () => {
    expect(failingFiles("Error: Test timed out in 10000ms.")).toEqual([]);
  });
});
