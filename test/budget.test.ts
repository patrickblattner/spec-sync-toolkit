import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  AMBIGUITY_WINDOW_MS,
  contextIncrements,
  derive,
  latestContextEvent,
  p90PerTicket,
  projectSlug,
  rawUsageCount,
  readContext,
  resolveTranscript,
  usageEntries,
} from "../src/budget.js";
import { parseBudgetOptions, runBudget } from "../src/commands/budget.js";
import { appendEvent, ledgerPath, readLedger, type LedgerEvent } from "../src/ledger.js";
import { EXIT, ToolkitError } from "../src/output.js";
import type { CommandContext } from "../src/cli.js";
import type { Config } from "../src/config.js";

/** A real transcript excerpt, entries slimmed to the fields the measurement reads. */
const FIXTURE = fileURLToPath(new URL("./fixtures/transcript-streaming.jsonl", import.meta.url));

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
  return mkdtempSync(join(tmpdir(), "spec-sync-budget-"));
}

/** A `$HOME` carrying `.claude/projects/<slug>/` for `repoRoot`. */
function home(repoRoot: string, files: Record<string, string> = {}): string {
  const root = mkdtempSync(join(tmpdir(), "spec-sync-home-"));
  const dir = join(root, ".claude", "projects", projectSlug(repoRoot));
  mkdirSync(dir, { recursive: true });
  for (const [name, content] of Object.entries(files)) writeFileSync(join(dir, name), content);
  return root;
}

function touch(path: string, msAgo: number): void {
  const seconds = (Date.now() - msAgo) / 1000;
  utimesSync(path, seconds, seconds);
}

function ctx(repoRoot: string, contextBudget = 800_000): CommandContext {
  return {
    flags: { human: false, dryRun: false },
    args: [],
    repoRoot,
    config: { contextBudget } as Config,
  };
}

describe("DECISION (usage-dedup) — counted per message.id (spec §7.8, M6)", () => {
  const raw = readFileSync(FIXTURE, "utf8");

  it("drops the streaming repeats: the fixture's raw count is over 1.5x the deduplicated one", () => {
    const deduplicated = usageEntries(raw);
    const factor = rawUsageCount(raw) / deduplicated.length;

    // The measured range is 1.6–2.6 across client versions; M6 demands the
    // fixture prove more than 1.5, so a reader that forgot to deduplicate fails
    // here rather than shipping an inflated context level.
    expect(factor).toBeGreaterThan(1.5);
    expect(rawUsageCount(raw)).toBe(59);
    expect(deduplicated).toHaveLength(22);
  });

  it("keeps every id exactly once, in file order", () => {
    const ids = usageEntries(raw).map((entry) => entry.messageId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("takes the youngest entry as the context level, never the sum", () => {
    const entries = usageEntries(raw);
    const sum = entries.reduce((total, entry) => total + entry.context, 0);
    const { context } = readContext(FIXTURE);

    expect(context).toBe(entries[entries.length - 1]?.context);
    expect(context).toBe(198_217);
    // The last call carries the whole window; summing the session would report
    // an order of magnitude too much.
    expect(sum).toBeGreaterThan(context * 10);
  });

  it("adds input, cache-read and cache-creation tokens of that entry", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: {
        id: "msg_x",
        usage: { input_tokens: 3, cache_read_input_tokens: 100, cache_creation_input_tokens: 20 },
      },
    });
    expect(usageEntries(line)[0]?.context).toBe(123);
  });

  it("ignores lines that are not assistant entries with a usage block", () => {
    const lines = [
      JSON.stringify({ type: "user", message: { role: "user", content: "…" } }),
      JSON.stringify({ type: "assistant", message: { id: "msg_y" } }),
      "{ half-written",
      JSON.stringify({ type: "assistant", message: { id: "msg_z", usage: { input_tokens: 5 } } }),
    ].join("\n");

    expect(usageEntries(lines)).toEqual([{ messageId: "msg_z", context: 5 }]);
  });
});

describe("session assignment (spec §7.8)", () => {
  it("derives the transcript directory from the absolute repo path", () => {
    expect(projectSlug("/Users/pbl/projects/spec-sync-toolkit")).toBe(
      "-Users-pbl-projects-spec-sync-toolkit",
    );
    // Dots are replaced too — a repo named `foo.bar` lives under `foo-bar`.
    expect(projectSlug("/tmp/foo.bar")).toBe("-tmp-foo-bar");
  });

  it("takes --session as a session id and looks it up in the project directory", () => {
    const root = repo();
    const h = home(root, { "abc-123.jsonl": "" });
    expect(resolveTranscript(root, h, "abc-123").file).toBe(
      join(h, ".claude", "projects", projectSlug(root), "abc-123.jsonl"),
    );
  });

  it("takes --session as a file path when it looks like one", () => {
    const root = repo();
    expect(resolveTranscript(root, home(root), FIXTURE).file).toBe(FIXTURE);
  });

  it("chooses the most recently modified transcript and says so in a note", () => {
    const root = repo();
    const h = home(root, { "old.jsonl": "", "new.jsonl": "" });
    const dir = join(h, ".claude", "projects", projectSlug(root));
    touch(join(dir, "old.jsonl"), 3 * AMBIGUITY_WINDOW_MS);
    touch(join(dir, "new.jsonl"), 2 * AMBIGUITY_WINDOW_MS);

    const resolved = resolveTranscript(root, h, undefined);
    expect(resolved.file).toBe(join(dir, "new.jsonl"));
    expect(resolved.note).toContain("new");
  });

  it("exits 3 with the candidate list when several transcripts are live", () => {
    const root = repo();
    const h = home(root, { "one.jsonl": "", "two.jsonl": "" });
    const dir = join(h, ".claude", "projects", projectSlug(root));
    touch(join(dir, "one.jsonl"), 30_000);
    touch(join(dir, "two.jsonl"), 60_000);

    const error = thrown(() => resolveTranscript(root, h, undefined));
    expect(error.exit).toBe(EXIT.AMBIGUOUS);
    // Parallel sessions call with --session; the toolkit does not pick one.
    expect(error.message).toContain("one");
    expect(error.message).toContain("two");
  });

  it("is not ambiguous when only one file was touched inside the window", () => {
    const root = repo();
    const h = home(root, { "one.jsonl": "", "two.jsonl": "" });
    const dir = join(h, ".claude", "projects", projectSlug(root));
    touch(join(dir, "one.jsonl"), 30_000);
    touch(join(dir, "two.jsonl"), 4 * AMBIGUITY_WINDOW_MS);

    expect(resolveTranscript(root, h, undefined).file).toBe(join(dir, "one.jsonl"));
  });

  it("exits 4 when the project directory does not exist", () => {
    const root = repo();
    const error = thrown(() =>
      resolveTranscript(root, mkdtempSync(join(tmpdir(), "empty-")), undefined),
    );
    expect(error.exit).toBe(EXIT.PRECONDITION);
  });

  it("exits 4 when the named transcript is missing or unreadable", () => {
    const error = thrown(() => readContext(join(repo(), "nope.jsonl")));
    expect(error.exit).toBe(EXIT.PRECONDITION);
    expect(error.field).toBe("--session");
  });

  it("exits 4 when the transcript carries no usage entries at all", () => {
    const root = repo();
    const file = join(root, "empty.jsonl");
    writeFileSync(file, `${JSON.stringify({ type: "user" })}\n`);
    expect(thrown(() => readContext(file)).exit).toBe(EXIT.PRECONDITION);
  });
});

describe("derived numbers (spec §7.8)", () => {
  /** `context` values framing `merge-completed` events, as the ledger records them. */
  function history(values: number[]): LedgerEvent[] {
    const events: LedgerEvent[] = [{ at: "2026-07-29T10:00:00Z", type: "context", context: 0 }];
    values.forEach((value, index) => {
      events.push({ at: "2026-07-29T10:00:00Z", type: "merge-completed", issue: index, ok: true });
      events.push({ at: "2026-07-29T10:00:00Z", type: "context", context: value });
    });
    return events;
  }

  it("reads the growth per ticket as the difference of the values framing a merge", () => {
    expect(contextIncrements(history([100, 250, 400]))).toEqual([100, 150, 150]);
  });

  it("ignores a merge without a measurement behind it", () => {
    const events: LedgerEvent[] = [
      { at: "t", type: "context", context: 100 },
      { at: "t", type: "merge-completed", issue: 1, ok: true },
      // No `context` after this merge — nothing is estimated for it.
    ];
    expect(contextIncrements(events)).toEqual([]);
  });

  it("keeps p90 and forecast null below five measurements", () => {
    const increments = [10, 20, 30, 40];
    expect(p90PerTicket(increments)).toBeNull();
    expect(derive(0, 800_000, increments)).toEqual({ p90PerTicket: null, forecastTickets: null });
  });

  it("computes both from five measurements on", () => {
    const increments = [10_000, 20_000, 30_000, 40_000, 50_000];
    expect(p90PerTicket(increments)).toBe(50_000);
    expect(derive(300_000, 800_000, increments)).toEqual({
      p90PerTicket: 50_000,
      forecastTickets: 10,
    });
  });

  it("takes the p90 over the newest twenty increments only", () => {
    // Twenty-five points: the first five are huge and must fall out of the window.
    const increments = [...Array<number>(5).fill(900_000), ...Array<number>(20).fill(1_000)];
    expect(p90PerTicket(increments)).toBe(1_000);
  });

  it("reports no reach when the measured growth is zero", () => {
    // floor(x / 0) has no finite value, and "infinitely many tickets" is not a
    // measurement — it stays null like every other case the data does not carry.
    expect(derive(100, 800_000, Array<number>(5).fill(0))).toEqual({
      p90PerTicket: 0,
      forecastTickets: null,
    });
  });
});

describe("the context event is additive (spec §8, M6)", () => {
  /** The §8 type table as it stood before `context` existed. */
  const LEGACY_TYPES = [
    "drift",
    "section-mapped",
    "ticket-created",
    "gate",
    "merge-started",
    "merge-completed",
    "blocked",
  ];

  it("a reader built against the old type table skips it and reports nothing malformed", () => {
    const root = repo();
    appendEvent(root, { type: "gate", issue: 7, ok: true, profile: "merge" });
    appendEvent(root, { type: "context", context: 123_456, label: "after #7" });
    appendEvent(root, { type: "merge-completed", issue: 7, ok: true });

    const { events, malformedLines } = readLedger(root);
    // DECISION (ledger-tolerant-reader): an unknown type is kept, not discarded.
    expect(malformedLines).toEqual([]);
    expect(events).toHaveLength(3);

    const legacy = events.filter((event) => LEGACY_TYPES.includes(event.type));
    expect(legacy.map((event) => event.type)).toEqual(["gate", "merge-completed"]);
  });

  it("carries the timestamp, the value and the optional label", () => {
    const root = repo();
    appendEvent(root, { type: "context", context: 99, label: "start" });
    const line = JSON.parse(readFileSync(ledgerPath(root), "utf8").trim()) as LedgerEvent;
    expect(line).toMatchObject({ type: "context", context: 99, label: "start" });
    expect(typeof line.at).toBe("string");
  });

  it("finds the newest measurement", () => {
    const events: LedgerEvent[] = [
      { at: "t1", type: "context", context: 1 },
      { at: "t2", type: "gate" },
      { at: "t3", type: "context", context: 2 },
    ];
    expect(latestContextEvent(events)?.context).toBe(2);
    expect(latestContextEvent([{ at: "t", type: "gate" }])).toBeUndefined();
  });
});

describe("the budget command (spec §7.8)", () => {
  it("measures, records the event and answers with the six fields", () => {
    const root = repo();
    const result = runBudget(
      ctx(root),
      { home: home(root), now: () => Date.now() },
      {
        session: FIXTURE,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.exit).toBeUndefined();
    expect(result.data).toMatchObject({
      context: 198_217,
      contextBudget: 800_000,
      remaining: 800_000 - 198_217,
      p90PerTicket: null,
      forecastTickets: null,
      sessionFile: FIXTURE,
    });

    const recorded = readLedger(root).events.filter((event) => event.type === "context");
    expect(recorded).toHaveLength(1);
    expect(recorded[0]?.context).toBe(198_217);
  });

  it("stays exit 0 on a tight budget — tight is a finding, not a failure", () => {
    const root = repo();
    const result = runBudget(
      ctx(root, 100_000),
      { home: home(root), now: () => Date.now() },
      {
        session: FIXTURE,
      },
    );

    expect(result.ok).toBe(true);
    expect(result.data?.remaining).toBe(100_000 - 198_217);
  });

  it("attaches the label when one was given", () => {
    const root = repo();
    runBudget(
      ctx(root),
      { home: home(root), now: () => Date.now() },
      {
        session: FIXTURE,
        label: "vor #5",
      },
    );
    expect(latestContextEvent(readLedger(root).events)?.label).toBe("vor #5");
  });

  it("rejects an unknown option with exit 4 naming it", () => {
    const error = thrown(() => parseBudgetOptions(["--sessions", "x"]));
    expect(error.exit).toBe(EXIT.PRECONDITION);
    expect(error.field).toBe("--sessions");
  });

  it("reads both --session spellings", () => {
    expect(parseBudgetOptions(["--session", "abc"]).session).toBe("abc");
    expect(parseBudgetOptions(["--session=abc"]).session).toBe("abc");
  });
});
