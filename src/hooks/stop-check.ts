// stop-check — turn-end acceptance of the worker session (stop hook, harness level 3).
// (No shebang here: tsup sets it as a banner in the build.)
//
// One chain, one counter (#1091, dev.process 2.36.1 §Worker-Loop (b)) — RANK ORDER:
//   pause flag → fresh handover → budget stage → usage valve → block cap
//   → workbench check → acceptance checker
// The rank order says which valve WINS, not when each is checked. Each valve names its own
// CHECK TIMING: the budget stage measures at every turn end, the usage valve only immediately
// before a block (#1107) — it therefore sits behind the boundary-claim gate, otherwise it would
// cost keychain and network on every waiting turn.
// The order lives in `decideStop` (lib.ts), the measurement in io.ts, only the wiring here.
// Fail-open throughout: the hook must never be stricter than its own knowledge — so every
// measurement delivers "don't know" instead of a block on error.
//
// Home in the toolkit since 2026-08-18 (decision #193); the worker repos only register the
// call on `dist/hooks/stop-check.js`.
import { decideStop, USAGE_THRESHOLD_PERCENT } from "./lib.js";
import { askAcceptance } from "./acceptance.js";
import {
  budgetAlreadyBlocked,
  bumpCount,
  clearCount,
  emit,
  handoverAge,
  isPaused,
  markBudgetBlocked,
  measureContextPercent,
  readContextBudget,
  readCount,
  readHookInput,
  usageOverThreshold,
  workbenchFindings,
} from "./io.js";

const KIND = "stop-check";
const input = readHookInput();
const cwd = String(input.cwd || process.cwd());
const key = String(input.session_id || "unknown");
const message = String(input.last_assistant_message || "");
const count = readCount(KIND, key);

// Only boundary claims are checked — the same gate for the workbench check and the acceptance checker.
const claimsBoundary =
  /goal reconciliation|in sync|handover|run\s+(is\s+)?(done|finished|completed)/i.test(message);

const decision = decideStop({
  paused: isPaused(cwd),
  handoverAgeMin: handoverAge(cwd),
  contextPercent: measureContextPercent(input.transcript_path, readContextBudget(cwd)),
  budgetAlreadyBlocked: budgetAlreadyBlocked(KIND, key),
  usageOver: () => usageOverThreshold(USAGE_THRESHOLD_PERCENT),
  blockCount: count,
  claimsBoundary,
  findings: () => workbenchFindings(cwd),
  acceptance: () => askAcceptance({ kind: "stop", message, cwd }),
});

if (decision.action === "block") {
  bumpCount(KIND, key, count);
  if (decision.stage === "budget") markBudgetBlocked(KIND, key);
} else {
  clearCount(KIND, key);
}

emit(decision, "Stop");
