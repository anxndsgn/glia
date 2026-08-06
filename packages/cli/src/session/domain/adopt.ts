import { dirname, join } from "node:path";
import { cp, mkdir, rm } from "node:fs/promises";
import type { LoadedProject, StoreDeletionEvent } from "../../core/session-module.ts";
import type { ProjectPaths } from "../../core/project/paths.ts";
import {
  deletionMarkerBytes,
  markerEpoch,
  prepareStoreForWrite,
  readLocalStoreMarker,
  STORE_MARKER_FILE,
} from "../../core/store/marker.ts";
import { ProjectStore } from "../../core/store/store.ts";
import { buildAndPublishLocked } from "../projection/publish.ts";
import { listSessionIds, sessionDir } from "../storage/store-layout.ts";
import { candidatesFromSideDir, isSessionConflicted, writeConflictLayout } from "./conflict.ts";
import {
  isTombstoned,
  mergeLedgerEvents,
  readLocalLedgerEvents,
  serializeLedgerFile,
} from "./deletion.ts";
import { associateCandidate, readDiscoveryState, writeDiscoveryState } from "./discovery-state.ts";
import { appendWithheldLosses, type WithheldLossRecord } from "./withheld-loss.ts";

export interface AdoptMergeReport {
  /** Sessions written into the target Store with an ordinary Current Revision. */
  merged: number;
  /** Sessions the target Store already holds at the same Revision digest. */
  skipped: number;
  /** Sessions frozen in the target Store as a Session Conflict by this merge. */
  conflicts: number;
  /** Deletion Ledger events replayed into the target Store's epoch slots. */
  ledgerMigrated: number;
  /** Candidate associations rewritten from the old Project to the target. */
  associationsRewritten: number;
  /** Withheld evaluations dropped instead of migrated; their identities become loss records. */
  withheldDropped: number;
  storeCommit: string | null;
  projectionFresh: boolean;
}

function emptyReport(): AdoptMergeReport {
  return {
    merged: 0,
    skipped: 0,
    conflicts: 0,
    ledgerMigrated: 0,
    associationsRewritten: 0,
    withheldDropped: 0,
    storeCommit: null,
    projectionFresh: false,
  };
}

function eventKey(event: StoreDeletionEvent): string {
  return [event.unitId, event.replicaId, event.deletedAt].join("\0");
}

function compareIncoming(a: StoreDeletionEvent, b: StoreDeletionEvent): number {
  return (
    a.epoch - b.epoch ||
    a.deletedAt.localeCompare(b.deletedAt) ||
    a.unitId.localeCompare(b.unitId) ||
    a.replicaId.localeCompare(b.replicaId)
  );
}

/**
 * Replays every Session the old Project holds into the adopting Project's
 * Store, then migrates its Deletion Ledger and machine-local discovery
 * state. Session-level replay, never a directory move: the Store marker
 * records the Project ID, so a whole-Store move would be a STORE_MISMATCH.
 *
 * The caller owns the machine-global Bindings lease and both Stores'
 * writer leases (target first, source second), so the source's Current
 * Revision is read without a concurrent hook capture tearing it.
 */
export async function adoptSessionsFrom(
  target: LoadedProject,
  fromPaths: ProjectPaths,
  fromProjectId: string,
): Promise<AdoptMergeReport> {
  const report = emptyReport();
  const toStoreDir = target.paths.storeDir;
  const toProjectId = target.declaration.projectId;
  const store = new ProjectStore(toStoreDir);
  await prepareStoreForWrite(store, toProjectId, {
    recoveryDetails: { projectId: toProjectId, replicaId: target.replicaId },
  });

  const fromStoreDir = fromPaths.storeDir;
  if (await new ProjectStore(fromStoreDir).exists()) {
    await mergeSessionUnits(toStoreDir, fromStoreDir, target.paths.stagingRoot, report);
    report.ledgerMigrated = await migrateLedger(toStoreDir, fromStoreDir, toProjectId);
  }

  const trailer = JSON.stringify({
    op: "project.adopt",
    projectId: toProjectId,
    replicaId: target.replicaId,
    fromProjectId,
    merged: report.merged,
    skipped: report.skipped,
    conflicts: report.conflicts,
    ledgerMigrated: report.ledgerMigrated,
  });
  const head = await store.commitAll(
    `project: adopt ${report.merged + report.conflicts} session(s) from ${fromProjectId}\n\nglia-op: ${trailer}`,
  );
  report.storeCommit = head;

  const local = await migrateDiscoveryState(fromPaths, target.paths, fromProjectId, toProjectId);
  report.associationsRewritten = local.associationsRewritten;
  report.withheldDropped = local.withheldDropped;

  try {
    await buildAndPublishLocked(target, head);
    report.projectionFresh = true;
  } catch {
    // Adopted evidence stays authoritative; the next query rebuilds.
  }
  return report;
}

async function mergeSessionUnits(
  toStoreDir: string,
  fromStoreDir: string,
  stagingRoot: string,
  report: AdoptMergeReport,
): Promise<void> {
  const staging = join(stagingRoot, `adopt-${process.pid}`);
  await rm(staging, { recursive: true, force: true });
  try {
    for (const sessionId of await listSessionIds(fromStoreDir)) {
      const fromDir = sessionDir(fromStoreDir, sessionId);
      const fromCandidates = await candidatesFromSideDir(fromDir);
      // A Session directory carrying neither a Current Revision nor a
      // conflict layout holds nothing to replay.
      if (fromCandidates.length === 0) continue;

      const toDir = sessionDir(toStoreDir, sessionId);
      const toCandidates = await candidatesFromSideDir(toDir);
      if (toCandidates.length === 0) {
        // A Source Identity this Store deliberately deleted is never
        // resurrected by a merge; its tombstone stays authoritative.
        if (await isTombstoned(toStoreDir, sessionId)) {
          report.skipped += 1;
          continue;
        }
        const stage = join(staging, sessionId, "from");
        await cp(fromDir, stage, { recursive: true });
        await rm(toDir, { recursive: true, force: true });
        await mkdir(dirname(toDir), { recursive: true });
        await cp(stage, toDir, { recursive: true });
        // A frozen conflict migrates whole, candidates intact, and stays frozen.
        if (await isSessionConflicted(toStoreDir, sessionId)) report.conflicts += 1;
        else report.merged += 1;
        continue;
      }

      // Revision digests decide, never the wrapper bytes: an acceptedAt
      // that differs between Replicas is not a divergence.
      const digests = new Set(toCandidates.map((c) => c.meta.currentRevision.digest));
      if (fromCandidates.every((c) => digests.has(c.meta.currentRevision.digest))) {
        report.skipped += 1;
        continue;
      }

      // Both sides carry content the other lacks. Stage both before
      // writing: the conflict layout replaces the target directory the
      // target's own candidates are read from.
      const stageFrom = join(staging, sessionId, "from");
      const stageTo = join(staging, sessionId, "to");
      await cp(fromDir, stageFrom, { recursive: true });
      await cp(toDir, stageTo, { recursive: true });
      await writeConflictLayout(toStoreDir, sessionId, [
        ...(await candidatesFromSideDir(stageFrom)),
        ...(await candidatesFromSideDir(stageTo)),
      ]);
      report.conflicts += 1;
    }
  } finally {
    await rm(staging, { recursive: true, force: true });
  }
}

/**
 * Replays the old Store's deletion events into the target's own epoch
 * slots and advances its marker to the largest slot it handed out, so a
 * later sync's renumbering and ever-synchronized decisions keep working.
 */
async function migrateLedger(
  toStoreDir: string,
  fromStoreDir: string,
  toProjectId: string,
): Promise<number> {
  const fromEvents = await readLocalLedgerEvents(fromStoreDir);
  if (fromEvents.length === 0) return 0;
  const toEvents = await readLocalLedgerEvents(toStoreDir);
  const known = new Set(toEvents.map(eventKey));
  const incoming = fromEvents.filter((event) => !known.has(eventKey(event))).sort(compareIncoming);
  if (incoming.length === 0) return 0;

  const markerBefore = markerEpoch(await readLocalStoreMarker(toStoreDir));
  let slot = toEvents.reduce((max, event) => Math.max(max, event.epoch), markerBefore);
  const renumbered = incoming.map((event) => ({ ...event, epoch: ++slot }));

  const byUnit = new Map<string, StoreDeletionEvent[]>();
  for (const event of [...toEvents, ...renumbered]) {
    const existing = byUnit.get(event.unitId);
    if (existing === undefined) byUnit.set(event.unitId, [event]);
    else existing.push(event);
  }
  for (const events of byUnit.values()) {
    const file = serializeLedgerFile(mergeLedgerEvents(events, []));
    const dest = join(toStoreDir, file.path);
    await mkdir(dirname(dest), { recursive: true });
    await Bun.write(dest, file.content);
  }
  await Bun.write(
    join(toStoreDir, STORE_MARKER_FILE),
    deletionMarkerBytes(toProjectId, Math.max(markerBefore, slot)),
  );
  return renumbered.length;
}

/**
 * Machine-local ownership follows the adopting Project: explicit Candidate
 * associations are rewritten to it, while withheld evaluations are not
 * migrated — their identities become loss records under the adopting
 * Project, matching the existing pruning semantics.
 */
async function migrateDiscoveryState(
  fromPaths: ProjectPaths,
  toPaths: ProjectPaths,
  fromProjectId: string,
  toProjectId: string,
): Promise<{ associationsRewritten: number; withheldDropped: number }> {
  const fromState = await readDiscoveryState(fromPaths.discoveryFile);
  const toState = await readDiscoveryState(toPaths.discoveryFile);
  let associationsRewritten = 0;
  for (const [candidateId, association] of Object.entries(fromState.associations)) {
    if (association.projectId !== fromProjectId) continue;
    associateCandidate(toState, candidateId, toProjectId, association.decidedAt);
    fromState.associations[candidateId] = {
      projectId: toProjectId,
      decidedAt: association.decidedAt,
    };
    associationsRewritten += 1;
  }

  const prunedAt = new Date().toISOString();
  const losses: WithheldLossRecord[] = [];
  const withheldDropped = Object.keys(fromState.evaluations).length;
  for (const [candidateId, evaluation] of Object.entries(fromState.evaluations)) {
    if (evaluation.identity !== undefined) {
      losses.push({
        candidateId,
        identity: evaluation.identity,
        firstFlaggedAt: evaluation.firstFlaggedAt ?? evaluation.evaluatedAt,
        prunedAt,
      });
    }
    delete fromState.evaluations[candidateId];
  }
  // Record the evidence before dropping the evaluation it describes.
  await appendWithheldLosses(toPaths.withheldLossFile, losses);

  if (associationsRewritten > 0) await writeDiscoveryState(toPaths.discoveryFile, toState);
  if (associationsRewritten > 0 || withheldDropped > 0) {
    await writeDiscoveryState(fromPaths.discoveryFile, fromState);
  }
  return { associationsRewritten, withheldDropped };
}
