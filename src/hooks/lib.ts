// Decision logic of the turn-end hooks (#1091 valve chain, #1095 handover freshness).
//
// Home since 2026-08-18 here in the toolkit (decision #193): ONE source for all worker repos,
// the repos only register the hook call on `dist/hooks/*` — identical behaviour everywhere is
// thus construction, not copy discipline. Ported 1:1 from production-cockpit
// `scripts/stop-check.lib.mjs` (as of e070647b/011896b4).
//
// This is everything decidable without a process, network or filesystem: the freshness
// measurement, the context measurement from the transcript, and the two valve chains. The
// drivers (`stop-check.ts`, `subagent-stop-check.ts`) supply the measurements and execute what
// is decided here — that is what makes the chain testable without starting a hook.
//
// --- Handover freshness measurement (#1095, dev.process 2.35.0 §Worker-Loop) ---
//
// "Fresh" is the handover's WRITE TIME, not the file time: `/unpause` and the harness `touch`
// touch `.spec-sync-handover.md` without a new handover having been written — measured via
// `mtime` that disarmed the workbench check for the length of the freshness window even though
// new work was running afterwards. So the timestamp measured is the one from the content
// (`- Time: <ISO>`, that is how `spec-sync handover` writes it); `mtime` stays the fallback for
// when the line is missing or unparsable.

const TIME_LINE = /^[-*]\s*Time:\s*(\S+)/m;

/** Timestamp from the handover content in ms, or null when there is no parsable `- Time:` line. */
export function parseHandoverTime(content: unknown): number | null {
  const m = TIME_LINE.exec(String(content ?? ""));
  if (!m) return null;
  const ms = Date.parse(m[1] as string);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Age of the handover in minutes. `content` beats `mtimeMs`; without either, null (unknown).
 */
export function handoverAgeMinutes({
  content,
  mtimeMs,
  now = Date.now(),
}: {
  content?: unknown;
  mtimeMs?: number;
  now?: number;
}): number | null {
  const written =
    parseHandoverTime(content) ?? (Number.isFinite(mtimeMs) ? (mtimeMs as number) : null);
  return written === null ? null : (now - written) / 60000;
}

// --- Context measurement from the transcript (#1091 (a), same measuring logic as `spec-sync budget`) ---
//
// A session cannot observe its own window, but the client writes it along. Two traps are in
// there, both mapped here: streaming writes up to three entries per API call, each with a full
// `usage` block — so it is deduplicated by `message.id`. And the level is the YOUNGEST entry, not
// the sum: the last call carries the whole window, a sum over the session would count it dozens
// of times over.

/** Context level (tokens) of a transcript, or null when nothing measurable is in it. */
export function contextFromTranscript(raw: unknown): number | null {
  const seen = new Set<string>();
  let latest: number | null = null;
  for (const line of String(raw ?? "").split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Half-written last line: the transcript is written live — skip it.
      continue;
    }
    if (parsed === null || typeof parsed !== "object") continue;
    if ((parsed as { type?: unknown }).type !== "assistant") continue;
    const message = (parsed as { message?: unknown }).message;
    if (message === null || typeof message !== "object") continue;
    const { id, usage } = message as { id?: unknown; usage?: unknown };
    if (typeof id !== "string" || usage === null || typeof usage !== "object") continue;
    if (seen.has(id)) continue;
    seen.add(id);
    const u = usage as Record<string, unknown>;
    latest =
      num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
  }
  return latest;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Context level in percent of the budget; null when either quantity is missing. */
export function contextPercent(context: number | null, budget: number | null): number | null {
  if (
    !Number.isFinite(context as number) ||
    !Number.isFinite(budget as number) ||
    (budget as number) <= 0
  )
    return null;
  return ((context as number) / (budget as number)) * 100;
}

// --- Valve chains (#1091 (b)/(c)) ---

export const MAX_BLOCKS = 3;
export const HANDOVER_FRESH_MIN = 60;
/** Threshold of the usage valve — the same as the harness guard's (dev.process §Worker-Loop). */
export const USAGE_THRESHOLD_PERCENT = 95;
/** From here the hook forces an orderly close — 100 % of `contextBudget`. */
export const BUDGET_PERCENT = 100;

export interface HookDecision {
  action: "allow" | "block";
  stage: string;
  reason?: string;
  note?: string;
}

export interface AcceptanceVerdict {
  decision: "allow" | "block";
  reason?: string;
}

export interface UsageWindow {
  kind: string;
  percent: number;
}

const HANDOVER_INSTRUCTION =
  "Write `npx spec-sync handover --reason budget` NOW and end the turn afterwards. " +
  "Start nothing else — the context is at budget.";

/**
 * The valve chain of the stop hook, as one decision.
 *
 * RANK ORDER (dev.process 2.36.1 §Worker-Loop (b)): pause flag → fresh handover → budget stage →
 * usage valve → block cap, behind that the blockable sub-steps workbench check and acceptance
 * checker. It says WHICH VALVE WINS when several could apply — not when each is checked.
 *
 * CHECK TIMING — each valve names its own (#1107, Q&A #447/#448):
 *   - The budget stage measures at EVERY turn end (dev.process §Worker-Loop (a)) and therefore
 *     stands in front of the gate.
 *   - The usage valve is checked ONLY IMMEDIATELY BEFORE A BLOCK, "never at normal turn ends"
 *     (§Usage-Stopp im Worker (a)) — it therefore stands behind the gate, right before the block
 *     sub-steps. Checking a valve in front of the gate that can only OPEN the hook changes no
 *     outcome: it just confirms the "allow" that would happen anyway, and pays keychain access,
 *     a network call and latency for it on every waiting and interim-status turn.
 *
 * The expensive probes (usage query, workbench, checker) come in as FUNCTIONS, not values: this
 * way the chain measures only once it actually needs the answer, and a test can pin down the
 * check timing by the fact that the probe was never called.
 *
 * `blockCount` is the counter of the WHOLE hook, not of one sub-step: three blocks are three
 * blocks, whatever the reason — otherwise the sub-steps would add up into a loop that no single
 * cap ever ends.
 */
export function decideStop({
  paused = false,
  handoverAgeMin = null,
  contextPercent: percent = null,
  budgetAlreadyBlocked = false,
  usageOver = () => null,
  blockCount = 0,
  claimsBoundary = false,
  findings = () => [],
  acceptance = () => null,
}: {
  paused?: boolean;
  handoverAgeMin?: number | null;
  contextPercent?: number | null;
  budgetAlreadyBlocked?: boolean;
  usageOver?: () => UsageWindow | null;
  blockCount?: number;
  claimsBoundary?: boolean;
  findings?: () => string[];
  acceptance?: () => AcceptanceVerdict | null;
}): HookDecision {
  if (paused) return { action: "allow", stage: "pause" };

  if (handoverAgeMin !== null && handoverAgeMin < HANDOVER_FRESH_MIN)
    return { action: "allow", stage: "handover" };

  // Budget stage: exactly ONE block per session. After that the chain runs on normally — if the
  // session still writes no handover, the block cap lets it through eventually. The hook forces
  // an orderly close, it does not lock the session up.
  if (percent !== null && percent >= BUDGET_PERCENT && !budgetAlreadyBlocked)
    return {
      action: "block",
      stage: "budget",
      reason: `stop-check: context at ${Math.round(percent)} % of the budget. ${HANDOVER_INSTRUCTION}`,
    };

  // Gate for EVERYTHING behind it: only one boundary claim is checked. An interim status, a
  // follow-up question, an owner dialogue is not a run end and is never touched. The gate stands
  // BEFORE the usage valve (#1107): behind it a block can still happen, in front of it never —
  // and per the norm the usage valve is checked only immediately before a block.
  if (!claimsBoundary) return { action: "allow", stage: "gate" };

  const over = usageOver();
  if (over)
    return {
      action: "allow",
      stage: "usage",
      note: `stop-check: usage valve — ${over.kind} ${over.percent} % >= ${USAGE_THRESHOLD_PERCENT} %, the session ends quietly. Cleanup happens once there is budget again.`,
    };

  if (blockCount >= MAX_BLOCKS)
    return {
      action: "allow",
      stage: "cap",
      note: `stop-check: let through after ${MAX_BLOCKS} blocks — the finding stays and belongs in the goal reconciliation.`,
    };

  const workbench = findings();
  if (workbench.length)
    return {
      action: "block",
      stage: "workbench",
      reason: `Workbench not empty (block ${blockCount + 1}/${MAX_BLOCKS}): ${workbench.join("; ")}. Clean up first (remove worktree, delete branch, push), then end the turn — or write a handover with an evidenced reason.`,
    };

  const verdict = acceptance();
  if (verdict && verdict.decision === "block")
    return {
      action: "block",
      stage: "acceptance",
      reason: `Acceptance (block ${blockCount + 1}/${MAX_BLOCKS}): ${verdict.reason}`,
    };

  return { action: "allow", stage: "clean" };
}

/**
 * The valve chain of the SubagentStop hook (#1091 (c)) — its own chain, its own counter per
 * agent run.
 *
 * The difference from the session chain is the task: an agent at budget does not clean up a
 * workbench, it closes cleanly and hands off the rest. Only whoever builds or accepts a ticket is
 * checked — every other agent type runs through unchecked.
 */
export const CHECKED_AGENT_TYPES = ["impl", "impl-fast", "impl-deep", "review"];

const AGENT_BUDGET_INSTRUCTION =
  "Report your status now with the closing line `CONTEXT LOW` and end the run. " +
  "Follow-up tickets belong to a fresh agent, not this run anymore.";

export function decideSubagentStop({
  paused = false,
  contextPercent: percent = null,
  budgetAlreadyBlocked = false,
  blockCount = 0,
  agentType = "",
  acceptance = () => null,
}: {
  paused?: boolean;
  contextPercent?: number | null;
  budgetAlreadyBlocked?: boolean;
  blockCount?: number;
  agentType?: string;
  acceptance?: () => AcceptanceVerdict | null;
}): HookDecision {
  if (paused) return { action: "allow", stage: "pause" };

  if (percent !== null && percent >= BUDGET_PERCENT && !budgetAlreadyBlocked)
    return {
      action: "block",
      stage: "budget",
      reason: `subagent-stop-check: context at ${Math.round(percent)} % of the budget. ${AGENT_BUDGET_INSTRUCTION}`,
    };

  if (blockCount >= MAX_BLOCKS)
    return {
      action: "allow",
      stage: "cap",
      note: `subagent-stop-check: let through after ${MAX_BLOCKS} blocks — the finding belongs in the report.`,
    };

  if (!CHECKED_AGENT_TYPES.includes(agentType)) return { action: "allow", stage: "gate" };

  const verdict = acceptance();
  if (verdict && verdict.decision === "block")
    return {
      action: "block",
      stage: "acceptance",
      reason: `Acceptance (block ${blockCount + 1}/${MAX_BLOCKS}): ${verdict.reason}`,
    };

  return { action: "allow", stage: "clean" };
}

/**
 * The valve chain of the architect stop hook (PROC-DEV-020 / PROC-DEV-036, owner's word 08/22).
 *
 * The architect has no workbench and no acceptance checker — its natural boundary is an answered
 * question, i.e. the turn end. Hence ONE stage at 75 % (the threshold from which the harness
 * attests `budget`), exactly once per session. The block message dictates the handover with the
 * measured number — the session does not know its window, the hook does. If an owner
 * conversation is running (owner input in this session), it is not the handover but the
 * announcement that is forced: the owner ends the conversation with `/handover` (PROC-DEV-020 (4),
 * register #204).
 */
export const ARCHITECT_BUDGET_PERCENT = 75;

/**
 * Does a `reason: budget` handover carry the attestation the harness can read? Mirror of
 * worker-harness `parseContextAttest` (PROC-DEV-037): the `## Context` block must hold
 * `- State: <n> Tokens (measured <ISO>)` with a parseable timestamp. Incident 2026-08-29:
 * the architect translated the dictated literal ("Stand … gemessen"), the harness read no
 * measurement and hard-stopped instead of renewing — six questions sat for 16 hours.
 */
export function handoverAttestValid(content: unknown): boolean {
  const m = /^- State: \d+ Tokens \(measured ([^)]+)\)[ \t]*\r?$/m.exec(String(content ?? ""));
  return m !== null && Number.isFinite(Date.parse(m[1] as string));
}

/** The machine-readable first line of a handover, mirror of worker-harness `parseReason`. */
export function handoverReason(content: unknown): string | undefined {
  const firstLine = String(content ?? "").split("\n", 1)[0] as string;
  const m = /^reason:[ \t]*(\S+)[ \t]*\r?$/.exec(firstLine);
  return m === null ? undefined : m[1];
}

export function decideArchitectStop({
  paused = false,
  handoverAgeMin = null,
  handoverText = null,
  attestBlockCount = 0,
  contextTokens = null,
  budgetTokens = null,
  budgetAlreadyBlocked = false,
  ownerEngaged = false,
  measuredAt = new Date().toISOString(),
}: {
  paused?: boolean;
  handoverAgeMin?: number | null;
  handoverText?: string | null;
  attestBlockCount?: number;
  contextTokens?: number | null;
  budgetTokens?: number | null;
  budgetAlreadyBlocked?: boolean;
  ownerEngaged?: boolean;
  measuredAt?: string;
}): HookDecision {
  if (paused) return { action: "allow", stage: "pause" };

  if (handoverAgeMin !== null && handoverAgeMin < HANDOVER_FRESH_MIN) {
    // Attest verification (PROC-DEV-037): a fresh `reason: budget` handover whose attestation
    // the harness cannot parse is a hard stop over there — catch it HERE, while the session can
    // still fix the file. Capped like every block; without a measurement to dictate, fail-open.
    if (
      handoverText !== null &&
      handoverReason(handoverText) === "budget" &&
      !handoverAttestValid(handoverText) &&
      contextTokens !== null &&
      attestBlockCount < MAX_BLOCKS
    ) {
      return {
        action: "block",
        stage: "attest",
        reason:
          `architect-stop-check: your \`.spec-sync-handover.md\` carries \`reason: budget\` but ` +
          "its attestation is unreadable for the harness — it will refuse the renewal. Rewrite " +
          "the file NOW via the Write tool: keep line 1 `reason: budget` and your handoff lines, " +
          "and make the context block EXACTLY these two lines, verbatim — do not translate or " +
          "reword them:\n" +
          `## Context\n- State: ${contextTokens} Tokens (measured ${measuredAt})\n` +
          "Then end the turn — no further tool call.",
      };
    }
    return { action: "allow", stage: "handover" };
  }

  const percent = contextPercent(contextTokens, budgetTokens);
  if (percent === null || percent < ARCHITECT_BUDGET_PERCENT || budgetAlreadyBlocked)
    return { action: "allow", stage: "clean" };

  const stand = `Context at ${contextTokens} tokens (${Math.round(percent)} % of the budget ${budgetTokens}).`;
  if (ownerEngaged)
    return {
      action: "block",
      stage: "budget-owner",
      reason:
        `architect-stop-check: ${stand} An owner conversation is running (owner input in this ` +
        'session): do NOT write a handover. Tell the owner in one line "Context at ' +
        `${Math.round(percent)} % — please /handover once we are done" and end the turn.`,
    };
  return {
    action: "block",
    stage: "budget",
    reason:
      `architect-stop-check: ${stand} Write \`.spec-sync-handover.md\` into the working directory ` +
      "NOW via the Write tool: line 1 exactly `reason: budget`, then 3–5 lines of handoff (question " +
      "ids handled, spec_refs set, what's open), then exactly this block:\n" +
      `## Context\n- State: ${contextTokens} Tokens (measured ${measuredAt})\n` +
      "Then end the turn — no further tool call. If an owner conversation is running instead: " +
      'do not write, announce it ("Context at X % — please /handover").',
  };
}
