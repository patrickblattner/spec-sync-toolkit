/**
 * Finding the spec references in a ticket (spec §7.3).
 *
 * Tickets are written by the worker loop, and they name their spec sections in
 * one recurring shape — unit id in backticks, sections with `§`, further `§`
 * tokens carrying on with the unit named before them:
 *
 *   `foundation.dev.process` §Worker-Loop (Effort-Tabelle) und §Label-Taxonomie
 *   `community-platform.personas` **0.15.0** §Qualitäts-Wächter → Ada
 *
 * Two consequences for this parser. It is deliberately permissive about where a
 * section name ends — prose runs straight into it ("§Tabellen fordert schon
 * heute…") — and hands the raw text on; narrowing happens in the resolver,
 * which can test a name against the unit's actual headings. And it never
 * invents a reference: a `§` it cannot attach to a unit is reported as
 * dangling, a unit without a `§` as a bare mention. `pack` turns both into
 * exit 3 rather than a guess (spec §2, `DECISION (no-domain-defaults)`).
 */

/** A `unit §section` pair as written in the ticket. */
export interface SpecReference {
  unit: string;
  /** The `§…` text, cleaned of trailing prose delimiters but not resolved. */
  section: string;
}

export interface ParsedReferences {
  references: SpecReference[];
  /** Units named without any `§section` — a mention, not a reference. */
  bareUnits: string[];
  /** `§…` tokens that belong to no discernible unit. */
  danglingSections: string[];
}

/**
 * Dot-namespaced unit ids (`<project>.<…>`). The lookarounds keep the match off
 * file paths (`e2e/a11y.spec.ts`) and the suffix list off bare file names
 * (`nightly.yml`). Whatever survives is checked against the server's index
 * before it is used, so a false positive costs nothing.
 */
const UNIT_ID = /(?<![\w./-])([a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)+)(?![\w/-])/gu;

const FILE_SUFFIXES = new Set([
  "ts",
  "tsx",
  "js",
  "jsx",
  "mjs",
  "cjs",
  "mts",
  "json",
  "jsonl",
  "yml",
  "yaml",
  "md",
  "css",
  "scss",
  "html",
  "sh",
  "sql",
  "toml",
  "lock",
  "txt",
  "log",
  "png",
  "jpg",
  "svg",
  "env",
]);

/** Stops before the next `§` so an enumeration yields one token per section. */
const SECTION_TOKEN = /§\s*([^§\n]{1,120})/gu;

/**
 * Where a section name can no longer continue: bracketing and quoting, a second
 * `§`, an enumerating conjunction, a spaced slash or dash. Prose that simply
 * runs on ("§Tabellen fordert…") is cut down by the resolver instead.
 */
const SECTION_STOP =
  /[(),;:„“”"»«[\]`*…]|§|\s+(?:und|oder|sowie|bzw\.?)\s|\s[—–-]\s|\s\/\s|\.(?:\s|$)/u;

/** How many words of trailing prose a section name may carry into the resolver. */
const MAX_SECTION_WORDS = 8;

export function parseSpecReferences(text: string): ParsedReferences {
  const units = collectUnits(text);
  const references: SpecReference[] = [];
  const danglingSections: string[] = [];
  const used = new Set<string>();
  const seen = new Set<string>();

  for (const token of collectSections(text)) {
    const unit = unitFor(units, token.index);
    if (unit === undefined) {
      if (!danglingSections.includes(token.name)) danglingSections.push(token.name);
      continue;
    }
    used.add(unit);
    const key = `${unit}§${token.name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    references.push({ unit, section: token.name });
  }

  const bareUnits = [...new Set(units.map((entry) => entry.unit))].filter(
    (unit) => !used.has(unit),
  );
  return { references, bareUnits, danglingSections };
}

interface UnitOccurrence {
  unit: string;
  index: number;
}

function collectUnits(text: string): UnitOccurrence[] {
  const found: UnitOccurrence[] = [];
  for (const match of text.matchAll(UNIT_ID)) {
    const unit = match[1];
    if (unit === undefined || match.index === undefined) continue;
    const suffix = unit.slice(unit.lastIndexOf(".") + 1);
    if (FILE_SUFFIXES.has(suffix)) continue;
    found.push({ unit, index: match.index });
  }
  return found;
}

interface SectionOccurrence {
  name: string;
  index: number;
}

function collectSections(text: string): SectionOccurrence[] {
  const found: SectionOccurrence[] = [];
  for (const match of text.matchAll(SECTION_TOKEN)) {
    const raw = match[1];
    if (raw === undefined || match.index === undefined) continue;
    const name = cleanSectionName(raw);
    if (name !== "") found.push({ name, index: match.index });
  }
  return found;
}

/** Cuts a `§…` capture back to the part that can plausibly still be a heading. */
export function cleanSectionName(raw: string): string {
  const stop = raw.search(SECTION_STOP);
  const cut = stop === -1 ? raw : raw.slice(0, stop);
  return cut
    .trim()
    .split(/\s+/u)
    .slice(0, MAX_SECTION_WORDS)
    .join(" ")
    .replace(/[.,-]+$/u, "");
}

/**
 * The unit a `§` belongs to: the last one named before it — the way the tickets
 * are written. A `§` that opens the text is attached only when the ticket names
 * exactly one unit overall; with several, guessing would be a coin flip.
 */
function unitFor(units: UnitOccurrence[], sectionIndex: number): string | undefined {
  let candidate: string | undefined;
  for (const entry of units) {
    if (entry.index < sectionIndex) candidate = entry.unit;
    else break;
  }
  if (candidate !== undefined) return candidate;
  const distinct = new Set(units.map((entry) => entry.unit));
  return distinct.size === 1 ? [...distinct][0] : undefined;
}
