import { locallyForgotten } from "../domain/local-state.ts";
import type { CommandDefinition } from "../../core/session-module.ts";
import type { CommandOutcome } from "../../core/output/result.ts";
import { GliaError } from "../../core/output/errors.ts";
import { queryProjection, readableProjectionJson, readableNotes } from "../projection/readable.ts";
import { getSessionDetail } from "../projection/query.ts";
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
  unenrolledRead: "empty",
  description: "show one local or saved Session's objective metadata",
  arguments: [{ name: "session-id", description: "the Session ID" }],
  options: [{ flags: "--saved", description: "read only the saved Store version" }],
  async run(ctx, args, options): Promise<CommandOutcome> {
    const sessionId = args[0];
    if (!sessionId) throw new GliaError("USAGE", "session show requires a <session-id>");
    await requireSessionUnconflicted(ctx.project.paths.storeDir, sessionId);
    const handle = await queryProjection(ctx, options["saved"] === true);
    const db = handle.db;
    try {
      const detail = getSessionDetail(db, sessionId);
      if (!detail) {
        if ((await locallyForgotten(ctx.project.home)).has(sessionId))
          throw new GliaError("SESSION_DELETED", `Session ${sessionId} was forgotten locally`, {
            sessionId,
          });
        const missing = await missingSessionError(ctx.project.paths.storeDir, sessionId);
        if (missing.code === "SESSION_DELETED") throw missing;
        if (handle.issues.length > 0 || options["revision"] !== undefined)
          throw new GliaError(
            "SOURCE_INCOMPLETE",
            "Session evidence is unavailable in this query",
            { sessionId, issues: handle.issues },
          );
        throw missing;
      }
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
        `  revision: ${detail.revisionDigest.slice(0, 12)}${detail.acceptedAt ? ` saved ${detail.acceptedAt}` : " (not saved)"}`,
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
        json: {
          session: { ...rest, subagent: subagentJson(detail, spawnedSubagents) },
          projection: readableProjectionJson(handle, [sessionId]),
        },
        human: human + readableNotes(handle, [sessionId]),
      };
    } finally {
      db.close();
    }
  },
};
