/**
 * Turning ticket references into packable sections (spec §7.3).
 *
 * Every section that goes into a pack is **resolved** — overlays composed —
 * and carries `unit@version` plus its section hash. The hash is what makes the
 * pack falsifiable: a sub-agent (or a later `pack` run) can ask the server
 * whether the section still hashes to that value instead of trusting a copy of
 * unknown age. A section whose hash cannot be determined is therefore not
 * packed; it is reported as unresolved.
 *
 * Content and hashes come from **one** `ticket_context` call covering all units
 * (`spec-mcp.build-spec` §21.2): it composes `extends` itself and takes the
 * section hash from the same function as the lock, so the hash stays comparable
 * to `spec.lock.json` and `check_drift`.
 *
 * That call wants slugs, and a ticket writes prose ("§7.3", "§Worker-Loop").
 * So each unit is first read as an **outline** — `get_spec` without a body, a
 * fraction of the unit's size — and only the matched sections are requested.
 * An outline is not composed, though: a unit that `extends` another has more
 * sections in its effective view than in its own file. Those units are asked
 * for whole, in the same call, and matched against the composed answer.
 */

import { EXIT, ToolkitError } from "../output.js";
import type { Tools } from "./exec.js";
import type { SpecReference } from "./refs.js";

/** What matching needs — the shape an outline and a context section share. */
export interface SectionOutline {
  slug: string;
  path: string;
  heading: string;
}

/** A section as `ticket_context` returns it: outline plus content and hash. */
interface ContextSection extends SectionOutline {
  content: string;
  hash: string;
}

interface ContextUnit {
  id: string;
  version: string;
  sections?: ContextSection[];
  composed_from?: { id: string; version: string }[];
}

/** A unit's table of contents, plus whether its effective view is composed. */
interface Outline {
  version: string;
  /** true when the unit `extends` another — then this outline is incomplete. */
  composed: boolean;
  sections: SectionOutline[];
}

/** The shape every spec-server error carries (§21.2, like `get_section`). */
interface SpecError {
  code: string;
  message: string;
}

/** One resolved section, ready to be written into a pack. */
export interface PackedSection {
  /**
   * The unit the ticket referenced — the effective view's own id.
   *
   * For a section inherited through `extends` this is the overlay, not the base
   * that wrote it: `ticket_context` carries `composed_from` per unit, not
   * provenance per section, and buying that provenance back would cost the
   * extra `resolve_effective_spec` call this whole path exists to avoid. The
   * contributors stay visible in `composedFrom`; the hash is unaffected.
   */
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
  private readonly outlines = new Map<string, Promise<Outline | undefined>>();

  constructor(private readonly tools: Tools) {}

  /** A unit's table of contents; `undefined` when the server does not know it. */
  outline(unit: string): Promise<Outline | undefined> {
    const cached = this.outlines.get(unit);
    if (cached !== undefined) return cached;
    const pending = this.loadOutline(unit);
    this.outlines.set(unit, pending);
    return pending;
  }

  async knows(unit: string): Promise<boolean> {
    return (await this.outline(unit)) !== undefined;
  }

  /**
   * The one call that carries the payload (§21.2). Its errors are faults, not
   * findings: the unit ids and slugs it is given come from the server's own
   * outlines, so a `NOT_FOUND` or `SECTION_NOT_FOUND` here means the index
   * moved under us — passing that on beats packing a half-filled paket.
   */
  async context(units: { id: string; sections?: string[] }[]): Promise<ContextUnit[]> {
    const payload = await this.tools.spec<{ units?: ContextUnit[] } & Partial<SpecError>>(
      "ticket_context",
      { units },
    );
    const failure = asError(payload);
    if (failure !== undefined) {
      throw new ToolkitError(
        `spec-mcp ticket_context failed: ${failure.code} — ${failure.message}`,
        EXIT.PRECONDITION,
        { field: "spec-mcp", reason: failure.code },
      );
    }
    return payload.units ?? [];
  }

  private async loadOutline(unit: string): Promise<Outline | undefined> {
    const payload = await this.tools.spec<
      {
        version?: string;
        sections?: SectionOutline[];
        frontmatter?: { extends?: string };
      } & Partial<SpecError>
    >("get_spec", { id: unit, body: false });

    if (asError(payload) !== undefined) return undefined;
    return {
      version: payload.version ?? "?",
      composed: payload.frontmatter?.extends !== undefined,
      sections: payload.sections ?? [],
    };
  }
}

/** An error payload, told apart from a result by its `code`/`message` pair. */
function asError(payload: Partial<SpecError>): SpecError | undefined {
  return typeof payload.code === "string" && typeof payload.message === "string"
    ? (payload as SpecError)
    : undefined;
}

/** What one unit contributes to the single `ticket_context` call. */
interface UnitPlan {
  /** Matched paths — `undefined` for a composed unit, which is asked for whole. */
  paths?: string[];
  /** `§…` text -> the path it matched, so the second pass need not match again. */
  matched: Map<string, string>;
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
  const unresolved: UnresolvedReference[] = [];
  const plans = new Map<string, UnitPlan>();

  for (const reference of references) {
    const outline = await gateway.outline(reference.unit);
    if (outline === undefined) {
      unresolved.push({ ...reference, reason: "unknown-unit" });
      continue;
    }

    let plan = plans.get(reference.unit);
    if (plan === undefined) {
      plan = { paths: outline.composed ? undefined : [], matched: new Map() };
      plans.set(reference.unit, plan);
    }
    // A composed outline is incomplete; that unit is matched against the
    // effective view the server sends back instead.
    if (plan.paths === undefined) continue;

    const match = matchSection(outline.sections, reference.section);
    if (match.section === undefined) {
      unresolved.push({
        ...reference,
        reason: match.candidates === undefined ? "no-such-section" : "ambiguous-section",
        candidates: match.candidates,
      });
      continue;
    }
    plan.matched.set(reference.section, match.section.path);
    if (!plan.paths.includes(match.section.path)) plan.paths.push(match.section.path);
  }

  const request = [...plans]
    .filter(([, plan]) => plan.paths === undefined || plan.paths.length > 0)
    .map(([id, plan]) => (plan.paths === undefined ? { id } : { id, sections: plan.paths }));
  if (request.length === 0) return { sections: [], unresolved };

  const answered = new Map<string, ContextUnit>();
  for (const unit of await gateway.context(request)) answered.set(unit.id, unit);

  return { sections: assemble(references, plans, answered, unresolved), unresolved };
}

/**
 * Walks the references a second time, now with the answer in hand, so the pack
 * keeps the ticket's order. A composed unit is matched here — its effective
 * sections exist only in that answer.
 */
function assemble(
  references: SpecReference[],
  plans: Map<string, UnitPlan>,
  answered: Map<string, ContextUnit>,
  unresolved: UnresolvedReference[],
): PackedSection[] {
  const sections: PackedSection[] = [];
  const packed = new Set<string>();

  for (const reference of references) {
    const plan = plans.get(reference.unit);
    const unit = answered.get(reference.unit);
    if (plan === undefined || unit === undefined) continue;
    const available = unit.sections ?? [];

    let path = plan.matched.get(reference.section);
    if (plan.paths === undefined) {
      const match = matchSection(available, reference.section);
      if (match.section === undefined) {
        unresolved.push({
          ...reference,
          reason: match.candidates === undefined ? "no-such-section" : "ambiguous-section",
          candidates: match.candidates,
        });
        continue;
      }
      path = match.section.path;
    }

    const section = available.find((entry) => entry.path === path);
    if (section === undefined) continue;
    if (typeof section.hash !== "string" || section.hash === "") {
      unresolved.push({ ...reference, reason: "no-hash" });
      continue;
    }

    const key = `${unit.id}#${section.path}`;
    if (packed.has(key)) continue;
    packed.add(key);

    const composedFrom = (unit.composed_from ?? []).map((source) => source.id);
    sections.push({
      unit: unit.id,
      version: unit.version,
      slug: section.slug,
      path: section.path,
      heading: section.heading,
      hash: section.hash,
      content: section.content,
      requestedAs: reference.section,
      ...(composedFrom.length > 1 ? { composedFrom } : {}),
    });
  }

  return sections;
}

export interface SectionMatch {
  section?: SectionOutline;
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
export function matchSection(sections: SectionOutline[], name: string): SectionMatch {
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

    const rules: ((section: SectionOutline) => boolean)[] = [
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
function headingOf(section: SectionOutline): string {
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
