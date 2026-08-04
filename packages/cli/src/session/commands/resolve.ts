import { PROJECTION_DEFERRED_NOTE } from "../../core/session-module.ts";
import type { CommandDefinition } from "../../core/session-module.ts";
import type { CommandOutcome } from "../../core/output/result.ts";
import { GliaError } from "../../core/output/errors.ts";
import { resolveSessionConflict } from "../domain/resolve.ts";

export const resolveCommand: CommandDefinition = {
  name: "resolve",
  projectAccess: "write",
  description: "resolve a Session Conflict by promoting one candidate to Current Revision",
  arguments: [{ name: "session-id", description: "the frozen Session's ID" }],
  options: [
    {
      flags: "--revision <digest>",
      description: "the candidate Revision digest to promote (a unique prefix is accepted)",
    },
  ],
  async run(ctx, args, options): Promise<CommandOutcome> {
    const sessionId = args[0];
    if (!sessionId) throw new GliaError("USAGE", "session resolve requires a <session-id>");
    const digest = options["revision"] !== undefined ? String(options["revision"]) : null;
    if (!digest || digest.length === 0) {
      throw new GliaError("USAGE", "session resolve requires --revision <digest>");
    }

    const report = await resolveSessionConflict(ctx.project, ctx.env, sessionId, digest);
    const lines = [
      `Resolved session ${report.sessionId} to revision ${report.revision.slice(0, 12)} (accepted ${report.acceptedAt}).`,
      ...report.unselected.map(
        (c) =>
          `Unselected candidate ${c.digest.slice(0, 12)} remains traceable in Store history; nothing was deleted.`,
      ),
      `Store commit ${report.storeCommit.slice(0, 12)}.`,
    ];
    if (!report.projectionFresh) {
      lines.push(PROJECTION_DEFERRED_NOTE);
    }
    return { json: report, human: lines.join("\n") };
  },
};
