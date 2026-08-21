import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  HANDOVER_FILE,
  handoverCommand,
  openMerges,
  parseHandoverOptions,
  renderHandover,
  runHandover,
  trimNote,
  writeAtomic,
  type HandoverDeps,
} from "../src/commands/handover.js";
import { appendEvent, type LedgerEvent } from "../src/ledger.js";
import { EXIT, ToolkitError } from "../src/output.js";
import type { CommandContext } from "../src/cli.js";
import type { Config } from "../src/config.js";

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
  return mkdtempSync(join(tmpdir(), "spec-sync-handover-"));
}

function render(over: Partial<Parameters<typeof renderHandover>[0]> = {}): string {
  return renderHandover({
    repoRoot: "/repo",
    now: new Date("2026-07-29T12:00:00Z"),
    mainHead: "abc1234 chore: v0.6.0",
    pins: { pinnedAt: "2026-07-29T10:00:00.000Z", units: 42 },
    queueHead: [],
    needsPin: 0,
    findings: 0,
    openMerges: [],
    ...over,
  });
}

const CONFIG = { contextBudget: 800_000, labels: {} } as unknown as Config;

function ctx(repoRoot: string): CommandContext {
  return { flags: { human: false, dryRun: false }, args: [], repoRoot, config: CONFIG };
}

/** `gh` answering with an empty issue list — a repo without open tickets. */
function deps(over: Partial<HandoverDeps> = {}): HandoverDeps {
  return {
    queue: {
      gh: async () => "[]",
      lastMainCommit: async () => undefined,
      now: () => new Date("2026-07-29T12:00:00Z"),
    },
    mainHead: async () => "abc1234 chore: v0.6.0",
    now: () => new Date("2026-07-29T12:00:00Z"),
    ...over,
  };
}

describe("the mandatory fields of §7.9", () => {
  it("names repo, time and the main HEAD with short hash and subject", () => {
    const document = render();
    expect(document).toContain("- Repo: /repo");
    expect(document).toContain("- Zeit: 2026-07-29T12:00:00.000Z");
    expect(document).toContain("- `main`-HEAD: abc1234 chore: v0.6.0");
  });

  it("names the pins state with the pin time and the entry count", () => {
    const document = render({
      pins: { pinnedAt: "2026-07-29T10:00:00.000Z", units: 137 },
    });
    expect(document).toContain("zuletzt gepinnt: 2026-07-29T10:00:00.000Z");
    expect(document).toContain("Einträge: 137");
  });

  it("renders the queue head, the needsPin count and the findings count", () => {
    const document = render({
      queueHead: [
        { issue: 3, title: "Runner-Prosa" },
        { issue: 5, title: "budget + handover" },
      ],
      needsPin: 2,
      findings: 1,
    });
    expect(document).toContain("#3 — Runner-Prosa");
    expect(document).toContain("#5 — budget + handover");
    expect(document).toContain("- needsPin: 2");
    expect(document).toContain("- findings: 1");
  });

  it("lists every merge-started that never completed", () => {
    const document = render({ openMerges: [{ issue: 9, at: "2026-07-29T11:00:00Z" }] });
    expect(document).toContain("#9: `merge-started` 2026-07-29T11:00:00Z ohne `merge-completed`");
  });

  it("carries the driver's note", () => {
    expect(render({ note: "Kontext knapp." })).toContain("Kontext knapp.");
  });
});

describe("empty sets are named, never left out (spec §7.9, M6)", () => {
  it("says so when no context was ever measured", () => {
    const document = render();
    expect(document).toContain("keine Messung");
    expect(document).toContain("## Kontext");
  });

  it("says so when the queue is empty", () => {
    expect(render()).toContain("keine offenen Tickets");
  });

  it("says so when no merge is open", () => {
    expect(render()).toContain("kein `merge-started` ohne `merge-completed`");
  });

  it("says so when the driver left no note", () => {
    const lines = render().split("\n");
    const index = lines.indexOf("## Notiz des Treibers");
    expect(lines[index + 2]).toBe("keine");
  });

  it("says so when there are no readable pins", () => {
    expect(render({ pins: undefined })).toContain("Kein lesbares spec-pins.json");
  });

  it("names an unreadable main HEAD instead of dropping the field", () => {
    expect(render({ mainHead: undefined })).toContain("- `main`-HEAD: nicht lesbar");
  });
});

describe("the context section (spec §7.9)", () => {
  it("carries the level plus p90 and reach when they are computable", () => {
    const document = render({
      context: {
        value: 200_000,
        at: "2026-07-29T11:30:00Z",
        p90PerTicket: 50_000,
        forecastTickets: 12,
      },
    });
    expect(document).toContain("- Stand: 200000 Tokens (gemessen 2026-07-29T11:30:00Z)");
    expect(document).toContain("(p90): 50000");
    expect(document).toContain("Reichweite: 12 Ticket(s)");
  });

  it("names the level but not a guessed reach below five measurements", () => {
    const document = render({
      context: { value: 200_000, at: "t", p90PerTicket: null, forecastTickets: null },
    });
    expect(document).toContain("- Stand: 200000 Tokens");
    expect(document).toContain("unter 5 Messpunkten");
    expect(document).toContain("Reichweite: nicht berechenbar");
  });
});

describe("open merges from the ledger", () => {
  it("returns a start without a completion and forgets one that finished", () => {
    const events: LedgerEvent[] = [
      { at: "t1", type: "merge-started", issue: 1 },
      { at: "t2", type: "merge-completed", issue: 1 },
      { at: "t3", type: "merge-started", issue: 2 },
    ];
    expect(openMerges(events)).toEqual([{ issue: 2, at: "t3" }]);
  });

  it("reads `merged` as a completion, so older ledgers stay truthful", () => {
    const events: LedgerEvent[] = [
      { at: "t1", type: "merge-started", issue: 4 },
      // `readLedger` normalises the alias; the same shape reaches this function.
      { at: "t2", type: "merge-completed", issue: 4 },
    ];
    expect(openMerges(events)).toEqual([]);
  });
});

describe("the note is the only non-mechanical part (spec §7.9)", () => {
  it("keeps at most three sentences", () => {
    expect(trimNote("Eins. Zwei. Drei. Vier. Fünf.")).toBe("Eins. Zwei. Drei.");
  });

  it("leaves a shorter note untouched", () => {
    expect(trimNote("Nur ein Satz ohne Punkt")).toBe("Nur ein Satz ohne Punkt");
  });

  it("cuts at sentence ends, not mid-word", () => {
    expect(trimNote("A! B? C. D.")).toBe("A! B? C.");
  });
});

describe("the file is overwritten atomically (spec §7.9, M6)", () => {
  it("replaces the content and leaves no temp file behind", () => {
    const root = repo();
    const path = join(root, HANDOVER_FILE);

    writeAtomic(path, "erste Fassung\n");
    writeAtomic(path, "zweite Fassung\n");

    expect(readFileSync(path, "utf8")).toBe("zweite Fassung\n");
    expect(readdirSync(root).filter((name) => name.endsWith(".tmp"))).toEqual([]);
  });

  it("never leaves a half-written file in place of the old one", () => {
    const root = repo();
    const path = join(root, HANDOVER_FILE);
    writeFileSync(path, "alt\n");

    // Writing into a directory that does not exist fails before the rename, so
    // the previous snapshot survives intact rather than being truncated.
    expect(() => writeAtomic(join(root, "missing", "x.md"), "neu")).toThrow();
    expect(readFileSync(path, "utf8")).toBe("alt\n");
  });
});

describe("the handover command end to end", () => {
  it("writes the file, exits 0 and returns its path on a repo without a ledger", async () => {
    const root = repo();
    const result = await runHandover(ctx(root), CONFIG, deps(), {});

    expect(result.ok).toBe(true);
    expect(result.data?.file).toBe(join(root, HANDOVER_FILE));
    expect(existsSync(join(root, HANDOVER_FILE))).toBe(true);

    const document = readFileSync(join(root, HANDOVER_FILE), "utf8");
    expect(document).toContain("keine Messung");
    expect(document).toContain("keine offenen Tickets");
  });

  it("takes the newest context measurement out of the ledger", async () => {
    const root = repo();
    appendEvent(root, { type: "context", context: 111_000 });
    appendEvent(root, { type: "context", context: 222_000 });

    await runHandover(ctx(root), CONFIG, deps(), {});
    expect(readFileSync(join(root, HANDOVER_FILE), "utf8")).toContain("- Stand: 222000 Tokens");
  });

  it("names an unreadable queue instead of failing the handover", async () => {
    const root = repo();
    const broken = deps();
    broken.queue = {
      ...broken.queue,
      gh: async () => {
        throw new Error("gh: not found");
      },
    };

    const result = await runHandover(ctx(root), CONFIG, broken, {});
    expect(result.ok).toBe(true);
    expect(readFileSync(join(root, HANDOVER_FILE), "utf8")).toContain(
      "nicht lesbar: gh: not found",
    );
  });

  it("rejects an unknown option with exit 4 naming it", () => {
    const error = thrown(() => parseHandoverOptions(["--notes", "x"]));
    expect(error.exit).toBe(EXIT.PRECONDITION);
    expect(error.field).toBe("--notes");
  });
});

describe("the machine-readable stop reason (spec §7.9, M6)", () => {
  it("writes `reason: budget` as the very first line", async () => {
    const root = repo();
    appendEvent(root, { type: "context", context: 700_000 });
    await runHandover(ctx(root), CONFIG, deps(), { reason: "budget" });

    const document = readFileSync(join(root, HANDOVER_FILE), "utf8");
    expect(document.split("\n")[0]).toBe("reason: budget");
    expect(document).toContain("# spec-sync handover");
  });

  it("writes no reason line without the flag", async () => {
    const root = repo();
    await runHandover(ctx(root), CONFIG, deps(), {});

    const document = readFileSync(join(root, HANDOVER_FILE), "utf8");
    expect(document.split("\n")[0]).toBe("# spec-sync handover");
    expect(document).not.toContain("reason:");
  });

  it("rejects an unknown value with exit 1 and writes no file", async () => {
    const error = thrown(() => parseHandoverOptions(["--reason", "quatsch"]));
    expect(error.exit).toBe(EXIT.FAILED);
    expect(error.field).toBe("--reason");

    const root = repo();
    await expect(
      handoverCommand.run({ ...ctx(root), args: ["--reason", "quatsch"] }),
    ).rejects.toThrow(ToolkitError);
    expect(existsSync(join(root, HANDOVER_FILE))).toBe(false);
  });
});

describe("`--reason budget` bound to the measurement (SST-DESIGN-024 rev 3)", () => {
  async function caught(root: string, options: Parameters<typeof runHandover>[3]): Promise<ToolkitError> {
    try {
      await runHandover(ctx(root), CONFIG, deps(), options);
    } catch (error) {
      if (error instanceof ToolkitError) return error;
      throw error;
    }
    throw new Error("expected a ToolkitError, none was thrown");
  }

  it("refuses below 75 % of the context budget with exit 1 and writes no file", async () => {
    const root = repo();
    appendEvent(root, { type: "context", context: 599_999 }); // one under 75 % of 800_000

    const error = await caught(root, { reason: "budget" });
    expect(error.exit).toBe(EXIT.FAILED);
    expect(error.field).toBe("--reason");
    expect(error.message).toContain("599999");
    expect(error.message).toContain("600000");
    expect(error.message).toContain("frage-offen");
    expect(error.message).toContain("Handover ohne --reason");
    expect(existsSync(join(root, HANDOVER_FILE))).toBe(false);
  });

  it("refuses with no context measurement at all", async () => {
    const root = repo();

    const error = await caught(root, { reason: "budget" });
    expect(error.exit).toBe(EXIT.FAILED);
    expect(error.message).toContain("fehlt");
    expect(existsSync(join(root, HANDOVER_FILE))).toBe(false);
  });

  it("writes the file when the measurement reaches exactly 75 %", async () => {
    const root = repo();
    appendEvent(root, { type: "context", context: 600_000 }); // exactly 75 % of 800_000

    await runHandover(ctx(root), CONFIG, deps(), { reason: "budget" });
    expect(readFileSync(join(root, HANDOVER_FILE), "utf8").split("\n")[0]).toBe("reason: budget");
  });

  it("leaves `--reason done` unaffected below the threshold", async () => {
    const root = repo();
    appendEvent(root, { type: "context", context: 100_000 });

    await runHandover(ctx(root), CONFIG, deps(), { reason: "done" });
    expect(readFileSync(join(root, HANDOVER_FILE), "utf8").split("\n")[0]).toBe("reason: done");
  });

  it("leaves a call without `--reason` unaffected", async () => {
    const root = repo();

    const result = await runHandover(ctx(root), CONFIG, deps(), {});
    expect(result.ok).toBe(true);
    expect(existsSync(join(root, HANDOVER_FILE))).toBe(true);
  });
});
