// The outside world of the turn-end hooks (#1091): hook input, counters, context measurement,
// usage, workbench.
//
// Kept separate from `lib.ts`, because that is where the decision lives and this is where the
// measurement lives. Every function here is built so that its own failure blocks NOTHING: it
// then delivers the value the chain reads as "don't know" (null, false, an empty list). Fail-open
// is not an ingredient of the hook, it is its construction.
//
// The hooks are their own binaries with the stdout protocol of the Claude Code hook contract —
// the CLI envelope contract (spec §3, src/output.ts) does not apply to them; the two
// console.log calls in `emit()` carry a justified inline disable for that reason.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";

import { contextFromTranscript, contextPercent, handoverAgeMinutes } from "./lib.js";
import type { HookDecision, UsageWindow } from "./lib.js";

export type HookInput = Record<string, unknown>;

/** Hook input from stdin. Empty or broken means defaults — never an abort. */
export function readHookInput(): HookInput {
  try {
    const parsed: unknown = JSON.parse(readFileSync(0, "utf8") || "{}");
    return parsed !== null && typeof parsed === "object" ? (parsed as HookInput) : {};
  } catch {
    return {};
  }
}

export function isPaused(cwd: string): boolean {
  return existsSync(join(cwd, ".spec-sync-pause"));
}

/** Age of the handover in minutes, or null when none is there or it is not readable. */
export function handoverAge(cwd: string): number | null {
  const file = join(cwd, ".spec-sync-handover.md");
  if (!existsSync(file)) return null;
  try {
    return handoverAgeMinutes({
      content: readFileSync(file, "utf8"),
      mtimeMs: statSync(file).mtimeMs,
    });
  } catch {
    return null;
  }
}

/** `contextBudget` from the repo configuration; null when there is none there. */
export function readContextBudget(cwd: string): number | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(cwd, "spec-sync.config.json"), "utf8"));
    const budget = (parsed as { contextBudget?: unknown }).contextBudget;
    return typeof budget === "number" && Number.isFinite(budget) && budget > 0 ? budget : null;
  } catch {
    return null;
  }
}

/** Context level of the transcript in tokens; null when nothing measurable is in it. */
export function measureContextTokens(transcriptPath: unknown): number | null {
  if (!transcriptPath) return null;
  try {
    return contextFromTranscript(readFileSync(String(transcriptPath), "utf8"));
  } catch {
    return null;
  }
}

/**
 * An owner conversation in this session? Read from the worker-harness hook's state file
 * (bin/session-state.js: `<stateDir>/sessions/<slug(cwd)>/<session_id>.json`, field
 * `last_owner_prompt_at` — only real owner input, no wrappers). If the file or the field is
 * missing: no conversation known (false) — the block message then carries the announcement rule
 * as a hint.
 */
export function ownerEngaged(cwd: string, sessionId: string): boolean {
  try {
    const stateDir =
      process.env.WORKER_HARNESS_STATE_DIR ?? join(homedir(), ".local", "state", "worker-harness");
    const slug = cwd.replace(/[^A-Za-z0-9]/g, "-");
    const raw = readFileSync(join(stateDir, "sessions", slug, `${sessionId}.json`), "utf8");
    const parsed: unknown = JSON.parse(raw);
    const at = (parsed as { last_owner_prompt_at?: unknown })?.last_owner_prompt_at;
    return typeof at === "string" && at !== "";
  } catch {
    return false;
  }
}

/** Context level of the transcript in percent of the budget; null as soon as one quantity is missing. */
export function measureContextPercent(
  transcriptPath: unknown,
  budget: number | null,
): number | null {
  if (!transcriptPath || budget === null) return null;
  try {
    return contextPercent(
      contextFromTranscript(readFileSync(String(transcriptPath), "utf8")),
      budget,
    );
  } catch {
    return null;
  }
}

// Counter and budget marker live in the tmp directory, per run under its own key: for the session
// the session_id, for an agent its own transcript — "per agent run" is exactly that.
const state = (kind: string, key: string) => join(tmpdir(), `${kind}-${key || "unknown"}`);

export function counterKeyOf(input: HookInput): string {
  if (input.transcript_path)
    return basename(String(input.transcript_path)).replace(/\.jsonl$/u, "");
  return String(input.session_id || "unknown");
}

export function readCount(kind: string, key: string): number {
  try {
    return parseInt(readFileSync(state(kind, `${key}.count`), "utf8"), 10) || 0;
  } catch {
    return 0;
  }
}

export function bumpCount(kind: string, key: string, count: number): void {
  try {
    writeFileSync(state(kind, `${key}.count`), String(count + 1));
  } catch {
    // Counter not writable: the block still applies, only the cap kicks in later.
  }
}

export function clearCount(kind: string, key: string): void {
  try {
    unlinkSync(state(kind, `${key}.count`));
  } catch {
    // No counter there — nothing to do.
  }
}

// The budget marker DELIBERATELY survives the counter being cleared: "exactly once" applies to
// the whole run. If it fell with the counter, the budget stage would block again after every
// allowed turn — a one-time instruction would turn into a loop.
export function budgetAlreadyBlocked(kind: string, key: string): boolean {
  return existsSync(state(kind, `${key}.budget`));
}

export function markBudgetBlocked(kind: string, key: string): void {
  try {
    writeFileSync(state(kind, `${key}.budget`), new Date().toISOString());
  } catch {
    // Cannot be marked: worst case the stage blocks a second time, the cap catches it.
  }
}

/**
 * Kontoweites Usage-Fenster >= Schwelle? Dann endet die Session still, statt Arbeit ins
 * Sonderguthaben zu erzwingen (Vorfall 2026-08-16). Token via stdin, nie argv.
 */
export function usageOverThreshold(threshold: number): UsageWindow | null {
  try {
    const cred = execFileSync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { encoding: "utf8" },
    );
    const token = (JSON.parse(cred) as { claudeAiOauth: { accessToken: string } }).claudeAiOauth
      .accessToken;
    const usage: unknown = JSON.parse(
      execFileSync(
        "curl",
        ["-fsS", "--max-time", "5", "--config", "-", "https://api.anthropic.com/api/oauth/usage"],
        {
          encoding: "utf8",
          input:
            `header = "Authorization: Bearer ${token}"\n` +
            `header = "anthropic-beta: oauth-2025-04-20"\n`,
        },
      ),
    );
    const limits = (usage as { limits?: unknown }).limits;
    return (
      (Array.isArray(limits) ? (limits as UsageWindow[]) : []).find(
        (l) =>
          ["session", "weekly_all"].includes(l && l.kind) &&
          Number.isFinite(l && l.percent) &&
          l.percent >= threshold,
      ) ?? null
    );
  } catch {
    return null;
  }
}

/** Workbench finding: worktrees, ticket branches, unpushed commits, tracked changes. */
export function workbenchFindings(cwd: string): string[] {
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const findings: string[] = [];
  try {
    const wts = git("worktree", "list", "--porcelain").split("\n\n").filter(Boolean);
    if (wts.length > 1)
      findings.push(`${wts.length - 1} worktree(s) next to the main tree — git worktree remove`);
    const branches = git("branch", "--format=%(refname:short)")
      .split("\n")
      .filter((b) => b && b !== "main");
    if (branches.length)
      findings.push(`local branches next to main: ${branches.join(", ")} — delete the merged ones`);
    const ahead = git("rev-list", "origin/main..main", "--count");
    if (ahead !== "0") findings.push(`${ahead} unpushed commit(s) on main — git push origin main`);
    const dirty = git("status", "--porcelain")
      .split("\n")
      .filter((l) => l && !l.startsWith("??"))
      // `.claude/**` is owner/Overmind domain (decision #192): the worker must not touch the
      // file and could therefore NEVER clear this finding — the chore rule deliberately leaves
      // the change lying there (it rides along with the next push). Counted as a workbench
      // finding it blocked every turn end up to the cap (measured 08/18, cockpit/unpause: a
      // block on `M .claude/settings.json` right after the settings chore).
      // Regex instead of a column slice: the git helper's `trim()` cuts off the leading status
      // column of the first line, so fixed offsets would then lie.
      .filter((l) => !/(^|\s)\.claude\//.test(l));
    if (dirty.length) findings.push(`changes to tracked files: ${dirty.slice(0, 5).join(" | ")}`);
  } catch {
    // git not queryable: no statement about the workbench, so no finding and no block.
    return [];
  }
  return findings;
}

/** Emits the decision and ends the hook. Output format as before (Stop/SubagentStop). */
export function emit(decision: HookDecision, hookEventName: string): never {
  if (decision.action === "block") {
    // eslint-disable-next-line no-console -- hook protocol: stdout belongs to the hook contract here.
    console.log(
      JSON.stringify({
        decision: "block",
        reason: decision.reason,
        hookSpecificOutput: { hookEventName, decision: "block", reason: decision.reason },
      }),
    );
  } else if (decision.note) {
    // eslint-disable-next-line no-console -- hook protocol: stdout belongs to the hook contract here.
    console.log(JSON.stringify({ systemMessage: decision.note }));
  }
  process.exit(0);
}
