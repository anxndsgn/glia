import { PROJECTION_DEFERRED_NOTE } from "../session-module.ts";
import type { SessionModule, CommandRunContext } from "../session-module.ts";
import type { CommandOutcome } from "../output/result.ts";
import { withProgress } from "../output/progress.ts";
import { runSync, type SyncReport } from "../store/sync.ts";

export async function runSyncCommand(
  ctx: CommandRunContext,
  modules: readonly SessionModule[],
): Promise<CommandOutcome> {
  // The fetch, merge and push segments are network-bound: without an
  // indicator a healthy sync is indistinguishable from a hung terminal.
  const remote = ctx.project.declaration.store.remote;
  const report = await withProgress(
    ctx,
    remote ? `Syncing with ${remote}` : "Syncing",
    () => "Synced",
    () => runSync(ctx.project, ctx.env, modules),
  );
  return { json: report, human: humanSyncReport(report) };
}

function humanSyncReport(report: SyncReport): string {
  const lines: string[] = [];
  const summary = {
    up_to_date: "Already up to date with",
    fast_forward: "Fast-forwarded from",
    local_ahead: "Pushed local changes to",
    diverged: "Merged with",
  }[report.classification];
  lines.push(`${summary} ${report.remote}.`);
  lines.push(
    `Pulled ${report.pulled}, pushed ${report.pushed}, merged ${report.merged}, ` +
      `conflicted ${report.conflicted.length}. Store head ${report.head.slice(0, 12)}.`,
  );
  if (report.conflicted.length > 0) {
    for (const unit of report.conflicted) lines.push(`conflict: ${unit}`);
    lines.push(
      "Each conflicted Session is frozen until resolved; every other Session stays available.",
    );
    lines.push("Inspect with `glia conflicts`, resolve with `glia resolve`.");
  }
  if (report.recoveryCommit) {
    lines.push(
      `Recovered uncommitted Store residue from an interrupted operation in commit ${report.recoveryCommit.slice(0, 12)}.`,
    );
  }
  if (report.backfillCommit) {
    lines.push(
      `Backfilled the store.json format marker in commit ${report.backfillCommit.slice(0, 12)}.`,
    );
  }
  if (report.attempts > 1) {
    lines.push(
      `The remote advanced during the window; completed after ${report.attempts} attempts.`,
    );
  }
  if (report.deletion) {
    lines.push(
      `Deletion propagation: applied ${report.deletion.eventsApplied} event(s) from the remote, ` +
        `pushed ${report.deletion.eventsPushed}; epoch ${report.deletion.epochBefore} -> ${report.deletion.epochAfter}.`,
    );
    for (const item of report.deletion.preserved) {
      lines.push(
        `PRESERVED: unsynchronized local changes to ${item.unit} were saved to ${item.path} before the deletion rewrite was applied; ` +
          `delete the files to accept the deletion, keep them elsewhere, or re-admit via \`glia accept\`.`,
      );
    }
  }
  if (!report.projectionFresh) {
    lines.push(PROJECTION_DEFERRED_NOTE);
  }
  return lines.join("\n");
}
