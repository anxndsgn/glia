import type { FamilyHint } from "../domain/family-hint.ts";

/** The Fork Family note of the collection surfaces; null outside any visible family. */
export function familyNote(
  sessionId: string,
  family: { anchor: string; memberCount: number } | null,
): string | null {
  if (family === null) return null;
  return family.anchor === sessionId
    ? `(family of ${family.memberCount})`
    : `(family: ${family.anchor})`;
}

/** The cross-Session copy marker for a collapsed match; empty when uncollapsed. */
export function alsoInMarker(alsoIn: string[] | undefined): string {
  if (alsoIn === undefined || alsoIn.length === 0) return "";
  return alsoIn.length === 1 ? ` (also in ${alsoIn[0]})` : ` (also in ${alsoIn.length} sessions)`;
}

/**
 * The consent-time Fork Family note: the overlap with the stored Session
 * that shares most, and the count of further related Sessions. Advisory
 * only — it never gates acceptance.
 */
export function familyHintText(hint: FamilyHint): string {
  const more = hint.furtherSessions > 0 ? `; ${hint.furtherSessions} more related session(s)` : "";
  return (
    `shares ${hint.sharedEvents} of ${hint.totalEvents} events with ` +
    `${hint.withSessionId.slice(0, 10)}… (fork family${more})`
  );
}
