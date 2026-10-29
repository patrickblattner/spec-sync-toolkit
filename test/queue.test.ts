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
    deferred: "status: deferred",
    started: "status: in-progress",
    blocked: "blocked",
    priority: { must: "P1 must", important: "P2 important", polish: "P3 polish" },
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

describe("status: deferred never appears in the work list (PROC-DEV-010 rev 5)", () => {
  it("excludes a deferred ticket, even one still carrying auto-audit or type: bug", () => {
    const sweep = sweepIssues(
      [
        issue(1, ["spec-sync", "status: deferred"], "M1"),
        issue(2, ["auto-audit", "status: deferred"], "M1"),
        issue(3, ["type: bug", "status: deferred"], "M1"),
        issue(4, ["spec-sync"], "M1"),
      ],
      config,
      norms,
    );
    expect(sweep.queue.map((entry) => entry.issue)).toEqual([4]);
    expect(sweep.deferred.map((ticket) => ticket.issue)).toEqual([1, 2, 3]);
    expect(sweep.held).toEqual([]);
  });

  it("keeps a deferred ticket out of needsPin and notSwept", () => {
    const sweep = sweepIssues(
      [issue(1, ["status: deferred"]), issue(2, ["spec-sync"])],
      config,
      norms,
    );
    expect(sweep.needsPin.map((t) => t.issue)).toEqual([2]);
    expect(sweep.notSwept).toEqual([]);
    expect(sweep.deferred).toHaveLength(1);
  });

  it("lets owner-hold win when both labels are present", () => {
    const sweep = sweepIssues([issue(1, ["owner-hold", "status: deferred"])], config, norms);
    expect(sweep.held).toHaveLength(1);
    expect(sweep.deferred).toEqual([]);
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

  it("answers at the same size whether one ticket is open or two hundred (spec §3)", async () => {
    const lines = async (count: number): Promise<number> => {
      const issues = Array.from({ length: count }, (_, index) =>
        issue(index + 1, ["spec-sync"], "M1"),
      );
      const { gh } = fakeGh({ issues });
      const result = await runQueue(deps(gh), config, { check: true }, norms);
      return formatJson({
        command: "queue",
        ok: true,
        exit: 0,
        durationMs: 12,
        notes: result.notes,
        ...result.data,
      }).split("\n").length;
    };
    expect(await lines(200)).toBe(await lines(1));
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

/**
 * `SST-DESIGN-017` rev 4: a blocked ticket stays in the queue and is marked.
 * Filtering would lose two things at once — the work itself, the moment a label
 * goes stale, and the position a path-clearer inherits its rank at
 * (`PROC-DEV-039`, sort level 0).
 */
describe("blocked tickets — marked at their position, never filtered", () => {
  const blocked = (number: number, phase: string, comments: string[]): GhIssue =>
    issue(number, ["spec-sync", "blocked"], phase, {
      comments: [{ body: `Phase: ${phase} — weil` }, ...comments.map((body) => ({ body }))],
    });

  it("keeps the ticket at its sort position and marks it", () => {
    const sweep = sweepIssues(
      [
        issue(4, ["spec-sync"], "M1"),
        blocked(5, "M1", ["Bedingung: #4 liefert den Exporter — Ziel-Phase M2"]),
        issue(6, ["spec-sync"], "M1"),
      ],
      config,
      norms,
    );

    expect(sweep.queue.map((entry) => entry.issue)).toEqual([4, 5, 6]);
    expect(sweep.queue[1]?.blocked).toBe(true);
    expect(sweep.queue[1]?.position).toBe(2);
    expect(sweep.queue[1]?.blockedComment).toContain("Bedingung: #4 liefert den Exporter");
  });

  it("does not shorten the queue, and leaves every other entry untouched", () => {
    const issues = [issue(4, ["spec-sync"], "M1"), issue(5, ["spec-sync"], "M1")];
    const before = sweepIssues(issues, config, norms);
    const after = sweepIssues(
      [issue(4, ["spec-sync", "blocked"], "M1"), issue(5, ["spec-sync"], "M1")],
      config,
      norms,
    );

    expect(after.queue).toHaveLength(before.queue.length);
    expect(after.queue.map((entry) => entry.position)).toEqual(
      before.queue.map((entry) => entry.position),
    );
    expect(after.queue[1]).toEqual(before.queue[1]);
  });

  it("takes the LAST documented condition — a deferral changes by a new comment", () => {
    const sweep = sweepIssues(
      [
        blocked(5, "M1", [
          "Bedingung: wartet auf #3 — Ziel-Phase M2",
          "Condition: now waiting on #7 — target phase M3",
        ]),
      ],
      config,
      norms,
    );
    expect(sweep.queue[0]?.blockedComment).toContain("#7");
  });

  it("reads a condition written as prose, when it names a phase as well", () => {
    const sweep = sweepIssues(
      [blocked(5, "M1", ["Zurückgestellt, die condition ist #3; frühestens Phase M3."])],
      config,
      norms,
    );
    expect(sweep.queue[0]?.blockedComment).toContain("frühestens Phase M3");
  });

  it("reports an undocumented block as null rather than inventing a condition", () => {
    const sweep = sweepIssues([blocked(5, "M1", ["Looks unrelated to me."])], config, norms);
    expect(sweep.queue[0]?.blocked).toBe(true);
    expect(sweep.queue[0]?.blockedComment).toBeNull();
  });

  it("leaves an unblocked entry without the two fields at all", () => {
    const sweep = sweepIssues([issue(4, ["spec-sync"], "M1")], config, norms);
    expect(sweep.queue[0]).not.toHaveProperty("blocked");
    expect(sweep.queue[0]).not.toHaveProperty("blockedComment");
  });

  // The hold is the owner taking a ticket off the table; the block is a
  // condition anyone may find fulfilled. Only the hold excludes.
  it("leaves a ticket carrying both labels in `held` — the hold wins", () => {
    const sweep = sweepIssues(
      [issue(5, ["spec-sync", "blocked", "owner-hold"], "M1")],
      config,
      norms,
    );
    expect(sweep.held.map((ref) => ref.issue)).toEqual([5]);
    expect(sweep.queue).toEqual([]);
  });

  it("names the count and the first buildable entry in the summary", async () => {
    const { gh } = fakeGh({
      issues: [
        blocked(4, "M1", ["Bedingung: #9 zuerst — Ziel-Phase M2"]),
        blocked(5, "M1", ["Bedingung: #9 zuerst — Ziel-Phase M2"]),
        issue(6, ["spec-sync"], "M1"),
      ],
      runs: [{ conclusion: "success", createdAt: "2026-07-26T06:00:00.000Z" }],
    });
    const result = await runQueue(deps(gh), config, { check: false }, norms);

    expect(result.notes.join("\n")).toContain("2 blocked ticket(s) carried at their position");
    expect(result.notes.join("\n")).toContain("first buildable: #6");
  });

  it("says so when every queued ticket is blocked, rather than naming none", async () => {
    const { gh } = fakeGh({
      issues: [blocked(4, "M1", ["Bedingung: #9 zuerst — Ziel-Phase M2"])],
      runs: [{ conclusion: "success", createdAt: "2026-07-26T06:00:00.000Z" }],
    });
    const result = await runQueue(deps(gh), config, { check: false }, norms);
    expect(result.notes.join("\n")).toContain("every queued ticket is blocked");
  });

  it("counts an undocumented block in the summary, so it cannot pass unnoticed", async () => {
    const { gh } = fakeGh({
      issues: [blocked(4, "M1", []), issue(6, ["spec-sync"], "M1")],
      runs: [{ conclusion: "success", createdAt: "2026-07-26T06:00:00.000Z" }],
    });
    const result = await runQueue(deps(gh), config, { check: false }, norms);
    expect(result.notes.join("\n")).toContain("1 of them without a documented condition comment");
  });

  it("says nothing about blocked tickets when there are none", async () => {
    const { gh } = fakeGh({
      issues: [issue(6, ["spec-sync"], "M1")],
      runs: [{ conclusion: "success", createdAt: "2026-07-26T06:00:00.000Z" }],
    });
    const result = await runQueue(deps(gh), config, { check: false }, norms);
    expect(result.notes.join("\n")).not.toContain("blocked");
  });
});

describe("priority class — sort level ½ (SST-DESIGN-017 rev 6, PROC-DEV-039 rev 3)", () => {
  const order = (sweep: { queue: { issue: number }[] }) => sweep.queue.map((entry) => entry.issue);

  it("AC1: same phase, P3 / none / P1 → P1, unclassified, P3; the unclassified one is listed", () => {
    const sweep = sweepIssues(
      [
        issue(3, ["spec-sync", "P3 polish"], "M2"),
        issue(5, ["spec-sync"], "M2"),
        issue(7, ["spec-sync", "P1 must"], "M2"),
      ],
      config,
      norms,
    );
    expect(order(sweep)).toEqual([7, 5, 3]);
    expect(sweep.queue.map((entry) => entry.class)).toEqual(["must", "unclassified", "polish"]);
    expect(sweep.unclassified).toEqual([{ issue: 5, title: "ticket 5" }]);
    expect(sweep.labelDrift).toEqual([]);
  });

  it("AC2: a P2 build ticket sorts ahead of a P3 auto-audit ticket", () => {
    const sweep = sweepIssues(
      [issue(2, ["auto-audit", "P3 polish"], "M1"), issue(8, ["spec-sync", "P2 important"], "M1")],
      config,
      norms,
    );
    expect(order(sweep)).toEqual([8, 2]);
  });

  it("AC2: within P1, audit < bug < build, and started precedes unstarted", () => {
    const sweep = sweepIssues(
      [
        issue(1, ["spec-sync", "P1 must"], "M1"),
        issue(2, ["spec-sync", "P1 must", "status: in-progress"], "M3"),
        issue(3, ["type: bug", "P1 must"], "M1"),
        issue(4, ["auto-audit", "P1 must"], "M1"),
      ],
      config,
      norms,
    );
    expect(order(sweep)).toEqual([4, 3, 2, 1]);
  });

  it("AC3: P1 and P3 on one ticket → sorts as P1 and is a label-drift finding", () => {
    const sweep = sweepIssues(
      [
        issue(4, ["spec-sync", "P2 important"], "M1"),
        issue(9, ["spec-sync", "P1 must", "P3 polish"], "M1"),
      ],
      config,
      norms,
    );
    expect(order(sweep)).toEqual([9, 4]);
    expect(sweep.queue[0]?.class).toBe("must");
    expect(sweep.labelDrift).toHaveLength(1);
    expect(sweep.labelDrift[0]).toMatchObject({ kind: "label-drift", issue: 9 });
    expect(sweep.labelDrift[0]?.detail).toContain('"P1 must"');
    expect(sweep.labelDrift[0]?.detail).toContain('"P3 polish"');
  });

  it("AC4: without any class label the order is the four-tier order, all unclassified", () => {
    const issues = [
      issue(6, ["spec-sync"], "M2"),
      issue(5, ["spec-sync"], "M1"),
      issue(4, ["type: bug"], "M3"),
      issue(3, ["spec-sync", "status: in-progress"], "M3"),
      issue(2, ["auto-audit"], "M4"),
    ];
    const sweep = sweepIssues(issues, config, norms);
    expect(order(sweep)).toEqual([2, 4, 3, 5, 6]);
    expect(sweep.queue.every((entry) => entry.class === "unclassified")).toBe(true);
    expect(sweep.unclassified.map((entry) => entry.issue)).toEqual([2, 4, 3, 5, 6]);
  });

  it("honours configured class label names", () => {
    const custom = {
      ...config,
      labels: {
        ...config.labels,
        priority: { must: "prio:1", important: "prio:2", polish: "prio:3" },
      },
    } as Config;
    const sweep = sweepIssues(
      [
        issue(1, ["spec-sync", "prio:3"], "M1"),
        issue(2, ["spec-sync", "P1 must"], "M1"),
        issue(3, ["spec-sync", "prio:1"], "M1"),
      ],
      custom,
      norms,
    );
    expect(order(sweep)).toEqual([3, 2, 1]);
    expect(sweep.queue.map((entry) => entry.class)).toEqual(["must", "unclassified", "polish"]);
  });

  it("the summary names the count per class and lists unclassified and the drift", async () => {
    const { gh } = fakeGh({
      issues: [
        issue(1, ["spec-sync", "P1 must"], "M1"),
        issue(2, ["spec-sync", "P1 must", "P2 important"], "M1"),
        issue(3, ["spec-sync"], "M1"),
        issue(4, ["spec-sync", "P3 polish"], "M1"),
      ],
      runs: [{ conclusion: "success", createdAt: "2026-07-26T06:00:00.000Z" }],
    });
    const result = await runQueue(deps(gh), config, { check: false }, norms);
    expect(result.notes.join("\n")).toContain(
      "classes: 2 must, 0 important, 1 polish, 1 unclassified",
    );
    expect(result.data.unclassified).toEqual([{ issue: 3, title: "ticket 3" }]);
    expect(result.data.findings).toEqual([
      expect.objectContaining({ kind: "label-drift", issue: 2 }),
    ]);
  });

  it("leaves --check unchanged", async () => {
    const { gh } = fakeGh({
      issues: [
        issue(5, ["spec-sync", "P3 polish"], "M1"),
        issue(9, ["spec-sync", "P1 must"], "M1"),
      ],
    });
    const result = await runQueue(deps(gh), config, { check: true }, norms);
    expect(result.data).toEqual({ open: 2, next: 9 });
  });
});
