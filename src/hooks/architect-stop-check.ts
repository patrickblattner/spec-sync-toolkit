// architect-stop-check — turn-end budget boundary of the architect inbox (stop hook).
// (No shebang here: tsup sets it as a banner in the build.)
//
// Chain (PROC-DEV-020 rev 4 / PROC-DEV-036 rev 5, owner's word 08/22):
//   pause flag → fresh handover → budget stage (75 %, exactly once per session)
// No workbench, no acceptance checker, no usage valve: the architect builds nothing. The stage
// measures at EVERY turn end from the transcript and dictates the handover in the block with the
// measured number — the session does not know its window, the hook does. With an owner
// conversation running (the worker-harness hook's state file) it forces the announcement instead
// of the handover. Fail-open throughout: every measurement delivers "don't know" on error.
//
// The architect repos only register the call on `dist/hooks/architect-stop-check.js`;
// the budget lives in their `spec-sync.config.json` (`contextBudget`).
import { decideArchitectStop } from "./lib.js";
import {
  budgetAlreadyBlocked,
  emit,
  handoverAge,
  isPaused,
  markBudgetBlocked,
  measureContextTokens,
  ownerEngaged,
  readContextBudget,
  readHookInput,
} from "./io.js";

const KIND = "architect-stop-check";
const input = readHookInput();
const cwd = String(input.cwd || process.cwd());
const sessionId = String(input.session_id || "unknown");

const decision = decideArchitectStop({
  paused: isPaused(cwd),
  handoverAgeMin: handoverAge(cwd),
  contextTokens: measureContextTokens(input.transcript_path),
  budgetTokens: readContextBudget(cwd),
  budgetAlreadyBlocked: budgetAlreadyBlocked(KIND, sessionId),
  ownerEngaged: ownerEngaged(cwd, sessionId),
});

if (decision.action === "block") markBudgetBlocked(KIND, sessionId);

emit(decision, "Stop");
