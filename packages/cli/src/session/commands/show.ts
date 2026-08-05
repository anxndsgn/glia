import type { CommandDefinition } from "../../core/session-module.ts";
import type { CommandOutcome } from "../../core/output/result.ts";
import { GliaError } from "../../core/output/errors.ts";
import { ensureProjection } from "../projection/publish.ts";
import { getSessionDetail, openProjection } from "../projection/query.ts";
import { requireSessionUnconflicted } from "../domain/conflict.ts";
import { missingSessionError } from "../domain/deletion.ts";
import { subagentNote } from "./subagent-display.ts";
import { subagentJson } from "./view.ts";
import type { SessionDetail } from "../projection/query.ts";

/**
 * Both directions of the subagent relation, stated only where they hold:
 * what this Session is a subagent of, what its bundle carries, and which
 * Sessions name it as their parent.
 */
function subagentLines(detail: SessionDetail): string[] {
  const lines: string[] = [];
  const note = subagentNote(detail);
  if (note !== null) lines.push(`  subagent: ${note}`);
  if (detail.spawnedSubagents.length > 0) {
    lines.push(`  spawned subagent sessions: ${detail.spawnedSubagents.join(", ")}`);
  }
  return lines;
}

export const showCommand: CommandDefinition = {
  name: "show",
  projectAccess: "read",
  unenrolledRead: "error",
  description: "show one accepted Session's objective metadata",
  arguments: [{ name: "session-id", description: "the Session ID" }],
  async run(ctx, args): Promise<CommandOutcome> {
    const sessionId = args[0];
    if (!sessionId) throw new GliaError("USAGE", "session show requires a <session-id>");
    await requireSessionUnconflicted(ctx.project.paths.storeDir, sessionId);
    const handle = await ensureProjection(ctx.project, ctx.env);
    const db = openProjection(handle.dbPath);
    try {
      const detail = getSessionDetail(db, sessionId);
      if (!detail) throw await missingSessionError(ctx.project.paths.storeDir, sessionId);
      const kinds = Object.entries(detail.eventKinds)
        .map(([kind, n]) => `${kind}=${n}`)
        .join(" ");
      // Direct address reports the family over the whole Store: archive
      // filtering does not apply, and archived members are marked. Each
      // other member states its overlap with this Session and where the
      // shared history ends — the divergence point of a fork twin.
      const familyLines: string[] = [];
      if (detail.family !== null) {
        familyLines.push(
          `  family: ${detail.family.members.length} member(s), anchor ${detail.family.anchor}`,
        );
        for (const member of detail.family.members) {
          const notes = [
            member.sessionId === detail.family.anchor ? "(anchor)" : null,
            member.archiveState === "archived" ? "[archived]" : null,
          ]
            .filter((note): note is string => note !== null)
            .join(" ");
          let overlap = "";
          if (member.sessionId !== detail.sessionId) {
            if (member.lastShared !== null) {
              const at =
                member.lastShared.timestamp === null ? "" : ` (${member.lastShared.timestamp})`;
              overlap =
                ` — shares ${member.sharedEvents} event(s), ` +
                `diverges after #${member.lastShared.seq}${at}`;
            } else {
              // Continuation links and transitive family ties share nothing
              // directly with the addressed Session.
              overlap = " — no directly shared events";
            }
          }
          familyLines.push(`    ${member.sessionId}${notes === "" ? "" : ` ${notes}`}${overlap}`);
        }
      }
      const human = [
        `session ${detail.sessionId}`,
        `  harness: ${detail.harnessId}`,
        `  source session: ${detail.sourceSessionId}`,
        `  opening path: ${detail.openingPath ?? "(unresolved)"}`,
        `  association: ${detail.associationMode}`,
        `  archive state: ${detail.archiveState}`,
        detail.continuationParent ? `  continues: ${detail.continuationParent}` : null,
        ...subagentLines(detail),
        ...familyLines,
        `  revision: ${detail.revisionDigest.slice(0, 12)} accepted ${detail.acceptedAt}`,
        `  events: ${detail.eventCount} (${kinds})`,
        `  file touches: ${detail.fileTouchCount}`,
        `  bundle files: ${detail.artifacts.length}`,
      ]
        .filter((l): l is string => l !== null)
        .join("\n");
      // The relation has one truth source in this document: the structured
      // `subagent` object. The raw projection columns it is built from stay
      // out, so a consumer cannot read the two representations apart.
      const {
        subagentOrigin: _origin,
        subagentKind: _kind,
        subagentParent: _parent,
        subagentParentSession: _parentSession,
        subagentCount: _count,
        spawnedSubagents,
        ...rest
      } = detail;
      return {
        json: { session: { ...rest, subagent: subagentJson(detail, spawnedSubagents) } },
        human,
      };
    } finally {
      db.close();
    }
  },
};
