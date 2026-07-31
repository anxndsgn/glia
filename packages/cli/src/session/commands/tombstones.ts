import type { CommandDefinition } from "../../core/session-module.ts";
import type { CommandOutcome } from "../../core/output/result.ts";
import { readLocalLedgerEvents, tombstoneSummaries } from "../domain/deletion.ts";

export const tombstonesCommand: CommandDefinition = {
  name: "tombstones",
  description: "list the Deletion Ledger as events (read-only, no network)",
  async run(ctx): Promise<CommandOutcome> {
    const events = await readLocalLedgerEvents(ctx.project.paths.storeDir);
    const summaries = tombstoneSummaries(events);
    if (summaries.length === 0) {
      return { json: { events: [] }, human: "No deletions persisted in this Store." };
    }
    const lines = [`${summaries.length} deletion event(s):`];
    for (const s of summaries) {
      lines.push(
        `epoch ${s.epoch}: ${s.sessionId} (${s.harnessId} ${s.sourceSessionId}) deleted ${s.deletedAt} by replica ${s.replicaId}`,
      );
    }
    return { json: { events: summaries }, human: lines.join("\n") };
  },
};
