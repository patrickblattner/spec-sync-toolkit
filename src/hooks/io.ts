// Die Aussenwelt der Turn-Ende-Hooks (#1091): Hook-Input, Zähler, Kontextmessung, Usage, Werkbank.
//
// Getrennt von `lib.ts`, weil dort die Entscheidung steht und hier die Messung. Jede
// Funktion hier ist so gebaut, dass ihr Fehlschlag NICHTS blockt: sie liefert dann den Wert, den
// die Kette als "weiss ich nicht" liest (null, false, leere Liste). Fail-open ist keine Zutat des
// Hooks, sondern seine Bauart.
//
// Die Hooks sind eigene Binaries mit dem stdout-Protokoll des Claude-Code-Hook-Vertrags —
// der CLI-Envelope-Vertrag (spec §3, src/output.ts) gilt für sie nicht; die beiden
// console.log in `emit()` tragen dafür begründete Inline-Disables.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { contextFromTranscript, contextPercent, handoverAgeMinutes } from "./lib.js";
import type { HookDecision, UsageWindow } from "./lib.js";

export type HookInput = Record<string, unknown>;

/** Hook-Input von stdin. Leer oder kaputt heisst Defaults — nie ein Abbruch. */
export function readHookInput(): HookInput {
  try {
    const parsed: unknown = JSON.parse(readFileSync(0, "utf8") || "{}");
    return parsed !== null && typeof parsed === "object" ? (parsed as HookInput) : {};
  } catch {
    return {};
  }
}

export function isPaused(cwd: string): boolean {
  return existsSync(join(cwd, ".spec-sync-pause"));
}

/** Alter des Handovers in Minuten, oder null wenn keines daliegt oder es nicht lesbar ist. */
export function handoverAge(cwd: string): number | null {
  const file = join(cwd, ".spec-sync-handover.md");
  if (!existsSync(file)) return null;
  try {
    return handoverAgeMinutes({
      content: readFileSync(file, "utf8"),
      mtimeMs: statSync(file).mtimeMs,
    });
  } catch {
    return null;
  }
}

/** `contextBudget` aus der Repo-Konfiguration; null, wenn dort keines steht. */
export function readContextBudget(cwd: string): number | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(join(cwd, "spec-sync.config.json"), "utf8"));
    const budget = (parsed as { contextBudget?: unknown }).contextBudget;
    return typeof budget === "number" && Number.isFinite(budget) && budget > 0 ? budget : null;
  } catch {
    return null;
  }
}

/** Kontextstand des Transcripts in Prozent des Budgets; null, sobald eine Größe fehlt. */
export function measureContextPercent(
  transcriptPath: unknown,
  budget: number | null,
): number | null {
  if (!transcriptPath || budget === null) return null;
  try {
    return contextPercent(
      contextFromTranscript(readFileSync(String(transcriptPath), "utf8")),
      budget,
    );
  } catch {
    return null;
  }
}

// Zähler und Budget-Marke liegen im tmp-Verzeichnis, je Lauf unter einem eigenen Schlüssel: für die
// Session die session_id, für einen Agenten sein eigenes Transcript — "je Agent-Lauf" ist genau das.
const state = (kind: string, key: string) => join(tmpdir(), `${kind}-${key || "unknown"}`);

export function counterKeyOf(input: HookInput): string {
  if (input.transcript_path)
    return basename(String(input.transcript_path)).replace(/\.jsonl$/u, "");
  return String(input.session_id || "unknown");
}

export function readCount(kind: string, key: string): number {
  try {
    return parseInt(readFileSync(state(kind, `${key}.count`), "utf8"), 10) || 0;
  } catch {
    return 0;
  }
}

export function bumpCount(kind: string, key: string, count: number): void {
  try {
    writeFileSync(state(kind, `${key}.count`), String(count + 1));
  } catch {
    // Zähler nicht schreibbar: der Block gilt trotzdem, nur die Obergrenze greift später.
  }
}

export function clearCount(kind: string, key: string): void {
  try {
    unlinkSync(state(kind, `${key}.count`));
  } catch {
    // Kein Zähler da — nichts zu tun.
  }
}

// Die Budget-Marke überlebt das Aufräumen des Zählers ABSICHTLICH: "genau einmal" gilt für den
// ganzen Lauf. Würde sie mit dem Zähler fallen, blockte die Budget-Stufe nach jedem erlaubten Turn
// erneut — aus einer einmaligen Anweisung würde eine Schleife.
export function budgetAlreadyBlocked(kind: string, key: string): boolean {
  return existsSync(state(kind, `${key}.budget`));
}

export function markBudgetBlocked(kind: string, key: string): void {
  try {
    writeFileSync(state(kind, `${key}.budget`), new Date().toISOString());
  } catch {
    // Nicht markierbar: schlimmstenfalls blockt die Stufe ein zweites Mal, die Obergrenze fängt es.
  }
}

/**
 * Kontoweites Usage-Fenster >= Schwelle? Dann endet die Session still, statt Arbeit ins
 * Sonderguthaben zu erzwingen (Vorfall 2026-08-16). Token via stdin, nie argv.
 */
export function usageOverThreshold(threshold: number): UsageWindow | null {
  try {
    const cred = execFileSync(
      "security",
      ["find-generic-password", "-s", "Claude Code-credentials", "-w"],
      { encoding: "utf8" },
    );
    const token = (JSON.parse(cred) as { claudeAiOauth: { accessToken: string } }).claudeAiOauth
      .accessToken;
    const usage: unknown = JSON.parse(
      execFileSync(
        "curl",
        ["-fsS", "--max-time", "5", "--config", "-", "https://api.anthropic.com/api/oauth/usage"],
        {
          encoding: "utf8",
          input:
            `header = "Authorization: Bearer ${token}"\n` +
            `header = "anthropic-beta: oauth-2025-04-20"\n`,
        },
      ),
    );
    const limits = (usage as { limits?: unknown }).limits;
    return (
      (Array.isArray(limits) ? (limits as UsageWindow[]) : []).find(
        (l) =>
          ["session", "weekly_all"].includes(l && l.kind) &&
          Number.isFinite(l && l.percent) &&
          l.percent >= threshold,
      ) ?? null
    );
  } catch {
    return null;
  }
}

/** Werkbank-Befund: Worktrees, Ticket-Branches, ungepushte Commits, getrackte Änderungen. */
export function workbenchFindings(cwd: string): string[] {
  const git = (...args: string[]) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
  const findings: string[] = [];
  try {
    const wts = git("worktree", "list", "--porcelain").split("\n\n").filter(Boolean);
    if (wts.length > 1)
      findings.push(`${wts.length - 1} Worktree(s) neben dem Hauptbaum — git worktree remove`);
    const branches = git("branch", "--format=%(refname:short)")
      .split("\n")
      .filter((b) => b && b !== "main");
    if (branches.length)
      findings.push(`lokale Branches neben main: ${branches.join(", ")} — gemergte löschen`);
    const ahead = git("rev-list", "origin/main..main", "--count");
    if (ahead !== "0")
      findings.push(`${ahead} ungepushte(r) Commit(s) auf main — git push origin main`);
    const dirty = git("status", "--porcelain")
      .split("\n")
      .filter((l) => l && !l.startsWith("??"))
      // `.claude/**` ist Owner-/Overmind-Domäne (Entscheid #192): der Worker darf die Datei
      // nicht anfassen und könnte diesen Befund deshalb NIE beräumen — die Chore-Regel lässt
      // die Änderung absichtlich liegen (fährt mit dem nächsten Push mit). Als Werkbank-Befund
      // gewertet blockte sie jedes Turn-Ende bis zur Obergrenze (gemessen 18.08.,
      // Cockpit-/unpause: Block auf `M .claude/settings.json` direkt nach dem Settings-Chore).
      // Regex statt Spalten-Slice: das `trim()` der git-Hilfe kappt die führende
      // Statusspalte der ersten Zeile, feste Offsets lügen dann.
      .filter((l) => !/(^|\s)\.claude\//.test(l));
    if (dirty.length)
      findings.push(`Änderungen an getrackten Dateien: ${dirty.slice(0, 5).join(" | ")}`);
  } catch {
    // git nicht befragbar: keine Aussage über die Werkbank, also kein Befund und kein Block.
    return [];
  }
  return findings;
}

/** Entscheidung ausgeben und den Hook beenden. Ausgabeformat wie bisher (Stop/SubagentStop). */
export function emit(decision: HookDecision, hookEventName: string): never {
  if (decision.action === "block") {
    // eslint-disable-next-line no-console -- Hook-Protokoll: stdout gehört hier dem Hook-Vertrag.
    console.log(
      JSON.stringify({
        decision: "block",
        reason: decision.reason,
        hookSpecificOutput: { hookEventName, decision: "block", reason: decision.reason },
      }),
    );
  } else if (decision.note) {
    // eslint-disable-next-line no-console -- Hook-Protokoll: stdout gehört hier dem Hook-Vertrag.
    console.log(JSON.stringify({ systemMessage: decision.note }));
  }
  process.exit(0);
}
