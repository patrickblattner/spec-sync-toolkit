import { describe, expect, it } from "vitest";
import {
  BOT_LOGIN,
  HEALTH_MAX_TICKETS,
  ISSUE_LIMIT,
  parseQueueOptions,
  quotaStarts,
  readPhasePin,
  runQueue,
  specArea,
  sweepIssues,
  type GhIssue,
  type QueueDeps,
} from "../src/commands/queue.js";
import { NORM_DEFAULTS } from "../src/norms.js";
import { EXIT, ToolkitError, formatJson } from "../src/output.js";
import type { Config } from "../src/config.js";
import { findSpecKeys } from "../src/pack/refs.js";

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
    sweep: "sweep",
    pipeline: "pipeline",
    product: "product",
    mergeBlocker: "merge-blocker",
    nonProduct: [],
    priority: { must: "P1 must", important: "P2 important", polish: "P3 polish" },
  },
  review: { securityLabel: "security", label: "review-codex" },
  nightlyWorkflow: "nightly.yml",
  health: { p1MaxShare: 0.25, p1MinQueue: 8, staleBlockDays: 7, quotaUnclassifiedMax: 0 },
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
function fakeGh(
  answers: {
    issues?: GhIssue[];
    runs?: unknown[];
    runsFail?: string;
    /** `gh issue view <n>` answers: the labels of a closed ticket. */
    views?: Record<number, string[]>;
  } = {},
) {
  const calls: string[][] = [];
  const gh = async (args: string[]): Promise<string> => {
    calls.push(args);
    if (args[0] === "issue" && args[1] === "view") {
      const labels = answers.views?.[Number(args[2])];
      if (labels === undefined) throw new Error(`no issue ${args[2] ?? ""}`);
      return JSON.stringify({ labels: labels.map((name) => ({ name })) });
    }
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

describe("complete sweep — no silent truncation (SST-DESIGN-017 rev 9)", () => {
  it("sweeps all 214 open issues and puts the oldest P1 at the head", async () => {
    const issues = Array.from({ length: 214 }, (_, index) =>
      issue(index + 1, ["spec-sync", index === 0 ? "P1 must" : "P2 important"], "M1"),
    );
    const { gh, calls } = fakeGh({ issues });
    expect((await runQueue(deps(gh), config, { check: true }, norms)).data).toEqual({
      open: 214,
      next: 1,
    });
    expect(calls[0]).toContain(String(ISSUE_LIMIT));
  });

  it("aborts with exit 4 when the fetch reaches the safety cap", async () => {
    const issues = Array.from({ length: ISSUE_LIMIT }, (_, index) =>
      issue(index + 1, ["spec-sync"], "M1"),
    );
    const { gh } = fakeGh({ issues });
    const run = runQueue(deps(gh), config, { check: true }, norms);
    await expect(run).rejects.toThrowError(/safety cap of 10000/);
    await expect(run).rejects.toMatchObject({ exit: EXIT.PRECONDITION });
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
    expect(parseQueueOptions([])).toEqual({ check: false, health: false, bundle: false });
    expect(parseQueueOptions(["--check"])).toEqual({ check: true, health: false, bundle: false });
    expect(parseQueueOptions(["--health"])).toEqual({ check: false, health: true, bundle: false });
    expect(parseQueueOptions(["--bundle"])).toEqual({ check: false, health: false, bundle: true });
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

describe("product quota (SST-DESIGN-017 rev 11, PROC-DEV-039 rev 5 level ¼)", () => {
  const order = (issues: GhIssue[], recent: boolean[] = [], cfg: Config = config) =>
    sweepIssues(issues, cfg, norms, recent).queue.map((entry) => entry.issue);
  const reviewPr = (issueNo: number, pr: number, at: string, mode = "pr") => ({
    at,
    type: "review" as const,
    issue: issueNo,
    pr,
    mode,
  });

  it("bypass: P1 audit, P1 security and a merge-blocker go ahead of product and pipeline", () => {
    expect(
      order([
        issue(1, ["spec-sync", "product", "P1 must"], "M1"),
        issue(2, ["spec-sync", "pipeline", "P1 must"], "M1"),
        issue(3, ["spec-sync", "merge-blocker", "P2 important"], "M3"),
        issue(4, ["spec-sync", "security", "P1 must"], "M2"),
        issue(5, ["auto-audit", "P1 must"], "M1"),
      ]),
    ).toEqual([5, 4, 3, 1, 2]);
  });

  it("third slot: pipeline, escalated sweep, due sweep, then other non-product by the levels", () => {
    expect(
      order([
        issue(1, ["spec-sync", "P1 must"], "M1"),
        issue(2, ["spec-sync", "sweep", "P2 important"]),
        issue(3, ["spec-sync", "sweep", "P1 must"]),
        issue(4, ["spec-sync", "pipeline", "P1 must"], "M4"),
      ]),
    ).toEqual([4, 3, 2, 1]);
  });

  it("two of the last three starts non-product → the product head, even with a pipeline ticket open", () => {
    const issues = [
      issue(1, ["spec-sync", "pipeline", "P1 must"], "M1"),
      issue(2, ["spec-sync", "product", "P3 polish"], "M2"),
    ];
    expect(order(issues, [true, false, false])[0]).toBe(2);
  });

  it("an escalated sweep vs a product ticket: the quota decides, not the sweep label", () => {
    const issues = [
      issue(1, ["spec-sync", "sweep", "P1 must"]),
      issue(2, ["spec-sync", "product", "P2 important"], "M1"),
    ];
    expect(order(issues, [false, true, false])[0]).toBe(2);
    expect(order(issues, [true, true, false])[0]).toBe(1);
  });

  it("quota has room → the better head by the levels, a non-product head allowed", () => {
    const issues = [
      issue(1, ["spec-sync", "pipeline", "P1 must"], "M1"),
      issue(2, ["spec-sync", "product", "P2 important"], "M1"),
      issue(3, ["spec-sync", "product", "P2 important"], "M1"),
      issue(4, ["spec-sync", "sweep", "P2 important"]),
    ];
    // window [P, P, P] → pipeline (P1) first; then [P, P, N] → product 2 (P2, older
    // than sweep 4); then [P, N, P] → product 3 by the levels; then the sweep.
    expect(order(issues, [true, true, true])).toEqual([1, 2, 3, 4]);
    // window [N, N] → product 2; [N, N, P] still has two non-product → product 3.
    expect(order(issues, [false, false])).toEqual([2, 3, 1, 4]);
  });

  it("no buildable product ticket → the third-slot head despite the quota", () => {
    const issues = [
      issue(1, ["spec-sync", "product", "blocked", "P1 must"], "M1"),
      issue(2, ["spec-sync", "sweep", "P2 important"]),
    ];
    expect(order(issues, [false, false, false])[0]).toBe(2);
  });

  it("a repo without product labels sorts as before: every ticket in the third slot", () => {
    const sweep = sweepIssues(
      [issue(1, ["spec-sync", "P3 polish"], "M1"), issue(2, ["spec-sync", "P1 must"], "M2")],
      config,
      norms,
      [false, false, false],
    );
    expect(sweep.queue.map((entry) => [entry.issue, entry.slot])).toEqual([
      [2, "third"],
      [1, "third"],
    ]);
    expect(sweep.queue[0]).not.toHaveProperty("lane");
  });

  it("a sweep ticket without a phase pin counts to the current phase, never needsPin", () => {
    const sweep = sweepIssues([issue(8, ["spec-sync", "sweep", "P2 important"])], config, norms);
    expect(sweep.needsPin).toEqual([]);
    expect(sweep.queue[0]).toMatchObject({ issue: 8, pin: "aktuell", sweep: "due" });
  });

  it("the quota label names are configurable", () => {
    const custom = {
      ...config,
      labels: { ...config.labels, product: "kind: product", mergeBlocker: "stop-the-line" },
    } as Config;
    const issues = [
      issue(1, ["spec-sync", "pipeline", "P1 must"], "M1"),
      issue(2, ["spec-sync", "kind: product", "P3 polish"], "M1"),
      issue(3, ["spec-sync", "stop-the-line", "P3 polish"], "M1"),
    ];
    expect(order(issues, [false, false], custom)).toEqual([3, 2, 1]);
  });

  it("starts: merge-started each, a PR's first pr review once; rechecks and batch runs never", () => {
    expect(
      quotaStarts([
        reviewPr(10, 100, "2026-11-11T01:00:00Z"),
        reviewPr(10, 100, "2026-11-11T01:10:00Z", "recheck"),
        reviewPr(10, 100, "2026-11-11T01:20:00Z"),
        { at: "2026-11-11T01:30:00Z", type: "review", mode: "batch" },
        { at: "2026-11-11T02:00:00Z", type: "merge-started", issue: 11, branch: "b" },
        { at: "2026-11-11T02:05:00Z", type: "gate", issue: 12, ok: true },
        reviewPr(12, 101, "2026-11-11T03:00:00Z"),
      ]),
    ).toEqual([
      { at: "2026-11-11T01:00:00Z", issue: 10, source: "review-pr" },
      { at: "2026-11-11T02:00:00Z", issue: 11, source: "merge-started" },
      { at: "2026-11-11T03:00:00Z", issue: 12, source: "review-pr" },
    ]);
  });

  it("queue reads the last three starts from the ledger and shows the quota state", async () => {
    const { gh, calls } = fakeGh({
      issues: [
        issue(1, ["spec-sync", "pipeline", "P1 must"], "M1"),
        issue(2, ["spec-sync", "product", "P2 important"], "M1"),
        issue(7, ["spec-sync", "product", "P2 important"], "M1"),
      ],
      views: { 5: ["spec-sync", "pipeline"], 6: ["spec-sync", "sweep"] },
    });
    const ledger = () => [
      reviewPr(4, 40, "2026-11-10T01:00:00Z"),
      reviewPr(7, 70, "2026-11-10T02:00:00Z"),
      reviewPr(5, 50, "2026-11-10T03:00:00Z"),
      reviewPr(6, 60, "2026-11-10T04:00:00Z"),
    ];
    const result = await runQueue(deps(gh, { ledger }), config, { check: false }, norms);
    const queue = result.data.queue as { issue: number; slot: string }[];
    expect(queue.map((entry) => entry.issue)).toEqual([2, 7, 1]);
    expect(result.data.quota).toMatchObject({
      starts: [
        { issue: 7, kind: "product" },
        { issue: 5, kind: "non-product" },
        { issue: 6, kind: "non-product" },
      ],
      nonProduct: 2,
      forced: true,
      head: "product",
    });
    expect(result.notes.some((note) => note.includes("head from the product slot"))).toBe(true);
    // #4 is outside the window: no view call for it; #7 is open and read from the list.
    expect(calls.filter((call) => call[1] === "view").map((call) => call[2])).toEqual(["5", "6"]);
  });

  it("a start whose labels cannot be read counts as unknown, not product", async () => {
    const { gh } = fakeGh({ issues: [issue(2, ["spec-sync", "product", "P2 important"], "M1")] });
    const ledger = () => [reviewPr(9, 90, "2026-11-10T01:00:00Z")];
    const result = await runQueue(deps(gh, { ledger }), config, { check: false }, norms);
    expect(result.data.quota).toMatchObject({
      starts: [{ issue: 9, kind: "unknown" }],
      nonProduct: 1,
    });
  });

  it("--check stays a single gh call and reads no ledger", async () => {
    const { gh, calls } = fakeGh({ issues: [issue(2, ["spec-sync", "product"], "M1")] });
    let read = false;
    const ledger = () => {
      read = true;
      return [];
    };
    await runQueue(deps(gh, { ledger }), config, { check: true }, norms);
    expect(calls).toHaveLength(1);
    expect(read).toBe(false);
  });

  it("--health warns about tickets unclassified for the quota without failing", async () => {
    const issues = [
      issue(1, ["spec-sync", "product", "P2 important"], "M1"),
      issue(2, ["spec-sync", "pipeline", "P1 must"], "M1"),
      issue(3, ["spec-sync", "P2 important"], "M1"),
      issue(4, ["spec-sync", "chore: norm", "P3 polish"], "M1"),
    ];
    const { gh } = fakeGh({ issues });
    const result = await runQueue(deps(gh), config, { check: false, health: true }, norms);
    expect(result.exit).toBe(EXIT.OK);
    expect(result.data.findings).toEqual([]);
    expect(result.data.warnings).toMatchObject([
      { check: "quota-unclassified", tickets: [3, 4], value: 2, threshold: 0 },
    ]);
    const relaxed = {
      ...config,
      labels: { ...config.labels, nonProduct: ["chore: norm"] },
      health: { ...config.health, quotaUnclassifiedMax: 1 },
    } as Config;
    const again = await runQueue(
      deps(fakeGh({ issues }).gh),
      relaxed,
      { check: false, health: true },
      norms,
    );
    expect(again.data.warnings).toEqual([]);
  });

  it("an escalated sweep is not counted against the p1-share threshold", async () => {
    const issues = [
      issue(1, ["spec-sync", "product", "P1 must"], "M1"),
      issue(2, ["spec-sync", "product", "P1 must"], "M1"),
      issue(3, ["spec-sync", "sweep", "P1 must"]),
      issue(4, ["spec-sync", "sweep", "P1 must"]),
      ...[5, 6, 7, 8, 9, 10].map((n) => issue(n, ["spec-sync", "product", "P2 important"], "M1")),
    ];
    const { gh } = fakeGh({ issues });
    const result = await runQueue(deps(gh), config, { check: false, health: true }, norms);
    expect(result.exit).toBe(EXIT.OK);
    expect(result.data.findings).toEqual([]);
  });
});

describe("--health — the sweep judged like a gate (SST-DESIGN-017 rev 7)", () => {
  const NOW = "2026-07-26T12:00:00.000Z";
  const daysAgo = (days: number) => new Date(Date.parse(NOW) - days * 86_400_000).toISOString();
  const classed = (number: number, cls: string, extra: string[] = []) =>
    issue(number, ["spec-sync", cls, ...extra], "M1");
  const dated = (base: GhIssue, comments: { body: string; createdAt: string }[]): GhIssue => ({
    ...base,
    comments: [...(base.comments ?? []), ...comments],
  });
  const health = async (issues: GhIssue[], cfg: Config = config) => {
    const { gh, calls } = fakeGh({ issues });
    const result = await runQueue(deps(gh), cfg, { check: false, health: true }, norms);
    const findings = result.data.findings as {
      check: string;
      tickets: number[];
      more: number;
      value: number;
      threshold: number;
    }[];
    return { result, calls, findings, checks: findings.map((f) => f.check) };
  };

  it("AC5: every ticket one class, P1 ≤ 25 %, no stale block → exit 0, no finding", async () => {
    const issues = [
      classed(1, "P1 must"),
      classed(2, "P1 must"),
      ...[3, 4, 5, 6, 7, 8].map((n) => classed(n, "P2 important")),
      dated(classed(9, "P3 polish", ["blocked"]), [
        { body: "Condition: waits for #3, Phase: M2", createdAt: daysAgo(6) },
      ]),
    ];
    const { result, findings } = await health(issues);
    expect(result.ok).toBe(true);
    expect(result.exit).toBe(EXIT.OK);
    expect(findings).toEqual([]);
  });

  it("AC6: unclassified + 3 of 10 P1 + an 8-day-old block → exit 1, three findings, nothing written", async () => {
    const issues = [
      classed(1, "P1 must"),
      classed(2, "P1 must"),
      classed(3, "P1 must"),
      issue(4, ["spec-sync"], "M1"),
      ...[5, 6, 7, 8, 9].map((n) => classed(n, "P2 important")),
      dated(classed(10, "P3 polish", ["blocked"]), [
        { body: "Condition: waits for #99, Phase: M2", createdAt: daysAgo(8) },
      ]),
    ];
    const { result, calls, findings, checks } = await health(issues);
    expect(result.ok).toBe(false);
    expect(result.exit).toBe(EXIT.FAILED);
    expect(checks).toEqual(["unclassified", "p1-share", "stale-block"]);
    expect(findings[0]).toMatchObject({ tickets: [4], value: 1, threshold: 0 });
    expect(findings[1]).toMatchObject({ tickets: [1, 2, 3], value: 0.3, threshold: 0.25 });
    expect((findings[1] as unknown as { detail: string }).detail).toContain(
      "30 % (3 of 10) > 25 %",
    );
    expect(findings[2]).toMatchObject({ tickets: [10], value: 8, threshold: 7 });
    // Writes nothing: the only gh call is the read-only issue list, no nightly call.
    expect(calls).toHaveLength(1);
    expect(calls[0]?.slice(0, 2)).toEqual(["issue", "list"]);
    expect(calls[0]).toContain("number,title,labels,author,comments,updatedAt");
  });

  it("AC7: 2 of 4 P1 → no p1-share finding below the minimum queue", async () => {
    const { result, checks } = await health([
      classed(1, "P1 must"),
      classed(2, "P1 must"),
      classed(3, "P2 important"),
      classed(4, "P3 polish"),
    ]);
    expect(checks).toEqual([]);
    expect(result.exit).toBe(EXIT.OK);
  });

  it("reports a ticket with several class labels as several-classes", async () => {
    const { checks, findings, result } = await health([
      classed(1, "P2 important"),
      classed(2, "P1 must", ["P3 polish"]),
    ]);
    expect(checks).toEqual(["several-classes"]);
    expect(findings[0]).toMatchObject({ tickets: [2], value: 1, threshold: 0 });
    expect(result.exit).toBe(EXIT.FAILED);
  });

  it("names at most ten tickets per finding, then counts the rest", async () => {
    const issues = Array.from({ length: 13 }, (_, i) => issue(i + 1, ["spec-sync"], "M1"));
    const { findings } = await health(issues);
    expect(findings[0]?.tickets).toHaveLength(HEALTH_MAX_TICKETS);
    expect(findings[0]?.more).toBe(3);
    expect((findings[0] as unknown as { detail: string }).detail).toContain("+3 more");
  });

  it("falls back to updatedAt for a blocked ticket without a dated comment", async () => {
    const stale = {
      ...issue(1, ["spec-sync", "P2 important", "blocked"], "M1"),
      updatedAt: daysAgo(9),
    };
    const fresh = {
      ...issue(2, ["spec-sync", "P2 important", "blocked"], "M1"),
      updatedAt: daysAgo(1),
    };
    const { checks, findings } = await health([stale, fresh]);
    expect(checks).toEqual(["stale-block"]);
    expect(findings[0]?.tickets).toEqual([1]);
  });

  it("honours configured thresholds", async () => {
    const strict = {
      ...config,
      health: { p1MaxShare: 0.1, p1MinQueue: 4, staleBlockDays: 2 },
    } as unknown as Config;
    const issues = [
      classed(1, "P1 must"),
      classed(2, "P2 important"),
      classed(3, "P2 important"),
      dated(classed(4, "P3 polish", ["blocked"]), [
        { body: "Condition: x, Phase: M2", createdAt: daysAgo(3) },
      ]),
    ];
    expect((await health(issues)).checks).toEqual([]);
    const { checks, findings } = await health(issues, strict);
    expect(checks).toEqual(["p1-share", "stale-block"]);
    expect(findings[0]).toMatchObject({ value: 0.25, threshold: 0.1 });
    expect(findings[1]).toMatchObject({ value: 3, threshold: 2 });
  });

  it("AC8: a block waiting on a still-open ticket is skipped; with that ticket closed it counts", async () => {
    const waiting = dated(classed(5, "P2 important", ["blocked"]), [
      { body: "Waits on #7", createdAt: daysAgo(10) },
    ]);
    const dependency = classed(7, "P2 important");
    expect((await health([waiting, dependency])).checks).toEqual([]);
    // #7 no longer in the open set = closed.
    const closed = await health([waiting]);
    expect(closed.checks).toEqual(["stale-block"]);
    expect(closed.findings[0]).toMatchObject({ tickets: [5], value: 10, threshold: 7 });
  });

  it("skips a block whose newest comment names several tickets when at least one is open", async () => {
    const waiting = dated(classed(5, "P2 important", ["blocked"]), [
      { body: "Waits on #40 and #41, see also other/repo#7", createdAt: daysAgo(10) },
    ]);
    expect((await health([waiting, classed(41, "P2 important")])).checks).toEqual([]);
    // Only a cross-repo or self reference open → still stale.
    const crossRepo = await health([waiting, classed(7, "P2 important")]);
    expect(crossRepo.checks).toEqual(["stale-block"]);
  });

  it("judges only the newest comment for the dependency", async () => {
    const waiting = dated(classed(5, "P2 important", ["blocked"]), [
      { body: "Waits on #7", createdAt: daysAgo(20) },
      { body: "Condition: owner decision, Phase: M2", createdAt: daysAgo(10) },
    ]);
    expect((await health([waiting, classed(7, "P2 important")])).checks).toEqual(["stale-block"]);
  });

  it("rejects --health together with --check as a usage error (exit 4)", () => {
    let caught: ToolkitError | undefined;
    try {
      parseQueueOptions(["--health", "--check"]);
    } catch (error) {
      caught = error as ToolkitError;
    }
    expect(caught?.exit).toBe(EXIT.PRECONDITION);
    expect(caught?.field).toBe("--health");
  });
});

describe("queue --bundle (PROC-DEV-005 §Bundled tickets)", () => {
  const bundleConfig = {
    ...config,
    bundle: {
      maxTickets: 3,
      maxLines: 300,
      areaPrefix: "area: ",
      smallLabels: ["bug", "fix", "i18n", "translation", "a11y", "accessibility"],
      excludeKeywords: [
        "schema",
        "migration",
        "ratchet",
        "baseline",
        "measure",
        "registry",
        "registries",
        "visual",
      ],
    },
  } as unknown as Config;

  /** A swept polish ticket of one area; `title` and extra labels vary per case. */
  const small = (
    n: number,
    area: string | null,
    extra: string[] = [],
    title?: string,
  ): GhIssue => ({
    ...issue(
      n,
      ["spec-sync", "P3 polish", ...(area === null ? [] : [`area: ${area}`]), ...extra],
      "M1",
    ),
    ...(title === undefined ? {} : { title }),
  });

  const bundle = async (issues: GhIssue[]) => {
    const { gh, calls } = fakeGh({ issues });
    const result = await runQueue(deps(gh), bundleConfig, {
      check: false,
      health: false,
      bundle: true,
    });
    return { result, calls, data: result.data as Record<string, unknown> };
  };

  it("bundles up to three adjacent small tickets of one area, head first", async () => {
    const { result, calls, data } = await bundle([
      small(1, "frontend"),
      small(2, "frontend"),
      small(3, "frontend"),
      small(4, "frontend"),
    ]);
    expect(result.ok).toBe(true);
    expect(data).toMatchObject({ bundle: [1, 2, 3], area: "frontend", lineCap: 300, excluded: [] });
    expect(result.notes).toEqual([
      "bundle #1, #2, #3 (area: frontend) — keep it under ~300 changed lines, measured after building",
    ]);
    // Like --health: no nightly call, the sweep's single gh call only.
    expect(calls).toHaveLength(1);
  });

  it("does not change the order: the bundle follows the sorted queue", async () => {
    // #9 is P1 and therefore the head, even though #1 is older.
    const { data } = await bundle([
      small(1, "frontend"),
      { ...issue(9, ["spec-sync", "P1 must", "type: bug", "area: frontend"], "M1") },
    ]);
    expect(data.bundle).toEqual([9, 1]);
  });

  it("a ticket of another area ends the run, and the reason is named", async () => {
    const { data, result } = await bundle([
      small(1, "frontend"),
      small(2, "backend"),
      small(3, "frontend"),
    ]);
    expect(data).toMatchObject({
      bundle: [1],
      area: null,
      excluded: [{ issue: 2, reason: "other area (area: backend)" }],
    });
    expect(result.notes).toEqual(["no bundle — #1 alone"]);
  });

  it.each<[string, GhIssue, string]>([
    ["a migration", small(2, "frontend", [], "Block IDs: schema + migration"), 'keyed "schema"'],
    [
      "a ratchet baseline",
      small(2, "frontend", [], "Raise the ratchet baseline"),
      'keyed "ratchet"',
    ],
    [
      "a registry change",
      small(2, "frontend", [], "Add to the obligations registry"),
      'keyed "registry"',
    ],
    ["a visual change", small(2, "frontend", ["visual-regression"]), 'keyed "visual"'],
    [
      "a measure change",
      small(2, "frontend", [], "measure: raise the size limit"),
      'keyed "measure"',
    ],
    ["a blocked ticket", small(2, "frontend", ["blocked"]), "blocked"],
    [
      "a non-small ticket",
      issue(2, ["spec-sync", "P2 important", "area: frontend"], "M1"),
      "not small (no bug, polish, translation or accessibility label)",
    ],
    ["a ticket without area", small(2, null), 'no "area: …" label and no spec key'],
  ])("never bundles %s", async (_name, candidate, reason) => {
    // A P2 head with a small label, so a P2 candidate cannot sort above it.
    const head = issue(1, ["spec-sync", "P2 important", "area: frontend", "bug"], "M1");
    const { data } = await bundle([head, candidate]);
    expect(data).toMatchObject({ bundle: [1], excluded: [{ issue: 2, reason }] });
  });

  it("counts translation and accessibility labels as small", async () => {
    const { data } = await bundle([
      { ...issue(1, ["spec-sync", "P2 important", "area: frontend", "i18n"], "M1") },
      { ...issue(2, ["spec-sync", "P2 important", "area: frontend", "a11y"], "M1") },
    ]);
    expect(data.bundle).toEqual([1, 2]);
  });

  it("an unbundleable head stands alone, with its reason", async () => {
    const { data } = await bundle([
      issue(1, ["spec-sync", "P2 important", "area: frontend"], "M1"),
      small(2, "frontend"),
    ]);
    expect(data).toMatchObject({
      bundle: [1],
      area: null,
      excluded: [{ issue: 1, reason: expect.stringContaining("not small") }],
    });
  });

  it("without an area label, derives the area from the spec keys in title and body", async () => {
    const { data, result, calls } = await bundle([
      small(1, null, [], "Asset classes: course-bound media (COM-FEATURE-CONT-100 r2)"),
      {
        ...small(2, null, [], "Protected copy follows replacement"),
        body: "Spec: `COM-DESIGN-CONT-103` rev 4",
      },
      small(3, null, [], "Library sort order (COM-FEATURE-CONT-104, COM-GL-CONT-010)"),
      small(4, null, [], "Kurs notes (COM-FEATURE-KURS-010 r2)"),
    ]);
    expect(data).toMatchObject({
      bundle: [1, 2, 3],
      area: "CONT",
      areaSource: "keys",
      excluded: [],
    });
    expect(result.notes?.[0]).toContain("(spec area CONT)");
    // The body is fetched only for --bundle.
    expect(calls[0]).toContain("number,title,labels,author,comments,updatedAt,body");
  });

  it.each<[string, GhIssue, string]>([
    [
      "keys of several areas",
      small(2, null, [], "Tooltips (GL-UI-016 rev 19, COM-FEATURE-CONT-100)"),
      "spec keys span several areas (GL-UI, CONT)",
    ],
    [
      "a key without an area",
      small(2, null, [], "Leave guard (COM-FEATURE-591 r2)"),
      "spec key COM-FEATURE-591 names no area",
    ],
    [
      "another spec area",
      small(2, null, [], "Kurs notes (COM-FEATURE-KURS-010 r2)"),
      "other area (spec area KURS)",
    ],
  ])("a follower with %s ends the run", async (_name, candidate, reason) => {
    const head = small(1, null, [], "Asset classes (COM-FEATURE-CONT-100 r2)");
    const { data } = await bundle([head, candidate]);
    expect(data).toMatchObject({ bundle: [1], area: null, excluded: [{ issue: 2, reason }] });
  });

  it("the label wins over the keys, and a label area never equals a key area", async () => {
    const { data } = await bundle([
      small(1, "CONT", [], "Asset classes (COM-FEATURE-KURS-014 r2)"),
      small(2, null, [], "Library (COM-FEATURE-CONT-104)"),
    ]);
    expect(data).toMatchObject({
      bundle: [1],
      excluded: [{ issue: 2, reason: "other area (spec area CONT)" }],
    });
  });

  it("specArea reads the segments between kind and number", () => {
    expect(specArea("COM-FEATURE-CONT-100")).toBe("CONT");
    expect(specArea("CPT-FEATURE-TPL-061")).toBe("TPL");
    expect(specArea("COM-PROC-HYG-025")).toBe("HYG");
    expect(specArea("GL-UI-034")).toBe("GL-UI");
    expect(specArea("PROC-DEV-005")).toBe("PROC-DEV");
    expect(specArea("COM-FEATURE-591")).toBeUndefined();
    expect(specArea("COM-GL-071")).toBeUndefined();
    expect(specArea("PROC-010")).toBeUndefined();
    expect(specArea("AUTH-040")).toBeUndefined();
  });

  it("findSpecKeys finds bare and backticked keys in the shape pack parses", () => {
    expect(
      findSpecKeys(
        "Fix (COM-FEATURE-411 r6, GL-UI-039 r2) and `SST-DESIGN-018`; not X-1 or GL-UI-0345",
      ),
    ).toEqual(["COM-FEATURE-411", "GL-UI-039", "SST-DESIGN-018"]);
  });

  it("an empty queue proposes nothing", async () => {
    const { data, result } = await bundle([]);
    expect(data).toMatchObject({ bundle: [], area: null, excluded: [] });
    expect(result.notes).toEqual(["queue empty — nothing to bundle"]);
  });

  it("rejects --bundle together with --check or --health (exit 4)", () => {
    for (const other of ["--check", "--health"]) {
      let caught: ToolkitError | undefined;
      try {
        parseQueueOptions(["--bundle", other]);
      } catch (error) {
        caught = error as ToolkitError;
      }
      expect(caught?.exit).toBe(EXIT.PRECONDITION);
      expect(caught?.field).toBe("--bundle");
    }
  });
});
