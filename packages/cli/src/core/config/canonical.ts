/**
 * Canonical serialization for the optional Project Declaration (`glia.json`). One
 * canonical form makes a rewrite without semantic change byte-identical
 * and keeps code-repository diffs minimal and reviewable:
 *
 * - top-level keys in registry order (`schemaVersion` always first);
 * - unknown top-level keys after every registry key, lexicographically;
 * - entries of map-valued fields in lexicographic key order;
 * - two-space indentation and a trailing newline.
 */

/** The Declaration field registry, in registry order. Each key is claimed
 * by exactly one spec; unclaimed keys are reserved. */
export const DECLARATION_KEY_REGISTRY = [
  "schemaVersion",
  "projectId",
  "store",
  "secretDetection",
] as const;

function sortedValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortedValue);
  if (typeof value === "object" && value !== null) {
    const source = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(source).sort()) {
      out[key] = sortedValue(source[key]);
    }
    return out;
  }
  return value;
}

/** Serializes one container file in the canonical form. */
export function canonicalContainerBytes(
  content: Record<string, unknown>,
  registry: readonly string[],
): string {
  const ordered: Record<string, unknown> = {};
  const registryKeys = registry.filter((key) => key in content);
  const unknownKeys = Object.keys(content)
    .filter((key) => !registry.includes(key))
    .sort();
  // Every nested object serializes with lexicographic keys, which covers
  // map-valued fields and unknown-key values deterministic too.
  for (const key of [...registryKeys, ...unknownKeys]) {
    ordered[key] = sortedValue(content[key]);
  }
  return JSON.stringify(ordered, null, 2) + "\n";
}
