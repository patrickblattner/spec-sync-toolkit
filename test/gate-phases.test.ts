/**
 * Running a phase and reading its failure (spec §7.1, §4).
 *
 * The verdict rule survives the translation from "a reporter's failure list" to
 * "an opaque command's output": saturation only ever decides whether a
 * TIMEOUT-ONLY red reads as broken (1) or unprovable (2), and never touches a
 * content failure.
 */

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { failureMessages, phaseExit, runPhase } from "../src/gate/phases.js";
import { EXIT } from "../src/output.js";

const cwd = (): string => mkdtempSync(join(tmpdir(), "spec-sync-phase-"));

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

describe("phaseExit — 1 on the merits, 2 unprovable (spec §4, exit-2-inherited)", () => {
  const timeoutOnly = "FAIL src/slow.test.ts\nTest timed out in 10000ms.\n";
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

  it("a timeout NEXT TO a content failure stays content — the mixed case", () => {
    expect(phaseExit({ output: timeoutOnly + contentOut, signal: null, saturated: true })).toBe(
      EXIT.FAILED,
    );
  });

  // A real vitest timeout run, as measured (evidence #773, E2/E4/E5): the
  // cause arrives wrapped in a header, an advice line and the summary block.
  const vitestTimeout = [
    " FAIL  src/slow.test.ts > waits for the box",
    "Error: Test timed out in 34000ms.",
    'If this is a long-running test, pass a timeout value as the last argument or configure it globally with "testTimeout".',
    "",
    " Test Files  1 failed (1)",
    "      Tests  1 failed (1)",
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
