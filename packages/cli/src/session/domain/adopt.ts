import { dirname, join } from "node:path";
import { cp, mkdir, readdir, rename, rm } from "node:fs/promises";
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
import {
  archiveMarkerPath,
  listArchiveMarkers,
  mergeArchiveMarker,
  readArchiveMarker,
} from "./archive.ts";
import { candidatesFromSideDir, writeConflictLayout } from "./conflict.ts";
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
  /** Archive markers created or advanced in the target Store. */
  archiveMigrated: number;
  /** Candidate associations rewritten from the old Project to the target. */
  associationsRewritten: number;
  /** Machine-local ignore decisions carried over to the target Project. */
  ignoredMigrated: number;
  /** Withheld evaluations dropped; each identity-bearing one becomes a loss record. */
  withheldDropped: number;
  storeCommit: string | null;
  projectionFresh: boolean;
}

export function emptyAdoptMergeReport(): AdoptMergeReport {
  return {
    merged: 0,
    skipped: 0,
    conflicts: 0,
    ledgerMigrated: 0,
    archiveMigrated: 0,
    associationsRewritten: 0,
    ignoredMigrated: 0,
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
 * Sibling build directory for the two-phase unit swap. A unit is built
 * next to its final path with its marker file written last, then swapped
 * in with an atomic rename. A crash therefore leaves either a torn
 * incoming directory (marker missing — discarded on rerun) or a complete
 * one (rolled forward on rerun); the final directory is never destroyed
 * before its full replacement is on disk.
 */
const INCOMING_SUFFIX = ".adopt-incoming";
const CONFLICT_MARKER = join("conflict", "conflict.json");
const SESSION_MARKER = "session.json";

async function fileExists(path: string): Promise<boolean> {
  return await Bun.file(path).exists();
}

async function markerRelPathOf(unitDir: string): Promise<string> {
  return (await fileExists(join(unitDir, CONFLICT_MARKER))) ? CONFLICT_MARKER : SESSION_MARKER;
}

/** Copies a Session unit, writing its marker file last. */
async function copyUnitMarkerLast(srcDir: string, destDir: string): Promise<void> {
  const marker = await markerRelPathOf(srcDir);
  const markerAbs = join(srcDir, marker);
  await rm(destDir, { recursive: true, force: true });
  await mkdir(dirname(destDir), { recursive: true });
  await cp(srcDir, destDir, {
    recursive: true,
    filter: (source) => source !== markerAbs,
  });
  await mkdir(dirname(join(destDir, marker)), { recursive: true });
  await cp(markerAbs, join(destDir, marker));
}

async function swapInUnit(incomingDir: string, finalDir: string): Promise<void> {
  await rm(finalDir, { recursive: true, force: true });
  await rename(incomingDir, finalDir);
}

/** Completes or discards incoming units a crashed earlier run left behind. */
async function rollForwardIncomingUnits(toStoreDir: string): Promise<void> {
  const container = dirname(sessionDir(toStoreDir, "unit"));
  let entries: string[];
  try {
    entries = await readdir(container);
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.endsWith(INCOMING_SUFFIX)) continue;
    const incoming = join(container, entry);
    const final = join(container, entry.slice(0, -INCOMING_SUFFIX.length));
    if ((await candidatesFromSideDir(incoming)).length > 0) {
      await swapInUnit(incoming, final);
    } else {
      await rm(incoming, { recursive: true, force: true });
    }
  }
}

/**
 * Replays every Session the old Project holds into the adopting Project's
 * Store, then migrates its Deletion Ledger, archive markers, and
 * machine-local discovery state. Session-level replay, never a directory
 * move: the Store marker records the Project ID, so a whole-Store move
 * would be a STORE_MISMATCH.
 *
 * The caller owns the machine-global Bindings lease and both Stores'
 * writer leases, so the source's Current Revision is read without a
 * concurrent hook capture tearing it.
 */
export async function adoptSessionsFrom(
  target: LoadedProject,
  fromPaths: ProjectPaths,
  fromProjectId: string,
): Promise<AdoptMergeReport> {
  const report = emptyAdoptMergeReport();
  const toStoreDir = target.paths.storeDir;
  const toProjectId = target.declaration.projectId;
  const store = new ProjectStore(toStoreDir);
  await prepareStoreForWrite(store, toProjectId, {
    recoveryDetails: { projectId: toProjectId, replicaId: target.replicaId },
  });
  await rollForwardIncomingUnits(toStoreDir);

  const fromStoreDir = fromPaths.storeDir;
  if (await new ProjectStore(fromStoreDir).exists()) {
    await mergeSessionUnits(toStoreDir, fromStoreDir, target.paths.stagingRoot, report);
    report.ledgerMigrated = await migrateLedger(toStoreDir, fromStoreDir, toProjectId);
    report.archiveMigrated = await migrateArchiveMarkers(toStoreDir, fromStoreDir);
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
  report.ignoredMigrated = local.ignoredMigrated;
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
      const incoming = `${toDir}${INCOMING_SUFFIX}`;
      const toCandidates = await candidatesFromSideDir(toDir);
      if (toCandidates.length === 0) {
        // A Source Identity this Store deliberately deleted is never
        // resurrected by a merge; its tombstone stays authoritative.
        if (await isTombstoned(toStoreDir, sessionId)) {
          report.skipped += 1;
          continue;
        }
        await copyUnitMarkerLast(fromDir, incoming);
        const frozen = await fileExists(join(incoming, CONFLICT_MARKER));
        await swapInUnit(incoming, toDir);
        // A frozen conflict migrates whole, candidates intact, and stays frozen.
        if (frozen) report.conflicts += 1;
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

      // Both sides carry content the other lacks. The layout is built in
      // staging from copies of both sides, then swapped in whole, so the
      // target directory holds either its old content or the complete
      // conflict layout at every instant.
      const stageFrom = join(staging, sessionId, "from");
      const stageTo = join(staging, sessionId, "to");
      const stageStore = join(staging, sessionId, "store");
      await cp(fromDir, stageFrom, { recursive: true });
      await cp(toDir, stageTo, { recursive: true });
      await writeConflictLayout(stageStore, sessionId, [
        ...(await candidatesFromSideDir(stageFrom)),
        ...(await candidatesFromSideDir(stageTo)),
      ]);
      await copyUnitMarkerLast(sessionDir(stageStore, sessionId), incoming);
      await swapInUnit(incoming, toDir);
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
 *
 * Events whose Session the target holds live are never migrated: the
 * target's evidence wins, exactly as its tombstones win over the source's
 * live Sessions in mergeSessionUnits. Migrating such an event would enter
 * the ledger without the history rewrite the deletion protocol pairs it
 * with, and the next sync would propagate a deletion nobody in the
 * target Project decided.
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
  const incoming: StoreDeletionEvent[] = [];
  for (const event of fromEvents) {
    if (known.has(eventKey(event))) continue;
    const liveInTarget =
      (await candidatesFromSideDir(sessionDir(toStoreDir, event.unitId))).length > 0;
    if (liveInTarget) continue;
    incoming.push(event);
  }
  if (incoming.length === 0) return 0;
  incoming.sort(compareIncoming);

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
 * Unions the old Store's archive markers into the target, applying the
 * marker-level deterministic rule to overlaps — the same surface sync's
 * archive unit merge covers, so adopt's merge is not narrower than sync's.
 */
async function migrateArchiveMarkers(toStoreDir: string, fromStoreDir: string): Promise<number> {
  let migrated = 0;
  for (const marker of await listArchiveMarkers(fromStoreDir)) {
    const existing = await readArchiveMarker(toStoreDir, marker.sessionId);
    const next = existing === null ? marker : mergeArchiveMarker(existing, marker);
    if (next === existing) continue;
    const dest = join(toStoreDir, archiveMarkerPath(marker.sessionId));
    await mkdir(dirname(dest), { recursive: true });
    await Bun.write(dest, JSON.stringify(next, null, 2) + "\n");
    migrated += 1;
  }
  return migrated;
}

/**
 * Machine-local ownership follows the adopting Project: explicit Candidate
 * associations and ignore decisions carry over, while the adopting
 * Project's own existing decisions always win over the merged-from side.
 * Withheld evaluations are not migrated — each identity-bearing one
 * becomes a loss record under the adopting Project, matching the existing
 * pruning semantics.
 */
async function migrateDiscoveryState(
  fromPaths: ProjectPaths,
  toPaths: ProjectPaths,
  fromProjectId: string,
  toProjectId: string,
): Promise<{ associationsRewritten: number; ignoredMigrated: number; withheldDropped: number }> {
  const fromState = await readDiscoveryState(fromPaths.discoveryFile);
  const toState = await readDiscoveryState(toPaths.discoveryFile);
  let associationsRewritten = 0;
  let ignoredMigrated = 0;
  for (const [candidateId, association] of Object.entries(fromState.associations)) {
    if (association.projectId !== fromProjectId) continue;
    if (toState.associations[candidateId] !== undefined || toState.ignored.includes(candidateId)) {
      continue;
    }
    associateCandidate(toState, candidateId, toProjectId, association.decidedAt);
    fromState.associations[candidateId] = {
      projectId: toProjectId,
      decidedAt: association.decidedAt,
    };
    associationsRewritten += 1;
  }
  for (const candidateId of fromState.ignored) {
    if (toState.ignored.includes(candidateId) || toState.associations[candidateId] !== undefined) {
      continue;
    }
    toState.ignored.push(candidateId);
    ignoredMigrated += 1;
  }

  const prunedAt = new Date().toISOString();
  const losses: WithheldLossRecord[] = [];
  const evaluationCount = Object.keys(fromState.evaluations).length;
  for (const [candidateId, evaluation] of Object.entries(fromState.evaluations)) {
    // A legacy evaluation without an identity leaves nothing citable to
    // record; it is dropped without a loss record and without being
    // counted as one.
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

  if (associationsRewritten > 0 || ignoredMigrated > 0) {
    await writeDiscoveryState(toPaths.discoveryFile, toState);
  }
  if (associationsRewritten > 0 || evaluationCount > 0) {
    await writeDiscoveryState(fromPaths.discoveryFile, fromState);
  }
  return { associationsRewritten, ignoredMigrated, withheldDropped: losses.length };
}
