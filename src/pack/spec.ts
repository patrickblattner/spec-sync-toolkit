/**
 * Resolving a ticket's spec-key references against the v2 server (spec §7.3,
 * SST-DESIGN-018).
 *
 * v2 specs are already leaf-sized: the whole `spec_get_many` block for a key
 * *is* the packable unit — no section resolution, no `extends` composition
 * (overlays were struck, spec-server-v2 Bauplan §0 Entscheid 5), no section
 * hash. `key@rev` is the validity check a pack carries instead: a later
 * `spec_get` on the same key tells whether it moved.
 *
 * One `spec_get_many` call resolves every key at once. The server answers in
 * request order, blocks separated by `\n\n---\n\n` (SMCP-DESIGN-012) — matched
 * **positionally**, so a "not found" or alias-redirect block (which does not
 * name the key it failed for) still lines up with the key that produced it.
 */

import type { Tools } from "./exec.js";

export interface ResolvedSpec {
  key: string;
  rev: number;
  title: string;
  status: string;
  /** The full rendered spec block — header, body and references — as returned. */
  content: string;
}

export interface KeyResolution {
  specs: ResolvedSpec[];
  /** Keys the server does not know, or that resolved only to an alias redirect. */
  unknown: string[];
}

const HEADER = /^#\s+(\S+)\s+—\s+(.+)$/mu;
const META = /^Status:\s*(\S+)\s*·\s*Art:\s*\S+\s*·\s*rev\s*(\d+)\s*·/mu;

/** Resolves every key of a ticket in one call. Empty input costs no roundtrip. */
export async function resolveKeys(keys: string[], tools: Tools): Promise<KeyResolution> {
  if (keys.length === 0) return { specs: [], unknown: [] };

  const text = await tools.spec("spec_get_many", { keys });
  const blocks = text.split(/\n\n---\n\n/u);
  const specs: ResolvedSpec[] = [];
  const unknown: string[] = [];

  keys.forEach((key, index) => {
    const block = (blocks[index] ?? "").trim();
    const header = HEADER.exec(block);
    const meta = META.exec(block);
    if (header === null || meta === null) {
      unknown.push(key);
      return;
    }
    specs.push({
      key: header[1] as string,
      title: header[2] as string,
      status: meta[1] as string,
      rev: Number.parseInt(meta[2] as string, 10),
      content: block,
    });
  });

  return { specs, unknown };
}
