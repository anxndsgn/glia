/**
 * The one shared excerpt renderer: human output and the JSON `excerpt`
 * field both carry exactly this string and may never diverge. The `«»`
 * markers are presentational — source text containing them is ambiguous
 * and that is accepted, because the excerpt is a preview, not evidence;
 * exact bytes come from the evidence locator.
 */
import { oneLine } from "../../core/output/terminal.ts";
import { foldCase, termOccurrences, type TermRange } from "./term-match.ts";

/** Bounded excerpt width in UTF-16 code units, before the ellipses. */
export const EXCERPT_MAX_WIDTH = 120;

/** Leading context kept before the first marked term when truncating. */
const LEAD_CONTEXT = 24;

const ELLIPSIS = "…";
const MARK_OPEN = "«";
const MARK_CLOSE = "»";

type Range = TermRange;

/**
 * Renders one single-line excerpt: source whitespace runs (including
 * newlines) collapse to single spaces, every matched term inside the
 * window is marked with `«»`, and the result is truncated with ellipses
 * to a bounded width around the first match. In word mode only
 * word-bounded occurrences are marked, matching what word search kept.
 */
export function renderExcerpt(text: string, terms: string[], word = false): string {
  const collapsed = oneLine(text);
  const ranges = mergeRanges(findTermRanges(collapsed, terms, word));
  const window = pickWindow(collapsed, ranges);
  let out = "";
  let cursor = window.start;
  for (const range of ranges) {
    const start = Math.max(range.start, window.start);
    const end = Math.min(range.end, window.end);
    if (end <= start) continue;
    out += collapsed.slice(cursor, start) + MARK_OPEN + collapsed.slice(start, end) + MARK_CLOSE;
    cursor = end;
  }
  out += collapsed.slice(cursor, window.end);
  const prefix = window.start > 0 ? ELLIPSIS : "";
  const suffix = window.end < collapsed.length ? ELLIPSIS : "";
  return prefix + out + suffix;
}

/** Case-insensitive literal occurrences of every term, as index ranges. */
function findTermRanges(collapsed: string, terms: string[], word: boolean): Range[] {
  const folded = foldCase(collapsed);
  return terms.flatMap((term) => termOccurrences(collapsed, term, word, folded));
}

function mergeRanges(ranges: Range[]): Range[] {
  const sorted = [...ranges].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Range[] = [];
  for (const range of sorted) {
    const last = merged[merged.length - 1];
    if (last && range.start <= last.end) last.end = Math.max(last.end, range.end);
    else merged.push({ ...range });
  }
  return merged;
}

/** The bounded view: whole text when it fits, else centered on the first match. */
function pickWindow(collapsed: string, ranges: Range[]): Range {
  if (collapsed.length <= EXCERPT_MAX_WIDTH) return { start: 0, end: collapsed.length };
  const anchor = ranges[0]?.start ?? 0;
  let start = Math.max(0, anchor - LEAD_CONTEXT);
  let end = Math.min(collapsed.length, start + EXCERPT_MAX_WIDTH);
  start = Math.max(0, end - EXCERPT_MAX_WIDTH);
  // Never split a surrogate pair at a cut point.
  if (start > 0 && isLowSurrogate(collapsed.charCodeAt(start))) start += 1;
  if (end < collapsed.length && isLowSurrogate(collapsed.charCodeAt(end))) end -= 1;
  return { start, end };
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff;
}
