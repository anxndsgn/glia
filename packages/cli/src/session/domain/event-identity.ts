/**
 * Shared Event Identity: two normalized events share identity when their
 * source event identifier, timestamp, and text are all equal and the
 * identifier is non-null. JSON framing keeps null fields and arbitrary
 * text unambiguous; the digest keeps the key fixed-width. Every consumer
 * compares identity keys only for equality, so a digest carries all the
 * information the rule needs without storing — and indexing — a second
 * copy of every event's text.
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
