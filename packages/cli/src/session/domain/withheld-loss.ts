import type { SourceIdentity } from "./identity.ts";
import { readFileIfPresent, writeJsonAtomic } from "../../core/state/atomic-file.ts";
import { requireSupportedSchemaVersion } from "../../core/state/schema-version.ts";

const LOSS_RECORD_LIMIT = 100;

export interface WithheldLossRecord {
  candidateId: string;
  identity: SourceIdentity;
  firstFlaggedAt: string;
  prunedAt: string;
}

interface WithheldLossState {
  schemaVersion: 1;
  records: WithheldLossRecord[];
}

export async function readWithheldLosses(path: string): Promise<WithheldLossRecord[]> {
  const text = await readFileIfPresent(path);
  if (text === null) return [];
  const raw = JSON.parse(text) as Partial<WithheldLossState>;
  requireSupportedSchemaVersion("withheld loss state", path, raw.schemaVersion, 1);
  if (raw.schemaVersion !== 1 || !Array.isArray(raw.records)) return [];
  return raw.records
    .filter(
      (record): record is WithheldLossRecord =>
        typeof record === "object" &&
        record !== null &&
        typeof record.candidateId === "string" &&
        typeof record.firstFlaggedAt === "string" &&
        typeof record.prunedAt === "string" &&
        typeof record.identity === "object" &&
        record.identity !== null &&
        typeof record.identity.harnessId === "string" &&
        typeof record.identity.sourceSessionId === "string",
    )
    .slice(-LOSS_RECORD_LIMIT);
}

export async function appendWithheldLosses(
  path: string,
  additions: readonly WithheldLossRecord[],
): Promise<void> {
  if (additions.length === 0) return;
  // Callers serialize this read/modify/write with the Project writer lease.
  // The stable key also makes a retry safe when the loss record landed but
  // the corresponding discovery-state deletion did not.
  const existing = await readWithheldLosses(path);
  const seen = new Set(existing.map(lossKey));
  const records = [...existing];
  for (const addition of additions) {
    if (seen.has(lossKey(addition))) continue;
    records.push(addition);
    seen.add(lossKey(addition));
  }
  await writeJsonAtomic(path, { schemaVersion: 1, records: records.slice(-LOSS_RECORD_LIMIT) });
}

function lossKey(record: WithheldLossRecord): string {
  return `${record.candidateId}\0${record.firstFlaggedAt}`;
}

export const withheldLossRecordLimit = LOSS_RECORD_LIMIT;
