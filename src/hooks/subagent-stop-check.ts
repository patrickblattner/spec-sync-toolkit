// subagent-stop-check — Abschluss-Abnahme eines Build-Agenten (SubagentStop-Hook, #1091 (c)).
// (Kein Shebang hier: tsup setzt ihn als Banner in den Build.)
//
// Eigene Ventilkette, eigener Zähler JE AGENT-LAUF (Schlüssel ist das Agent-Transcript, nicht die
// Session): zwei parallel laufende Agenten dürfen sich ihre Blocks nicht gegenseitig aufbrauchen.
//   Pause-Flag → Budget-Stufe → Block-Obergrenze → Typ-Tor → Abnahme-Prüfer
// Der Auftrag am Budget ist ein anderer als bei der Session: ein Agent räumt keine Werkbank auf, er
// meldet CONTEXT LOW und gibt die Folgetickets an einen frischen Agenten ab.
//
// Heimat seit 2026-08-18 im Toolkit (Entscheid #193); die Worker-Repos registrieren nur den
// Aufruf auf `dist/hooks/subagent-stop-check.js`.
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
