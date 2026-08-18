// stop-check — Turn-Ende-Abnahme der Worker-Session (Stop-Hook, Harness Level 3).
// (Kein Shebang hier: tsup setzt ihn als Banner in den Build.)
//
// Eine Kette, ein Zähler (#1091, dev.process 2.36.1 §Worker-Loop (b)) — RANGORDNUNG:
//   Pause-Flag → frisches Handover → Budget-Stufe → Usage-Ventil → Block-Obergrenze
//   → Werkbank-Prüfung → Abnahme-Prüfer
// Die Rangordnung sagt, welches Ventil GEWINNT, nicht wann jedes abgefragt wird. Den
// PRÜFZEITPUNKT nennt jedes Ventil selbst: die Budget-Stufe misst an jedem Turn-Ende, das
// Usage-Ventil nur unmittelbar vor einem Block (#1107) — es liegt deshalb hinter dem
// Grenz-Behauptungs-Tor, sonst kostete es Keychain und Netz an jedem Warte-Turn.
// Die Reihenfolge steht in `decideStop` (lib.ts), die Messung in io.ts, hier nur die
// Verdrahtung. Fail-open über die ganze Länge: der Hook darf nie härter sein als sein
// Wissen — dafür liefert jede Messung im Fehlerfall "weiss ich nicht" statt eines Blocks.
//
// Heimat seit 2026-08-18 im Toolkit (Entscheid #193); die Worker-Repos registrieren nur den
// Aufruf auf `dist/hooks/stop-check.js`.
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

// Nur Grenz-Behauptungen werden geprüft — dasselbe Tor für Werkbank-Prüfung und Abnahme-Prüfer.
const claimsBoundary =
  /zielabgleich|in sync|handover|durchlauf\s+(ist\s+)?(fertig|beendet|abgeschlossen)/i.test(
    message,
  );

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
