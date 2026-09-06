import { loadProject } from "../../core/project/load.ts";
import { discoverCandidates } from "../domain/discover.ts";
import { forgetLocalSession, locallyForgotten } from "../domain/local-state.ts";
import { readSessionMeta } from "../storage/store-layout.ts";
import { isSessionConflicted } from "../domain/conflict.ts";
import { PROJECTION_DEFERRED_NOTE } from "../../core/session-module.ts";
import type { CommandDefinition } from "../../core/session-module.ts";
import type { CommandOutcome } from "../../core/output/result.ts";
import { confirmProceed } from "../../core/output/confirm.ts";
import { GliaError } from "../../core/output/errors.ts";
import { DELETION_LIMITATION } from "../../core/store/deletion.ts";
import { planDelete, runDelete, type DeletePlan } from "../domain/delete.ts";

export const deleteCommand: CommandDefinition = {
  name: "delete",
  projectAccess: "read",
  description:
    "forget a local or saved Session; retain Harness files and purge saved evidence with a tombstone",
  arguments: [{ name: "session-id", description: "the Session ID to delete" }],
  options: [{ flags: "--yes", description: "accept the deletion without prompting" }],
  async run(ctx, args, options): Promise<CommandOutcome> {
    const sessionId = args[0];
    if (!sessionId) throw new GliaError("USAGE", "session delete requires a <session-id>");
    const yes = options["yes"] === true;

    // The preview is read-only; INPUT_REQUIRED and the interactive
    // confirmation are both reported before any Store mutation.
    const stored = await readSessionMeta(ctx.project.paths.storeDir, sessionId);
    const conflicted = await isSessionConflicted(ctx.project.paths.storeDir, sessionId);
    if (stored === null && !conflicted) {
      if ((await locallyForgotten(ctx.project.home)).has(sessionId)) {
        throw new GliaError("SESSION_DELETED", `Session ${sessionId} was forgotten`);
      }
      const discovery = await discoverCandidates(ctx.project, ctx.env, null);
      const local = discovery.candidates.find(
        (c) => c.candidate.candidateId === sessionId && c.classification.kind === "associated",
      );
      if (local !== undefined) {
        if (!yes) {
          if (ctx.jsonMode || ctx.inputDisabled)
            throw new GliaError(
              "INPUT_REQUIRED",
              "forgetting a Session needs confirmation; re-run with --yes",
              { sessionId },
              [`glia delete ${sessionId} --yes`],
            );
          if (
            !(await confirmProceed(
              `Forget Session ${sessionId}? Glia will exclude it from search and automatic import. The Harness source file is retained.`,
            ))
          ) {
            throw new GliaError("CANCELLED", "deletion cancelled; nothing was changed");
          }
        }
        await forgetLocalSession(ctx.project.home, sessionId, ctx.project.worktree);
        return {
          json: { sessionId, forgotten: true, saved: false },
          human: `Forgot local Session ${sessionId}. It is excluded from search and import; the Harness source file is retained.`,
        };
      }
    }
    if (ctx.project.enrollment.kind === "unenrolled")
      throw new GliaError("NOT_FOUND", `Session ${sessionId} is not available in this Project`);
    const plan = await planDelete(ctx.project, sessionId);

    if (!yes) {
      if (ctx.jsonMode || ctx.inputDisabled) {
        throw new GliaError(
          "INPUT_REQUIRED",
          "session delete is destructive and needs confirmation; re-run with --yes to accept",
          {
            plan: {
              sessionId: plan.sessionId,
              harnessId: plan.harnessId,
              sourceSessionId: plan.sourceSessionId,
              revisionCount: plan.revisionCount,
              conflicted: plan.conflict !== null,
              epoch: plan.nextEpoch,
            },
            limitation: DELETION_LIMITATION,
          },
          [`glia delete ${sessionId} --yes`],
        );
      }
      if (!(await confirmProceed(`${previewText(plan)}\n\nDelete permanently?`))) {
        throw new GliaError("CANCELLED", "deletion cancelled; nothing was changed");
      }
    }

    // Re-enter the write loader after consent so historical aliases cannot mutate a Store.
    const writable = await loadProject(ctx.project.worktree, ctx.project.home);
    if (writable.declaration.projectId !== ctx.project.declaration.projectId)
      throw new GliaError(
        "BINDING_CHANGED",
        "Project ownership changed during deletion preview; retry",
        { sessionId },
      );
    const report = await runDelete(writable, ctx.env, sessionId);
    const lines = [
      `Deleted session ${report.sessionId} (${report.harnessId} ${report.sourceSessionId}) at epoch ${report.epoch}.`,
      `Its contents were purged from the working tree and the complete Store history; a payload-free tombstone remains.`,
    ];
    if (report.deletedConflictCandidates > 0) {
      lines.push(
        `The Session was frozen in a Session Conflict; all ${report.deletedConflictCandidates} candidate Revisions were deleted with it.`,
      );
    }
    lines.push(
      report.propagation === "pending_sync"
        ? "The deletion propagates to the declared remote at the next `glia sync`."
        : "This Project is local_only; the deletion is complete.",
    );
    if (!report.projectionFresh) {
      lines.push(PROJECTION_DEFERRED_NOTE);
    }
    lines.push(report.limitation);
    return { json: report, human: lines.join("\n") };
  },
};

function previewText(plan: DeletePlan): string {
  const lines = [
    `Delete session ${plan.sessionId}?`,
    "",
    `  source identity: ${plan.harnessId} ${plan.sourceSessionId}`,
    `  revisions in history: ${plan.revisionCount} — all of them will be destroyed`,
  ];
  if (plan.conflict !== null) {
    lines.push(
      `  this Session is frozen in a Session Conflict; both candidate Revisions will be deleted:`,
    );
    for (const candidate of plan.conflict.candidates) {
      lines.push(
        `    candidate ${candidate.digest.slice(0, 12)} (accepted ${candidate.acceptedAt})`,
      );
    }
  }
  lines.push(`  deletion epoch: ${plan.nextEpoch}`, "", DELETION_LIMITATION);
  return lines.join("\n");
}
