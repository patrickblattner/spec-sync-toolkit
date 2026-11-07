/**
 * `review growth` — Codex first opinion on the weekly growth and cleanness
 * audit (SST-DESIGN-040, PROC-REL-080): prompt, result schema, strict parse,
 * ID assignment, and the defensive read of the metrics file.
 *
 * The metrics schema is not final in the app repos yet, so only what the
 * prompt needs is read: a target list (`targets`, entries a path string or an
 * object with `file`, `path` or `module`) and the week the file measures
 * (`week` "YYYY-Www", or a `date`/`generatedAt`/`measuredAt` date, or a date in
 * the file name). Anything else is passed to Codex as it is.
 */

export const GROWTH_CATEGORIES = [
  "over-engineered",
  "reinvented",
  "long-winded",
  "inconsistent",
  "needless-defence",
] as const;

export const GROWTH_PROMPT = `You are a read-only reviewer of the repository {{REPO}}.
You give a first opinion on this week's growth and cleanness audit. You never edit files, never run commands that change anything.

Commits since {{SINCE}} are listed below with their file statistics. The metrics file of the week follows. Read the target files yourself.

Task 1 — Growth. For every growth item in the metrics (chunk size, ratchet count, dependency count, module lines of code, worsened FTA score or complexity), name the most likely cause with evidence (commit, package, file and line). Typical causes: new code or integration, whole-library import, duplicate package version, heavier dependency update, inlined asset, dev code or source maps in the bundle, code moved into the entry chunk, all locales shipped, generated code, tool update with new rules, wider scan scope. avoidable is "yes" when the growth could be brought back without losing function, otherwise "no".

Task 2 — Cleanness. For every target file, check this list:
- over-engineered: abstraction, configurability or extension points nobody uses
- reinvented: an own helper or component where @suite/ui or the project already has one (name it in evidence)
- long-winded: much more code than the job needs
- inconsistent: one problem solved differently in several places (name the other places in evidence)
- needless-defence: handling for cases that cannot occur

Rules:
- Read only. Do not write, format, install or commit anything.
- Only claims with file, line and evidence. An unproven suspicion is not an item.
- Use the empty string for a field that has nothing to say, and line 0 when no line applies.
- Empty growth and cleanness lists are a valid and welcome result.

Target files:
{{TARGETS}}

Metrics file:
{{METRICS}}

Commits (git log --stat since {{SINCE}}):
{{LOG}}

Answer with exactly one JSON object matching the given output schema and nothing else.
`;

export interface GrowthPromptValues {
  REPO: string;
  SINCE: string;
  TARGETS: string;
  METRICS: string;
  LOG: string;
}

/** One-pass fill, so a value containing `{{LOG}}` is never substituted again. */
export function renderGrowthPrompt(values: GrowthPromptValues): string {
  return GROWTH_PROMPT.replace(/\{\{([A-Z]+)\}\}/g, (match, key: string) =>
    key in values ? values[key as keyof GrowthPromptValues] : match,
  );
}

const STRING = { type: "string" } as const;

/** `--output-schema` of the growth mode: object root, every field required. */
export const GROWTH_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["growth", "cleanness"],
  properties: {
    growth: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["item", "cause", "evidence", "avoidable"],
        properties: {
          item: STRING,
          cause: STRING,
          evidence: STRING,
          avoidable: { type: "string", enum: ["yes", "no"] },
        },
      },
    },
    cleanness: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["file", "line", "category", "claim", "evidence", "fix"],
        properties: {
          file: STRING,
          line: { type: "integer" },
          category: { type: "string", enum: [...GROWTH_CATEGORIES] },
          claim: STRING,
          evidence: STRING,
          fix: STRING,
        },
      },
    },
  },
} as const;

export interface GrowthItem {
  item: string;
  cause: string;
  evidence: string;
  avoidable: "yes" | "no";
}

export interface CleannessItem {
  file: string;
  line: number;
  category: (typeof GROWTH_CATEGORIES)[number];
  claim: string;
  evidence: string;
  fix: string;
}

export interface Dropped {
  kind: "growth" | "cleanness";
  item: string;
  reason: string;
}

export type GrowthParse =
  { ok: true; growth: GrowthItem[]; cleanness: CleannessItem[] } | { ok: false; reason: string };

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function shapeProblem(
  entry: unknown,
  keys: Record<string, (value: unknown) => boolean>,
): string | undefined {
  if (!isObject(entry)) return "not an object";
  const extra = Object.keys(entry).filter((key) => !(key in keys));
  if (extra.length > 0) return `unknown field ${extra.join(", ")}`;
  for (const [key, valid] of Object.entries(keys)) {
    if (!(key in entry)) return `missing ${key}`;
    if (!valid(entry[key])) return `invalid ${key}`;
  }
  return undefined;
}

const str = (value: unknown): boolean => typeof value === "string";
const GROWTH_KEYS = {
  item: str,
  cause: str,
  evidence: str,
  avoidable: (value: unknown) => value === "yes" || value === "no",
};
const CLEANNESS_KEYS = {
  file: str,
  line: (value: unknown) => Number.isInteger(value) && (value as number) >= 0,
  category: (value: unknown) => (GROWTH_CATEGORIES as readonly unknown[]).includes(value),
  claim: str,
  evidence: str,
  fix: str,
};

/** Strict parse; the only tolerance is whitespace and one Markdown fence (as `parseResult`). */
export function parseGrowthResult(raw: string): GrowthParse {
  const text = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```$/, "")
    .trim();
  if (text === "") return { ok: false, reason: "empty output" };
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    return {
      ok: false,
      reason: `not valid JSON (${error instanceof Error ? error.message : String(error)})`,
    };
  }
  if (!isObject(data)) return { ok: false, reason: "root is not an object" };
  const extra = Object.keys(data).filter((key) => key !== "growth" && key !== "cleanness");
  if (extra.length > 0) return { ok: false, reason: `unknown root field ${extra.join(", ")}` };
  if (!Array.isArray(data.growth)) return { ok: false, reason: "`growth` is not an array" };
  if (!Array.isArray(data.cleanness)) return { ok: false, reason: "`cleanness` is not an array" };
  for (const [index, entry] of data.growth.entries()) {
    const problem = shapeProblem(entry, GROWTH_KEYS);
    if (problem !== undefined) return { ok: false, reason: `growth ${index}: ${problem}` };
  }
  for (const [index, entry] of data.cleanness.entries()) {
    const problem = shapeProblem(entry, CLEANNESS_KEYS);
    if (problem !== undefined) return { ok: false, reason: `cleanness ${index}: ${problem}` };
  }
  return {
    ok: true,
    growth: data.growth as GrowthItem[],
    cleanness: data.cleanness as CleannessItem[],
  };
}

/** Drops items without evidence (listed as dropped) and assigns G1…, K1… to the rest. */
export function assignGrowth(
  growth: readonly GrowthItem[],
  cleanness: readonly CleannessItem[],
): {
  growth: (GrowthItem & { id: string })[];
  cleanness: (CleannessItem & { id: string })[];
  dropped: Dropped[];
} {
  const dropped: Dropped[] = [];
  const keptGrowth = growth.filter((entry) => {
    if (entry.evidence.trim() !== "") return true;
    dropped.push({ kind: "growth", item: entry.item, reason: "no evidence" });
    return false;
  });
  const keptCleanness = cleanness.filter((entry) => {
    if (entry.evidence.trim() !== "") return true;
    dropped.push({ kind: "cleanness", item: `${entry.file}:${entry.line}`, reason: "no evidence" });
    return false;
  });
  return {
    growth: keptGrowth.map((entry, index) => ({ id: `G${index + 1}`, ...entry })),
    cleanness: keptCleanness.map((entry, index) => ({ id: `K${index + 1}`, ...entry })),
    dropped,
  };
}

// ---------------------------------------------------------------- metrics

export interface Metrics {
  targets: string[];
  /** The day the file measures (UTC midnight), when it says. */
  measured?: Date;
}

const DAY_MS = 86_400_000;

/** Monday (UTC) of ISO week `week` of ISO year `year`. */
function isoWeekMonday(year: number, week: number): Date {
  const jan4 = Date.UTC(year, 0, 4);
  const jan4Day = (new Date(jan4).getUTCDay() + 6) % 7; // Monday = 0
  return new Date(jan4 - jan4Day * DAY_MS + (week - 1) * 7 * DAY_MS);
}

/** ISO year and week of `date`, as `YYYY-Www`. */
export function isoWeekLabel(date: Date): string {
  const day = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const weekday = (day.getUTCDay() + 6) % 7;
  const thursday = new Date(day.getTime() + (3 - weekday) * DAY_MS);
  const year = thursday.getUTCFullYear();
  const week =
    Math.round((thursday.getTime() - isoWeekMonday(year, 1).getTime()) / (7 * DAY_MS)) + 1;
  return `${year}-W${String(week).padStart(2, "0")}`;
}

/** `YYYY-MM-DD` at the start of a string → that UTC day, if it is a real date. */
export function parseDay(text: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text);
  if (match === null) return undefined;
  const date = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return date.toISOString().slice(0, 10) === match[0] ? date : undefined;
}

function weekSunday(text: string): Date | undefined {
  const match = /^(\d{4})-W(\d{2})$/.exec(text);
  if (match === null) return undefined;
  const week = Number(match[2]);
  if (week < 1 || week > 53) return undefined;
  // The weekly run measures on Sunday (PROC-REL-080 §Sunday).
  return new Date(isoWeekMonday(Number(match[1]), week).getTime() + 6 * DAY_MS);
}

/**
 * The fields the prompt needs, or the reason the file is invalid. `fileName`
 * is the last fallback for the week (`2026-11-08.json`, `growth-2026-W45.json`).
 */
export function readMetrics(data: unknown, fileName: string): Metrics | string {
  if (!isObject(data)) return "the root is not an object";
  if (!Array.isArray(data.targets)) return "no target list (`targets` array)";
  const targets: string[] = [];
  for (const entry of data.targets) {
    const target =
      typeof entry === "string"
        ? entry
        : isObject(entry)
          ? [entry.file, entry.path, entry.module].find((value) => typeof value === "string")
          : undefined;
    if (typeof target !== "string" || target.trim() === "") {
      return "a target is neither a path nor an object with `file`, `path` or `module`";
    }
    targets.push(target as string);
  }
  let measured: Date | undefined;
  if (typeof data.week === "string") {
    measured = weekSunday(data.week);
    if (measured === undefined) return "`week` is not YYYY-Www";
  } else {
    for (const key of ["date", "generatedAt", "measuredAt"]) {
      const value = data[key];
      if (typeof value === "string") {
        measured = parseDay(value);
        if (measured === undefined) return `\`${key}\` is not a date`;
        break;
      }
    }
  }
  if (measured === undefined) {
    const day = /(\d{4}-\d{2}-\d{2})/.exec(fileName)?.[1];
    const week = /(\d{4}-W\d{2})/.exec(fileName)?.[1];
    measured =
      day !== undefined ? parseDay(day) : week !== undefined ? weekSunday(week) : undefined;
  }
  return measured === undefined ? { targets } : { targets, measured };
}

/** The default `--since`: one week before the measured day. */
export function previousWeek(measured: Date): string {
  return new Date(measured.getTime() - 7 * DAY_MS).toISOString().slice(0, 10);
}
