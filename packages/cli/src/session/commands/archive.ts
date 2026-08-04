import { PROJECTION_DEFERRED_NOTE } from "../../core/session-module.ts";
import type { CommandDefinition } from "../../core/session-module.ts";
import type { CommandOutcome } from "../../core/output/result.ts";
import { confirmProceed } from "../../core/output/confirm.ts";
import { GliaError } from "../../core/output/errors.ts";
import {
  planArchiveTransition,
  transitionSessionArchive,
  type ArchivePlan,
  type ArchiveState,
} from "../domain/archive.ts";

function commandFor(nextState: ArchiveState): CommandDefinition {
  const verb = nextState === "archived" ? "archive" : "unarchive";
  return {
    name: verb,
    projectAccess: "write",
    description:
      nextState === "archived"
        ? "hide one Session from default collection queries without changing its evidence"
        : "restore one Archived Session to default collection queries",
    arguments: [{ name: "session-id", description: "the Session ID" }],
    options: [
      { flags: "--dry-run", description: "preview the transition without writing" },
      { flags: "--yes", description: "accept the transition without prompting" },
    ],
    async run(ctx, args, options): Promise<CommandOutcome> {
      const sessionId = args[0];
      if (!sessionId) throw new GliaError("USAGE", `session ${verb} requires a <session-id>`);
      const dryRun = options["dryRun"] === true;
      const yes = options["yes"] === true;
      if (dryRun && yes) {
        throw new GliaError("USAGE", "--dry-run and --yes are mutually exclusive");
      }

      // The plan is read-only. INPUT_REQUIRED and interactive confirmation
      // both happen before the writer lease or any Store mutation.
      const plan = await planArchiveTransition(ctx.project, sessionId, nextState);
      if (!plan.changed) {
        return {
          json: { ...plan, applied: false },
          human: `Session ${sessionId} is already ${nextState}. Nothing to do.`,
        };
      }
      if (dryRun) {
        return {
          json: { ...plan, applied: false },
          human: previewText(plan),
        };
      }
      if (!yes) {
        if (ctx.jsonMode || ctx.inputDisabled) {
          throw new GliaError(
            "INPUT_REQUIRED",
            `session ${verb} needs confirmation; re-run with --yes to accept or --dry-run to preview`,
            {
              plan,
              nextSteps: [`glia ${verb} ${sessionId} --dry-run`, `glia ${verb} ${sessionId} --yes`],
            },
          );
        }
        if (!(await confirmProceed(`${previewText(plan)}\n\nContinue?`))) {
          throw new GliaError("CANCELLED", `session ${verb} cancelled; nothing was changed`);
        }
      }

      const report = await transitionSessionArchive(ctx.project, ctx.env, sessionId, nextState);
      const lines = [
        `${nextState === "archived" ? "Archived" : "Unarchived"} session ${sessionId}.`,
        nextState === "archived"
          ? "It is hidden from default `session list` and `session search` results; direct addressing still works."
          : "It is visible in default `session list` and `session search` results again.",
        "Only shared query metadata changed; the Session evidence and Store history were not removed, and no space was reclaimed.",
        `Store commit ${report.storeCommit.slice(0, 12)}.`,
      ];
      if (!report.projectionFresh) {
        lines.push(PROJECTION_DEFERRED_NOTE);
      }
      return { json: report, human: lines.join("\n") };
    },
  };
}

function previewText(plan: ArchivePlan): string {
  const action = plan.nextState === "archived" ? "Archive" : "Unarchive";
  const effect =
    plan.nextState === "archived"
      ? "The Session will leave default collection queries but remain directly readable."
      : "The Session will return to default collection queries.";
  return [
    `${action} session ${plan.sessionId}?`,
    "",
    `  source identity: ${plan.harnessId} ${plan.sourceSessionId}`,
    `  archive state: ${plan.previousState} -> ${plan.nextState}`,
    "",
    effect,
    "This shared marker does not remove evidence, conceal it from Store holders, or reclaim space.",
  ].join("\n");
}

export const archiveCommand = commandFor("archived");
export const unarchiveCommand = commandFor("active");
