/**
 * Finding the spec references in a ticket (spec §7.3, SST-DESIGN-018).
 *
 * v2 keys are self-contained leaves (`PROC-DEV-039`, `GL-SEC-001`,
 * `SST-DESIGN-018`, `ADR-001`) — a whole spec is small enough to be "the
 * section" (spec-server-v2 Bauplan §5, budget ≤ 2k tokens), so there is no
 * more `unit §section` addressing to parse. A ticket names its spec
 * references as backticked keys; anything else — a key-shaped word loose in
 * prose, a mention outside backticks — is not a reference. `pack` never
 * invents one (spec §2, `DECISION (no-domain-defaults)`).
 */

/** `PROC-DEV-039`, `GL-SEC-010`, `ADR-CC-001`, `PROC-010`, `VISION-001`, … */
const KEY_TOKEN = /^[A-Z][A-Z0-9]*(?:-[A-Z][A-Z0-9]*)*-\d{3}$/u;

/** The backticked, key-shaped tokens of a ticket, in first-seen order, deduped. */
export function parseSpecReferences(text: string): string[] {
  const keys: string[] = [];
  for (const match of text.matchAll(/`([^`\n]{2,40})`/gu)) {
    const token = (match[1] ?? "").trim();
    if (token !== "" && KEY_TOKEN.test(token) && !keys.includes(token)) keys.push(token);
  }
  return keys;
}
