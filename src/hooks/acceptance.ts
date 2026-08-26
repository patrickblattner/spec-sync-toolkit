// Acceptance sub-step of the turn-end hooks (#1091 (b)/(c)).
//
// Until 08/17 this was a native `prompt` hook. That exact construction is forbidden — it sits in
// front of no valve chain and therefore blocked unchecked (incident 08/16–17); the check itself is
// required. It comes back here as a sub-step of ONE command hook: only whoever has passed the
// regex gate and gotten past every valve is asked, the answer is structured, parsing is
// deterministic. The wording of the check prompts is that of the removed prompt hooks
// (production-cockpit commit 0c80ded4), not reinvented.
//
// The one rule that stands above everything: **fail-open**. No checker, no network, a broken
// answer, a timeout — all of it ends in ALLOW. A hook that is stricter than its own knowledge
// halts the session without knowing anything; that was exactly the block loop. So that "allowed"
// is never confused with "answered", EVERY fail-open case is logged with its reason: a checker
// that never answers would otherwise look like one that never has anything to object to.

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type { AcceptanceVerdict } from "./lib.js";

// Model explicitly pinned: a `claude -p` without `--model` inherits the global entry — this is how
// both workers ran unnoticed on a large model from 08/13–17 (double quota load). For a one-line
// verdict on a short text, Haiku is the right class.
const MODEL = "claude-haiku-4-5-20251001";
/** Hard upper bound of the check call. The hook timeout in the settings must be above this. */
const TIMEOUT_MS = 45_000;
/** This much of the final message the checker sees — the rest contributes nothing to the judgment. */
const MAX_MESSAGE_CHARS = 6000;
/** Countable log, one JSON line per query. */
const LOG_FILE = join(".spec-sync", "acceptance-check.jsonl");

const OUTPUT_CONTRACT =
  'Answer with EXACTLY one line of JSON, no fencing, no explanation before or after: {"decision":"allow"} or {"decision":"block","reason":"<the missing evidence, one sentence>"}.';

const STOP_PROMPT =
  "Acceptance checker for the turn end of a spec-sync worker session. Judge ONLY the final message " +
  "below. ALLOW when the message does not claim the run has ended (an interim status, a follow-up " +
  "question, an owner dialogue) — never block normal turns. ALLOW a claimed run end for one of three " +
  "evidenced outcomes: (1) Handover written (npx spec-sync handover, any --reason) — always allow, " +
  "never block after a handover. (2) In-sync ending: a proven pin drift with no changes AND an empty " +
  "ticket sweep (auto-audit, type: bug, spec-sync) are named concretely. (3) Run DoD: the goal " +
  "reconciliation names drift→tickets→merges, the assignment of the open issues, the section mapping, " +
  "and the empty workbench (no worktrees/ticket branches, agents stopped, merges pushed). BLOCK only " +
  "when a run end or goal reconciliation is claimed and evidence is missing — name the missing " +
  "evidence precisely. When in doubt, allow.";

const SUBAGENT_PROMPT =
  "Acceptance checker for the completion of a build agent in a spec-sync worker repo. Judge ONLY the " +
  "final message below. Always allow interim states (a question, a status update, CONTEXT LOW, an " +
  "escalation or a block with a reason). BLOCK only when the message claims the ticket is built and " +
  "done or ready to merge, without gate evidence (a gate command with a green result or exit code) — " +
  "for a review agent, without a delivered verdict. Name the missing evidence precisely. When in " +
  "doubt, allow.";

export interface LogEntry {
  kind: string;
  agentType?: string;
  outcome?: string;
  failReason?: string;
  error?: string;
  raw?: string;
  reason?: string;
}

/**
 * Asks the checker and returns `{decision, reason}` when it BLOCKS — otherwise `null`. For the
 * chain, `null` always means ALLOW, whether the checker allowed or could not answer at all; which
 * of the two cases it was is recorded in the log afterwards.
 */
export function askAcceptance({
  kind,
  message,
  agentType,
  cwd = process.cwd(),
  run = runChecker,
  log = logLine,
}: {
  kind: "stop" | "subagent";
  message: unknown;
  agentType?: unknown;
  cwd?: string;
  run?: (prompt: string) => string;
  log?: (cwd: string, entry: LogEntry) => void;
}): AcceptanceVerdict | null {
  const text = String(message ?? "").slice(0, MAX_MESSAGE_CHARS);
  if (text.trim() === "") return null;

  const entry: LogEntry = { kind, agentType: String(agentType ?? "") || undefined };

  let raw: string;
  try {
    raw = run(buildPrompt(kind, text, agentType));
  } catch (error) {
    log(cwd, { ...entry, outcome: "fail-open", failReason: classify(error), error: short(error) });
    return null;
  }

  const verdict = parseVerdict(raw);
  if (verdict === null) {
    // An answer came back but is unreadable — that is a different error than "unreachable", and
    // only counted separately can you see whether the model is structurally off.
    log(cwd, { ...entry, outcome: "fail-open", failReason: "parse", raw: short(raw) });
    return null;
  }

  // Verdict AND reason go into the log: a block whose own reason would suggest ALLOW is only
  // findable later this way.
  log(cwd, { ...entry, outcome: verdict.decision, reason: verdict.reason });
  return verdict.decision === "block" ? verdict : null;
}

function buildPrompt(kind: string, text: string, agentType: unknown): string {
  const head = kind === "subagent" ? SUBAGENT_PROMPT : STOP_PROMPT;
  const context = kind === "subagent" ? `\n\nAgent type: ${String(agentType ?? "unknown")}` : "";
  return `${head}\n\n${OUTPUT_CONTRACT}${context}\n\nFinal message:\n"""\n${text}\n"""`;
}

/** The one call to the outside. Kept separate so tests can replace it. */
function runChecker(prompt: string): string {
  return execFileSync("claude", ["-p", prompt, "--model", MODEL, "--output-format", "json"], {
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
}

/** Timeout or other runtime error — the two are told apart by the kill signal. */
export function classify(error: unknown): string {
  const e = error as { killed?: boolean; code?: string; signal?: string } | null;
  if (e && (e.killed === true || e.code === "ETIMEDOUT" || e.signal === "SIGTERM"))
    return "timeout";
  return "runtime";
}

function short(value: unknown): string {
  const text = value instanceof Error ? value.message : String(value ?? "");
  return text.slice(0, 300);
}

/** Best-effort log: one JSON line. If the write fails, it stays at allow. */
export function logLine(cwd: string, entry: LogEntry): void {
  try {
    const dir = join(cwd || process.cwd(), ".spec-sync");
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(cwd || process.cwd(), LOG_FILE),
      `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`,
    );
  } catch {
    // Log not writable — the hook still decides, just more quietly.
  }
}

/**
 * Reads the verdict from the checker's answer: `{decision, reason}` for `block`, `{decision:"allow"}`
 * for `allow`, and `null` when nothing readable was there. Two envelopes are possible — the
 * client's JSON envelope (`{"result":"…"}`) and the bare answer; both are tried.
 */
export function parseVerdict(raw: unknown): AcceptanceVerdict | null {
  const text = String(raw ?? "").trim();
  if (text === "") return null;

  let inner = text;
  try {
    const envelope: unknown = JSON.parse(text);
    if (
      envelope &&
      typeof envelope === "object" &&
      typeof (envelope as { result?: unknown }).result === "string"
    )
      inner = (envelope as { result: string }).result.trim();
  } catch {
    // No envelope — then the output itself is the answer.
  }

  const match = /\{[\s\S]*\}/u.exec(inner);
  if (!match) return null;

  let verdict: unknown;
  try {
    verdict = JSON.parse(match[0]);
  } catch {
    return null;
  }
  if (!verdict || typeof verdict !== "object") return null;
  const v = verdict as { decision?: unknown; reason?: unknown };
  if (v.decision === "allow") return { decision: "allow" };
  if (v.decision !== "block") return null;

  const reason =
    typeof v.reason === "string" && v.reason.trim() !== "" ? v.reason.trim() : "missing evidence";
  return { decision: "block", reason };
}
