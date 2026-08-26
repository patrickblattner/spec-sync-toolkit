// Ported from production-cockpit scripts/stop-check.test.mjs (as of e070647b/011896b4),
// home move decision #193 — content unchanged, only import paths and TS annotations.
// Counter-check for the handover freshness of the stop-hook valve (#1095).
//
// The failure path this file nails down: a `touch` on an OLD handover (fresh mtime, old
// content) must no longer open the valve.

import { describe, expect, it } from "vitest";

import type { AcceptanceVerdict } from "../src/hooks/lib.js";
import {
  ARCHITECT_BUDGET_PERCENT,
  CHECKED_AGENT_TYPES,
  MAX_BLOCKS,
  contextFromTranscript,
  decideArchitectStop,
  decideStop,
  decideSubagentStop,
  handoverAgeMinutes,
  parseHandoverTime,
} from "../src/hooks/lib.js";
import { askAcceptance, classify, parseVerdict } from "../src/hooks/acceptance.js";
import type { LogEntry } from "../src/hooks/acceptance.js";
import { measureContextPercent, ownerEngaged, workbenchFindings } from "../src/hooks/io.js";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NOW = Date.parse("2026-08-17T12:00:00.000Z");
const handover = (iso: string) =>
  `reason: done\n\n# spec-sync handover\n\n- Repo: /Users/pbl/projects/production-cockpit\n- Time: ${iso}\n`;

describe("parseHandoverTime", () => {
  it("reads the `- Time:` line from the handover", () => {
    expect(parseHandoverTime(handover("2026-08-17T11:30:00.000Z"))).toBe(
      Date.parse("2026-08-17T11:30:00.000Z"),
    );
  });

  it("reports null without a line and for an unparsable value", () => {
    expect(parseHandoverTime("# spec-sync handover\n\n- Repo: /x\n")).toBeNull();
    expect(parseHandoverTime("- Time: yesterday\n")).toBeNull();
    expect(parseHandoverTime(undefined)).toBeNull();
  });
});

describe("handoverAgeMinutes", () => {
  it("fresh content: valve opens (age below the window)", () => {
    const age = handoverAgeMinutes({
      content: handover("2026-08-17T11:30:00.000Z"),
      mtimeMs: NOW,
      now: NOW,
    });
    expect(age).toBe(30);
  });

  it("old content despite fresh mtime: valve stays shut (touch has no effect)", () => {
    const age = handoverAgeMinutes({
      content: handover("2026-08-16T12:00:00.000Z"),
      mtimeMs: NOW, // just touched
      now: NOW,
    });
    expect(age).toBe(24 * 60);
  });

  it("fallback: without a parsable line, the mtime counts", () => {
    expect(
      handoverAgeMinutes({
        content: "# spec-sync handover\n\n- Repo: /x\n",
        mtimeMs: NOW - 10 * 60000,
        now: NOW,
      }),
    ).toBe(10);
    expect(
      handoverAgeMinutes({ content: "- Time: yesterday\n", mtimeMs: NOW - 5 * 60000, now: NOW }),
    ).toBe(5);
  });

  it("neither content nor mtime: unknown (null)", () => {
    expect(handoverAgeMinutes({ content: "", mtimeMs: undefined, now: NOW })).toBeNull();
  });
});

// --- Valve chain (#1091) ---
//
// The chain is this hook's actual mechanism, and its failures are silent: a swapped order blocks
// a session that should have ended quietly, a block counted per sub-step turns the cap into an
// infinite loop, and a budget block without a marker repeats forever. Exactly these four cases
// are below.

describe("contextFromTranscript", () => {
  const line = (id: string, usage: Record<string, unknown>) =>
    JSON.stringify({ type: "assistant", message: { id, usage } });

  it("takes the YOUNGEST entry, not the sum", () => {
    const raw = [
      line("a", { input_tokens: 10, cache_read_input_tokens: 90 }),
      line("b", { input_tokens: 20, cache_read_input_tokens: 180 }),
    ].join("\n");
    expect(contextFromTranscript(raw)).toBe(200);
  });

  it("deduplicates by message.id — streaming writes the same call multiple times", () => {
    const raw = [
      line("a", { input_tokens: 100 }),
      line("a", { input_tokens: 100 }),
      line("a", { input_tokens: 100 }),
    ].join("\n");
    expect(contextFromTranscript(raw)).toBe(100);
  });

  it("skips broken and foreign lines instead of throwing (a file written live)", () => {
    const raw = [
      '{"type":"user","message":{"id":"u","usage":{"input_tokens":999}}}',
      line("a", { input_tokens: 50 }),
      '{"type":"assistant","message":{"id":"halb',
    ].join("\n");
    expect(contextFromTranscript(raw)).toBe(50);
  });

  it("without usable entries: null (unknown, not zero tokens)", () => {
    expect(contextFromTranscript("")).toBeNull();
    expect(contextFromTranscript("not json")).toBeNull();
  });
});

describe("decideStop — order of the valves", () => {
  // The probes count their own calls: "the valve already caught it" means the expensive
  // measurement behind it did NOT run at all — that is the order, proven rather than claimed.
  const probes = () => {
    const calls = { usage: 0, findings: 0, acceptance: 0 };
    return {
      calls,
      usageOver: () => {
        calls.usage += 1;
        return null;
      },
      findings: () => {
        calls.findings += 1;
        return ["a worktree next to the main tree"];
      },
      acceptance: (): AcceptanceVerdict => {
        calls.acceptance += 1;
        return { decision: "block", reason: "no gate evidence" };
      },
    };
  };

  it("pause beats everything — no probe runs", () => {
    const p = probes();
    const d = decideStop({ paused: true, claimsBoundary: true, contextPercent: 150, ...p });
    expect(d).toMatchObject({ action: "allow", stage: "pause" });
    expect(p.calls).toEqual({ usage: 0, findings: 0, acceptance: 0 });
  });

  it("a fresh handover beats the budget stage", () => {
    const p = probes();
    const d = decideStop({ handoverAgeMin: 5, contextPercent: 150, claimsBoundary: true, ...p });
    expect(d).toMatchObject({ action: "allow", stage: "handover" });
    expect(p.calls.usage).toBe(0);
  });

  it("the budget stage beats usage and workbench", () => {
    const p = probes();
    const d = decideStop({ contextPercent: 100, claimsBoundary: true, ...p });
    expect(d).toMatchObject({ action: "block", stage: "budget" });
    expect(d.reason).toContain("spec-sync handover --reason budget");
    expect(p.calls).toEqual({ usage: 0, findings: 0, acceptance: 0 });
  });

  it("the usage valve lets through quietly, without even measuring the workbench", () => {
    const p = probes();
    const d = decideStop({
      ...p,
      usageOver: () => ({ kind: "weekly_all", percent: 100 }),
      claimsBoundary: true,
    });
    expect(d).toMatchObject({ action: "allow", stage: "usage" });
    expect(p.calls.findings).toBe(0);
  });

  it("without a boundary claim BOTH sub-steps are skipped", () => {
    const p = probes();
    const d = decideStop({ claimsBoundary: false, ...p });
    expect(d).toMatchObject({ action: "allow", stage: "gate" });
    expect(p.calls.findings).toBe(0);
    expect(p.calls.acceptance).toBe(0);
  });

  // #1107 / dev.process 2.36.1 §Worker-Loop (b), Q&A #447/#448: the chain is a RANK ORDER, not
  // an execution plan. Per the norm the usage valve is checked "only immediately before a block"
  // and "never at normal turn ends" — a waiting or interim-status turn must therefore cost
  // neither keychain nor network. The wrong build this test pins down: the valve stood in front
  // of the gate and ran at EVERY turn end, for a result that can only open.
  it("without a boundary claim the usage valve is NEVER queried — not even when it would apply", () => {
    const p = probes();
    const d = decideStop({
      ...p,
      claimsBoundary: false,
      usageOver: () => {
        p.calls.usage += 1;
        return { kind: "weekly_all", percent: 100 };
      },
    });
    expect(d).toMatchObject({ action: "allow", stage: "gate" });
    expect(p.calls.usage).toBe(0);
  });

  it("the rank order holds: usage beats the block cap, workbench and acceptance", () => {
    const p = probes();
    const d = decideStop({
      ...p,
      claimsBoundary: true,
      blockCount: MAX_BLOCKS,
      usageOver: () => ({ kind: "weekly_all", percent: 100 }),
    });
    expect(d).toMatchObject({ action: "allow", stage: "usage" });
    expect(p.calls).toMatchObject({ findings: 0, acceptance: 0 });
  });

  it("workbench before acceptance: the checker is asked only once the workbench is empty", () => {
    const p = probes();
    expect(decideStop({ claimsBoundary: true, ...p })).toMatchObject({
      action: "block",
      stage: "workbench",
    });
    expect(p.calls.acceptance).toBe(0);

    const q = probes();
    const d = decideStop({ claimsBoundary: true, ...q, findings: () => [] });
    expect(d).toMatchObject({ action: "block", stage: "acceptance" });
    expect(d.reason).toContain("no gate evidence");
  });
});

describe("decideStop — hook-wide counter and budget marker", () => {
  it("the cap counts hook-wide: three blocks are three blocks, whatever the stage", () => {
    const args = {
      claimsBoundary: true,
      findings: () => ["a worktree next to the main tree"],
      acceptance: (): AcceptanceVerdict => ({ decision: "block", reason: "x" }),
    };
    expect(decideStop({ ...args, blockCount: MAX_BLOCKS - 1 }).action).toBe("block");
    const capped = decideStop({ ...args, blockCount: MAX_BLOCKS });
    expect(capped).toMatchObject({ action: "allow", stage: "cap" });
    expect(capped.note).toContain(`after ${MAX_BLOCKS} blocks`);
  });

  it("budget blocks EXACTLY ONCE — with the marker set, the chain keeps running", () => {
    const first = decideStop({ contextPercent: 120, claimsBoundary: false });
    expect(first).toMatchObject({ action: "block", stage: "budget" });

    const second = decideStop({
      contextPercent: 120,
      budgetAlreadyBlocked: true,
      claimsBoundary: false,
    });
    expect(second).toMatchObject({ action: "allow", stage: "gate" });
  });

  it("an unmeasurable context never blocks (fail-open)", () => {
    expect(decideStop({ contextPercent: null, claimsBoundary: false }).stage).toBe("gate");
  });

  it("below the budget the stage does not block", () => {
    expect(decideStop({ contextPercent: 99.9, claimsBoundary: false }).stage).toBe("gate");
  });
});

describe("decideSubagentStop", () => {
  const blocking = (): AcceptanceVerdict => ({
    decision: "block",
    reason: "Done without gate evidence",
  });

  it("checks only building and accepting agents", () => {
    expect(decideSubagentStop({ agentType: "investigate", acceptance: blocking }).stage).toBe(
      "gate",
    );
    expect(decideSubagentStop({ agentType: "docs", acceptance: blocking }).stage).toBe("gate");
    for (const agentType of CHECKED_AGENT_TYPES)
      expect(decideSubagentStop({ agentType, acceptance: blocking })).toMatchObject({
        action: "block",
        stage: "acceptance",
      });
  });

  it("budget forces a clean close, exactly once", () => {
    const first = decideSubagentStop({ agentType: "impl", contextPercent: 100 });
    expect(first).toMatchObject({ action: "block", stage: "budget" });
    expect(first.reason).toContain("CONTEXT LOW");
    expect(
      decideSubagentStop({ agentType: "impl", contextPercent: 100, budgetAlreadyBlocked: true })
        .stage,
    ).toBe("clean");
  });

  it("pause and the cap let through", () => {
    expect(
      decideSubagentStop({ paused: true, agentType: "impl", acceptance: blocking }).action,
    ).toBe("allow");
    expect(
      decideSubagentStop({ agentType: "impl", blockCount: MAX_BLOCKS, acceptance: blocking }),
    ).toMatchObject({ action: "allow", stage: "cap" });
  });

  it("a checker without a verdict allows (fail-open)", () => {
    expect(decideSubagentStop({ agentType: "impl", acceptance: () => null }).stage).toBe("clean");
  });
});

describe("parseVerdict", () => {
  it("reads a block verdict from the checker process's JSON envelope", () => {
    const raw = JSON.stringify({ result: '{"decision":"block","reason":"no gate evidence"}' });
    expect(parseVerdict(raw)).toEqual({ decision: "block", reason: "no gate evidence" });
  });

  it("reads it also without an envelope and with chatter around it", () => {
    expect(parseVerdict('Sure: {"decision":"block","reason":"no verdict"} — done')).toEqual({
      decision: "block",
      reason: "no verdict",
    });
  });

  it("separates ALLOWED from UNREADABLE — exactly this distinction carries the log", () => {
    expect(parseVerdict('{"decision":"allow"}')).toEqual({ decision: "allow" });
    expect(parseVerdict("")).toBeNull();
    expect(parseVerdict(undefined)).toBeNull();
    expect(parseVerdict("{broken")).toBeNull();
    expect(parseVerdict('{"verdict":"block"}')).toBeNull();
  });

  it("a block without a reason gets one, instead of disappearing", () => {
    expect(parseVerdict('{"decision":"block"}')).toEqual({
      decision: "block",
      reason: "missing evidence",
    });
  });
});

describe("classify — timeout told apart from a runtime error", () => {
  it("recognises the killed checker as a timeout", () => {
    expect(classify(Object.assign(new Error("killed"), { killed: true }))).toBe("timeout");
    expect(classify(Object.assign(new Error("x"), { code: "ETIMEDOUT" }))).toBe("timeout");
    expect(classify(Object.assign(new Error("x"), { signal: "SIGTERM" }))).toBe("timeout");
  });

  it("everything else is runtime", () => {
    expect(classify(new Error("command not found"))).toBe("runtime");
    expect(classify(undefined)).toBe("runtime");
  });
});

// The log is the counter-check to the hook's leniency: "allowed" and "could not ask" look the
// same from outside, and without a line nobody would know whether the checker ever answered.
describe("askAcceptance — verdict and log", () => {
  const collect = () => {
    const lines: LogEntry[] = [];
    return {
      lines,
      log: (_cwd: string, entry: LogEntry) => {
        lines.push(entry);
      },
    };
  };

  it("does not even ask on an empty message", () => {
    let called = false;
    const { log } = collect();
    const verdict = askAcceptance({
      kind: "stop",
      message: "   ",
      log,
      run: () => {
        called = true;
        return '{"decision":"block","reason":"x"}';
      },
    });
    expect(verdict).toBeNull();
    expect(called).toBe(false);
  });

  it("logs the timeout as fail-open WITH a reason and allows", () => {
    const { lines, log } = collect();
    const verdict = askAcceptance({
      kind: "stop",
      message: "The run is done.",
      log,
      run: () => {
        throw Object.assign(new Error("ETIMEDOUT"), { killed: true });
      },
    });
    expect(verdict).toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ outcome: "fail-open", failReason: "timeout" });
  });

  it("logs an unreadable answer separately as parse", () => {
    const { lines, log } = collect();
    expect(
      askAcceptance({ kind: "stop", message: "Goal reconciliation.", log, run: () => "not json" }),
    ).toBeNull();
    expect(lines[0]).toMatchObject({ outcome: "fail-open", failReason: "parse" });
  });

  it("logs an ALLOWED as such — not as fail-open", () => {
    const { lines, log } = collect();
    expect(
      askAcceptance({
        kind: "stop",
        message: "Goal reconciliation.",
        log,
        run: () => '{"decision":"allow"}',
      }),
    ).toBeNull();
    expect(lines[0]).toMatchObject({ outcome: "allow" });
    expect(lines[0]?.failReason).toBeUndefined();
  });

  it("passes a block through and logs verdict AND reason", () => {
    const { lines, log } = collect();
    let seen = "";
    const verdict = askAcceptance({
      kind: "subagent",
      agentType: "impl-fast",
      message: "Ticket is done, ready to merge.",
      log,
      run: (prompt: string) => {
        seen = prompt;
        return '{"decision":"block","reason":"no gate evidence"}';
      },
    });
    expect(verdict).toEqual({ decision: "block", reason: "no gate evidence" });
    expect(seen).toContain("Agent type: impl-fast");
    expect(seen).toContain("Ticket is done, ready to merge.");
    expect(lines[0]).toMatchObject({
      outcome: "block",
      reason: "no gate evidence",
      agentType: "impl-fast",
    });
  });

  it("really writes the line to disk, as JSONL", () => {
    const cwd = mkdtempSync(join(tmpdir(), "stop-check-log-"));
    askAcceptance({
      kind: "stop",
      message: "Goal reconciliation.",
      cwd,
      run: () => '{"decision":"allow"}',
    });
    const written = readFileSync(join(cwd, ".spec-sync", "acceptance-check.jsonl"), "utf8").trim();
    expect(JSON.parse(written)).toMatchObject({ kind: "stop", outcome: "allow" });
  });

  it("an unwritable log does not change the decision", () => {
    expect(
      askAcceptance({
        kind: "stop",
        message: "Goal reconciliation.",
        cwd: "/not/writable",
        run: () => '{"decision":"block","reason":"no evidence"}',
      }),
    ).toEqual({ decision: "block", reason: "no evidence" });
  });
});

// The measurement itself, pinned down on its most important property: it must block NOTHING on
// error. A valve that strikes on a measurement failure freezes the queue — the most expensive
// failure mode of this repo.
describe("measureContextPercent — fail-open of the measurement", () => {
  it("without a transcript path or without a budget: null (no block)", () => {
    expect(measureContextPercent(undefined, 250000)).toBeNull();
    expect(measureContextPercent("/does/not/exist.jsonl", null)).toBeNull();
  });

  it("unreadable transcript: null instead of an exception", () => {
    expect(measureContextPercent("/does/not/exist.jsonl", 250000)).toBeNull();
  });

  it("readable transcript without usage entries: null", () => {
    const file = join(mkdtempSync(join(tmpdir(), "stop-check-")), "t.jsonl");
    writeFileSync(file, "not json\n");
    expect(measureContextPercent(file, 250000)).toBeNull();
  });

  it("measures in percent of the budget", () => {
    const file = join(mkdtempSync(join(tmpdir(), "stop-check-")), "t.jsonl");
    writeFileSync(
      file,
      `${JSON.stringify({ type: "assistant", message: { id: "a", usage: { input_tokens: 125000 } } })}\n`,
    );
    expect(measureContextPercent(file, 250000)).toBe(50);
  });
});

// The workbench check pinned down on the one exception it must never report: `.claude/**` is
// owner/Overmind domain (decision #192) — the worker could never clear the finding, the chore
// rule deliberately leaves the change lying there.
describe("workbenchFindings — .claude/** is never a finding", () => {
  function scratchRepoWithClaude(): string {
    const dir = mkdtempSync(join(tmpdir(), "workbench-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.json"), "{}\n");
    writeFileSync(join(dir, "code.txt"), "a\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    // Point origin/main at the same state so only the dirty check speaks.
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    return dir;
  }

  it("a changed .claude/settings.json (an Overmind chore) does not block", () => {
    const dir = scratchRepoWithClaude();
    writeFileSync(join(dir, ".claude", "settings.json"), '{"changed":true}\n');
    expect(workbenchFindings(dir)).toEqual([]);
  });

  it("a changed tracked code file remains a finding", () => {
    const dir = scratchRepoWithClaude();
    writeFileSync(join(dir, "code.txt"), "b\n");
    const findings = workbenchFindings(dir);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("code.txt");
  });
});

// Architect chain (PROC-DEV-020 rev 4 / PROC-DEV-036 rev 5, owner's word 08/22): one stage at
// 75 %, exactly once, the handover dictated with the measurement; an owner conversation forces
// the announcement.
describe("decideArchitectStop", () => {
  const AT = "2026-08-22T14:00:00.000Z";
  const base = { budgetTokens: 250_000, measuredAt: AT };

  it("the threshold is 75 % — below it, allow, no block", () => {
    expect(ARCHITECT_BUDGET_PERCENT).toBe(75);
    expect(decideArchitectStop({ ...base, contextTokens: 187_499 })).toMatchObject({
      action: "allow",
      stage: "clean",
    });
  });

  it("from 75 % it blocks once and dictates the handover with the measured number", () => {
    const d = decideArchitectStop({ ...base, contextTokens: 187_500 });
    expect(d).toMatchObject({ action: "block", stage: "budget" });
    expect(d.reason).toContain("reason: budget");
    expect(d.reason).toContain(`- State: 187500 Tokens (measured ${AT})`);
    expect(d.reason).toContain("75 % of the budget 250000");
    expect(
      decideArchitectStop({ ...base, contextTokens: 300_000, budgetAlreadyBlocked: true }),
    ).toMatchObject({ action: "allow", stage: "clean" });
  });

  it("an owner conversation forces the announcement instead of the handover", () => {
    const d = decideArchitectStop({ ...base, contextTokens: 200_000, ownerEngaged: true });
    expect(d).toMatchObject({ action: "block", stage: "budget-owner" });
    expect(d.reason).toContain("do NOT write a handover");
    expect(d.reason).toContain("/handover");
    expect(d.reason).not.toContain("- State:");
  });

  it("pause flag and a fresh handover beat the budget stage; no block without a measurement", () => {
    expect(decideArchitectStop({ ...base, contextTokens: 300_000, paused: true })).toMatchObject({
      action: "allow",
      stage: "pause",
    });
    expect(
      decideArchitectStop({ ...base, contextTokens: 300_000, handoverAgeMin: 5 }),
    ).toMatchObject({ action: "allow", stage: "handover" });
    expect(decideArchitectStop({ ...base, contextTokens: null })).toMatchObject({
      action: "allow",
      stage: "clean",
    });
    expect(decideArchitectStop({ contextTokens: 300_000, budgetTokens: null })).toMatchObject({
      action: "allow",
      stage: "clean",
    });
  });
});

describe("ownerEngaged", () => {
  it("reads last_owner_prompt_at from the worker-harness hook's state file; false when absent", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "wh-state-"));
    const cwd = "/Users/pbl/projects/specs-meta/projects/community-platform";
    const slug = cwd.replace(/[^A-Za-z0-9]/g, "-");
    const dir = join(stateDir, "sessions", slug);
    mkdirSync(dir, { recursive: true });
    const prev = process.env.WORKER_HARNESS_STATE_DIR;
    process.env.WORKER_HARNESS_STATE_DIR = stateDir;
    try {
      expect(ownerEngaged(cwd, "s1")).toBe(false);
      writeFileSync(
        join(dir, "s1.json"),
        JSON.stringify({ last_prompt_at: "2026-08-22T13:00:00Z" }),
      );
      expect(ownerEngaged(cwd, "s1")).toBe(false);
      writeFileSync(
        join(dir, "s1.json"),
        JSON.stringify({
          last_prompt_at: "2026-08-22T13:00:00Z",
          last_owner_prompt_at: "2026-08-22T13:00:00Z",
        }),
      );
      expect(ownerEngaged(cwd, "s1")).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.WORKER_HARNESS_STATE_DIR;
      else process.env.WORKER_HARNESS_STATE_DIR = prev;
    }
  });
});
