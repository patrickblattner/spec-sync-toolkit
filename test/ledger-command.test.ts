import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CommandContext } from "../src/cli.js";
import { runLedger } from "../src/commands/ledger.js";
import { openMerges } from "../src/commands/handover.js";
import { appendEvent, interruptedMerge, readLedger } from "../src/ledger.js";
import { EXIT, ToolkitError } from "../src/output.js";
import type { RunResult, Tools } from "../src/pack/exec.js";
import { findOrphans } from "../src/pack/orphans.js";

/** `ledger close` — an orphaned merge-started of a CLOSED issue, ended by hand. */

function repo(events: Parameters<typeof appendEvent>[1][] = []): string {
  const root = mkdtempSync(join(tmpdir(), "spec-sync-ledger-"));
  for (const event of events) appendEvent(root, event);
  return root;
}

const started = (issue: number) =>
  ({ at: "2026-08-01T10:00:00.000Z", type: "merge-started", issue }) as const;

/** gh answers `issue view` with the given state; git (orphan checks) is unavailable. */
function fakeTools(state: string | "fail", calls: string[][] = []): Tools {
  return {
    run(file, args): RunResult {
      calls.push([file, ...args]);
      if (file === "gh" && args[0] === "issue" && args[1] === "view") {
        expect(args).toEqual(["issue", "view", args[2], "--json", "state"]);
        return state === "fail"
          ? { ok: false, code: 1, stdout: "", stderr: "Could not resolve to an issue" }
          : { ok: true, code: 0, stdout: JSON.stringify({ state }), stderr: "" };
      }
      return { ok: false, code: 127, stdout: "", stderr: "not available in this test" };
    },
    spec: () => {
      throw new Error("ledger close never calls the spec server");
    },
  };
}

const ctx = (root: string, args: string[], dryRun = false): CommandContext => ({
  flags: { human: false, dryRun },
  args,
  repoRoot: root,
  config: undefined,
});

function thrown(fn: () => unknown): ToolkitError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ToolkitError) return error;
    throw error;
  }
  throw new Error("expected a ToolkitError, none was thrown");
}

describe("ledger close", () => {
  it("appends exactly one merge-completed marked as closed by hand, with the reason", () => {
    const root = repo([started(525), { type: "gate", issue: 525, ok: true }]);
    const before = readLedger(root).events.length;

    const result = runLedger(ctx(root, ["close", "525", "--reason", "old subject format"]), {
      tools: fakeTools("CLOSED"),
    });

    expect(result.ok).toBe(true);
    const events = readLedger(root).events;
    expect(events).toHaveLength(before + 1);
    expect(events.at(-1)).toMatchObject({
      type: "merge-completed",
      issue: 525,
      ok: false,
      closedByHand: true,
      reason: "old subject format",
    });
    expect(result.data).toMatchObject({ issue: 525, startedAt: "2026-08-01T10:00:00.000Z" });
  });

  it("leaves doctor, handover and merge seeing the issue as closed", () => {
    const root = repo([started(525), started(575)]);
    runLedger(ctx(root, ["close", "525", "--reason", "closed on GitHub"]), {
      tools: fakeTools("CLOSED"),
    });

    const events = readLedger(root).events;
    expect(interruptedMerge(events, 525)).toBeUndefined();
    expect(openMerges(events).map((open) => open.issue)).toEqual([575]);
    const details = findOrphans({ tools: fakeTools("CLOSED"), repoRoot: root })
      .findings.filter((finding) => finding.check === "merge-incomplete")
      .map((finding) => finding.detail);
    expect(details).toHaveLength(1);
    expect(details[0]).toMatch(/^#575: /);
  });

  it("--dry-run writes nothing and reports the event it would append", () => {
    const root = repo([started(525)]);
    const result = runLedger(ctx(root, ["close", "525", "--reason", "x"], true), {
      tools: fakeTools("CLOSED"),
    });

    expect(result.ok).toBe(true);
    expect(result.data).toMatchObject({
      dryRun: true,
      event: { type: "merge-completed", issue: 525, closedByHand: true, reason: "x" },
    });
    expect(readLedger(root).events).toHaveLength(1);
  });

  it("refuses with exit 4 when there is no open merge-started for the issue", () => {
    const calls: string[][] = [];
    const none = repo([{ type: "gate", issue: 525, ok: true }]);
    const done = repo([started(525), { type: "merge-completed", issue: 525, ok: true }]);
    for (const root of [none, done]) {
      const error = thrown(() =>
        runLedger(ctx(root, ["close", "525", "--reason", "x"]), {
          tools: fakeTools("CLOSED", calls),
        }),
      );
      expect(error.exit).toBe(EXIT.PRECONDITION);
      expect(error.message).toContain("no merge-started without a later merge-completed");
    }
    expect(readLedger(done).events).toHaveLength(2);
  });

  it("refuses with exit 4 unless gh says the issue is CLOSED", () => {
    const root = repo([started(525)]);
    for (const state of ["OPEN", "fail"]) {
      const error = thrown(() =>
        runLedger(ctx(root, ["close", "525", "--reason", "x"]), { tools: fakeTools(state) }),
      );
      expect(error.exit).toBe(EXIT.PRECONDITION);
    }
    expect(readLedger(root).events).toHaveLength(1);
  });

  it("refuses with exit 4 without a non-empty --reason", () => {
    const root = repo([started(525)]);
    for (const args of [
      ["close", "525"],
      ["close", "525", "--reason", "   "],
    ]) {
      const error = thrown(() => runLedger(ctx(root, args), { tools: fakeTools("CLOSED") }));
      expect(error.exit).toBe(EXIT.PRECONDITION);
      expect(error.field).toBe("--reason");
    }
    expect(readLedger(root).events).toHaveLength(1);
  });

  it("refuses a missing subcommand, a bad issue number and unknown options", () => {
    const root = repo([started(525)]);
    const tools = fakeTools("CLOSED");
    expect(thrown(() => runLedger(ctx(root, []), { tools })).field).toBe("subcommand");
    expect(
      thrown(() => runLedger(ctx(root, ["close", "x", "--reason", "r"]), { tools })).field,
    ).toBe("issue");
    expect(
      thrown(() => runLedger(ctx(root, ["close", "525", "--reason", "r", "--force"]), { tools }))
        .field,
    ).toBe("--force");
  });
});

describe("ledger start (0.49.0, register #2030)", () => {
  it("appends exactly one work-started event for the issue, without asking gh", () => {
    const root = repo();
    const calls: string[][] = [];
    const result = runLedger(ctx(root, ["start", "77"]), { tools: fakeTools("OPEN", calls) });
    expect(result.ok).toBe(true);
    expect(calls).toEqual([]);
    const events = readLedger(root).events;
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: "work-started", issue: 77 });
    expect(typeof events[0]?.at).toBe("string");
  });

  it("--dry-run writes nothing and reports the event it would append", () => {
    const root = repo();
    const result = runLedger(ctx(root, ["start", "77"], true), { tools: fakeTools("OPEN") });
    expect(result.data).toMatchObject({ dryRun: true, event: { type: "work-started", issue: 77 } });
    expect(readLedger(root).events).toEqual([]);
  });

  it("refuses a bad issue number and every option it does not know", () => {
    const root = repo();
    const tools = fakeTools("OPEN");
    expect(thrown(() => runLedger(ctx(root, ["start"]), { tools })).field).toBe("issue");
    expect(thrown(() => runLedger(ctx(root, ["start", "0"]), { tools })).field).toBe("issue");
    expect(
      thrown(() => runLedger(ctx(root, ["start", "7", "--reason", "r"]), { tools })).field,
    ).toBe("--reason");
    expect(readLedger(root).events).toEqual([]);
  });
});
