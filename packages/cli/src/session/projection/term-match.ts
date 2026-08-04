/**
 * Term occurrence matching, shared by search row filtering and excerpt
 * rendering so the rows word mode keeps and the ranges the excerpt marks
 * can never disagree.
 *
 * Word mode bounds a term at ASCII word characters only: a term edge that
 * is a letter, digit, or underscore must not touch another word character
 * in the text. Edges outside that alphabet keep substring semantics —
 * most importantly CJK prose, which has no delimiters to bound on, so
 * word mode never hides it.
 */

export interface TermRange {
  start: number;
  end: number;
}

const WORD_CHAR = /[0-9A-Za-z_]/;

/** Case-insensitive literal occurrences of one term, optionally word-bounded. */
export function termOccurrences(text: string, term: string, word: boolean): TermRange[] {
  const ranges: TermRange[] = [];
  if (term.length === 0) return ranges;
  const haystack = text.toLowerCase();
  const needle = term.toLowerCase();
  const boundLeft = word && WORD_CHAR.test(needle[0]!);
  const boundRight = word && WORD_CHAR.test(needle[needle.length - 1]!);
  let from = 0;
  while (true) {
    const start = haystack.indexOf(needle, from);
    if (start === -1) return ranges;
    from = start + 1;
    if (boundLeft && start > 0 && WORD_CHAR.test(haystack[start - 1]!)) continue;
    const end = start + needle.length;
    if (boundRight && end < haystack.length && WORD_CHAR.test(haystack[end]!)) continue;
    ranges.push({ start, end });
  }
}

/** Whether every term occurs in the text under the given matching mode. */
export function matchesEveryTerm(text: string, terms: string[], word: boolean): boolean {
  return terms.every((term) => termOccurrences(text, term, word).length > 0);
}
