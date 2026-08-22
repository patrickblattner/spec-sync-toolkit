// Entscheidungslogik der Turn-Ende-Hooks (#1091 Ventilkette, #1095 Handover-Frische).
//
// Heimat seit 2026-08-18 hier im Toolkit (Entscheid #193): EINE Quelle für alle Worker-Repos,
// die Repos registrieren nur noch den Hook-Aufruf auf `dist/hooks/*` — identisches Verhalten
// überall ist damit Konstruktion, nicht Kopier-Disziplin. Portiert 1:1 aus
// production-cockpit `scripts/stop-check.lib.mjs` (Stand e070647b/011896b4).
//
// Hier steht alles, was ohne Prozess, Netz und Dateisystem entscheidbar ist: die Frische-Messung,
// die Kontextmessung aus dem Transcript und die beiden Ventilketten. Die Treiber
// (`stop-check.ts`, `subagent-stop-check.ts`) liefern die Messwerte und führen aus, was hier
// beschlossen wird — deshalb ist die Kette testbar, ohne einen Hook zu starten.
//
// --- Frische-Messung des Handovers (#1095, dev.process 2.35.0 §Worker-Loop) ---
//
// "Frisch" ist die SCHREIBZEIT des Handovers, nicht die Dateizeit: `/unpause` und der
// Harness-`touch` fassen `.spec-sync-handover.md` an, ohne dass ein neues Handover geschrieben
// wurde — über `mtime` gemessen entwaffnete das die Werkbank-Prüfung für die Dauer des
// Frische-Fensters, obwohl danach neue Arbeit läuft. Gemessen wird deshalb der Zeitstempel aus dem
// Inhalt (`- Zeit: <ISO>`, so schreibt `spec-sync handover` ihn); `mtime` bleibt Fallback für den
// Fall, dass die Zeile fehlt oder nicht parsebar ist.

const TIME_LINE = /^[-*]\s*Zeit:\s*(\S+)/m;

/** Zeitstempel aus dem Handover-Inhalt in ms, oder null wenn keine parsebare `- Zeit:`-Zeile. */
export function parseHandoverTime(content: unknown): number | null {
  const m = TIME_LINE.exec(String(content ?? ""));
  if (!m) return null;
  const ms = Date.parse(m[1] as string);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Alter des Handovers in Minuten. `content` schlägt `mtimeMs`; ohne beides null (unbekannt).
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

// --- Kontextmessung aus dem Transcript (#1091 (a), Messlogik wie `spec-sync budget`) ---
//
// Eine Session kann ihr eigenes Fenster nicht beobachten, der Client schreibt es aber mit. Zwei
// Fallen stecken darin, beide hier abgebildet: Streaming schreibt bis zu drei Einträge je
// API-Aufruf, jeden mit vollem `usage`-Block — deshalb wird nach `message.id` dedupliziert. Und der
// Stand ist der JÜNGSTE Eintrag, nicht die Summe: der letzte Aufruf trägt das ganze Fenster, eine
// Summe über die Session zählte es dutzendfach.

/** Kontextstand (Tokens) eines Transcripts, oder null wenn nichts Messbares drinsteht. */
export function contextFromTranscript(raw: unknown): number | null {
  const seen = new Set<string>();
  let latest: number | null = null;
  for (const line of String(raw ?? "").split("\n")) {
    if (line.trim() === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      // Halb geschriebene letzte Zeile: das Transcript wird live geschrieben — überspringen.
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

/** Kontextstand in Prozent des Budgets; null, wenn eine der beiden Größen fehlt. */
export function contextPercent(context: number | null, budget: number | null): number | null {
  if (
    !Number.isFinite(context as number) ||
    !Number.isFinite(budget as number) ||
    (budget as number) <= 0
  )
    return null;
  return ((context as number) / (budget as number)) * 100;
}

// --- Ventilketten (#1091 (b)/(c)) ---

export const MAX_BLOCKS = 3;
export const HANDOVER_FRESH_MIN = 60;
/** Schwelle des Usage-Ventils — dieselbe wie beim Harness-Guard (dev.process §Worker-Loop). */
export const USAGE_THRESHOLD_PERCENT = 95;
/** Ab hier erzwingt der Hook den geordneten Abschluss — 100 % des `contextBudget`. */
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
  "Schreibe JETZT `npx spec-sync handover --reason budget` und beende danach den Turn. " +
  "Nichts anderes mehr anfangen — der Kontext ist am Budget.";

/**
 * Die Ventilkette des Stop-Hooks, als eine Entscheidung.
 *
 * RANGORDNUNG (dev.process 2.36.1 §Worker-Loop (b)): Pause-Flag → frisches Handover → Budget-Stufe →
 * Usage-Ventil → Block-Obergrenze, dahinter die blockfähigen Teilschritte Werkbank-Prüfung und
 * Abnahme-Prüfer. Sie sagt, WELCHES VENTIL GEWINNT, wenn mehrere greifen könnten — nicht, wann
 * jedes abgefragt wird.
 *
 * PRÜFZEITPUNKT — jedes Ventil nennt seinen eigenen (#1107, Q&A #447/#448):
 *   - Die Budget-Stufe misst an JEDEM Turn-Ende (dev.process §Worker-Loop (a)) und steht deshalb
 *     vor dem Tor.
 *   - Das Usage-Ventil wird NUR UNMITTELBAR VOR EINEM BLOCK abgefragt, „nie bei normalen
 *     Turn-Enden" (§Usage-Stopp im Worker (a)) — es steht deshalb hinter dem Tor, direkt vor den
 *     Block-Teilschritten. Ein Ventil vor dem Tor abzufragen, das den Hook nur ÖFFNEN kann, ändert
 *     keinen Ausgang: es bestätigt das „erlauben", das ohnehin eintritt, und bezahlt dafür
 *     Keychain-Zugriff, Netzaufruf und Latenz an jedem Warte- und Zwischenstands-Turn.
 *
 * Die teuren Sonden (Usage-Abfrage, Werkbank, Prüfer) kommen als FUNKTIONEN herein, nicht als
 * Werte: so misst die Kette erst, wenn sie die Antwort auch braucht, und ein Test kann den
 * Prüfzeitpunkt daran festnageln, dass die Sonde nie gerufen wurde.
 *
 * `blockCount` ist der Zähler des GANZEN Hooks, nicht der eines Teilschritts: drei Blocks sind drei
 * Blocks, gleich aus welchem Grund — sonst summierten sich die Teilschritte zu einer Schleife, die
 * keine einzelne Obergrenze je beendet.
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

  // Budget-Stufe: genau EIN Block je Session. Danach läuft die Kette normal weiter — schreibt die
  // Session trotzdem kein Handover, lässt die Block-Obergrenze sie irgendwann durch. Der Hook
  // erzwingt einen geordneten Abschluss, er sperrt die Session nicht ein.
  if (percent !== null && percent >= BUDGET_PERCENT && !budgetAlreadyBlocked)
    return {
      action: "block",
      stage: "budget",
      reason: `stop-check: Kontext bei ${Math.round(percent)} % des Budgets. ${HANDOVER_INSTRUCTION}`,
    };

  // Tor für ALLES, was dahinter liegt: nur eine Grenz-Behauptung wird geprüft. Ein Zwischenstand,
  // eine Rückfrage, ein Owner-Dialog ist kein Durchlauf-Ende und wird nie angefasst. Das Tor steht
  // VOR dem Usage-Ventil (#1107): hinter ihm kann noch geblockt werden, davor nie — und das
  // Usage-Ventil wird laut Norm nur unmittelbar vor einem Block abgefragt.
  if (!claimsBoundary) return { action: "allow", stage: "gate" };

  const over = usageOver();
  if (over)
    return {
      action: "allow",
      stage: "usage",
      note: `stop-check: Usage-Ventil — ${over.kind} ${over.percent} % >= ${USAGE_THRESHOLD_PERCENT} %, Session endet still. Aufgeräumt wird, wenn wieder Guthaben da ist.`,
    };

  if (blockCount >= MAX_BLOCKS)
    return {
      action: "allow",
      stage: "cap",
      note: `stop-check: nach ${MAX_BLOCKS} Blocks durchgelassen — der Befund bleibt und gehört in den Zielabgleich.`,
    };

  const workbench = findings();
  if (workbench.length)
    return {
      action: "block",
      stage: "workbench",
      reason: `Werkbank nicht leer (Block ${blockCount + 1}/${MAX_BLOCKS}): ${workbench.join("; ")}. Erst aufräumen (Worktree entfernen, Branch löschen, Push), dann Turn beenden — oder Handover mit belegtem Grund schreiben.`,
    };

  const verdict = acceptance();
  if (verdict && verdict.decision === "block")
    return {
      action: "block",
      stage: "acceptance",
      reason: `Abnahme (Block ${blockCount + 1}/${MAX_BLOCKS}): ${verdict.reason}`,
    };

  return { action: "allow", stage: "clean" };
}

/**
 * Die Ventilkette des SubagentStop-Hooks (#1091 (c)) — eigene Kette, eigener Zähler je Agent-Lauf.
 *
 * Der Unterschied zur Session-Kette ist der Auftrag: ein Agent am Budget räumt keine Werkbank auf,
 * er beendet sauber und gibt den Rest ab. Geprüft wird nur, wer ein Ticket baut oder abnimmt —
 * jeder andere Agent-Typ läuft ungeprüft durch.
 */
export const CHECKED_AGENT_TYPES = ["impl", "impl-fast", "impl-deep", "review"];

const AGENT_BUDGET_INSTRUCTION =
  "Melde jetzt deinen Stand mit der Schlusszeile `CONTEXT LOW` und beende den Lauf. " +
  "Folgetickets gehören an einen frischen Agenten, nicht mehr in diesen Lauf.";

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
      reason: `subagent-stop-check: Kontext bei ${Math.round(percent)} % des Budgets. ${AGENT_BUDGET_INSTRUCTION}`,
    };

  if (blockCount >= MAX_BLOCKS)
    return {
      action: "allow",
      stage: "cap",
      note: `subagent-stop-check: nach ${MAX_BLOCKS} Blocks durchgelassen — der Befund gehört in den Bericht.`,
    };

  if (!CHECKED_AGENT_TYPES.includes(agentType)) return { action: "allow", stage: "gate" };

  const verdict = acceptance();
  if (verdict && verdict.decision === "block")
    return {
      action: "block",
      stage: "acceptance",
      reason: `Abnahme (Block ${blockCount + 1}/${MAX_BLOCKS}): ${verdict.reason}`,
    };

  return { action: "allow", stage: "clean" };
}

/**
 * Die Ventilkette des Architekten-Stop-Hooks (PROC-DEV-020 / PROC-DEV-036, Owner-Wort 22.08.).
 *
 * Der Architekt hat keine Werkbank und keinen Abnahme-Prüfer — seine natürliche Grenze ist eine
 * beantwortete Frage, also das Turn-Ende. Deshalb EINE Stufe bei 75 % (der Schwelle, ab der der
 * Harness `budget` attestiert), genau einmal je Session. Die Block-Meldung diktiert das Handover
 * mit der gemessenen Zahl — die Session kennt ihr Fenster nicht, der Hook schon. Läuft ein
 * Owner-Gespräch (Owner-Eingabe in dieser Session), wird nicht das Handover, sondern die Ansage
 * erzwungen: der Owner beendet das Gespräch mit `/handover` (PROC-DEV-020 (4), Register #204).
 */
export const ARCHITECT_BUDGET_PERCENT = 75;

export function decideArchitectStop({
  paused = false,
  handoverAgeMin = null,
  contextTokens = null,
  budgetTokens = null,
  budgetAlreadyBlocked = false,
  ownerEngaged = false,
  measuredAt = new Date().toISOString(),
}: {
  paused?: boolean;
  handoverAgeMin?: number | null;
  contextTokens?: number | null;
  budgetTokens?: number | null;
  budgetAlreadyBlocked?: boolean;
  ownerEngaged?: boolean;
  measuredAt?: string;
}): HookDecision {
  if (paused) return { action: "allow", stage: "pause" };

  if (handoverAgeMin !== null && handoverAgeMin < HANDOVER_FRESH_MIN)
    return { action: "allow", stage: "handover" };

  const percent = contextPercent(contextTokens, budgetTokens);
  if (percent === null || percent < ARCHITECT_BUDGET_PERCENT || budgetAlreadyBlocked)
    return { action: "allow", stage: "clean" };

  const stand = `Kontext bei ${contextTokens} Tokens (${Math.round(percent)} % des Budgets ${budgetTokens}).`;
  if (ownerEngaged)
    return {
      action: "block",
      stage: "budget-owner",
      reason:
        `architect-stop-check: ${stand} Owner-Gespräch läuft (Owner-Eingabe in dieser Session): ` +
        "KEIN Handover schreiben. Sag dem Owner in einer Zeile „Kontext bei " +
        `${Math.round(percent)} % — bitte /handover, sobald wir fertig sind“ und beende den Turn.`,
    };
  return {
    action: "block",
    stage: "budget",
    reason:
      `architect-stop-check: ${stand} Schreibe JETZT per Write-Tool \`.spec-sync-handover.md\` ins ` +
      "Arbeitsverzeichnis: Zeile 1 exakt `reason: budget`, dann 3–5 Zeilen Übergabe (behandelte " +
      "Fragen-IDs, gesetzte spec_refs, Offenes), dann genau dieser Block:\n" +
      `## Kontext\n- Stand: ${contextTokens} Tokens (gemessen ${measuredAt})\n` +
      "Danach den Turn beenden — kein weiterer Werkzeugaufruf. Läuft doch ein Owner-Gespräch: " +
      "nicht schreiben, sondern ansagen („Kontext bei X % — bitte /handover“).",
  };
}
