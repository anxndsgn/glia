import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { WriterLease, writerLeaseTimeoutMs } from "../store/lease.ts";

export function readCacheRoot(home: string): string {
  return join(home, "cache", "reads");
}

export function readCacheLock(home: string): string {
  return join(home, "read-cache-lock.sqlite");
}

/** Retire disposable evidence when a read-only Project identity is replaced. */
export async function retireReadCache(home: string, projectId: string): Promise<void> {
  const lease = await WriterLease.acquire(readCacheLock(home), writerLeaseTimeoutMs());
  try {
    const root = readCacheRoot(home);
    const entries = await readdir(root).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return [];
      throw error;
    });
    // Include older projection versions and their WAL/SHM sidecars.
    for (const name of entries) {
      if (name.startsWith(`${projectId}-v`)) await rm(join(root, name), { force: true });
    }
  } finally {
    lease.release();
  }
}
