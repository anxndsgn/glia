import { bindingsLockFile } from "../../core/project/paths.ts";
import { readCacheRoot, readCacheLock } from "../../core/project/read-cache.ts";
import { loadProjectForRead } from "../../core/project/load.ts";
import { readSessionMeta } from "../storage/store-layout.ts";
import { join } from "node:path";
import { readdir, rm } from "node:fs/promises";
import { writeJsonAtomic } from "../../core/state/atomic-file.ts";
import { WriterLease, writerLeaseTimeoutMs } from "../../core/store/lease.ts";
import { GliaError } from "../../core/output/errors.ts";

export async function locallyForgotten(home: string): Promise<Set<string>> {
  try {
    return new Set(
      (await readdir(join(home, "state", "forgotten")))
        .filter((n) => n.endsWith(".json"))
        .map((n) => n.slice(0, -5)),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return new Set();
    throw error;
  }
}

/** Payload-free local exclusions survive disposable cache removal and future enrollment. */
export async function forgetLocalSession(
  home: string,
  sessionId: string,
  cwd: string,
): Promise<void> {
  if (!/^ses_[a-f0-9]{32}$/.test(sessionId)) throw new GliaError("USAGE", "invalid Session ID");
  const bindingsLease = await WriterLease.acquire(bindingsLockFile(home), writerLeaseTimeoutMs());
  let lease: WriterLease | null = null;
  try {
    const current = await loadProjectForRead(cwd, home);
    if (await readSessionMeta(current.paths.storeDir, sessionId)) {
      throw new GliaError(
        "BINDING_CHANGED",
        "Session was saved during deletion preview; repeat the deletion to purge the saved version",
        { sessionId },
      );
    }
    lease = await WriterLease.acquire(readCacheLock(home), writerLeaseTimeoutMs());
    await writeJsonAtomic(join(home, "state", "forgotten", `${sessionId}.json`), {
      schemaVersion: 1,
      sessionId,
      deletedAt: new Date().toISOString(),
    });
    await rm(readCacheRoot(home), { recursive: true, force: true });
  } finally {
    lease?.release();
    bindingsLease.release();
  }
}

/** Store deletion also purges disposable copies of normalized evidence. */
export async function purgeReadCache(home: string): Promise<void> {
  const lease = await WriterLease.acquire(readCacheLock(home), writerLeaseTimeoutMs());
  try {
    await rm(readCacheRoot(home), { recursive: true, force: true });
  } finally {
    lease.release();
  }
}
