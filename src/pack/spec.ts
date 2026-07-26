/**
 * Turning ticket references into packable sections (spec §7.3).
 *
 * Every section that goes into a pack is **resolved** — overlays composed via
 * `resolve_effective_spec` — and carries `unit@version` plus its section hash.
 * The hash is what makes the pack falsifiable: a sub-agent (or a later `pack`
 * run) can ask the server whether the section still hashes to that value
 * instead of trusting a copy of unknown age. A section whose hash cannot be
 * determined is therefore not packed; it is reported as unresolved.
 *
 * Hashes come from a `spec.lock/v3` manifest (`get_manifest`), which carries
 * per-section subtree hashes; one call per project covers that project **and**
 * foundation, so the whole resolution is a handful of round trips.
 */

import type { Tools } from "./exec.js";
import type { SpecReference } from "./refs.js";

interface EffectiveSection {
  slug: string;
  path: string;
  heading: string;
  level: number;
  content: string;
}

interface EffectiveSpec {
  id: string;
  effective_version: string;
  sections?: EffectiveSection[];
  /** overlay-level slug -> id of the unit that contributed it */
  provenance?: Record<string, string>;
  composed_from?: { id: string; version: string }[];
}

interface ManifestEntry {
  version: string;
  /** slug path -> section subtree hash */
  sections: Record<string, string>;
}

/** One resolved section, ready to be written into a pack. */
export interface PackedSection {
  /** The unit that contributes this section — with overlays, the base unit. */
  unit: string;
  version: string;
  slug: string;
  path: string;
  heading: string;
  hash: string;
  content: string;
  /** The `§…` text this was resolved from, so a reader can retrace the match. */
  requestedAs: string;
  /** Ids the effective view was composed from, when more than the unit itself. */
  composedFrom?: string[];
}

export interface UnresolvedReference {
  unit: string;
  section: string;
  reason: "unknown-unit" | "no-such-section" | "ambiguous-section" | "no-hash";
  candidates?: string[];
}

export interface Resolution {
  sections: PackedSection[];
  unresolved: UnresolvedReference[];
}

/** Caching view of the spec-mcp server. One instance per command run. */
export class SpecGateway {
  private readonly manifests = new Map<string, Promise<Map<string, ManifestEntry>>>();
  private readonly effectives = new Map<string, Promise<EffectiveSpec>>();

  constructor(private readonly tools: Tools) {}

  /** The project a unit id belongs to — its first dot-separated segment. */
  static projectOf(unit: string): string {
    return unit.split(".")[0] ?? unit;
  }

  manifest(project: string): Promise<Map<string, ManifestEntry>> {
    const cached = this.manifests.get(project);
    if (cached !== undefined) return cached;
    const pending = this.loadManifest(project);
    this.manifests.set(project, pending);
    return pending;
  }

  effective(unit: string): Promise<EffectiveSpec> {
    const cached = this.effectives.get(unit);
    if (cached !== undefined) return cached;
    const pending = this.tools.spec<EffectiveSpec>("resolve_effective_spec", { id: unit });
    this.effectives.set(unit, pending);
    return pending;
  }

  async knows(unit: string): Promise<boolean> {
    const manifest = await this.manifest(SpecGateway.projectOf(unit));
    return manifest.has(unit);
  }

  private async loadManifest(project: string): Promise<Map<string, ManifestEntry>> {
    const payload = await this.tools.spec<{
      snapshot?: {
        entries?: { id: string; version?: string; sections?: Record<string, string> }[];
      };
    }>("get_manifest", { project });

    const entries = new Map<string, ManifestEntry>();
    for (const entry of payload.snapshot?.entries ?? []) {
      entries.set(entry.id, { version: entry.version ?? "?", sections: entry.sections ?? {} });
    }
    return entries;
  }
}

/**
 * Resolves the ticket's references. Order is preserved, duplicates (the same
 * section named twice) are dropped — a pack repeating a section would spend the
 * sub-agent's context on nothing.
 */
export async function resolveReferences(
  references: SpecReference[],
  gateway: SpecGateway,
): Promise<Resolution> {
  const sections: PackedSection[] = [];
  const unresolved: UnresolvedReference[] = [];
  const packed = new Set<string>();

  for (const reference of references) {
    if (!(await gateway.knows(reference.unit))) {
      unresolved.push({ ...reference, reason: "unknown-unit" });
      continue;
    }

    const effective = await gateway.effective(reference.unit);
    const match = matchSection(effective.sections ?? [], reference.section);
    if (match.section === undefined) {
      unresolved.push({
        ...reference,
        reason: match.candidates === undefined ? "no-such-section" : "ambiguous-section",
        candidates: match.candidates,
      });
      continue;
    }

    const owner = effective.provenance?.[match.section.slug] ?? reference.unit;
    const manifest = await gateway.manifest(SpecGateway.projectOf(owner));
    const entry = manifest.get(owner);
    const hash = entry === undefined ? undefined : hashOf(entry, match.section);
    if (entry === undefined || hash === undefined) {
      unresolved.push({ ...reference, reason: "no-hash" });
      continue;
    }

    const key = `${owner}#${match.section.path}`;
    if (packed.has(key)) continue;
    packed.add(key);

    const composedFrom = (effective.composed_from ?? []).map((source) => source.id);
    sections.push({
      unit: owner,
      version: entry.version,
      slug: match.section.slug,
      path: match.section.path,
      heading: match.section.heading,
      hash,
      content: match.section.content,
      requestedAs: reference.section,
      ...(composedFrom.length > 1 ? { composedFrom } : {}),
    });
  }

  return { sections, unresolved };
}

/** The section hash, by path; overlay composition can shift it, so slug is the fallback. */
function hashOf(entry: ManifestEntry, section: EffectiveSection): string | undefined {
  const direct = entry.sections[section.path];
  if (direct !== undefined) return direct;
  for (const [path, hash] of Object.entries(entry.sections)) {
    if (path === section.slug || path.endsWith(`/${section.slug}`)) return hash;
  }
  return undefined;
}

export interface SectionMatch {
  section?: EffectiveSection;
  /** Set when a name matched several sections — ambiguity is reported, never resolved. */
  candidates?: string[];
}

/**
 * Matches a `§…` text against a unit's sections.
 *
 * Two problems at once: the ticket names a *heading* ("§Worker-Loop") while the
 * spec addresses *slugs* ("…/worker-loop-spec-sync"), and prose often runs into
 * the name ("§Tabellen fordert schon heute"). So the name is tried from longest
 * to shortest word prefix, and per prefix from strongest to weakest rule (exact
 * path/slug/heading, then heading prefix, then slug prefix). The first rule
 * that hits decides; if it hits more than once the reference is ambiguous and
 * comes back unresolved — picking one would be exactly the guess spec §2
 * forbids.
 */
export function matchSection(sections: EffectiveSection[], name: string): SectionMatch {
  const words = name.split(/\s+/u).filter((word) => word !== "");

  for (let end = words.length; end > 0; end -= 1) {
    const query = words.slice(0, end).join(" ");
    const parts = query
      .split(/\s*(?:→|->)\s*/u)
      .map((part) => part.trim())
      .filter((part) => part !== "");
    if (parts.length === 0) continue;

    const tail = parts[parts.length - 1] as string;
    const tailSlug = slugify(tail);
    const pathSlug = parts.map(slugify).join("/");
    if (tailSlug === "") continue;

    const rules: ((section: EffectiveSection) => boolean)[] = [
      (section) =>
        section.path === pathSlug ||
        section.path.endsWith(`/${pathSlug}`) ||
        section.slug === tailSlug ||
        headingOf(section) === tail.toLowerCase(),
      (section) => headingOf(section).startsWith(tail.toLowerCase()),
      (section) => section.slug.startsWith(`${tailSlug}-`),
    ];

    for (const rule of rules) {
      const hits = sections.filter((section) => rule(section));
      if (hits.length === 1) return { section: hits[0] };
      if (hits.length > 1) return { candidates: hits.map((section) => section.path) };
    }
  }

  return {};
}

/** Heading text as a ticket would write it — backticks dropped, numbering kept (`§7.3`). */
function headingOf(section: EffectiveSection): string {
  return section.heading.replace(/`/gu, "").trim().toLowerCase();
}

/** Same shape the spec server uses for slugs: lowercase, non-letters to dashes. */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .normalize("NFC")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/gu, "");
}
