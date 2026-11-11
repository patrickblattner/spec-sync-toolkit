/**
 * Release and review cadence (train 2026-11-15, Fable C4) — the counting part,
 * pure. `cadence tag` and `review tag|batch` read it for repos whose config
 * carries a `cadence` block. A day is the local calendar day of the machine.
 */

import type { LedgerEvent } from "./ledger.js";

/** `YYYY-MM-DD` of a moment in local time. */
export function localDay(moment: Date): string {
  const pad = (value: number): string => String(value).padStart(2, "0");
  return `${moment.getFullYear()}-${pad(moment.getMonth() + 1)}-${pad(moment.getDate())}`;
}

/**
 * The tags of one day from `git for-each-ref --format=%(refname:short)%09%(creatordate:unix)`.
 * For a lightweight tag the creator date is the tagged commit's date — the
 * release commit, made right before its tag.
 */
export function tagsOfDay(forEachRef: string, day: string): string[] {
  const tags: string[] = [];
  for (const line of forEachRef.split("\n")) {
    const [name, seconds] = line.trim().split("\t");
    if (name === undefined || name === "" || seconds === undefined) continue;
    const at = Number(seconds) * 1000;
    if (Number.isFinite(at) && localDay(new Date(at)) === day) tags.push(name);
  }
  return tags;
}

/** Review modes the daily review limit counts — the Codex runs on `main`, never a PR's. */
const COUNTED_MODES = new Set(["tag", "batch"]);
/** A run that reached Codex and got an answer; skipped and deferred runs do not count. */
const COUNTED_OUTCOMES = new Set(["clean", "findings"]);

/** The Codex reviews of `tag` and `batch` that ran on one day. */
export function codexReviewsOfDay(events: readonly LedgerEvent[], day: string): LedgerEvent[] {
  return events.filter(
    (event) =>
      event.type === "review" &&
      COUNTED_MODES.has(String(event.mode)) &&
      COUNTED_OUTCOMES.has(String(event.outcome)) &&
      localDay(new Date(event.at)) === day,
  );
}

/**
 * The newest `review tag` run that reached Codex: the tag it reviewed and the
 * commit its range ended at. Read to stop a rerun without an issue and to widen
 * the range after a deferred review.
 */
export function lastTagReview(
  events: readonly LedgerEvent[],
): { tag?: string; toSha?: string } | undefined {
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i] as LedgerEvent;
    if (event.type !== "review" || event.mode !== "tag") continue;
    if (!COUNTED_OUTCOMES.has(String(event.outcome))) continue;
    return {
      ...(typeof event.tag === "string" ? { tag: event.tag } : {}),
      ...(typeof event.toSha === "string" ? { toSha: event.toSha } : {}),
    };
  }
  return undefined;
}

/** Has a `review tag` run for this tag reached Codex already? */
export function tagReviewed(events: readonly LedgerEvent[], tag: string): boolean {
  return events.some(
    (event) =>
      event.type === "review" &&
      event.mode === "tag" &&
      event.tag === tag &&
      COUNTED_OUTCOMES.has(String(event.outcome)),
  );
}
