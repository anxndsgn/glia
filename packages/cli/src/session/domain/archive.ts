import { dirname, join } from "node:path";
import { mkdir, readdir, rm } from "node:fs/promises";
import {
  assertProjectWritable,
  type LoadedProject,
  type StoreUnitMerge,
} from "../../core/session-module.ts";
import { GliaError } from "../../core/output/errors.ts";
import { requireSupportedSchemaVersion } from "../../core/state/schema-version.ts";
import { WriterLease, writerLeaseTimeoutMs } from "../../core/store/lease.ts";
import { prepareStoreForWrite } from "../../core/store/marker.ts";
import { ProjectStore } from "../../core/store/store.ts";
import { buildAndPublishLocked } from "../projection/publish.ts";
import { readSessionMeta } from "../storage/store-layout.ts";
import { readSessionConflict } from "./conflict.ts";
import { missingSessionError } from "./deletion.ts";

export const ARCHIVE_SCHEMA_VERSION = 1;
export const SESSION_ARCHIVE_DIR = "session/archive";

export type ArchiveState = "active" | "archived";

/**
 * Shared, reversible query state. A marker is never removed by unarchive:
 * once created, it remains traceable for the Source Identity's lifetime.
 */
export interface ArchiveMarker {
  schemaVersion: number;
  sessionId: string;
  state: ArchiveState;
  transitionedAt: string;
  replicaId: string;
}

export function archiveMarkerPath(sessionId: string): string {
  return `${SESSION_ARCHIVE_DIR}/${sessionId}.json`;
}

function archiveMarkerFile(storeDir: string, sessionId: string): string {
  return join(storeDir, archiveMarkerPath(sessionId));
}

function parseArchiveMarker(path: string, input: unknown): ArchiveMarker {
  if (typeof input !== "object" || input === null) {
    throw new GliaError("INTERNAL", `archive marker ${path} is not an object`, { path });
  }
  const marker = input as Record<string, unknown>;
  requireSupportedSchemaVersion(
    "Session archive marker",
    path,
    marker["schemaVersion"],
    ARCHIVE_SCHEMA_VERSION,
  );
  if (
    marker["schemaVersion"] !== ARCHIVE_SCHEMA_VERSION ||
    typeof marker["sessionId"] !== "string" ||
    (marker["state"] !== "active" && marker["state"] !== "archived") ||
    typeof marker["transitionedAt"] !== "string" ||
    !Number.isFinite(Date.parse(marker["transitionedAt"])) ||
    typeof marker["replicaId"] !== "string"
  ) {
    throw new GliaError("INTERNAL", `archive marker ${path} has invalid contents`, { path });
  }
  return marker as unknown as ArchiveMarker;
}

export async function readArchiveMarker(
  storeDir: string,
  sessionId: string,
): Promise<ArchiveMarker | null> {
  const path = archiveMarkerFile(storeDir, sessionId);
  const file = Bun.file(path);
  if (!(await file.exists())) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(await file.text());
  } catch {
    throw new GliaError("INTERNAL", `archive marker ${path} is not valid JSON`, { path });
  }
  const marker = parseArchiveMarker(path, parsed);
  if (marker.sessionId !== sessionId) {
    throw new GliaError(
      "INTERNAL",
      `archive marker ${path} names ${marker.sessionId} instead of ${sessionId}`,
      { path, sessionId, markerSessionId: marker.sessionId },
    );
  }
  return marker;
}

export async function archiveStateFor(storeDir: string, sessionId: string): Promise<ArchiveState> {
  return (await readArchiveMarker(storeDir, sessionId))?.state ?? "active";
}

export async function listArchiveMarkers(storeDir: string): Promise<ArchiveMarker[]> {
  const root = join(storeDir, SESSION_ARCHIVE_DIR);
  let names: string[];
  try {
    names = (await readdir(root)).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return [];
  }
  const markers: ArchiveMarker[] = [];
  for (const name of names) {
    const sessionId = name.slice(0, -".json".length);
    const marker = await readArchiveMarker(storeDir, sessionId);
    if (marker) markers.push(marker);
  }
  return markers;
}

export async function countArchivedSessions(storeDir: string): Promise<number> {
  return (await listArchiveMarkers(storeDir)).filter((marker) => marker.state === "archived")
    .length;
}

function compareMarkers(a: ArchiveMarker, b: ArchiveMarker): number {
  const byTime = a.transitionedAt.localeCompare(b.transitionedAt);
  if (byTime !== 0) return byTime;
  const byReplica = a.replicaId.localeCompare(b.replicaId);
  if (byReplica !== 0) return byReplica;
  // Same Replica and timestamp should not arise from independent writes,
  // but a final stable order keeps malformed histories deterministic.
  return a.state.localeCompare(b.state);
}

/** Latest transition wins; equal timestamps choose the larger Replica ID. */
export function mergeArchiveMarker(a: ArchiveMarker, b: ArchiveMarker): ArchiveMarker {
  if (a.sessionId !== b.sessionId) {
    throw new GliaError(
      "INTERNAL",
      `cannot merge archive markers for ${a.sessionId} and ${b.sessionId}`,
    );
  }
  return compareMarkers(a, b) >= 0 ? a : b;
}

async function markersFromMaterialized(dir: string): Promise<Map<string, ArchiveMarker>> {
  const markers = new Map<string, ArchiveMarker>();
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith(".json")).sort();
  } catch {
    return markers;
  }
  for (const name of names) {
    const path = join(dir, name);
    let parsed: unknown;
    try {
      parsed = JSON.parse(await Bun.file(path).text());
    } catch {
      throw new GliaError("INTERNAL", `archive marker ${path} is not valid JSON`, { path });
    }
    const marker = parseArchiveMarker(path, parsed);
    const sessionId = name.slice(0, -".json".length);
    if (marker.sessionId !== sessionId) {
      throw new GliaError(
        "INTERNAL",
        `archive marker ${path} names ${marker.sessionId} instead of ${sessionId}`,
        { path, sessionId, markerSessionId: marker.sessionId },
      );
    }
    markers.set(sessionId, marker);
  }
  return markers;
}

function markerBytes(marker: ArchiveMarker): string {
  return JSON.stringify(marker, null, 2) + "\n";
}

/**
 * Store Sync hook for the whole archive namespace. It unions disjoint
 * markers and applies the marker-level deterministic rule to overlaps.
 */
export async function mergeArchiveUnit(
  project: LoadedProject,
  merge: StoreUnitMerge,
): Promise<void> {
  const staging = join(project.paths.stagingRoot, `archive-merge-${process.pid}`);
  await rm(staging, { recursive: true, force: true });
  try {
    const localDir = join(staging, "local");
    const remoteDir = join(staging, "remote");
    await merge.local.materialize(localDir);
    await merge.remote.materialize(remoteDir);
    const local = await markersFromMaterialized(localDir);
    const remote = await markersFromMaterialized(remoteDir);
    const sessionIds = [...new Set([...local.keys(), ...remote.keys()])].sort();
    const target = join(project.paths.storeDir, SESSION_ARCHIVE_DIR);
    await mkdir(target, { recursive: true });
    for (const sessionId of sessionIds) {
      const a = local.get(sessionId);
      const b = remote.get(sessionId);
      const marker = a && b ? mergeArchiveMarker(a, b) : (a ?? b)!;
      await Bun.write(join(target, `${sessionId}.json`), markerBytes(marker));
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

export interface ArchivePlan {
  sessionId: string;
  harnessId: string;
  sourceSessionId: string;
  previousState: ArchiveState;
  nextState: ArchiveState;
  changed: boolean;
}

/**
 * Read-only transition preview. A conflict-frozen Session is still a live
 * Session for archive purposes; a tombstoned identity remains deleted.
 */
export async function planArchiveTransition(
  project: LoadedProject,
  sessionId: string,
  nextState: ArchiveState,
): Promise<ArchivePlan> {
  const storeDir = project.paths.storeDir;
  const store = new ProjectStore(storeDir);
  if (!(await store.exists())) {
    throw new GliaError(
      "STORE_NOT_REALIZED",
      "this Project has no local Store; run `glia sync` first",
    );
  }
  const meta = await readSessionMeta(storeDir, sessionId);
  const conflict = await readSessionConflict(storeDir, sessionId);
  if (!meta && !conflict) throw await missingSessionError(storeDir, sessionId);
  const identity = meta
    ? { harnessId: meta.harnessId as string, sourceSessionId: meta.sourceSessionId }
    : {
        harnessId: conflict!.candidates[0]?.harnessId ?? "(unknown)",
        sourceSessionId: conflict!.candidates[0]?.sourceSessionId ?? "(unknown)",
      };
  const previousState = await archiveStateFor(storeDir, sessionId);
  return {
    sessionId,
    ...identity,
    previousState,
    nextState,
    changed: previousState !== nextState,
  };
}

export interface ArchiveReport extends ArchivePlan {
  applied: boolean;
  transitionedAt: string | null;
  replicaId: string | null;
  storeCommit: string;
  recoveryCommit: string | null;
  backfillCommit: string | null;
  projectionFresh: boolean;
}

/**
 * Applies one archive transition under the writer lease. A repeated
 * transition returns without Store preparation, marker writes, commits,
 * or projection publication.
 */
export async function transitionSessionArchive(
  project: LoadedProject,
  env: Record<string, string | undefined>,
  sessionId: string,
  nextState: ArchiveState,
): Promise<ArchiveReport> {
  assertProjectWritable(project);
  const lease = await WriterLease.acquire(project.paths.writerLockFile, writerLeaseTimeoutMs(env));
  try {
    const store = new ProjectStore(project.paths.storeDir);
    // A no-op transition reports the marker as it stands; the state is
    // re-planned after the Store is prepared because preparation can
    // integrate a marker written elsewhere.
    const unchangedReport = async (
      plan: ArchivePlan,
      prepared: { recoveryCommit: string | null; backfillCommit: string | null } | null,
    ): Promise<ArchiveReport> => {
      const marker = await readArchiveMarker(project.paths.storeDir, sessionId);
      return {
        ...plan,
        applied: false,
        transitionedAt: marker?.transitionedAt ?? null,
        replicaId: marker?.replicaId ?? null,
        storeCommit: await store.head(),
        recoveryCommit: prepared?.recoveryCommit ?? null,
        backfillCommit: prepared?.backfillCommit ?? null,
        projectionFresh: true,
      };
    };

    let plan = await planArchiveTransition(project, sessionId, nextState);
    if (!plan.changed) return await unchangedReport(plan, null);

    const prepared = await prepareStoreForWrite(store, project.declaration.projectId, {
      recoveryDetails: {
        projectId: project.declaration.projectId,
        replicaId: project.replicaId,
      },
    });
    plan = await planArchiveTransition(project, sessionId, nextState);
    if (!plan.changed) return await unchangedReport(plan, prepared);

    const transitionedAt = new Date().toISOString();
    const marker: ArchiveMarker = {
      schemaVersion: ARCHIVE_SCHEMA_VERSION,
      sessionId,
      state: nextState,
      transitionedAt,
      replicaId: project.replicaId,
    };
    const path = archiveMarkerFile(project.paths.storeDir, sessionId);
    await mkdir(dirname(path), { recursive: true });
    await Bun.write(path, markerBytes(marker));

    const trailer = JSON.stringify({
      op: nextState === "archived" ? "session.archive" : "session.unarchive",
      projectId: project.declaration.projectId,
      replicaId: project.replicaId,
      sessionId,
      transitionedAt,
    });
    const storeCommit = await store.commitAll(
      `session: ${nextState === "archived" ? "archive" : "unarchive"} ${sessionId}\n\nglia-op: ${trailer}`,
    );

    let projectionFresh = true;
    try {
      await buildAndPublishLocked(project, storeCommit);
    } catch {
      projectionFresh = false;
    }
    return {
      ...plan,
      applied: true,
      transitionedAt,
      replicaId: project.replicaId,
      storeCommit,
      recoveryCommit: prepared.recoveryCommit,
      backfillCommit: prepared.backfillCommit,
      projectionFresh,
    };
  } finally {
    lease.release();
  }
}
