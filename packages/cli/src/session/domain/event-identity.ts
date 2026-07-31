/**
 * Shared Event Identity: two normalized events share identity when their
 * source event identifier, timestamp, and text are all equal and the
 * identifier is non-null. JSON framing keeps null fields and arbitrary
 * text unambiguous; the digest keeps the key fixed-width. Every consumer
 * compares identity keys only for equality, so a digest carries all the
 * information the rule needs without storing — and indexing — a second
 * copy of every event's text.
 *
 * The timestamp stays in the key deliberately. It couples detection to a
 * source-native behavior — Claude Code desktop forks copy prefix events
 * with `uuid`, `timestamp`, and `message` intact (validated 2026-07; if a
 * harness ever rewrote timestamps on fork, families would quietly stop
 * forming, which is the safe direction: show more, never collapse
 * distinct content). It cannot be dropped for robustness, because not
 * every harness's event identifiers are validated globally unique — Codex
 * response-item ids are opaque payload ids — and without the timestamp an
 * ordinal-style id plus coincidentally equal text in unrelated Sessions
 * would forge an identity match, whose failure direction is the wrong
 * one. The envelope-rewrite regression test in
 * tests/integration/fork-family.test.ts pins the source behavior this
 * rule depends on.
 */
export function identityKeyOf(
  sourceEventId: string,
  timestamp: string | null,
  text: string | null,
): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(JSON.stringify([sourceEventId, timestamp, text]));
  return hasher.digest("hex").slice(0, 32);
}
