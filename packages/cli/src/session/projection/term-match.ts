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

/**
 * Case fold that preserves UTF-16 length so every folded index maps 1:1
 * onto the input. A code point whose lowercase form changes length
 * (e.g. İ → i̇) is kept as-is and matches only itself; ranges must stay
 * valid coordinates into the original text.
 */
function foldCase(value: string): string {
  const folded = value.toLowerCase();
  if (folded.length === value.length) return folded;
  let out = "";
  for (const ch of value) {
    const lower = ch.toLowerCase();
    out += lower.length === ch.length ? lower : ch;
  }
  return out;
}

/** Case-insensitive literal occurrences of one term, optionally word-bounded. */
export function termOccurrences(text: string, term: string, word: boolean): TermRange[] {
  const ranges: TermRange[] = [];
  if (term.length === 0) return ranges;
  const haystack = foldCase(text);
  const needle = foldCase(term);
  // Edge classes and neighbor tests use the original characters, never the
  // folded copy: a non-ASCII edge (İ) whose lowercase form starts with an
  // ASCII letter must still keep substring semantics.
  const boundLeft = word && WORD_CHAR.test(term[0]!);
  const boundRight = word && WORD_CHAR.test(term[term.length - 1]!);
  let from = 0;
  while (true) {
    const start = haystack.indexOf(needle, from);
    if (start === -1) return ranges;
    from = start + 1;
    if (boundLeft && start > 0 && WORD_CHAR.test(text[start - 1]!)) continue;
    const end = start + needle.length;
    if (boundRight && end < text.length && WORD_CHAR.test(text[end]!)) continue;
    ranges.push({ start, end });
  }
}

/** Whether every term occurs in the text under the given matching mode. */
export function matchesEveryTerm(text: string, terms: string[], word: boolean): boolean {
  return terms.every((term) => termOccurrences(text, term, word).length > 0);
}
