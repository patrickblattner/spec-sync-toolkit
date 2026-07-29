import { describe, expect, it } from "vitest";
import {
  BOT_LOGIN,
  parseQueueOptions,
  readPhasePin,
  runQueue,
  sweepIssues,
  type GhIssue,
  type QueueDeps,
} from "../src/commands/queue.js";
import { NORM_DEFAULTS } from "../src/norms.js";
import { EXIT, ToolkitError, formatJson } from "../src/output.js";
import type { Config } from "../src/config.js";

const config = {
  project: "demo",
  gate: { profiles: { local: ["unit"] }, phases: [{ name: "unit", cmd: "npm test" }] },
  lenses: {},
  labels: {
    build: "spec-sync",
    audit: "auto-audit",
    bug: "type: bug",
    hold: "owner-hold",
    started: "status: in-progress",
  },
  nightlyWorkflow: "nightly.yml",
} as unknown as Config;

const norms = NORM_DEFAULTS;

function issue(
  number: number,
  labels: string[],
  phase?: string,
  extra: Partial<GhIssue> = {},
): GhIssue {
  return {
    number,
    title: `ticket ${number}`,
    labels: labels.map((name) => ({ name })),
    comments: phase === undefined ? [] : [{ body: `Phase: ${phase} — weil` }],
    ...extra,
  };
}

/** A `gh` that answers from a script and records every call it was given. */
function fakeGh(answers: { issues?: GhIssue[]; runs?: unknown[]; runsFail?: string } = {}) {
  const calls: string[][] = [];
  const gh = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "issue") return JSON.stringify(answers.issues ?? []);
    if (args[0] === "run") {
      if (answers.runsFail !== undefined) throw new Error(answers.runsFail);
      return JSON.stringify(answers.runs ?? []);
    }
    throw new Error(`unexpected gh call: ${args.join(" ")}`);
  };
  return { gh, calls };
}

function deps(gh: QueueDeps["gh"], over: Partial<Omit<QueueDeps, "gh">> = {}): QueueDeps {
  return {
    gh,
    lastMainCommit: async () => undefined,
    now: () => new Date("2026-07-26T12:00:00.000Z"),
    ...over,
  };
}

describe("tier 2 — started before unstarted (foundation.dev.process 2.7.0, Q&A #152)", () => {
  it("puts a started ticket before an unstarted one, even an older one", () => {
    const sweep = sweepIssues(
      [
        issue(4, ["spec-sync"], "M2"),
        issue(9, ["spec-sync", "status: in-progress"], "M2"),
        issue(7, ["spec-sync"], "M2"),
      ],
      config,
      norms,
    );
    expect(sweep.queue.map((entry) => entry.issue)).toEqual([9, 4, 7]);
  });

  it("sorts above the phase — a started M4 ticket beats an unstarted M1 one", () => {
    const sweep = sweepIssues(
      [issue(1, ["spec-sync"], "M1"), issue(2, ["spec-sync", "status: in-progress"], "M4")],
      config,
      norms,
    );
    expect(sweep.queue.map((entry) => entry.issue)).toEqual([2, 1]);
  });

  it("stays below tier 1 — an unstarted auto-audit still outranks a started build ticket", () => {
    const sweep = sweepIssues(
      [issue(1, ["spec-sync", "status: in-progress"], "M1"), issue(2, ["auto-audit"], "M9")],
      config,
      norms,
    );
    expect(sweep.queue.map((entry) => entry.issue)).toEqual([2, 1]);
  });

  it("leaves oldest-first untouched inside each of the two groups", () => {
    const sweep = sweepIssues(
      [
        issue(8, ["spec-sync", "status: in-progress"], "M2"),
        issue(3, ["spec-sync"], "M2"),
        issue(5, ["spec-sync", "status: in-progress"], "M2"),
        issue(1, ["spec-sync"], "M2"),
      ],
      config,
      norms,
    );
    expect(sweep.queue.map((entry) => entry.issue)).toEqual([5, 8, 1, 3]);
  });
});

describe("sorting by the four tiers (§12 M3, foundation §Worker-Loop)", () => {
  it("puts auto-audit first, then type: bug, then ordinary build tickets", () => {
    const sweep = sweepIssues(
      [issue(1, ["spec-sync"], "1"), issue(2, ["type: bug"], "1"), issue(3, ["auto-audit"], "1")],
      config,
      norms,
    );
    expect(sweep.queue.map((entry) => entry.issue)).toEqual([3, 2, 1]);
  });

  it("sorts by build phase ascending inside the same tier", () => {
    const sweep = sweepIssues(
      [issue(1, ["spec-sync"], "M4"), issue(2, ["spec-sync"], "M2"), issue(3, ["spec-sync"], "M3")],
      config,
      norms,
    );
    expect(sweep.queue.map((entry) => entry.issue)).toEqual([2, 3, 1]);
  });

  it("sorts strictly oldest first inside the same phase", () => {
    const sweep = sweepIssues(
      [issue(9, ["spec-sync"], "M2"), issue(4, ["spec-sync"], "M2"), issue(7, ["spec-sync"], "M2")],
      config,
      norms,
    );
    expect(sweep.queue.map((entry) => entry.issue)).toEqual([4, 7, 9]);
  });

  it("applies all four tiers together, in order", () => {
    const sweep = sweepIssues(
      [
        issue(10, ["spec-sync"], "M1"),
        issue(11, ["auto-audit"], "M9"),
        issue(12, ["type: bug"], "M9"),
        issue(13, ["auto-audit"], "M2"),
        issue(14, ["spec-sync"], "M1"),
      ],
      config,
      norms,
    );
    // audit (M2 before M9), then bug, then build tickets oldest first.
    expect(sweep.queue.map((entry) => entry.issue)).toEqual([13, 11, 12, 10, 14]);
    expect(sweep.queue.map((entry) => entry.position)).toEqual([1, 2, 3, 4, 5]);
  });

  it("reports number, pinned phase and position — what the DoD report needs", () => {
    const sweep = sweepIssues([issue(5, ["spec-sync"], "M3")], config, norms);
    expect(sweep.queue[0]).toMatchObject({ issue: 5, pin: "M3", phase: 3, position: 1 });
  });

  it("an auto-audit ticket outranks a bug even in a much later phase", () => {
    const sweep = sweepIssues(
      [issue(1, ["type: bug"], "M1"), issue(2, ["auto-audit"], "M8")],
      config,
      norms,
    );
    expect(sweep.queue[0]?.issue).toBe(2);
  });
});

describe("owner-hold never appears in the work list (§12 M3)", () => {
  it("excludes a held ticket from the queue and reports it separately", () => {
    const sweep = sweepIssues(
      [issue(1, ["spec-sync", "owner-hold"], "M1"), issue(2, ["spec-sync"], "M1")],
      config,
      norms,
    );
    expect(sweep.queue.map((entry) => entry.issue)).toEqual([2]);
    expect(sweep.held).toEqual([{ issue: 1, title: "ticket 1" }]);
  });

  it("beats auto-audit and type: bug, the two labels that otherwise have right of way", () => {
    const sweep = sweepIssues(
      [issue(1, ["auto-audit", "owner-hold"], "M1"), issue(2, ["type: bug", "owner-hold"], "M1")],
      config,
      norms,
    );
    expect(sweep.queue).toEqual([]);
    expect(sweep.held.map((ticket) => ticket.issue)).toEqual([1, 2]);
  });

  it("keeps a held ticket out of needsPin and notSwept as well", () => {
    const sweep = sweepIssues([issue(1, ["owner-hold"])], config, norms);
    expect(sweep.needsPin).toEqual([]);
    expect(sweep.notSwept).toEqual([]);
    expect(sweep.held).toHaveLength(1);
  });
});

describe("a missing phase pin is reported, never guessed (§7.2, §12 M3)", () => {
  it("puts a ticket without a Phase comment into needsPin with a reason", () => {
    const sweep = sweepIssues([issue(1, ["spec-sync"])], config, norms);
    expect(sweep.queue).toEqual([]);
    expect(sweep.needsPin[0]).toMatchObject({ issue: 1, labels: ["spec-sync"] });
    expect(sweep.needsPin[0]?.reason).toMatch(/no `Phase:` comment/);
  });

  it("puts an unreadable pin into needsPin instead of inventing a number", () => {
    const sweep = sweepIssues([issue(1, ["spec-sync"], "irgendwann")], config, norms);
    expect(sweep.queue).toEqual([]);
    expect(sweep.needsPin[0]?.reason).toMatch(/unreadable phase pin "irgendwann"/);
  });

  it("reports an unpinned audit ticket too — urgency does not license a guess", () => {
    const sweep = sweepIssues([issue(1, ["auto-audit"])], config, norms);
    expect(sweep.queue).toEqual([]);
    expect(sweep.needsPin[0]?.labels).toContain("auto-audit");
  });

  it("reads the pin from the comment and lets the newest comment win", () => {
    const ticket = issue(1, ["spec-sync"]);
    ticket.comments = [{ body: "Phase: M2 — erst" }, { body: "Phase: M5 — umgepinnt, weil X" }];
    expect(readPhasePin(ticket)).toBe("M5");
    expect(sweepIssues([ticket], config, norms).queue[0]?.phase).toBe(5);
  });

  it("reads a bare number and a `Phase 3` form as the same phase", () => {
    expect(sweepIssues([issue(1, ["spec-sync"], "3")], config, norms).queue[0]?.phase).toBe(3);
    expect(sweepIssues([issue(1, ["spec-sync"], "Phase 3")], config, norms).queue[0]?.phase).toBe(
      3,
    );
  });

  it("treats `aktuell` as the lowest phase currently pinned — the one the loop works on", () => {
    const sweep = sweepIssues(
      [
        issue(1, ["spec-sync"], "M5"),
        issue(2, ["spec-sync"], "aktuell"),
        issue(3, ["spec-sync"], "M3"),
      ],
      config,
      norms,
    );
    expect(sweep.queue.find((entry) => entry.issue === 2)?.phase).toBe(3);
    expect(sweep.queue.map((entry) => entry.issue)).toEqual([2, 3, 1]);
  });
});

describe("sweep boundaries and the label-drift guard", () => {
  it("sweeps audit, bug and build labels — and nothing else", () => {
    const sweep = sweepIssues(
      [
        issue(1, ["auto-audit"], "M1"),
        issue(2, ["type: bug"], "M1"),
        issue(3, ["spec-sync"], "M1"),
        issue(4, ["type: feature"], "M1"),
      ],
      config,
      norms,
    );
    expect(sweep.queue.map((entry) => entry.issue)).toEqual([1, 2, 3]);
    expect(sweep.notSwept).toEqual([{ issue: 4, title: "ticket 4" }]);
  });

  it("reports an open bot ticket without the audit label as a finding", () => {
    const sweep = sweepIssues(
      [issue(1, ["type: bug"], "M1", { author: { login: BOT_LOGIN } })],
      config,
      norms,
    );
    expect(sweep.labelDrift[0]).toMatchObject({ kind: "label-drift", issue: 1 });
  });

  it("stays quiet about a correctly labelled bot ticket", () => {
    const sweep = sweepIssues(
      [issue(1, ["auto-audit"], "M1", { author: { login: BOT_LOGIN } })],
      config,
      norms,
    );
    expect(sweep.labelDrift).toEqual([]);
  });
});

describe("--check answers in one line from a single roundtrip (§7.2, §12 M3)", () => {
  it("costs exactly one gh call", async () => {
    const { gh, calls } = fakeGh({ issues: [issue(1, ["spec-sync"], "M1")] });
    await runQueue(deps(gh), config, { check: true }, norms);
    expect(calls).toHaveLength(1);
    expect(calls[0]?.[0]).toBe("issue");
  });

  it("carries the open count and the next number, and nothing else", async () => {
    const { gh } = fakeGh({
      issues: [issue(4, ["spec-sync"], "M2"), issue(2, ["auto-audit"], "M9")],
    });
    const result = await runQueue(deps(gh), config, { check: true }, norms);
    expect(Object.keys(result.data)).toEqual(["open", "next"]);
    expect(result.data).toEqual({ open: 2, next: 2 });
  });

  it("stays far under the 15-line budget of spec §3", async () => {
    const { gh } = fakeGh({ issues: [issue(1, ["spec-sync"], "M1")] });
    const result = await runQueue(deps(gh), config, { check: true }, norms);
    const rendered = formatJson({
      command: "queue",
      ok: true,
      exit: 0,
      durationMs: 12,
      notes: result.notes,
      ...result.data,
    });
    expect(rendered.split("\n").length).toBeLessThanOrEqual(15);
  });

  it("an empty tick is the whole output: nothing open, no next number", async () => {
    const { gh, calls } = fakeGh({ issues: [] });
    const result = await runQueue(deps(gh), config, { check: true }, norms);
    expect(result.data).toEqual({ open: 0, next: null });
    expect(result.notes).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("counts tickets waiting for a pin, so a poll never reads 0 while work waits", async () => {
    const { gh } = fakeGh({ issues: [issue(1, ["spec-sync"])] });
    const result = await runQueue(deps(gh), config, { check: true }, norms);
    expect(result.data).toEqual({ open: 1, next: null });
  });
});

describe("nightly findings are reported, not turned into tickets (§7.2)", () => {
  const redRun = [
    { status: "completed", conclusion: "failure", createdAt: "2026-07-26T02:00:00.000Z" },
  ];

  it("reports a red nightly without an open audit ticket", async () => {
    const { gh, calls } = fakeGh({ issues: [issue(1, ["spec-sync"], "M1")], runs: redRun });
    const result = await runQueue(deps(gh), config, { check: false }, norms);
    const findings = result.data.findings as { kind: string }[];
    expect(findings.map((finding) => finding.kind)).toContain("nightly-red-without-ticket");
    // Reported only — no gh call ever creates or edits an issue.
    expect(calls.every((call) => call[1] === "list")).toBe(true);
    expect(result.notes.join(" ")).toMatch(/no ticket created/);
  });

  it("stays quiet when a matching audit ticket is already open", async () => {
    const { gh } = fakeGh({ issues: [issue(1, ["auto-audit"], "M1")], runs: redRun });
    const result = await runQueue(deps(gh), config, { check: false }, norms);
    const findings = result.data.findings as { kind: string }[];
    expect(findings.map((finding) => finding.kind)).not.toContain("nightly-red-without-ticket");
  });

  it("counts an audit ticket that is only waiting for a pin as an existing ticket", async () => {
    const { gh } = fakeGh({ issues: [issue(1, ["auto-audit"])], runs: redRun });
    const result = await runQueue(deps(gh), config, { check: false }, norms);
    const findings = result.data.findings as { kind: string }[];
    expect(findings.map((finding) => finding.kind)).not.toContain("nightly-red-without-ticket");
  });

  it("reports a nightly that has not run for over 25 h although main moved", async () => {
    const { gh } = fakeGh({
      issues: [],
      runs: [{ status: "completed", conclusion: "success", createdAt: "2026-07-25T02:00:00.000Z" }],
    });
    const result = await runQueue(
      deps(gh, { lastMainCommit: async () => "2026-07-25T18:00:00.000Z" }),
      config,
      { check: false },
      norms,
    );
    const findings = result.data.findings as { kind: string }[];
    expect(findings.map((finding) => finding.kind)).toContain("nightly-stale");
  });

  it("stays quiet when the nightly was correctly skipped — no new commits", async () => {
    const { gh } = fakeGh({
      issues: [],
      runs: [{ status: "completed", conclusion: "success", createdAt: "2026-07-25T02:00:00.000Z" }],
    });
    const result = await runQueue(
      deps(gh, { lastMainCommit: async () => "2026-07-24T09:00:00.000Z" }),
      config,
      { check: false },
      norms,
    );
    expect(result.data.findings).toEqual([]);
  });

  it("reports a nightly that never ran while main carries commits", async () => {
    const { gh } = fakeGh({ issues: [], runs: [] });
    const result = await runQueue(
      deps(gh, { lastMainCommit: async () => "2026-07-25T18:00:00.000Z" }),
      config,
      { check: false },
      norms,
    );
    const findings = result.data.findings as { kind: string; detail: string }[];
    expect(findings[0]?.kind).toBe("nightly-stale");
    expect(findings[0]?.detail).toMatch(/never run/);
  });

  it("skips the nightly check with a note when no workflow is configured", async () => {
    const { gh, calls } = fakeGh({ issues: [] });
    const result = await runQueue(
      deps(gh),
      { ...config, nightlyWorkflow: undefined } as Config,
      { check: false },
      norms,
    );
    expect(result.notes.join(" ")).toMatch(/no `nightlyWorkflow`/);
    expect(calls).toHaveLength(1);
  });

  it("reports an unreadable nightly status rather than assuming green", async () => {
    const { gh } = fakeGh({ issues: [], runsFail: "gh: workflow not found" });
    const result = await runQueue(deps(gh), config, { check: false }, norms);
    const findings = result.data.findings as { kind: string }[];
    expect(findings[0]?.kind).toBe("nightly-unknown");
  });
});

describe("option parsing", () => {
  it("accepts --check and defaults to the full queue", () => {
    expect(parseQueueOptions([])).toEqual({ check: false });
    expect(parseQueueOptions(["--check"])).toEqual({ check: true });
  });

  it("rejects a mistyped option with exit 4 and names the field", () => {
    let caught: ToolkitError | undefined;
    try {
      parseQueueOptions(["--chekc"]);
    } catch (error) {
      caught = error as ToolkitError;
    }
    expect(caught?.exit).toBe(EXIT.PRECONDITION);
    expect(caught?.field).toBe("--chekc");
  });

  it("rejects a stray positional argument too", () => {
    expect(() => parseQueueOptions(["all"])).toThrowError(/unknown option for queue/);
  });
});
