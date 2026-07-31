import { shortSubagentId, subagentIdOf, isSubagentBundlePath } from "../adapters/subagent.ts";
import type { SubagentColumns } from "../projection/query.ts";

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
 * A subagent rollout that names no parent is still a subagent — Codex
 * stated the relation without stating the other end, and older rollouts
 * carry no parent link at all.
 */
function isSubagent(session: SubagentColumns): boolean {
  return session.subagentKind !== null || session.subagentParent !== null;
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

/** The per-match marker for evidence a subagent transcript contributed. */
export function subagentMatchMarker(sourceFile: string): string {
  if (!isSubagentBundlePath(sourceFile)) return "";
  return ` subagent ${shortSubagentId(subagentIdOf(sourceFile))}`;
}
