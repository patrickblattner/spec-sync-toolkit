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
