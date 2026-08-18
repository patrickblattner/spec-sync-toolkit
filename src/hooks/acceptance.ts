// Abnahme-Teilschritt der Turn-Ende-Hooks (#1091 (b)/(c)).
//
// Bis zum 17.08. war das ein nativer `prompt`-Hook. Verboten ist genau diese Bauform — sie steht
// vor keiner Ventilkette und blockte deshalb ungebremst (Vorfall 16./17.08.); die Prüfung selbst
// ist gefordert. Sie kehrt hier als Teilschritt EINES Command-Hooks zurück: befragt wird nur, wer
// das Regex-Tor passiert hat und an dem alle Ventile vorbei sind, geantwortet wird strukturiert,
// geparst wird deterministisch. Der Wortlaut der Prüfaufträge ist der der entfernten prompt-Hooks
// (production-cockpit Commit 0c80ded4), nicht neu erfunden.
//
// Die eine Regel, die über allem steht: **fail-open**. Kein Prüfer, kein Netz, kaputte Antwort,
// Zeitüberschreitung — alles endet in ERLAUBEN. Ein Hook, der härter ist als sein Wissen, hält die
// Session an, ohne etwas zu wissen; genau das war der Block-Loop. Damit "erlaubt" nicht mit
// "geantwortet" verwechselt wird, wird JEDER fail-open-Fall mit seinem Grund protokolliert: ein
// Prüfer, der nie antwortet, sieht sonst aus wie einer, der nie etwas zu beanstanden hat.

import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import type { AcceptanceVerdict } from "./lib.js";

// Modell explizit gepinnt: ein `claude -p` ohne `--model` erbt den globalen Eintrag — auf diesem Weg
// liefen beide Worker vom 13.–17.08. unbemerkt auf einem grossen Modell (doppelte Quote-Last). Für
// ein Ein-Zeilen-Verdikt über einen kurzen Text ist Haiku die richtige Klasse.
const MODEL = "claude-haiku-4-5-20251001";
/** Harte Obergrenze des Prüfaufrufs. Der Hook-Timeout in den Settings muss darüber liegen. */
const TIMEOUT_MS = 45_000;
/** So viel Schlussnachricht sieht der Prüfer — der Rest trägt zur Beurteilung nichts bei. */
const MAX_MESSAGE_CHARS = 6000;
/** Auszählbares Protokoll, eine JSON-Zeile je Befragung. */
const LOG_FILE = join(".spec-sync", "acceptance-check.jsonl");

const OUTPUT_CONTRACT =
  'Antworte mit GENAU einer Zeile JSON, ohne Rahmen, ohne Erklärung davor oder danach: {"decision":"allow"} oder {"decision":"block","reason":"<der fehlende Beleg, ein Satz>"}.';

const STOP_PROMPT =
  "Abnahme-Prüfer für das Turn-Ende einer spec-sync-Worker-Session. Beurteile NUR die unten stehende " +
  "Schlussnachricht. ERLAUBE, wenn die Nachricht kein Durchlauf-Ende behauptet (Zwischenstand, " +
  "Rückfrage, Owner-Dialog) — normale Turns nie blocken. ERLAUBE ein behauptetes Durchlauf-Ende bei " +
  "einem der drei belegten Ausgänge: (1) Handover geschrieben (npx spec-sync handover, beliebiger " +
  "--reason) — immer erlauben, nie nach einem Handover blocken. (2) In-sync-Ende: check_drift ohne " +
  "Änderungen UND leerer Ticket-Sweep (auto-audit, type: bug, spec-sync) sind konkret genannt. " +
  "(3) Durchlauf-DoD: Zielabgleich nennt Drift→Tickets→Merges, die Zuordnung der offenen Issues, die " +
  "Section-Zuordnung und die leere Werkbank (keine Worktrees/Ticket-Branches, Agents gestoppt, Merges " +
  "gepusht). BLOCKE nur, wenn ein Durchlauf-Ende oder Zielabgleich behauptet wird und ein Beleg fehlt " +
  "— nenne den fehlenden Beleg präzise. Im Zweifel erlauben.";

const SUBAGENT_PROMPT =
  "Abnahme-Prüfer für den Abschluss eines Build-Agenten in einem spec-sync-Worker-Repo. Beurteile NUR " +
  "die unten stehende Schlussnachricht. Zwischenstände immer erlauben (Frage, Statusmeldung, " +
  "CONTEXT LOW, Eskalation oder Blockade mit Grund). BLOCKE nur, wenn die Nachricht behauptet, das " +
  "Ticket sei fertig gebaut oder bereit zum Merge, ohne Gate-Beleg (Gate-Kommando mit grünem Ergebnis " +
  "bzw. Exit-Code) — bei einem review-Agenten ohne abgegebenes Verdict. Nenne den fehlenden Beleg " +
  "präzise. Im Zweifel erlauben.";

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
 * Fragt den Prüfer und gibt `{decision, reason}` zurück, wenn er BLOCKT — sonst `null`. Für die
 * Kette heisst `null` immer ERLAUBEN, gleich ob der Prüfer erlaubt hat oder gar nicht antworten
 * konnte; welcher der beiden Fälle es war, steht danach im Protokoll.
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
    // Antwort da, aber unlesbar — das ist ein anderer Fehler als "nicht erreichbar", und nur
    // getrennt gezählt sieht man, ob das Modell strukturell danebenliegt.
    log(cwd, { ...entry, outcome: "fail-open", failReason: "parse", raw: short(raw) });
    return null;
  }

  // Verdikt UND Begründung wandern ins Protokoll: ein Block, dessen eigene Begründung auf ERLAUBEN
  // schliessen lässt, ist nur so später überhaupt auffindbar.
  log(cwd, { ...entry, outcome: verdict.decision, reason: verdict.reason });
  return verdict.decision === "block" ? verdict : null;
}

function buildPrompt(kind: string, text: string, agentType: unknown): string {
  const head = kind === "subagent" ? SUBAGENT_PROMPT : STOP_PROMPT;
  const context = kind === "subagent" ? `\n\nAgent-Typ: ${String(agentType ?? "unbekannt")}` : "";
  return `${head}\n\n${OUTPUT_CONTRACT}${context}\n\nSchlussnachricht:\n"""\n${text}\n"""`;
}

/** Der eine Aufruf nach draussen. Getrennt gehalten, damit Tests ihn ersetzen können. */
function runChecker(prompt: string): string {
  return execFileSync("claude", ["-p", prompt, "--model", MODEL, "--output-format", "json"], {
    encoding: "utf8",
    timeout: TIMEOUT_MS,
    maxBuffer: 1024 * 1024,
  });
}

/** Zeitüberschreitung oder sonstiger Laufzeitfehler — die beiden trennen sich am Kill-Signal. */
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

/** Best-effort-Protokoll: eine JSON-Zeile. Schlägt das Schreiben fehl, bleibt es beim Erlauben. */
export function logLine(cwd: string, entry: LogEntry): void {
  try {
    const dir = join(cwd || process.cwd(), ".spec-sync");
    mkdirSync(dir, { recursive: true });
    appendFileSync(
      join(cwd || process.cwd(), LOG_FILE),
      `${JSON.stringify({ ts: new Date().toISOString(), ...entry })}\n`,
    );
  } catch {
    // Protokoll nicht schreibbar — der Hook entscheidet trotzdem, nur leiser.
  }
}

/**
 * Liest das Verdikt aus der Prüfer-Antwort: `{decision, reason}` bei `block`, `{decision:"allow"}`
 * bei `allow`, und `null`, wenn nichts Lesbares da war. Zwei Hüllen sind möglich — die JSON-Hülle
 * des Clients (`{"result":"…"}`) und die blanke Antwort; beides wird versucht.
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
    // Keine Hülle — dann ist die Ausgabe selbst die Antwort.
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
    typeof v.reason === "string" && v.reason.trim() !== "" ? v.reason.trim() : "Beleg fehlt";
  return { decision: "block", reason };
}
