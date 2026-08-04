/**
 * Option parsing and rendering primitives shared by the Session reading
 * surfaces. `session search` and `session view` must stay aligned with each
 * other — same USAGE wording, same excerpt renderer, same label column —
 * so these live in one place rather than per command.
 */
import { GliaError } from "../../core/output/errors.ts";
import { renderExcerpt } from "../projection/excerpt.ts";
import type { ViewEvent } from "../projection/query.ts";
import type { ClassifiedCandidate } from "../domain/classify.ts";

/**
 * Candidate order wherever they are listed or offered: most recent first,
 * undated last, ties broken by Candidate ID so the order is stable across
 * runs and identical between `candidates` and the interactive picker.
 */
export function byRecency(a: ClassifiedCandidate, b: ClassifiedCandidate): number {
  const timeA = a.candidate.sessionTime;
  const timeB = b.candidate.sessionTime;
  if (timeA !== timeB) {
    if (timeA === null) return 1;
    if (timeB === null) return -1;
    return timeB.localeCompare(timeA);
  }
  return a.candidate.candidateId.localeCompare(b.candidate.candidateId);
}

/** The widest filter-vocabulary label; the event label column pads to it. */
export const LABEL_WIDTH = "toolresult".length;

/** Unwrap a `repeatable` option into its values. */
export function repeatedValues(raw: unknown): string[] {
  if (raw === undefined) return [];
  if (Array.isArray(raw)) return raw.map(String);
  return [String(raw)];
}

function boundedInt(raw: unknown, flag: string, min: number, bound: string): number {
  const value = Number.parseInt(String(raw), 10);
  if (!Number.isFinite(value) || value < min || String(value) !== String(raw).trim()) {
    throw new GliaError("USAGE", `${flag} must be a ${bound} integer`);
  }
  return value;
}

export function positiveInt(raw: unknown, flag: string, fallback: number): number {
  if (raw === undefined) return fallback;
  return boundedInt(raw, flag, 1, "positive");
}

export function positiveIntOrNull(raw: unknown, flag: string): number | null {
  if (raw === undefined) return null;
  return boundedInt(raw, flag, 1, "positive");
}

export function nonNegativeInt(raw: unknown, flag: string, fallback: number): number {
  if (raw === undefined) return fallback;
  return boundedInt(raw, flag, 0, "non-negative");
}

/** The single-line preview: the shared renderer with no terms to mark. */
export function lineText(event: ViewEvent): string {
  return event.text === null ? "" : renderExcerpt(event.text, []);
}

/**
 * The exhaustiveness guard the "absent means default" serializers stand on.
 * A verb that omits defaults builds its per-item object by hand, so a column
 * added to a projection row would otherwise vanish from that verb's output
 * with nothing to notice. Each serializer destructures its row and passes
 * the rest here: every field must have been named, so a new one fails the
 * build until the verb decides whether to emit it.
 */
export function assertEveryFieldConsidered<T extends Record<string, never>>(_rest: T): void {}

/** A collapsed duplicate run's member sequences, first through last. */
export function seqRange(first: number, last: number): number[] {
  const seqs: number[] = [];
  for (let s = first; s <= last; s += 1) seqs.push(s);
  return seqs;
}
