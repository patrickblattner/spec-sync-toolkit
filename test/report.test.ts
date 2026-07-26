import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  NOT_SWEPT_PREFIX,
  notSweptLine,
  parseReportOptions,
  runReport,
  type ReportDeps,
  type ReportFinding,
} from "../src/commands/report.js";
import { appendEvent } from "../src/ledger.js";
import { EXIT, ToolkitError } from "../src/output.js";
import type { Sweep } from "../src/commands/queue.js";

/** Captures the ToolkitError a parser threw, so exit code and field are assertable. */
function thrown(fn: () => unknown): ToolkitError {
  try {
    fn();
  } catch (error) {
    if (error instanceof ToolkitError) return error;
    throw error;
  }
  throw new Error("expected a ToolkitError, none was thrown");
}

function repo(): string {
  return mkdtempSync(join(tmpdir(), "spec-sync-report-"));
}

function emptySweep(over: Partial<Sweep> = {}): Sweep {
  return { queue: [], needsPin: [], held: [], notSwept: [], labelDrift: [], ...over };
}

function deps(repoRoot: string, sweep: Sweep | (() => Promise<Sweep>)): ReportDeps {
  return {
    repoRoot,
    sweep: typeof sweep === "function" ? sweep : async () => sweep,
  };
}

/** A fully covered run: drift found, every section mapped, the ticket merged. */
function completeRun(root: string): void {
  appendEvent(root, {
    type: "drift",
    run: "r1",
    unit: "foundation.dev.process",
    sections: ["worker-loop"],
  });
  appendEvent(root, {
    type: "section-mapped",
    run: "r1",
    unit: "foundation.dev.process",
    section: "worker-loop",
    issue: 7,
  });
  appendEvent(root, { type: "ticket-created", run: "r1", issue: 7 });
  appendEvent(root, { type: "gate", run: "r1", issue: 7, ok: true, profile: "merge" });
  appendEvent(root, {
    type: "merge-completed",
    run: "r1",
    issue: 7,
    ok: true,
    commit: "abc1234",
    turns: 9,
  });
}

describe("the mandatory closing line is always written (§7.6, DoD)", () => {
  it("says `keine` in so many words on an empty set", () => {
    expect(notSweptLine([])).toBe(`${NOT_SWEPT_PREFIX} keine`);
  });

  it("names the tickets the loop deliberately left alone", () => {
    expect(notSweptLine([{ issue: 4 }, { issue: 9 }])).toBe(`${NOT_SWEPT_PREFIX} #4, #9`);
  });

  it("never silently omits the line, not even when the queue was unreadable", () => {
    expect(notSweptLine(undefined)).toContain(NOT_SWEPT_PREFIX);
    expect(notSweptLine(undefined)).not.toContain("keine");
  });

  it("appears in the response of a completely empty run", async () => {
    const root = repo();
    const result = await runReport(deps(root, emptySweep()), {});
    expect(result.data.notSwept).toBe(`${NOT_SWEPT_PREFIX} keine`);
  });

  it("carries the un-swept tickets the live sweep found", async () => {
    const root = repo();
    completeRun(root);
    const sweep = emptySweep({ notSwept: [{ issue: 12, title: "owner idea" }] });
    const result = await runReport(deps(root, sweep), {});
    expect(result.data.notSwept).toBe(`${NOT_SWEPT_PREFIX} #12`);
  });

  it("reports the line as undetermined and files a finding when the queue fails", async () => {
    const root = repo();
    const result = await runReport(
      deps(root, async () => {
        throw new Error("gh: not a repository");
      }),
      {},
    );
    expect(result.data.notSwept).toMatch(/unbestimmt/);
    const findings = result.data.findings as ReportFinding[];
    expect(findings.map((finding) => finding.kind)).toContain("queue-unreadable");
    expect(result.ok).toBe(false);
  });
});

describe("completeness, not the merits (§7.6)", () => {
  it("passes a run where every changed section has a ticket", async () => {
    const root = repo();
    completeRun(root);
    const result = await runReport(deps(root, emptySweep()), {});
    expect(result.data.findings).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.exit).toBe(EXIT.OK);
  });

  it("accepts an explicit reason in place of a ticket", async () => {
    const root = repo();
    appendEvent(root, { type: "drift", run: "r1", unit: "u", sections: ["s"] });
    appendEvent(root, {
      type: "section-mapped",
      run: "r1",
      unit: "u",
      section: "s",
      reason: "editorial only, no code effect",
    });
    const result = await runReport(deps(root, emptySweep()), {});
    expect(result.data.findings).toEqual([]);
  });

  it("files a finding when a section has neither ticket nor reason", async () => {
    const root = repo();
    appendEvent(root, { type: "drift", run: "r1", unit: "u", sections: ["s"] });
    appendEvent(root, { type: "section-mapped", run: "r1", unit: "u", section: "s" });

    const result = await runReport(deps(root, emptySweep()), {});
    const findings = result.data.findings as ReportFinding[];

    expect(findings[0]?.kind).toBe("section-without-ticket");
    expect(findings[0]?.detail).toContain("u §s");
    expect(result.ok).toBe(false);
    expect(result.exit).toBe(EXIT.FAILED);
  });

  it("files a finding when a changed section was never mapped at all", async () => {
    const root = repo();
    appendEvent(root, { type: "drift", run: "r1", unit: "u", sections: ["a", "b"] });
    appendEvent(root, { type: "section-mapped", run: "r1", unit: "u", section: "a", issue: 1 });

    const findings = (await runReport(deps(root, emptySweep()), {})).data
      .findings as ReportFinding[];

    expect(findings).toHaveLength(1);
    expect(findings[0]).toMatchObject({ kind: "section-unmapped" });
    expect(findings[0]?.detail).toContain("§b");
  });

  it("does not judge whether a reason is any good — only that one exists", async () => {
    const root = repo();
    appendEvent(root, { type: "drift", run: "r1", unit: "u", sections: ["s"] });
    appendEvent(root, {
      type: "section-mapped",
      run: "r1",
      unit: "u",
      section: "s",
      reason: "nope",
    });
    expect((await runReport(deps(root, emptySweep()), {})).data.findings).toEqual([]);
  });

  it("treats a blank reason as no reason", async () => {
    const root = repo();
    appendEvent(root, { type: "drift", run: "r1", unit: "u", sections: ["s"] });
    appendEvent(root, { type: "section-mapped", run: "r1", unit: "u", section: "s", reason: "  " });
    const findings = (await runReport(deps(root, emptySweep()), {})).data
      .findings as ReportFinding[];
    expect(findings[0]?.kind).toBe("section-without-ticket");
  });
});

describe("the Zielabgleich content (§7.6)", () => {
  it("renders drift, mapping, done with commit, and the sorted rest queue", async () => {
    const root = repo();
    completeRun(root);
    const restQueue = [{ issue: 8, title: "next", rank: 2, phase: 3, pin: "M3", position: 1 }];
    const result = await runReport(deps(root, emptySweep({ queue: restQueue })), {});

    expect(result.data.drift).toEqual([
      { unit: "foundation.dev.process", sections: ["worker-loop"] },
    ]);
    expect(result.data.mapping).toEqual([
      { unit: "foundation.dev.process", section: "worker-loop", issue: 7 },
    ]);
    expect(result.data.done).toEqual([{ issue: 7, commit: "abc1234" }]);
    expect(result.data.restQueue).toEqual(restQueue);
  });

  it("lists a blocked ticket as open, with its reason", async () => {
    const root = repo();
    appendEvent(root, { type: "blocked", run: "r1", issue: 5, reason: "waiting on a spec answer" });
    const result = await runReport(deps(root, emptySweep()), {});
    expect(result.data.open).toEqual([{ issue: 5, reason: "waiting on a spec answer" }]);
  });

  it("drops a ticket from `open` once it merged later in the same run", async () => {
    const root = repo();
    appendEvent(root, { type: "blocked", run: "r1", issue: 5, reason: "gate red" });
    appendEvent(root, { type: "merge-completed", run: "r1", issue: 5, ok: true, commit: "def" });
    const result = await runReport(deps(root, emptySweep()), {});
    expect(result.data.open).toEqual([]);
    expect(result.data.done).toEqual([{ issue: 5, commit: "def" }]);
  });

  it("names a blocked ticket that carries no reason rather than hiding it", async () => {
    const root = repo();
    appendEvent(root, { type: "blocked", run: "r1", issue: 5 });
    const open = (await runReport(deps(root, emptySweep()), {})).data.open as { reason: string }[];
    expect(open[0]?.reason).toMatch(/without a recorded reason/);
  });

  it("carries the four numbers per ticket, so the run is machine-evaluable", async () => {
    const root = repo();
    completeRun(root);
    const metrics = (await runReport(deps(root, emptySweep()), {})).data.metrics as {
      issue: number;
      turns: number;
      gateRuns: number;
      retries: number;
      wallClockMs: number;
    }[];

    expect(metrics).toHaveLength(1);
    expect(metrics[0]).toMatchObject({ issue: 7, turns: 9, gateRuns: 1, retries: 0 });
    expect(typeof metrics[0]?.wallClockMs).toBe("number");
  });

  it("reports an unreadable ledger line as a finding", async () => {
    const root = repo();
    completeRun(root);
    appendEvent(root, { type: "drift", run: "r1", unit: "u", sections: [] });
    const { writeFileSync, readFileSync } = await import("node:fs");
    const path = join(root, ".spec-sync", "ledger.jsonl");
    writeFileSync(path, `${readFileSync(path, "utf8")}garbage\n`);

    const findings = (await runReport(deps(root, emptySweep()), {})).data
      .findings as ReportFinding[];
    expect(findings.map((finding) => finding.kind)).toContain("ledger-malformed");
  });
});

describe("run selection", () => {
  it("defaults to the newest run in the ledger", async () => {
    const root = repo();
    appendEvent(root, { type: "merge-completed", run: "r1", issue: 1, ok: true, commit: "aaa" });
    appendEvent(root, { type: "merge-completed", run: "r2", issue: 2, ok: true, commit: "bbb" });

    const result = await runReport(deps(root, emptySweep()), {});
    expect(result.data.done).toEqual([{ issue: 2, commit: "bbb" }]);
    expect(result.notes.join(" ")).toContain("r2");
  });

  it("renders the run that was asked for", async () => {
    const root = repo();
    appendEvent(root, { type: "merge-completed", run: "r1", issue: 1, ok: true, commit: "aaa" });
    appendEvent(root, { type: "merge-completed", run: "r2", issue: 2, ok: true, commit: "bbb" });

    const result = await runReport(deps(root, emptySweep()), { run: "r1" });
    expect(result.data.done).toEqual([{ issue: 1, commit: "aaa" }]);
  });

  it("reports every event when the ledger carries no run id", async () => {
    const root = repo();
    appendEvent(root, { type: "merge-completed", issue: 1, ok: true, commit: "aaa" });
    appendEvent(root, { type: "merge-completed", issue: 2, ok: true, commit: "bbb" });

    const result = await runReport(deps(root, emptySweep()), {});
    expect(result.data.done).toHaveLength(2);
    expect(result.notes.join(" ")).toMatch(/no run id/);
  });

  it("parses --run and rejects anything else", () => {
    expect(parseReportOptions([])).toEqual({ run: undefined });
    expect(parseReportOptions(["--run", "r1"])).toEqual({ run: "r1" });
    expect(() => parseReportOptions(["--run"])).toThrowError(/--run needs a value/);
    expect(() => parseReportOptions(["--run="])).toThrowError(/--run needs a value/);
  });

  it("accepts --run=id as well as --run id", () => {
    expect(parseReportOptions(["--run=r1"])).toEqual({ run: "r1" });
  });

  it("rejects a mistyped option with exit 4 and names the field", () => {
    const error = thrown(() => parseReportOptions(["--rnu", "r1"]));
    expect(error.exit).toBe(EXIT.PRECONDITION);
    expect(error.field).toBe("--rnu");
  });
});
