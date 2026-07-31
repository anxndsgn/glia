/**
 * The one shared excerpt renderer: human output and the JSON `excerpt`
 * field both carry exactly this string and may never diverge. The `«»`
 * markers are presentational — source text containing them is ambiguous
 * and that is accepted, because the excerpt is a preview, not evidence;
 * exact bytes come from the evidence locator.
 */
import { oneLine } from "../../core/output/terminal.ts";

/** Bounded excerpt width in UTF-16 code units, before the ellipses. */
export const EXCERPT_MAX_WIDTH = 120;

/** Leading context kept before the first marked term when truncating. */
const LEAD_CONTEXT = 24;

const ELLIPSIS = "…";
const MARK_OPEN = "«";
const MARK_CLOSE = "»";

interface Range {
  start: number;
  end: number;
}

/**
 * Renders one single-line excerpt: source whitespace runs (including
 * newlines) collapse to single spaces, every matched term inside the
 * window is marked with `«»`, and the result is truncated with ellipses
 * to a bounded width around the first match.
 */
export function renderExcerpt(text: string, terms: string[]): string {
  const collapsed = oneLine(text);
  const ranges = mergeRanges(findTermRanges(collapsed, terms));
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
function findTermRanges(collapsed: string, terms: string[]): Range[] {
  const haystack = collapsed.toLowerCase();
  const ranges: Range[] = [];
  for (const term of terms) {
    const needle = term.toLowerCase();
    if (needle.length === 0) continue;
    let from = 0;
    while (true) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) break;
      ranges.push({ start: at, end: at + needle.length });
      from = at + 1;
    }
  }
  return ranges;
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
