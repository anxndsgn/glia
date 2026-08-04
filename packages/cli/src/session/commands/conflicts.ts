import type { CommandDefinition } from "../../core/session-module.ts";
import type { CommandOutcome } from "../../core/output/result.ts";
import {
  listConflictedSessionIds,
  readSessionConflict,
  type SessionConflictDoc,
} from "../domain/conflict.ts";

export const conflictsCommand: CommandDefinition = {
  name: "conflicts",
  projectAccess: "read",
  unenrolledRead: "empty",
  description: "list frozen Sessions with each conflict candidate's objective metadata",
  async run(ctx): Promise<CommandOutcome> {
    const { storeDir } = ctx.project.paths;
    const conflicts: SessionConflictDoc[] = [];
    for (const sessionId of await listConflictedSessionIds(storeDir)) {
      const doc = await readSessionConflict(storeDir, sessionId);
      if (doc) conflicts.push(doc);
    }

    const lines: string[] = [`${conflicts.length} session conflict(s).`];
    for (const doc of conflicts) {
      lines.push(`${doc.sessionId}`);
      for (const c of doc.candidates) {
        lines.push(
          `  candidate ${c.digest.slice(0, 12)}  accepted ${c.acceptedAt}  ${c.harnessId} ${c.sourceSessionId}`,
        );
      }
    }
    if (conflicts.length > 0) {
      lines.push("Resolve with `glia resolve <session-id> --revision <digest>`.");
    }
    return { json: { conflicts }, human: lines.join("\n") };
  },
};
