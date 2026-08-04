import { join } from "node:path";
import { mkdir, readdir, rename, rm } from "node:fs/promises";
import {
  assertProjectWritable,
  projectIsEnrolled,
  type LoadedProject,
} from "../../core/session-module.ts";
import { GliaError } from "../../core/output/errors.ts";
import { WriterLease, writerLeaseTimeoutMs } from "../../core/store/lease.ts";
import { prepareStoreForWrite } from "../../core/store/marker.ts";
import { probeSqliteFts5 } from "../../core/store/sqlite-probe.ts";
import { ProjectStore } from "../../core/store/store.ts";
import { buildProjection } from "./build.ts";
import { EMPTY_PROJECTION_PATH, PROJECTION_VERSION } from "./schema.ts";

export interface CurrentProjectionPointer {
  schemaVersion: number;
  storeCommit: string;
  /** Absent in pointers written before versioned invalidation existed. */
  projectionVersion?: number;
  dbFile: string;
}

/** Fresh means built from the current Store head by the current projection code. */
export function pointerIsCurrent(pointer: CurrentProjectionPointer, head: string): boolean {
  return pointer.storeCommit === head && pointer.projectionVersion === PROJECTION_VERSION;
}

export interface ProjectionHandle {
  dbPath: string;
  storeCommit: string;
  /** True when the projection lags the Store head. */
  stale: boolean;
}

export async function readCurrentPointer(
  currentFile: string,
): Promise<CurrentProjectionPointer | null> {
  const file = Bun.file(currentFile);
  if (!(await file.exists())) return null;
  try {
    return JSON.parse(await file.text()) as CurrentProjectionPointer;
  } catch {
    return null;
  }
}

/** The published projection's path when it is fresh for `head` and present on disk. */
async function freshProjectionPath(
  paths: LoadedProject["paths"],
  head: string,
): Promise<string | null> {
  const pointer = await readCurrentPointer(paths.currentProjectionFile);
  if (pointer === null || !pointerIsCurrent(pointer, head)) return null;
  const dbPath = join(paths.indexesDir, pointer.dbFile);
  return (await Bun.file(dbPath).exists()) ? dbPath : null;
}

/**
 * Returns the current projection path without acquiring the writer
 * lease or rebuilding. Advisory readers use this when stale or missing
 * projection state means "no result", not "repair it now".
 */
export async function currentProjectionPath(project: LoadedProject): Promise<string | null> {
  if (!projectIsEnrolled(project)) return null;
  const head = await new ProjectStore(project.paths.storeDir).head();
  return await freshProjectionPath(project.paths, head);
}

async function writeCurrentPointer(
  currentFile: string,
  pointer: CurrentProjectionPointer,
): Promise<void> {
  const tmp = `${currentFile}.tmp-${process.pid}`;
  await Bun.write(tmp, JSON.stringify(pointer, null, 2) + "\n");
  await rename(tmp, currentFile);
}

/**
 * Builds the projection for `storeCommit` and atomically switches
 * `current.json`. The caller must hold the Project writer lease.
 */
export async function buildAndPublishLocked(
  project: LoadedProject,
  storeCommit: string,
): Promise<string> {
  assertProjectWritable(project);
  probeSqliteFts5();
  const { indexesDir, currentProjectionFile, storeDir } = project.paths;
  await mkdir(indexesDir, { recursive: true });
  const finalPath = join(indexesDir, `${storeCommit}.sqlite`);
  const tmpPath = join(indexesDir, `${storeCommit}.sqlite.tmp-${process.pid}`);
  await rm(tmpPath, { force: true });
  try {
    await buildProjection(storeDir, storeCommit, tmpPath);
    await rm(finalPath, { force: true });
    await rename(tmpPath, finalPath);
  } finally {
    await rm(tmpPath, { force: true });
    await rm(`${tmpPath}-wal`, { force: true });
    await rm(`${tmpPath}-shm`, { force: true });
  }
  await writeCurrentPointer(currentProjectionFile, {
    schemaVersion: 1,
    storeCommit,
    projectionVersion: PROJECTION_VERSION,
    dbFile: `${storeCommit}.sqlite`,
  });
  await pruneIndexes(indexesDir, `${storeCommit}.sqlite`);
  return finalPath;
}

async function pruneIndexes(indexesDir: string, keep: string): Promise<void> {
  try {
    for (const name of await readdir(indexesDir)) {
      if (name === keep || !name.endsWith(".sqlite")) continue;
      await rm(join(indexesDir, name), { force: true });
      await rm(join(indexesDir, `${name}-wal`), { force: true });
      await rm(join(indexesDir, `${name}-shm`), { force: true });
    }
  } catch {
    // Pruning is best-effort; stale indexes are disposable cache.
  }
}

/**
 * Returns a readable projection for queries. Reading a published
 * projection never takes the lease; a rebuild is a write and does.
 */
export async function ensureProjection(
  project: LoadedProject,
  env: Record<string, string | undefined>,
): Promise<ProjectionHandle> {
  if (!projectIsEnrolled(project)) {
    return { dbPath: EMPTY_PROJECTION_PATH, storeCommit: "", stale: false };
  }
  const { currentProjectionFile, indexesDir, storeDir, writerLockFile } = project.paths;
  const head = await new ProjectStore(storeDir).head();

  const fresh = await freshProjectionPath(project.paths, head);
  if (fresh !== null) return { dbPath: fresh, storeCommit: head, stale: false };

  const lease = await WriterLease.acquire(writerLockFile, writerLeaseTimeoutMs(env));
  try {
    // A projection rebuild acquires the writer lease, so the one-time
    // store.json backfill migration runs here too; it may advance the head.
    await prepareStoreForWrite(new ProjectStore(storeDir), project.declaration.projectId, {
      recoverAlways: false,
    });
    const current = await new ProjectStore(storeDir).head();
    const rechecked = await freshProjectionPath(project.paths, current);
    if (rechecked !== null) return { dbPath: rechecked, storeCommit: current, stale: false };
    const dbPath = await buildAndPublishLocked(project, current);
    return { dbPath, storeCommit: current, stale: false };
  } catch (err) {
    if (err instanceof GliaError && err.code === "PROJECT_BUSY") throw err;
    // A stale fallback is servable only when its schema matches this
    // binary's query code: a projection built under another version
    // would fail on version-specific SQL and mask the real rebuild error.
    const fallback = await readCurrentPointer(currentProjectionFile);
    if (fallback && fallback.projectionVersion === PROJECTION_VERSION) {
      const dbPath = join(indexesDir, fallback.dbFile);
      if (await Bun.file(dbPath).exists())
        return { dbPath, storeCommit: fallback.storeCommit, stale: true };
    }
    throw err;
  } finally {
    lease.release();
  }
}
