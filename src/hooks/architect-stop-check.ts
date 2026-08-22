// architect-stop-check — Turn-Ende-Budgetgrenze der Architekten-Inbox (Stop-Hook).
// (Kein Shebang hier: tsup setzt ihn als Banner in den Build.)
//
// Kette (PROC-DEV-020 rev 4 / PROC-DEV-036 rev 5, Owner-Wort 22.08.):
//   Pause-Flag → frisches Handover → Budget-Stufe (75 %, genau einmal je Session)
// Keine Werkbank, kein Abnahme-Prüfer, kein Usage-Ventil: der Architekt baut nichts. Die Stufe
// misst an JEDEM Turn-Ende aus dem Transcript und diktiert im Block das Handover mit der
// gemessenen Zahl — die Session kennt ihr Fenster nicht, der Hook schon. Bei laufendem
// Owner-Gespräch (Zustandsdatei des worker-harness-Hooks) erzwingt sie die Ansage statt des
// Handovers. Fail-open über die ganze Länge: jede Messung liefert im Fehlerfall "weiss ich nicht".
//
// Die Architekten-Repos registrieren nur den Aufruf auf `dist/hooks/architect-stop-check.js`;
// das Budget steht in ihrer `spec-sync.config.json` (`contextBudget`).
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
