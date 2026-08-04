import { describe, expect, test } from "bun:test";
import { matchesEveryTerm, termOccurrences } from "../../src/session/projection/term-match.ts";

describe("termOccurrences substring mode", () => {
  test("finds every case-insensitive occurrence", () => {
    expect(termOccurrences("Auth and authored", "auth", false)).toEqual([
      { start: 0, end: 4 },
      { start: 9, end: 13 },
    ]);
  });

  test("an empty term matches nothing", () => {
    expect(termOccurrences("anything", "", false)).toEqual([]);
  });
});

describe("termOccurrences word mode", () => {
  test("drops occurrences embedded in a longer word", () => {
    expect(termOccurrences("authored auth authorization", "auth", true)).toEqual([
      { start: 9, end: 13 },
    ]);
  });

  test("camelCase and underscores are word characters", () => {
    expect(termOccurrences("sourceAuthoredUserMessages", "auth", true)).toEqual([]);
    expect(termOccurrences("user_authorization", "auth", true)).toEqual([]);
    expect(termOccurrences("auth_token", "auth_token", true)).toEqual([{ start: 0, end: 10 }]);
  });

  test("punctuation, string edges, and CJK neighbors are boundaries", () => {
    expect(termOccurrences("auth.", "auth", true)).toEqual([{ start: 0, end: 4 }]);
    expect(termOccurrences("(auth)", "auth", true)).toEqual([{ start: 1, end: 5 }]);
    expect(termOccurrences("重建auth索引", "auth", true)).toEqual([{ start: 2, end: 6 }]);
  });

  test("a term edge outside the word alphabet keeps substring semantics", () => {
    // Leading '.' imposes no left boundary; the trailing 'c' still needs one.
    expect(termOccurrences("the .specs dir", ".spec", true)).toEqual([]);
    expect(termOccurrences("the .spec file", ".spec", true)).toEqual([{ start: 4, end: 9 }]);
    // A fully CJK term inside CJK prose stays findable.
    expect(termOccurrences("我们需要重建投影缓存", "投影", true)).toEqual([{ start: 6, end: 8 }]);
  });
});

describe("termOccurrences Unicode case folding", () => {
  test("a length-changing fold keeps coordinates in the original text", () => {
    // "İ".toLowerCase() is "i̇" (two UTF-16 units); folding must never
    // shift ranges off the original string.
    expect(termOccurrences("İauth", "auth", true)).toEqual([{ start: 1, end: 5 }]);
    expect(termOccurrences("İİ auth", "auth", false)).toEqual([{ start: 3, end: 7 }]);
  });

  test("a non-ASCII term edge keeps substring semantics even when it folds toward ASCII", () => {
    expect(termOccurrences("xİy", "İ", true)).toEqual([{ start: 1, end: 2 }]);
  });
});

describe("matchesEveryTerm", () => {
  test("requires every term under the given mode", () => {
    expect(matchesEveryTerm("auth failed while authoring", ["auth", "authoring"], true)).toBe(true);
    expect(matchesEveryTerm("authored only", ["auth"], false)).toBe(true);
    expect(matchesEveryTerm("authored only", ["auth"], true)).toBe(false);
  });
});
