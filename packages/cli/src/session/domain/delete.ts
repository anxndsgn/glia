import { join } from "node:path";
import { rm } from "node:fs/promises";
import { assertProjectWritable, type LoadedProject } from "../../core/session-module.ts";
import { GliaError } from "../../core/output/errors.ts";
import { WriterLease, writerLeaseTimeoutMs } from "../../core/store/lease.ts";
import { git, gitOrThrow } from "../../core/store/git.ts";
import {
  markerEpoch,
  prepareStoreForWrite,
  readLocalStoreMarker,
} from "../../core/store/marker.ts";
import { ProjectStore } from "../../core/store/store.ts";
import { readRemoteTrackingHead, REMOTE_TRACKING_REF } from "../../core/store/remote-tracking.ts";
import {
  DELETION_LIMITATION,
  buildLedgerCommit,
  purgeUnreachableObjects,
  readDeletionPending,
  rewriteHistoryPurging,
  writeDeletionPending,
} from "../../core/store/deletion.ts";
import { buildAndPublishLocked } from "../projection/publish.ts";
import { type SessionConflictDoc } from "./conflict.ts";
import { sessionUnitPath } from "../storage/store-layout.ts";
import {
  collapseLocalState,
  ledgerEventsFor,
  mergeLedgerEvents,
  purgePathsFor,
  resolveSessionIdentity,
  serializeLedgerFile,
} from "./deletion.ts";

export interface DeletePlan {
  sessionId: string;
  harnessId: string;
  sourceSessionId: string;
  /** Revisions this Session accumulated across Store history. */
  revisionCount: number;
  /** Present when the Session is frozen in a Session Conflict. */
  conflict: SessionConflictDoc | null;
  nextEpoch: number;
}

/**
 * Read-only preview of one deletion. `SESSION_DELETED` for an identity
 * already deleted, `NOT_FOUND` for one that never existed — neither
 * changes the epoch, and nothing is mutated here: `INPUT_REQUIRED` and
 * the interactive confirmation both come before any Store write.
 */
export async function planDelete(project: LoadedProject, sessionId: string): Promise<DeletePlan> {
  const storeDir = project.paths.storeDir;
  const { conflict, harnessId, sourceSessionId } = await resolveSessionIdentity(
    storeDir,
    sessionId,
  );
  const revisions = await gitOrThrow(
    ["rev-list", "--count", "HEAD", "--", `${sessionUnitPath(sessionId)}/session.json`],
    storeDir,
  );
  const epoch = markerEpoch(await readLocalStoreMarker(storeDir));
  return {
    sessionId,
    harnessId,
    sourceSessionId,
    revisionCount: Math.max(1, Number(revisions.trim()) || 0),
    conflict,
    nextEpoch: epoch + 1,
  };
}

export interface DeleteReport {
  sessionId: string;
  harnessId: string;
  sourceSessionId: string;
  epoch: number;
  deletedAt: string;
  storeCommit: string;
  /** How many candidate Revisions of a Session Conflict the deletion destroyed; 0 without one. */
  deletedConflictCandidates: number;
  /** `pending_sync` when a declared remote awaits propagation via `glia sync`. */
  propagation: "pending_sync" | "local_only";
  projectionFresh: boolean;
  /** The erasure-limitation statement, verbatim. */
  limitation: string;
}

/**
 * The deletion operation: rewrites Store history to purge the Session's
 * directory from every commit, appends the ledger event and the epoch
 * increment in one commit, and adopts the result by one atomic reference
 * switch — an interrupted deletion leaves the pre-deletion Store fully
 * intact, and retrying is always safe because the rewrite is a
 * deterministic pure function. Holds the Project writer lease throughout.
 */
export async function runDelete(
  project: LoadedProject,
  env: Record<string, string | undefined>,
  sessionId: string,
): Promise<DeleteReport> {
  assertProjectWritable(project);
  const storeDir = project.paths.storeDir;
  const lease = await WriterLease.acquire(project.paths.writerLockFile, writerLeaseTimeoutMs(env));
  try {
    const store = new ProjectStore(storeDir);
    const projectId = project.declaration.projectId;
    await prepareStoreForWrite(store, projectId, {
      recoveryDetails: { projectId, replicaId: project.replicaId },
    });
    // Revalidate under the lease; the preview ran without it.
    const plan = await planDelete(project, sessionId);

    const oldHead = await store.head();
    const deletedAt = new Date().toISOString();
    const event = {
      unitId: sessionId,
      sourceIdentity: { harnessId: plan.harnessId, sourceSessionId: plan.sourceSessionId },
      replicaId: project.replicaId,
      deletedAt,
      epoch: plan.nextEpoch,
    };
    const priorEvents = await ledgerEventsFor(storeDir, sessionId);
    const events = mergeLedgerEvents(priorEvents, [event]);

    // 1. The deterministic rewrite, prepared aside in the object database.
    const purge = purgePathsFor(event);
    const rewrite = await rewriteHistoryPurging(storeDir, oldHead, purge);

    // 2. The ledger event and epoch increment, one commit on top.
    const trailer = JSON.stringify({
      op: "session.delete",
      projectId,
      replicaId: project.replicaId,
      sessionId,
      epoch: plan.nextEpoch,
    });
    const finalHead = await buildLedgerCommit(
      storeDir,
      rewrite.newHead,
      projectId,
      plan.nextEpoch,
      [serializeLedgerFile(events)],
      `session: delete ${sessionId} (epoch ${plan.nextEpoch})\n\nglia-op: ${trailer}\n`,
    );

    // 3. The atomic reference switch; everything before this left the
    // pre-deletion Store fully intact.
    await gitOrThrow(["update-ref", "refs/heads/main", finalHead, oldHead], storeDir);
    await gitOrThrow(["reset", "--hard", "--quiet"], storeDir);

    // 4. The last synchronized state maps to its image so the payload
    // stays unreachable; its pre-rewrite SHA moves into pending state as
    // the base the propagation protocol verifies against.
    const remote = project.declaration.store.remote;
    const associatedHead =
      remote === undefined ? null : await readRemoteTrackingHead(storeDir, remote);
    const tracking = await git(["rev-parse", "--verify", "--quiet", REMOTE_TRACKING_REF], storeDir);
    let baseHead: string | null = null;
    if (tracking.exitCode === 0) {
      const trackingHead = tracking.stdout.trim();
      if (trackingHead === associatedHead) baseHead = trackingHead;
      const image = rewrite.map.get(trackingHead);
      if (image !== undefined) {
        await gitOrThrow(["update-ref", REMOTE_TRACKING_REF, image], storeDir);
      } else {
        await git(["update-ref", "-d", REMOTE_TRACKING_REF], storeDir);
      }
    }

    const remoteDeclared = remote !== undefined;
    if (remoteDeclared) {
      const pending = (await readDeletionPending(project.paths.deletionPendingFile)) ?? {
        schemaVersion: 1,
        baseHead,
        events: [],
      };
      pending.events.push({ contextId: "session", event });
      await writeDeletionPending(project.paths.deletionPendingFile, pending);
    }

    // 5. Clean everything under Glia's control: staging residue, caches,
    // machine-local state, unreachable payload objects, the projection.
    await rm(project.paths.stagingRoot, { recursive: true, force: true });
    await rm(join(project.paths.sessionCacheDir, "indexes"), { recursive: true, force: true });
    await rm(project.paths.currentProjectionFile, { force: true });
    await collapseLocalState(project, [event]);
    await purgeUnreachableObjects(storeDir);

    let projectionFresh = true;
    try {
      await buildAndPublishLocked(project, finalHead);
    } catch {
      projectionFresh = false;
    }

    return {
      sessionId,
      harnessId: plan.harnessId,
      sourceSessionId: plan.sourceSessionId,
      epoch: plan.nextEpoch,
      deletedAt,
      storeCommit: finalHead,
      deletedConflictCandidates: plan.conflict?.candidates.length ?? 0,
      propagation: remoteDeclared ? "pending_sync" : "local_only",
      projectionFresh,
      limitation: DELETION_LIMITATION,
    };
  } finally {
    lease.release();
  }
}
