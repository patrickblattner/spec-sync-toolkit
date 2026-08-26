// subagent-stop-check — completion acceptance of a build agent (SubagentStop hook, #1091 (c)).
// (No shebang here: tsup sets it as a banner in the build.)
//
// Its own valve chain, its own counter PER AGENT RUN (the key is the agent transcript, not the
// session): two agents running in parallel must not use up each other's blocks.
//   pause flag → budget stage → block cap → type gate → acceptance checker
// The task at budget is different from the session's: an agent does not clean up a workbench, it
// reports CONTEXT LOW and hands the follow-up tickets off to a fresh agent.
//
// Home in the toolkit since 2026-08-18 (decision #193); the worker repos only register the
// call on `dist/hooks/subagent-stop-check.js`.
import { decideSubagentStop } from "./lib.js";
import { askAcceptance } from "./acceptance.js";
import {
  budgetAlreadyBlocked,
  bumpCount,
  clearCount,
  counterKeyOf,
  emit,
  isPaused,
  markBudgetBlocked,
  measureContextPercent,
  readContextBudget,
  readCount,
  readHookInput,
} from "./io.js";

const KIND = "subagent-stop-check";
const input = readHookInput();
const cwd = String(input.cwd || process.cwd());
const key = counterKeyOf(input);
const message = String(input.last_assistant_message || "");
const agentType = String(input.agent_type || "");
const count = readCount(KIND, key);

const decision = decideSubagentStop({
  paused: isPaused(cwd),
  contextPercent: measureContextPercent(input.transcript_path, readContextBudget(cwd)),
  budgetAlreadyBlocked: budgetAlreadyBlocked(KIND, key),
  blockCount: count,
  agentType,
  acceptance: () => askAcceptance({ kind: "subagent", message, agentType, cwd }),
});

if (decision.action === "block") {
  bumpCount(KIND, key, count);
  if (decision.stage === "budget") markBudgetBlocked(KIND, key);
} else {
  clearCount(KIND, key);
}

emit(decision, "SubagentStop");
