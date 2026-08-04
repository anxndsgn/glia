import { writeJsonAtomic } from "../state/atomic-file.ts";
import { requireSupportedSchemaVersion } from "../state/schema-version.ts";

export const SYNC_STATE_SCHEMA_VERSION = 1;

/**
 * Machine-local remote-contact display state. The authoritative fetched
 * tree is the Replica's remote-tracking ref; this file distinguishes the
 * last successful contact from the last completed `glia sync`, and
 * losing it affects nothing but `glia status`.
 */
export interface SyncState {
  schemaVersion: number;
  lastFetchAt: string | null;
  lastSyncAt: string | null;
  outcome: string | null;
  head: string | null;
}

function nullableString(value: unknown): string | null | undefined {
  if (value === undefined || value === null) return null;
  return typeof value === "string" ? value : undefined;
}

export async function readSyncState(syncStateFile: string): Promise<SyncState | null> {
  const file = Bun.file(syncStateFile);
  if (!(await file.exists())) return null;
  let raw: Record<string, unknown>;
  try {
    raw = JSON.parse(await file.text()) as Record<string, unknown>;
  } catch {
    return null;
  }
  requireSupportedSchemaVersion(
    "sync state",
    syncStateFile,
    raw["schemaVersion"],
    SYNC_STATE_SCHEMA_VERSION,
  );
  const lastSyncAt = nullableString(raw["lastSyncAt"]);
  const lastFetchAt =
    raw["lastFetchAt"] === undefined ? lastSyncAt : nullableString(raw["lastFetchAt"]);
  if (lastFetchAt === undefined || lastSyncAt === undefined) return null;
  const outcome = nullableString(raw["outcome"]);
  const head = nullableString(raw["head"]);
  if (
    outcome === undefined ||
    head === undefined ||
    (lastSyncAt !== null && (outcome === null || head === null)) ||
    (lastFetchAt === null && lastSyncAt === null)
  ) {
    return null;
  }
  return {
    schemaVersion: SYNC_STATE_SCHEMA_VERSION,
    lastFetchAt,
    lastSyncAt,
    outcome,
    head,
  };
}

export async function writeSyncState(syncStateFile: string, state: SyncState): Promise<void> {
  await writeJsonAtomic(syncStateFile, state);
}
