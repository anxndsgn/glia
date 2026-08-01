import { shortSubagentId } from "../adapters/subagent.ts";
import type { SubagentColumns, SubagentEvidence } from "../projection/query.ts";

/**
 * The subagent note of the collection surfaces; null when a Session neither
 * is a subagent nor carries one. The two relations are different facts and
 * read differently: a Session that *is* a subagent names its parent, one
 * that *carries* subagent transcripts states how many.
 */
export function subagentNote(session: SubagentColumns): string | null {
  const notes: string[] = [];
  if (isSubagent(session)) notes.push(`subagent${kindSuffix(session)} of ${parentName(session)}`);
  if (session.subagentCount > 0) {
    notes.push(`${session.subagentCount} subagent${session.subagentCount === 1 ? "" : "s"}`);
  }
  return notes.length > 0 ? notes.join(", ") : null;
}

/**
 * A subagent rollout that names neither a kind nor a parent is still a
 * subagent: the source stated the relation without stating either end, so
 * presence is its own column rather than inferred from the other two.
 */
function isSubagent(session: SubagentColumns): boolean {
  return session.subagentOrigin !== 0;
}

function kindSuffix(session: SubagentColumns): string {
  return session.subagentKind === null ? "" : `(${session.subagentKind})`;
}

/**
 * The parent as the reader can address it: its Session ID once imported,
 * otherwise the source ID the Harness stated, otherwise unknown. A parent
 * is never guessed, so "unknown" is a fact about the source, not a gap in
 * the query.
 */
function parentName(session: SubagentColumns): string {
  return session.subagentParentSession ?? session.subagentParent ?? "parent unknown";
}

/**
 * The per-match marker for evidence a subagent transcript contributed. The
 * agent's source-native type names it when the sidecar stated one; the id
 * still identifies which invocation, since a Session may spawn several of
 * the same type.
 */
export function subagentMatchMarker(evidence: SubagentEvidence): string {
  if (evidence.subagentId === null) return "";
  const id = evidence.subagentId === "" ? null : shortSubagentId(evidence.subagentId);
  if (evidence.subagentType === null) return id === null ? " subagent" : ` subagent ${id}`;
  return id === null
    ? ` subagent ${evidence.subagentType}`
    : ` subagent ${evidence.subagentType}(${id})`;
}
