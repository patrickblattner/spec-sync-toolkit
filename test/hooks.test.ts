// Portiert aus production-cockpit scripts/stop-check.test.mjs (Stand e070647b/011896b4),
// Heimat-Umzug Entscheid #193 — inhaltlich unverändert, nur Import-Pfade und TS-Annotationen.
// Gegenprobe zur Handover-Frische des Stop-Hook-Ventils (#1095).
//
// Der Fehlerpfad, den diese Datei festnagelt: ein `touch` auf ein ALTES Handover (frische mtime,
// alter Inhalt) darf das Ventil nicht mehr öffnen.

import { describe, expect, it } from "vitest";

import type { AcceptanceVerdict } from "../src/hooks/lib.js";
import {
  ARCHITECT_BUDGET_PERCENT,
  CHECKED_AGENT_TYPES,
  MAX_BLOCKS,
  contextFromTranscript,
  decideArchitectStop,
  decideStop,
  decideSubagentStop,
  handoverAgeMinutes,
  parseHandoverTime,
} from "../src/hooks/lib.js";
import { askAcceptance, classify, parseVerdict } from "../src/hooks/acceptance.js";
import type { LogEntry } from "../src/hooks/acceptance.js";
import { measureContextPercent, ownerEngaged, workbenchFindings } from "../src/hooks/io.js";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NOW = Date.parse("2026-08-17T12:00:00.000Z");
const handover = (iso: string) =>
  `reason: done\n\n# spec-sync handover\n\n- Repo: /Users/pbl/projects/production-cockpit\n- Zeit: ${iso}\n`;

describe("parseHandoverTime", () => {
  it("liest die `- Zeit:`-Zeile aus dem Handover", () => {
    expect(parseHandoverTime(handover("2026-08-17T11:30:00.000Z"))).toBe(
      Date.parse("2026-08-17T11:30:00.000Z"),
    );
  });

  it("meldet null ohne Zeile und bei unparsebarem Wert", () => {
    expect(parseHandoverTime("# spec-sync handover\n\n- Repo: /x\n")).toBeNull();
    expect(parseHandoverTime("- Zeit: gestern\n")).toBeNull();
    expect(parseHandoverTime(undefined)).toBeNull();
  });
});

describe("handoverAgeMinutes", () => {
  it("frischer Inhalt: Ventil öffnet (Alter unter dem Fenster)", () => {
    const age = handoverAgeMinutes({
      content: handover("2026-08-17T11:30:00.000Z"),
      mtimeMs: NOW,
      now: NOW,
    });
    expect(age).toBe(30);
  });

  it("alter Inhalt trotz frischer mtime: Ventil bleibt zu (touch wirkt nicht)", () => {
    const age = handoverAgeMinutes({
      content: handover("2026-08-16T12:00:00.000Z"),
      mtimeMs: NOW, // gerade angefasst
      now: NOW,
    });
    expect(age).toBe(24 * 60);
  });

  it("Fallback: ohne parsebare Zeile zählt die mtime", () => {
    expect(
      handoverAgeMinutes({
        content: "# spec-sync handover\n\n- Repo: /x\n",
        mtimeMs: NOW - 10 * 60000,
        now: NOW,
      }),
    ).toBe(10);
    expect(
      handoverAgeMinutes({ content: "- Zeit: gestern\n", mtimeMs: NOW - 5 * 60000, now: NOW }),
    ).toBe(5);
  });

  it("weder Inhalt noch mtime: unbekannt (null)", () => {
    expect(handoverAgeMinutes({ content: "", mtimeMs: undefined, now: NOW })).toBeNull();
  });
});

// --- Ventilkette (#1091) ---
//
// Die Kette ist die eigentliche Mechanik dieses Hooks, und ihre Fehler sind still: eine vertauschte
// Reihenfolge blockt eine Session, die still enden sollte, ein je-Teilschritt gezählter Block macht
// aus der Obergrenze eine Endlosschleife, und ein Budget-Block ohne Marke wiederholt sich für immer.
// Genau diese vier Fälle stehen unten.

describe("contextFromTranscript", () => {
  const line = (id: string, usage: Record<string, unknown>) =>
    JSON.stringify({ type: "assistant", message: { id, usage } });

  it("nimmt den JÜNGSTEN Eintrag, nicht die Summe", () => {
    const raw = [
      line("a", { input_tokens: 10, cache_read_input_tokens: 90 }),
      line("b", { input_tokens: 20, cache_read_input_tokens: 180 }),
    ].join("\n");
    expect(contextFromTranscript(raw)).toBe(200);
  });

  it("dedupliziert nach message.id — Streaming schreibt denselben Aufruf mehrfach", () => {
    const raw = [
      line("a", { input_tokens: 100 }),
      line("a", { input_tokens: 100 }),
      line("a", { input_tokens: 100 }),
    ].join("\n");
    expect(contextFromTranscript(raw)).toBe(100);
  });

  it("überspringt kaputte und fremde Zeilen, statt zu werfen (live geschriebene Datei)", () => {
    const raw = [
      '{"type":"user","message":{"id":"u","usage":{"input_tokens":999}}}',
      line("a", { input_tokens: 50 }),
      '{"type":"assistant","message":{"id":"halb',
    ].join("\n");
    expect(contextFromTranscript(raw)).toBe(50);
  });

  it("ohne verwertbare Einträge: null (unbekannt, nicht null Tokens)", () => {
    expect(contextFromTranscript("")).toBeNull();
    expect(contextFromTranscript("kein json")).toBeNull();
  });
});

describe("decideStop — Reihenfolge der Ventile", () => {
  // Die Sonden zählen ihre Aufrufe: "das Ventil hat vorher gegriffen" heisst, dass die teure
  // Messung dahinter GAR NICHT lief — das ist die Reihenfolge, nachweisbar statt behauptet.
  const probes = () => {
    const calls = { usage: 0, findings: 0, acceptance: 0 };
    return {
      calls,
      usageOver: () => {
        calls.usage += 1;
        return null;
      },
      findings: () => {
        calls.findings += 1;
        return ["ein Worktree neben dem Hauptbaum"];
      },
      acceptance: (): AcceptanceVerdict => {
        calls.acceptance += 1;
        return { decision: "block", reason: "kein Gate-Beleg" };
      },
    };
  };

  it("Pause schlägt alles — keine Sonde läuft", () => {
    const p = probes();
    const d = decideStop({ paused: true, claimsBoundary: true, contextPercent: 150, ...p });
    expect(d).toMatchObject({ action: "allow", stage: "pause" });
    expect(p.calls).toEqual({ usage: 0, findings: 0, acceptance: 0 });
  });

  it("frisches Handover schlägt die Budget-Stufe", () => {
    const p = probes();
    const d = decideStop({ handoverAgeMin: 5, contextPercent: 150, claimsBoundary: true, ...p });
    expect(d).toMatchObject({ action: "allow", stage: "handover" });
    expect(p.calls.usage).toBe(0);
  });

  it("Budget-Stufe schlägt Usage und Werkbank", () => {
    const p = probes();
    const d = decideStop({ contextPercent: 100, claimsBoundary: true, ...p });
    expect(d).toMatchObject({ action: "block", stage: "budget" });
    expect(d.reason).toContain("spec-sync handover --reason budget");
    expect(p.calls).toEqual({ usage: 0, findings: 0, acceptance: 0 });
  });

  it("Usage-Ventil lässt still durch, ohne die Werkbank überhaupt zu messen", () => {
    const p = probes();
    const d = decideStop({
      ...p,
      usageOver: () => ({ kind: "weekly_all", percent: 100 }),
      claimsBoundary: true,
    });
    expect(d).toMatchObject({ action: "allow", stage: "usage" });
    expect(p.calls.findings).toBe(0);
  });

  it("ohne Grenz-Behauptung werden BEIDE Teilschritte übersprungen", () => {
    const p = probes();
    const d = decideStop({ claimsBoundary: false, ...p });
    expect(d).toMatchObject({ action: "allow", stage: "gate" });
    expect(p.calls.findings).toBe(0);
    expect(p.calls.acceptance).toBe(0);
  });

  // #1107 / dev.process 2.36.1 §Worker-Loop (b), Q&A #447/#448: die Kette ist eine RANGORDNUNG,
  // kein Ausführungsplan. Das Usage-Ventil wird laut Norm "nur unmittelbar vor einem Block"
  // abgefragt und "nie bei normalen Turn-Enden" — ein Warte- oder Zwischenstands-Turn darf
  // deshalb weder Keychain noch Netz kosten. Der Fehlbau, den dieser Test festnagelt: das Ventil
  // stand vor dem Tor und lief an JEDEM Turn-Ende, für ein Ergebnis, das nur öffnen kann.
  it("ohne Grenz-Behauptung wird das Usage-Ventil NIE abgefragt — auch nicht, wenn es greifen würde", () => {
    const p = probes();
    const d = decideStop({
      ...p,
      claimsBoundary: false,
      usageOver: () => {
        p.calls.usage += 1;
        return { kind: "weekly_all", percent: 100 };
      },
    });
    expect(d).toMatchObject({ action: "allow", stage: "gate" });
    expect(p.calls.usage).toBe(0);
  });

  it("die Rangordnung bleibt: Usage schlägt Block-Obergrenze, Werkbank und Abnahme", () => {
    const p = probes();
    const d = decideStop({
      ...p,
      claimsBoundary: true,
      blockCount: MAX_BLOCKS,
      usageOver: () => ({ kind: "weekly_all", percent: 100 }),
    });
    expect(d).toMatchObject({ action: "allow", stage: "usage" });
    expect(p.calls).toMatchObject({ findings: 0, acceptance: 0 });
  });

  it("Werkbank vor Abnahme: der Prüfer wird erst bei leerer Werkbank befragt", () => {
    const p = probes();
    expect(decideStop({ claimsBoundary: true, ...p })).toMatchObject({
      action: "block",
      stage: "workbench",
    });
    expect(p.calls.acceptance).toBe(0);

    const q = probes();
    const d = decideStop({ claimsBoundary: true, ...q, findings: () => [] });
    expect(d).toMatchObject({ action: "block", stage: "acceptance" });
    expect(d.reason).toContain("kein Gate-Beleg");
  });
});

describe("decideStop — hook-weiter Zähler und Budget-Marke", () => {
  it("die Obergrenze zählt hook-weit: drei Blocks sind drei Blocks, gleich welcher Stufe", () => {
    const args = {
      claimsBoundary: true,
      findings: () => ["ein Worktree neben dem Hauptbaum"],
      acceptance: (): AcceptanceVerdict => ({ decision: "block", reason: "x" }),
    };
    expect(decideStop({ ...args, blockCount: MAX_BLOCKS - 1 }).action).toBe("block");
    const capped = decideStop({ ...args, blockCount: MAX_BLOCKS });
    expect(capped).toMatchObject({ action: "allow", stage: "cap" });
    expect(capped.note).toContain(`nach ${MAX_BLOCKS} Blocks`);
  });

  it("Budget blockt GENAU EINMAL — mit gesetzter Marke läuft die Kette weiter", () => {
    const first = decideStop({ contextPercent: 120, claimsBoundary: false });
    expect(first).toMatchObject({ action: "block", stage: "budget" });

    const second = decideStop({
      contextPercent: 120,
      budgetAlreadyBlocked: true,
      claimsBoundary: false,
    });
    expect(second).toMatchObject({ action: "allow", stage: "gate" });
  });

  it("unmessbarer Kontext blockt nie (fail-open)", () => {
    expect(decideStop({ contextPercent: null, claimsBoundary: false }).stage).toBe("gate");
  });

  it("unter dem Budget blockt die Stufe nicht", () => {
    expect(decideStop({ contextPercent: 99.9, claimsBoundary: false }).stage).toBe("gate");
  });
});

describe("decideSubagentStop", () => {
  const blocking = (): AcceptanceVerdict => ({
    decision: "block",
    reason: "Fertig ohne Gate-Beleg",
  });

  it("prüft nur bauende und abnehmende Agenten", () => {
    expect(decideSubagentStop({ agentType: "investigate", acceptance: blocking }).stage).toBe(
      "gate",
    );
    expect(decideSubagentStop({ agentType: "docs", acceptance: blocking }).stage).toBe("gate");
    for (const agentType of CHECKED_AGENT_TYPES)
      expect(decideSubagentStop({ agentType, acceptance: blocking })).toMatchObject({
        action: "block",
        stage: "acceptance",
      });
  });

  it("Budget erzwingt den sauberen Abschluss, genau einmal", () => {
    const first = decideSubagentStop({ agentType: "impl", contextPercent: 100 });
    expect(first).toMatchObject({ action: "block", stage: "budget" });
    expect(first.reason).toContain("CONTEXT LOW");
    expect(
      decideSubagentStop({ agentType: "impl", contextPercent: 100, budgetAlreadyBlocked: true })
        .stage,
    ).toBe("clean");
  });

  it("Pause und Obergrenze lassen durch", () => {
    expect(
      decideSubagentStop({ paused: true, agentType: "impl", acceptance: blocking }).action,
    ).toBe("allow");
    expect(
      decideSubagentStop({ agentType: "impl", blockCount: MAX_BLOCKS, acceptance: blocking }),
    ).toMatchObject({ action: "allow", stage: "cap" });
  });

  it("ein Prüfer ohne Verdikt erlaubt (fail-open)", () => {
    expect(decideSubagentStop({ agentType: "impl", acceptance: () => null }).stage).toBe("clean");
  });
});

describe("parseVerdict", () => {
  it("liest ein Block-Verdikt aus der JSON-Hülle des Prüfprozesses", () => {
    const raw = JSON.stringify({ result: '{"decision":"block","reason":"kein Gate-Beleg"}' });
    expect(parseVerdict(raw)).toEqual({ decision: "block", reason: "kein Gate-Beleg" });
  });

  it("liest es auch ohne Hülle und mit Geschwätz drumherum", () => {
    expect(parseVerdict('Klar: {"decision":"block","reason":"kein Verdict"} — fertig')).toEqual({
      decision: "block",
      reason: "kein Verdict",
    });
  });

  it("trennt ERLAUBT von UNLESBAR — genau diese Trennung trägt das Protokoll", () => {
    expect(parseVerdict('{"decision":"allow"}')).toEqual({ decision: "allow" });
    expect(parseVerdict("")).toBeNull();
    expect(parseVerdict(undefined)).toBeNull();
    expect(parseVerdict("{kaputt")).toBeNull();
    expect(parseVerdict('{"entscheidung":"block"}')).toBeNull();
  });

  it("Block ohne Begründung bekommt eine, statt zu verschwinden", () => {
    expect(parseVerdict('{"decision":"block"}')).toEqual({
      decision: "block",
      reason: "Beleg fehlt",
    });
  });
});

describe("classify — Timeout vom Laufzeitfehler getrennt", () => {
  it("erkennt den abgewürgten Prüfer als Timeout", () => {
    expect(classify(Object.assign(new Error("killed"), { killed: true }))).toBe("timeout");
    expect(classify(Object.assign(new Error("x"), { code: "ETIMEDOUT" }))).toBe("timeout");
    expect(classify(Object.assign(new Error("x"), { signal: "SIGTERM" }))).toBe("timeout");
  });

  it("alles andere ist Laufzeit", () => {
    expect(classify(new Error("command not found"))).toBe("runtime");
    expect(classify(undefined)).toBe("runtime");
  });
});

// Das Protokoll ist die Gegenprobe zur Nachsicht des Hooks: "erlaubt" und "konnte nicht fragen"
// sehen von aussen gleich aus, und ohne Zeile wüsste niemand, ob der Prüfer je geantwortet hat.
describe("askAcceptance — Verdikt und Protokoll", () => {
  const collect = () => {
    const lines: LogEntry[] = [];
    return {
      lines,
      log: (_cwd: string, entry: LogEntry) => {
        lines.push(entry);
      },
    };
  };

  it("fragt gar nicht erst bei leerer Nachricht", () => {
    let called = false;
    const { log } = collect();
    const verdict = askAcceptance({
      kind: "stop",
      message: "   ",
      log,
      run: () => {
        called = true;
        return '{"decision":"block","reason":"x"}';
      },
    });
    expect(verdict).toBeNull();
    expect(called).toBe(false);
  });

  it("protokolliert den Timeout als fail-open MIT Grund und erlaubt", () => {
    const { lines, log } = collect();
    const verdict = askAcceptance({
      kind: "stop",
      message: "Durchlauf ist fertig.",
      log,
      run: () => {
        throw Object.assign(new Error("ETIMEDOUT"), { killed: true });
      },
    });
    expect(verdict).toBeNull();
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ outcome: "fail-open", failReason: "timeout" });
  });

  it("protokolliert eine unlesbare Antwort getrennt als parse", () => {
    const { lines, log } = collect();
    expect(
      askAcceptance({ kind: "stop", message: "Zielabgleich.", log, run: () => "kein json" }),
    ).toBeNull();
    expect(lines[0]).toMatchObject({ outcome: "fail-open", failReason: "parse" });
  });

  it("protokolliert ein ERLAUBT als solches — nicht als fail-open", () => {
    const { lines, log } = collect();
    expect(
      askAcceptance({
        kind: "stop",
        message: "Zielabgleich.",
        log,
        run: () => '{"decision":"allow"}',
      }),
    ).toBeNull();
    expect(lines[0]).toMatchObject({ outcome: "allow" });
    expect(lines[0]?.failReason).toBeUndefined();
  });

  it("reicht ein Block durch und protokolliert Verdikt UND Begründung", () => {
    const { lines, log } = collect();
    let seen = "";
    const verdict = askAcceptance({
      kind: "subagent",
      agentType: "impl-fast",
      message: "Ticket ist fertig, merge-bereit.",
      log,
      run: (prompt: string) => {
        seen = prompt;
        return '{"decision":"block","reason":"kein Gate-Beleg"}';
      },
    });
    expect(verdict).toEqual({ decision: "block", reason: "kein Gate-Beleg" });
    expect(seen).toContain("Agent-Typ: impl-fast");
    expect(seen).toContain("Ticket ist fertig, merge-bereit.");
    expect(lines[0]).toMatchObject({
      outcome: "block",
      reason: "kein Gate-Beleg",
      agentType: "impl-fast",
    });
  });

  it("schreibt die Zeile wirklich auf die Platte, als JSONL", () => {
    const cwd = mkdtempSync(join(tmpdir(), "stop-check-log-"));
    askAcceptance({
      kind: "stop",
      message: "Zielabgleich.",
      cwd,
      run: () => '{"decision":"allow"}',
    });
    const written = readFileSync(join(cwd, ".spec-sync", "acceptance-check.jsonl"), "utf8").trim();
    expect(JSON.parse(written)).toMatchObject({ kind: "stop", outcome: "allow" });
  });

  it("ein unschreibbares Protokoll ändert die Entscheidung nicht", () => {
    expect(
      askAcceptance({
        kind: "stop",
        message: "Zielabgleich.",
        cwd: "/nicht/beschreibbar",
        run: () => '{"decision":"block","reason":"kein Beleg"}',
      }),
    ).toEqual({ decision: "block", reason: "kein Beleg" });
  });
});

// Die Messung selbst, an ihrer wichtigsten Eigenschaft festgenagelt: sie darf im Fehlerfall NICHTS
// blocken. Ein Ventil, das bei Messfehlern zuschlägt, friert die Queue ein — der teuerste
// Fehlermodus dieses Repos.
describe("measureContextPercent — fail-open der Messung", () => {
  it("ohne Transcript-Pfad oder ohne Budget: null (kein Block)", () => {
    expect(measureContextPercent(undefined, 250000)).toBeNull();
    expect(measureContextPercent("/nicht/vorhanden.jsonl", null)).toBeNull();
  });

  it("nicht lesbares Transcript: null statt Ausnahme", () => {
    expect(measureContextPercent("/nicht/vorhanden.jsonl", 250000)).toBeNull();
  });

  it("lesbares Transcript ohne Usage-Einträge: null", () => {
    const file = join(mkdtempSync(join(tmpdir(), "stop-check-")), "t.jsonl");
    writeFileSync(file, "kein json\n");
    expect(measureContextPercent(file, 250000)).toBeNull();
  });

  it("misst in Prozent des Budgets", () => {
    const file = join(mkdtempSync(join(tmpdir(), "stop-check-")), "t.jsonl");
    writeFileSync(
      file,
      `${JSON.stringify({ type: "assistant", message: { id: "a", usage: { input_tokens: 125000 } } })}\n`,
    );
    expect(measureContextPercent(file, 250000)).toBe(50);
  });
});

// Die Werkbank-Prüfung an der einen Ausnahme festgenagelt, die sie nie melden darf:
// `.claude/**` ist Owner-/Overmind-Domäne (Entscheid #192) — der Worker könnte den Befund
// nie beräumen, die Chore-Regel lässt die Änderung bewusst liegen.
describe("workbenchFindings — .claude/** ist nie ein Befund", () => {
  function scratchRepoWithClaude(): string {
    const dir = mkdtempSync(join(tmpdir(), "workbench-"));
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: dir, encoding: "utf8" }).trim();
    git("init", "-q", "-b", "main");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    mkdirSync(join(dir, ".claude"), { recursive: true });
    writeFileSync(join(dir, ".claude", "settings.json"), "{}\n");
    writeFileSync(join(dir, "code.txt"), "a\n");
    git("add", "-A");
    git("commit", "-q", "-m", "init");
    // origin/main auf denselben Stand zeigen lassen, damit nur die dirty-Prüfung spricht.
    git("update-ref", "refs/remotes/origin/main", "HEAD");
    return dir;
  }

  it("eine geänderte .claude/settings.json (Overmind-Chore) blockt nicht", () => {
    const dir = scratchRepoWithClaude();
    writeFileSync(join(dir, ".claude", "settings.json"), '{"changed":true}\n');
    expect(workbenchFindings(dir)).toEqual([]);
  });

  it("eine geänderte getrackte Code-Datei bleibt ein Befund", () => {
    const dir = scratchRepoWithClaude();
    writeFileSync(join(dir, "code.txt"), "b\n");
    const findings = workbenchFindings(dir);
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("code.txt");
  });
});

// Architekten-Kette (PROC-DEV-020 rev 4 / PROC-DEV-036 rev 5, Owner-Wort 22.08.): eine Stufe bei
// 75 %, genau einmal, Handover diktiert mit der Messung; Owner-Gespräch erzwingt die Ansage.
describe("decideArchitectStop", () => {
  const AT = "2026-08-22T14:00:00.000Z";
  const base = { budgetTokens: 250_000, measuredAt: AT };

  it("Schwelle ist 75 % — darunter erlaubt, ohne Block", () => {
    expect(ARCHITECT_BUDGET_PERCENT).toBe(75);
    expect(decideArchitectStop({ ...base, contextTokens: 187_499 })).toMatchObject({
      action: "allow",
      stage: "clean",
    });
  });

  it("ab 75 % blockt sie einmal und diktiert das Handover mit der gemessenen Zahl", () => {
    const d = decideArchitectStop({ ...base, contextTokens: 187_500 });
    expect(d).toMatchObject({ action: "block", stage: "budget" });
    expect(d.reason).toContain("reason: budget");
    expect(d.reason).toContain(`- Stand: 187500 Tokens (gemessen ${AT})`);
    expect(d.reason).toContain("75 % des Budgets 250000");
    expect(
      decideArchitectStop({ ...base, contextTokens: 300_000, budgetAlreadyBlocked: true }),
    ).toMatchObject({ action: "allow", stage: "clean" });
  });

  it("Owner-Gespräch erzwingt die Ansage statt des Handovers", () => {
    const d = decideArchitectStop({ ...base, contextTokens: 200_000, ownerEngaged: true });
    expect(d).toMatchObject({ action: "block", stage: "budget-owner" });
    expect(d.reason).toContain("KEIN Handover");
    expect(d.reason).toContain("/handover");
    expect(d.reason).not.toContain("- Stand:");
  });

  it("Pause-Flag und frisches Handover schlagen die Budget-Stufe; ohne Messung kein Block", () => {
    expect(decideArchitectStop({ ...base, contextTokens: 300_000, paused: true })).toMatchObject({
      action: "allow",
      stage: "pause",
    });
    expect(
      decideArchitectStop({ ...base, contextTokens: 300_000, handoverAgeMin: 5 }),
    ).toMatchObject({ action: "allow", stage: "handover" });
    expect(decideArchitectStop({ ...base, contextTokens: null })).toMatchObject({
      action: "allow",
      stage: "clean",
    });
    expect(decideArchitectStop({ contextTokens: 300_000, budgetTokens: null })).toMatchObject({
      action: "allow",
      stage: "clean",
    });
  });
});

describe("ownerEngaged", () => {
  it("liest last_owner_prompt_at aus der Zustandsdatei des worker-harness-Hooks; fehlt sie, false", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "wh-state-"));
    const cwd = "/Users/pbl/projects/specs-meta/projects/community-platform";
    const slug = cwd.replace(/[^A-Za-z0-9]/g, "-");
    const dir = join(stateDir, "sessions", slug);
    mkdirSync(dir, { recursive: true });
    const prev = process.env.WORKER_HARNESS_STATE_DIR;
    process.env.WORKER_HARNESS_STATE_DIR = stateDir;
    try {
      expect(ownerEngaged(cwd, "s1")).toBe(false);
      writeFileSync(
        join(dir, "s1.json"),
        JSON.stringify({ last_prompt_at: "2026-08-22T13:00:00Z" }),
      );
      expect(ownerEngaged(cwd, "s1")).toBe(false);
      writeFileSync(
        join(dir, "s1.json"),
        JSON.stringify({
          last_prompt_at: "2026-08-22T13:00:00Z",
          last_owner_prompt_at: "2026-08-22T13:00:00Z",
        }),
      );
      expect(ownerEngaged(cwd, "s1")).toBe(true);
    } finally {
      if (prev === undefined) delete process.env.WORKER_HARNESS_STATE_DIR;
      else process.env.WORKER_HARNESS_STATE_DIR = prev;
    }
  });
});
