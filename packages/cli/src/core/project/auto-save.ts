import { join } from "node:path";
import type { LoadedProject } from "../session-module.ts";
import { writeJsonAtomic } from "../state/atomic-file.ts";
import { WriterLease, writerLeaseTimeoutMs } from "../store/lease.ts";

/** Machine-local opt-in, independent of Store existence and remote declarations. */
export async function autoSaveEnabled(project: LoadedProject): Promise<boolean> {
  const file = Bun.file(join(project.paths.stateDir, "auto-save.json"));
  if (!(await file.exists())) return false;
  return (await file.json()).enabled === true;
}

export async function setAutoSave(project: LoadedProject, enabled: boolean): Promise<void> {
  const lease = await WriterLease.acquire(project.paths.writerLockFile, writerLeaseTimeoutMs());
  try {
    await writeJsonAtomic(join(project.paths.stateDir, "auto-save.json"), {
      schemaVersion: 1,
      enabled,
    });
  } finally {
    lease.release();
  }
}
