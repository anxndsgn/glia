import { join } from "node:path";
import type { LoadedProject } from "../session-module.ts";
import { writeJsonAtomic } from "../state/atomic-file.ts";
import { requireSupportedSchemaVersion } from "../state/schema-version.ts";
import { WriterLease, writerLeaseTimeoutMs } from "../store/lease.ts";

const AUTO_SAVE_SCHEMA_VERSION = 1;

/** Machine-local opt-in, independent of Store existence and remote declarations. */
export async function autoSaveEnabled(project: LoadedProject): Promise<boolean> {
  const path = join(project.paths.stateDir, "auto-save.json");
  const file = Bun.file(path);
  if (!(await file.exists())) return false;
  const state = await file.json();
  requireSupportedSchemaVersion(
    "automatic saving state",
    path,
    state.schemaVersion,
    AUTO_SAVE_SCHEMA_VERSION,
  );
  return state.enabled === true;
}

export async function setAutoSave(project: LoadedProject, enabled: boolean): Promise<void> {
  const lease = await WriterLease.acquire(project.paths.writerLockFile, writerLeaseTimeoutMs());
  try {
    await autoSaveEnabled(project);
    await writeJsonAtomic(join(project.paths.stateDir, "auto-save.json"), {
      schemaVersion: AUTO_SAVE_SCHEMA_VERSION,
      enabled,
    });
  } finally {
    lease.release();
  }
}
