import { join } from "node:path";
import { cp, mkdir, rm } from "node:fs/promises";
import type { LoadedProject } from "../../core/session-module.ts";
import { GliaError } from "../../core/output/errors.ts";
import { prepareStoreForWrite } from "../../core/store/marker.ts";
import { WriterLease, writerLeaseTimeoutMs } from "../../core/store/lease.ts";
import { ProjectStore } from "../../core/store/store.ts";
import { sessionDir } from "../storage/store-layout.ts";
import { buildAndPublishLocked } from "../projection/publish.ts";
import { conflictDir, readSessionConflict, selectCandidate } from "./conflict.ts";

export interface ResolveReport {
  sessionId: string;
  revision: string;
  acceptedAt: string;
  /** Candidates left behind in the working tree; they remain traceable in Store history. */
  unselected: { digest: string; acceptedAt: string }[];
  recoveryCommit: string | null;
  backfillCommit: string | null;
  storeCommit: string;
  projectionFresh: boolean;
}

/**
 * Minimal pick-one resolution: promotes one candidate to Current Revision
 * in a new Store commit. The unselected candidate leaves the working tree
 * but remains traceable in Store history — resolution never deletes. It
 * works offline; the next sync propagates it, and two Replicas resolving
 * the same conflict differently re-enter the same conflict capture.
 */
export async function resolveSessionConflict(
  project: LoadedProject,
  env: Record<string, string | undefined>,
  sessionId: string,
  digest: string,
): Promise<ResolveReport> {
  const { storeDir } = project.paths;
  const lease = await WriterLease.acquire(project.paths.writerLockFile, writerLeaseTimeoutMs(env));
  try {
    const store = new ProjectStore(storeDir);
    const prepared = await prepareStoreForWrite(store, project.declaration.projectId);

    const doc = await readSessionConflict(storeDir, sessionId);
    if (doc === null) {
      throw new GliaError("NOT_FOUND", `session ${sessionId} has no unresolved conflict`, {
        sessionId,
      });
    }
    const chosen = selectCandidate(doc, digest);
    const source = join(conflictDir(storeDir, sessionId), "candidates", chosen.key);

    // Stage the promotion outside the Session directory first: the chosen
    // candidate lives inside the conflict layout being replaced.
    const staging = join(project.paths.stagingRoot, `resolve-${process.pid}-${sessionId}`);
    await rm(staging, { recursive: true, force: true });
    await mkdir(staging, { recursive: true });
    try {
      await cp(join(source, "session.json"), join(staging, "session.json"));
      await cp(join(source, "bundle"), join(staging, "bundle"), { recursive: true });
      const target = sessionDir(storeDir, sessionId);
      await rm(target, { recursive: true, force: true });
      await mkdir(join(target, ".."), { recursive: true });
      await cp(staging, target, { recursive: true });
    } finally {
      await rm(staging, { recursive: true, force: true });
    }

    const trailer = JSON.stringify({
      op: "session.resolve",
      projectId: project.declaration.projectId,
      replicaId: project.replicaId,
      sessionId,
      revision: chosen.digest,
      candidateKey: chosen.key,
    });
    const storeCommit = await store.commitAll(
      `session: resolve conflict on ${sessionId}\n\nglia-op: ${trailer}`,
    );

    let projectionFresh = false;
    try {
      await buildAndPublishLocked(project, storeCommit);
      projectionFresh = true;
    } catch {
      // Accepted evidence stays authoritative; the next query rebuilds.
    }

    return {
      sessionId,
      revision: chosen.digest,
      acceptedAt: chosen.acceptedAt,
      unselected: doc.candidates
        .filter((c) => c.key !== chosen.key)
        .map((c) => ({ digest: c.digest, acceptedAt: c.acceptedAt })),
      recoveryCommit: prepared.recoveryCommit,
      backfillCommit: prepared.backfillCommit,
      storeCommit,
      projectionFresh,
    };
  } finally {
    lease.release();
  }
}
