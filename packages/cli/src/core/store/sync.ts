import { dirname, join } from "node:path";
import { mkdir, rename, rm } from "node:fs/promises";
import type { SessionModule, LoadedProject, StoreConflictSide } from "../session-module.ts";
import { GliaError } from "../output/errors.ts";
import { WriterLease, writerLeaseTimeoutMs } from "./lease.ts";
import { git, gitBytes, gitOrThrow } from "./git.ts";
import {
  markerEpoch,
  prepareStoreForWrite,
  readStoreMarkerAtRev,
  STORE_MARKER_FILE,
  deletionMarkerBytes,
  storeMarkerBytes,
  validateStoreMarker,
} from "./marker.ts";
import { COMMIT_IDENTITY, ProjectStore } from "./store.ts";
import { writeFetchState, writeSyncState } from "./sync-state.ts";
import { readRemoteTrackingHead, writeRemoteTrackingHead } from "./remote-tracking.ts";
import {
  compareEvents,
  eventKey,
  eventsBeyond,
  isLedgerPath,
  ledgerWritesOf,
  maxEpoch,
  purgePathsOf,
  purgeUnreachableObjects,
  readDeletionPending,
  readLedgerAtRev,
  reconcileLedgers,
  rewriteHistoryPurging,
  writeDeletionPending,
  type DeletionPendingState,
  type OwnedDeletionEvent,
} from "./deletion.ts";

export { REMOTE_TRACKING_REF } from "./remote-tracking.ts";

const MAX_SYNC_ATTEMPTS = 3;

export type SyncClassification = "up_to_date" | "fast_forward" | "local_ahead" | "diverged";

export interface SyncPreservedItem {
  unit: string;
  /** Machine-local preservation path awaiting explicit disposition. */
  path: string;
}

export interface SyncDeletionReport {
  /** Deletion events received from the remote and applied this run. */
  eventsApplied: number;
  /** Locally pending deletion events propagated to the remote this run. */
  eventsPushed: number;
  epochBefore: number;
  epochAfter: number;
  /** Bystander content preserved before a rewrite was applied. */
  preserved: SyncPreservedItem[];
}

export interface SyncReport {
  remote: string;
  classification: SyncClassification;
  /** The resulting Store head, identical on both sides after the sync. */
  head: string;
  /** Store units this Replica received from the remote. */
  pulled: number;
  /** Store units the remote received from this Replica. */
  pushed: number;
  /** Units changed on both sides that converged to identical content. */
  merged: number;
  /** Units frozen as conflicts during this sync. */
  conflicted: string[];
  attempts: number;
  recoveryCommit: string | null;
  backfillCommit: string | null;
  projectionFresh: boolean;
  /** Deletion propagation activity; null when no deletions were involved. */
  deletion: SyncDeletionReport | null;
}

export interface SyncOptions {
  /** Test seam: runs after local convergence, before each push attempt. */
  beforePush?: (attempt: number) => Promise<void>;
}

/**
 * `glia sync` — the single, explicit, idempotent whole-Store
 * synchronization. It holds the Project writer lease for its whole
 * cycle, network segments included: validate, recover residue, fetch,
 * verify any history rewrite against the Deletion Ledger, classify,
 * fast-forward or merge, push, and rebuild the projection.
 */
export async function runSync(
  project: LoadedProject,
  env: Record<string, string | undefined>,
  modules: readonly SessionModule[],
  options: SyncOptions = {},
): Promise<SyncReport> {
  const remote = project.declaration.store.remote;
  if (!remote) {
    throw new GliaError(
      "NO_STORE_REMOTE",
      "this Project's Store is local_only; declare a remote with `glia store remote set <url>`",
      { nextSteps: ["glia store remote set <url>"] },
    );
  }

  const lease = await WriterLease.acquire(project.paths.writerLockFile, writerLeaseTimeoutMs(env));
  try {
    const store = new ProjectStore(project.paths.storeDir);
    if (!(await store.exists())) {
      await bootstrapStoreFromRemote(project, remote);
    }
    const projectId = project.declaration.projectId;
    const prepared = await prepareStoreForWrite(store, projectId, {
      recoveryDetails: { projectId, replicaId: project.replicaId },
    });

    const storeDir = store.dir;
    const startLocalHead = await store.head();
    const epochBefore = markerEpoch(await readStoreMarkerAtRev(storeDir, startLocalHead, storeDir));
    const pendingState = await readDeletionPending(project.paths.deletionPendingFile);
    const state = initialIntegrateState(pendingState);

    for (let attempt = 1; attempt <= MAX_SYNC_ATTEMPTS; attempt += 1) {
      const remoteHead = await integrateRemoteOnce(project, modules, store, remote, state);
      const head = await store.head();
      if (options.beforePush) await options.beforePush(attempt);
      if (remoteHead !== head) {
        const needsForce = remoteHead !== null && !(await isAncestor(storeDir, remoteHead, head));
        const pushArgs = needsForce
          ? [
              "push",
              `--force-with-lease=refs/heads/main:${remoteHead}`,
              remote,
              "main:refs/heads/main",
            ]
          : ["push", remote, "main:refs/heads/main"];
        const push = await git(pushArgs, storeDir);
        if (push.exitCode !== 0) {
          if (isNonFastForwardRejection(push.stderr)) {
            if (needsForce && !(await remoteAdvancedBeyond(storeDir, remote, remoteHead))) {
              // The remote refuses non-fast-forward pushes outright:
              // propagation is impossible until its configuration allows
              // the sanctioned rewrite. The deletion stays locally
              // applied and propagation-pending.
              throw new GliaError(
                "REWRITE_PUSH_REFUSED",
                `the remote refuses the deletion's history rewrite: ${push.stderr.trim()}; the deletion remains applied locally and propagation-pending — allow non-fast-forward pushes on the remote (receive.denyNonFastForwards, protected branches) and re-run \`glia sync\``,
                { remote, gitMessage: push.stderr.trim(), nextSteps: ["glia sync"] },
              );
            }
            continue; // the remote advanced; re-run the cycle
          }
          throw new GliaError("GIT_FAILED", `git push failed: ${push.stderr.trim()}`, {
            remote,
            exitCode: push.exitCode,
          });
        }
      }

      await writeRemoteTrackingHead(storeDir, remote, head);
      if (pendingState !== null) {
        await writeDeletionPending(project.paths.deletionPendingFile, null);
      }
      await applyDeletionHooks(project, modules, state.appliedEvents);
      const completedAt = new Date().toISOString();
      await writeSyncState(project.paths.syncStateFile, {
        schemaVersion: 1,
        lastFetchAt: completedAt,
        lastSyncAt: completedAt,
        outcome: state.classification,
        head,
      });

      let projectionFresh = true;
      for (const module of modules) {
        if (!module.rebuildProjection) continue;
        try {
          await module.rebuildProjection(project, head);
        } catch {
          // A projection rebuild failure never rolls back a completed
          // synchronization; the next query rebuilds it.
          projectionFresh = false;
        }
      }

      const emptyTree = await emptyTreeOf(storeDir);
      // Independent diffs over two ranges; one round-trip, not two.
      const [pulled, pushed] = await Promise.all([
        countUnits(storeDir, modules, startLocalHead, head, state.conflicted),
        countUnits(storeDir, modules, state.startRemoteHead ?? emptyTree, head, state.conflicted),
      ]);
      const epochAfter = markerEpoch(await readStoreMarkerAtRev(storeDir, head, storeDir));

      if (state.rewriteInvolved) {
        // Payload transiently re-materialized by fetching a
        // not-yet-rewritten remote, and payload this rewrite purged,
        // must be gone before sync reports success.
        await purgeUnreachableObjects(storeDir);
      }

      return {
        remote,
        classification: state.classification,
        head,
        pulled,
        pushed,
        merged: state.mergedCount,
        conflicted: [...state.conflicted].sort(),
        attempts: attempt,
        recoveryCommit: prepared.recoveryCommit,
        backfillCommit: prepared.backfillCommit,
        projectionFresh,
        deletion:
          state.rewriteInvolved || state.appliedEvents.size > 0 || state.pushedEventCount > 0
            ? {
                eventsApplied: state.appliedEvents.size,
                eventsPushed: state.pushedEventCount,
                epochBefore,
                epochAfter,
                preserved: state.preserved,
              }
            : null,
      };
    }

    throw new GliaError(
      "SYNC_RETRY_EXHAUSTED",
      `the remote advanced during every one of ${MAX_SYNC_ATTEMPTS} push attempts; sync is idempotent — re-running it is always safe and always the complete remedy`,
      { remote, attempts: MAX_SYNC_ATTEMPTS },
    );
  } finally {
    lease.release();
  }
}

/**
 * The mutable outcome of inward integration passes: what was applied,
 * merged, frozen, or found pending. `runSync` carries one across its
 * push-retry attempts; `runInboundSync` uses one for its single pass.
 */
interface IntegrateState {
  pendingState: DeletionPendingState | null;
  startRemoteHead: string | null | undefined;
  conflicted: Set<string>;
  mergedCount: number;
  classification: SyncClassification;
  rewriteInvolved: boolean;
  appliedEvents: Map<string, OwnedDeletionEvent>;
  pushedEventCount: number;
  preserved: SyncPreservedItem[];
}

function initialIntegrateState(pendingState: DeletionPendingState | null): IntegrateState {
  return {
    pendingState,
    startRemoteHead: undefined,
    conflicted: new Set<string>(),
    mergedCount: 0,
    classification: "up_to_date",
    rewriteInvolved: pendingState !== null,
    appliedEvents: new Map<string, OwnedDeletionEvent>(),
    pushedEventCount: 0,
    preserved: [],
  };
}

/**
 * One inward pass of the synchronization mechanism: fetch the remote
 * head and integrate it into this Replica's Store — identity validation,
 * rewrite verification by recomputation, fast-forward or module-owned
 * merge with the conflict floor. This is the directional core both verbs
 * compose: `runSync` follows it with the outward push, `runInboundSync`
 * runs it alone. The caller holds the writer lease. Returns the fetched
 * remote head, or null for an empty remote.
 */
async function integrateRemoteOnce(
  project: LoadedProject,
  modules: readonly SessionModule[],
  store: ProjectStore,
  remote: string,
  state: IntegrateState,
): Promise<string | null> {
  const storeDir = store.dir;
  const projectId = project.declaration.projectId;
  const remoteHead = await fetchRemoteHead(storeDir, remote);
  if (state.startRemoteHead === undefined) state.startRemoteHead = remoteHead;

  let localHead = await store.head();
  let renumberLocal = false;
  if (remoteHead === null) {
    state.classification = "local_ahead";
    state.pushedEventCount = (await readLedgerAtRev(storeDir, localHead, modules)).length;
    return null;
  }

  let integrationHead: string = remoteHead;
  validateStoreMarker(await readStoreMarkerAtRev(storeDir, remoteHead, remote), projectId, remote);

  const localEvents = await readLedgerAtRev(storeDir, localHead, modules);
  const remoteEvents = await readLedgerAtRev(storeDir, remoteHead, modules);
  const newRemote = eventsBeyond(remoteEvents, localEvents);
  const newLocal = eventsBeyond(localEvents, remoteEvents);
  state.pushedEventCount = newLocal.length;

  if (newRemote.length === 0 && newLocal.length === 0) {
    await guardAgainstRewrittenRemote(storeDir, remoteHead, remote);
  } else {
    state.rewriteInvolved = true;
    // The concurrent-push loser re-derives its pending deletions
    // with the next epoch; a merge without a shared synchronized
    // history (the first-sync union) keeps equal epochs — they are
    // harmless across disjoint prefixes.
    const everSynced = (await readRemoteTrackingHead(storeDir, remote)) !== null;
    renumberLocal = newRemote.length > 0 && newLocal.length > 0 && everSynced;
    integrationHead = await verifyAndIntegrateRewrite(project, modules, store, {
      remote,
      remoteHead,
      localHead,
      newRemote,
      newLocal,
      pendingBase: state.pendingState?.baseHead ?? null,
      preserved: state.preserved,
    });
    for (const event of newRemote) state.appliedEvents.set(eventKey(event), event);
    localHead = await store.head();
  }

  state.classification = await classify(storeDir, localHead, integrationHead);
  if (state.classification === "fast_forward") {
    await gitOrThrow(["merge", "--ff-only", integrationHead], storeDir);
  } else if (state.classification === "diverged") {
    const outcome = await mergeDiverged(
      project,
      modules,
      store,
      localHead,
      integrationHead,
      renumberLocal,
    );
    state.mergedCount += outcome.merged;
    for (const unit of outcome.conflicted) state.conflicted.add(unit);
  }
  return remoteHead;
}

/** Local consequences of remotely originated deletions, after integration. */
async function applyDeletionHooks(
  project: LoadedProject,
  modules: readonly SessionModule[],
  appliedEvents: Map<string, OwnedDeletionEvent>,
): Promise<void> {
  if (appliedEvents.size === 0) return;
  const byContext = new Map<string, OwnedDeletionEvent[]>();
  for (const event of appliedEvents.values()) {
    const list = byContext.get(event.contextId) ?? [];
    list.push(event);
    byContext.set(event.contextId, list);
  }
  for (const [contextId, events] of byContext) {
    const hook = modules.find((p) => p.id === contextId)?.deletion;
    if (hook) {
      await hook.onDeletionApplied(
        project,
        events.sort(compareEvents).map((e) => e.event),
      );
    }
  }
}

export interface InboundSyncReport {
  remote: string;
  classification: SyncClassification;
  head: string;
  /** Store units this Replica received from the remote. */
  pulled: number;
  merged: number;
  conflicted: string[];
  recoveryCommit: string | null;
  backfillCommit: string | null;
}

/**
 * The inward half of synchronization alone: fetch + integrate, never
 * push — the remote's refs are unchanged by this call.
 * Locally pending deletion propagation stays pending and the machine's
 * sync state is untouched: this is not a synchronization — `glia sync`
 * remains that verb.
 */
export async function runInboundSync(
  project: LoadedProject,
  env: Record<string, string | undefined>,
  modules: readonly SessionModule[],
): Promise<InboundSyncReport> {
  const remote = project.declaration.store.remote;
  if (!remote) {
    throw new GliaError(
      "NO_STORE_REMOTE",
      "this Project's Store is local_only; declare a remote with `glia store remote set <url>`",
      { nextSteps: ["glia store remote set <url>"] },
    );
  }
  const lease = await WriterLease.acquire(project.paths.writerLockFile, writerLeaseTimeoutMs(env));
  try {
    const store = new ProjectStore(project.paths.storeDir);
    if (!(await store.exists())) {
      await bootstrapStoreFromRemote(project, remote);
    }
    const projectId = project.declaration.projectId;
    const prepared = await prepareStoreForWrite(store, projectId, {
      recoveryDetails: { projectId, replicaId: project.replicaId },
    });
    const startLocalHead = await store.head();
    const pendingState = await readDeletionPending(project.paths.deletionPendingFile);
    const state = initialIntegrateState(pendingState);

    const remoteHead = await integrateRemoteOnce(project, modules, store, remote, state);
    const head = await store.head();
    if (remoteHead !== null && !state.rewriteInvolved) {
      // The fetched head is now part of local history; sessioning it as
      // the last synchronized remote state keeps the non-fast-forward
      // guard's baseline accurate. Rewrite integration maintains the
      // tracking ref itself.
      await writeRemoteTrackingHead(store.dir, remote, remoteHead);
    }
    await applyDeletionHooks(project, modules, state.appliedEvents);
    if (state.rewriteInvolved) {
      await purgeUnreachableObjects(store.dir);
    }
    const pulled = await countUnits(store.dir, modules, startLocalHead, head, state.conflicted);
    await writeFetchState(project.paths.syncStateFile, new Date().toISOString());
    return {
      remote,
      classification: state.classification,
      head,
      pulled,
      merged: state.mergedCount,
      conflicted: [...state.conflicted].sort(),
      recoveryCommit: prepared.recoveryCommit,
      backfillCommit: prepared.backfillCommit,
    };
  } finally {
    lease.release();
  }
}

/** First-sync bootstrap for a declared Project on a clean machine. */
async function bootstrapStoreFromRemote(project: LoadedProject, remote: string): Promise<void> {
  const scratch = join(project.home, "tmp", `sync-bootstrap-${process.pid}-${crypto.randomUUID()}`);
  const cloneDir = join(scratch, "store");
  await rm(scratch, { recursive: true, force: true });
  await mkdir(scratch, { recursive: true });
  try {
    await gitOrThrow(["clone", remote, cloneDir], project.home);
    const hasHistory =
      (await git(["rev-parse", "--verify", "--quiet", "HEAD"], cloneDir)).exitCode === 0;
    if (hasHistory) {
      validateStoreMarker(
        await readStoreMarkerAtRev(cloneDir, "HEAD", remote),
        project.declaration.projectId,
        remote,
      );
      await writeRemoteTrackingHead(cloneDir, remote, "HEAD");
    } else {
      await gitOrThrow(["symbolic-ref", "HEAD", "refs/heads/main"], cloneDir);
      await Bun.write(
        join(cloneDir, STORE_MARKER_FILE),
        storeMarkerBytes(project.declaration.projectId),
      );
      await gitOrThrow(["add", "-A"], cloneDir);
      await gitOrThrow(
        [...COMMIT_IDENTITY, "commit", "--no-gpg-sign", "-m", "glia: initialize store"],
        cloneDir,
      );
    }
    await mkdir(dirname(project.paths.storeDir), { recursive: true });
    await rename(cloneDir, project.paths.storeDir);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

interface RewriteContext {
  remote: string;
  remoteHead: string;
  localHead: string;
  newRemote: OwnedDeletionEvent[];
  newLocal: OwnedDeletionEvent[];
  pendingBase: string | null;
  preserved: SyncPreservedItem[];
}

/**
 * The non-fast-forward guard's deletion extension: verification is
 * recomputation. The Replica independently recomputes the sanctioned
 * rewrite from its own last synchronized state plus the new ledger
 * events, and hash equality of histories — ancestry of the recomputed
 * image — proves the rewrite removed exactly the tombstoned content and
 * nothing else. Refusals happen with zero local mutation; only after
 * verification does the Replica apply the same purge to everything under
 * its control. Returns the remote head to integrate with (the fetched
 * head, filtered by this Replica's own pending events when it has any).
 */
async function verifyAndIntegrateRewrite(
  project: LoadedProject,
  modules: readonly SessionModule[],
  store: ProjectStore,
  ctx: RewriteContext,
): Promise<string> {
  const storeDir = store.dir;
  const lastSynced = await readRemoteTrackingHead(storeDir, ctx.remote);
  const related =
    lastSynced === null ||
    (await isAncestor(storeDir, lastSynced, ctx.remoteHead)) ||
    (await isAncestor(storeDir, ctx.remoteHead, lastSynced));

  const localPurge = purgePathsOf(modules, ctx.newLocal);
  const remotePurge = purgePathsOf(modules, ctx.newRemote);

  // The remote head filtered by this Replica's own pending deletions —
  // what the remote will converge to once they propagate.
  const remoteImage =
    ctx.newLocal.length > 0
      ? (await rewriteHistoryPurging(storeDir, ctx.remoteHead, localPurge)).newHead
      : ctx.remoteHead;

  if (!related && lastSynced !== null) {
    if (ctx.newRemote.length > 0) {
      // Recompute the image of the last synchronized prefix under the
      // new events and require it in the presented history's ancestry.
      const prefixImage = (await rewriteHistoryPurging(storeDir, lastSynced, remotePurge)).newHead;
      if (prefixImage !== remoteImage && !(await isAncestor(storeDir, prefixImage, remoteImage))) {
        throw new GliaError(
          "REMOTE_REWRITTEN",
          `the remote's rewritten history does not match recomputation of its Deletion Ledger events: recomputed image ${prefixImage.slice(0, 12)} is not an ancestor of the presented head ${ctx.remoteHead.slice(0, 12)}; nothing was changed locally`,
          {
            remote: ctx.remote,
            remoteHead: ctx.remoteHead,
            lastSynced,
            reason: "recomputation_mismatch",
          },
        );
      }
    } else {
      // The remote was rewritten while presenting no events beyond ours.
      // Our own pending deletion explains it only if the remote still
      // extends the pre-rewrite base persisted at delete time.
      const extendsBase =
        ctx.pendingBase !== null &&
        (ctx.pendingBase === ctx.remoteHead ||
          (await isAncestor(storeDir, ctx.pendingBase, ctx.remoteHead)));
      if (!extendsBase) {
        throw new GliaError(
          "REMOTE_REWRITTEN",
          `the remote's history was rewritten: its head ${ctx.remoteHead.slice(0, 12)} is unrelated to the last synchronized state ${lastSynced.slice(0, 12)} and its Deletion Ledger presents no events beyond this Replica's; nothing was changed locally`,
          {
            remote: ctx.remote,
            remoteHead: ctx.remoteHead,
            lastSynced,
            reason: "unexplained_rewrite",
          },
        );
      }
    }
  }

  if (ctx.newRemote.length === 0) return remoteImage;

  // Verified. Capture and complete: unsynchronized local changes to a
  // deleted Session cannot be re-derived, so they are preserved outside
  // the Store — export-shaped — before the rewrite is applied. Each run
  // preserves into its own layout and never overwrites earlier content.
  const baseline = lastSynced;
  let preservationRun: string | null = null;
  for (const owned of ctx.newRemote) {
    const hook = modules.find((p) => p.id === owned.contextId)?.deletion;
    if (!hook) continue;
    let changedUnit: string | null = null;
    for (const unit of hook.purgePathsFor(owned.event)) {
      const atLocal = await git(["rev-parse", `${ctx.localHead}:${unit}`], storeDir);
      if (atLocal.exitCode !== 0) continue; // nothing of this unit here
      const atBase =
        baseline === null ? null : await git(["rev-parse", `${baseline}:${unit}`], storeDir);
      const changedLocally =
        atBase === null || atBase.exitCode !== 0 || atBase.stdout.trim() !== atLocal.stdout.trim();
      if (!changedLocally) continue;
      changedUnit ??= unit;
    }
    if (changedUnit !== null) {
      if (preservationRun === null) {
        preservationRun = join(
          project.paths.preservedDir,
          `${Date.now().toString(36)}-${process.pid}`,
        );
      }
      const dest = join(preservationRun, owned.event.unitId);
      await mkdir(dest, { recursive: true });
      await hook.preserveUnit(project, ctx.localHead, owned.event, dest);
      ctx.preserved.push({ unit: changedUnit, path: dest });
    }
  }

  // Apply the purge to this Replica's own history and adopt it by one
  // atomic reference switch; bystander commits re-derive mechanically.
  const rewrite = await rewriteHistoryPurging(storeDir, ctx.localHead, remotePurge);
  if (rewrite.newHead !== ctx.localHead) {
    await gitOrThrow(["update-ref", "refs/heads/main", rewrite.newHead, ctx.localHead], storeDir);
    await gitOrThrow(["reset", "--hard", "--quiet"], storeDir);
  }
  if (lastSynced !== null) {
    const trackingImage =
      rewrite.map.get(lastSynced) ??
      (await rewriteHistoryPurging(storeDir, lastSynced, remotePurge)).newHead;
    await writeRemoteTrackingHead(storeDir, ctx.remote, trackingImage);
  }
  return remoteImage;
}

/**
 * Confirms reachability, then fetches the remote head into FETCH_HEAD
 * without touching any local ref — the non-fast-forward guard must run
 * with zero local mutation. Returns null for an empty remote.
 */
async function fetchRemoteHead(storeDir: string, remote: string): Promise<string | null> {
  const probe = await git(["ls-remote", remote, "refs/heads/main"], storeDir);
  if (probe.exitCode !== 0) {
    throw new GliaError("GIT_FAILED", `cannot reach store remote: ${probe.stderr.trim()}`, {
      remote,
    });
  }
  if (probe.stdout.trim().length === 0) return null;
  await gitOrThrow(["fetch", remote, "refs/heads/main"], storeDir);
  return (await gitOrThrow(["rev-parse", "FETCH_HEAD"], storeDir)).trim();
}

/** True when the remote's head moved past the state this cycle integrated. */
async function remoteAdvancedBeyond(
  storeDir: string,
  remote: string,
  integrated: string | null,
): Promise<boolean> {
  const probe = await git(["ls-remote", remote, "refs/heads/main"], storeDir);
  if (probe.exitCode !== 0) return false;
  const head = probe.stdout.trim().split("\t")[0] ?? "";
  if (head.length === 0) return integrated !== null;
  return head !== integrated;
}

/**
 * A remote head that is neither an ancestor nor a descendant of the last
 * synchronized state means someone rewrote the remote history. Refused
 * with zero local mutation; a rewrite presenting Deletion Ledger events
 * takes the verification path instead and never reaches this refusal.
 */
async function guardAgainstRewrittenRemote(
  storeDir: string,
  remoteHead: string,
  remote: string,
): Promise<void> {
  const last = await readRemoteTrackingHead(storeDir, remote);
  if (last === null) return; // first sync: identity validation is the guard
  if (
    !(await isAncestor(storeDir, last, remoteHead)) &&
    !(await isAncestor(storeDir, remoteHead, last))
  ) {
    throw new GliaError(
      "REMOTE_REWRITTEN",
      `the remote's history was rewritten: its head ${remoteHead.slice(0, 12)} is unrelated to the last synchronized state ${last.slice(0, 12)}; nothing was changed locally`,
      { remote, remoteHead, lastSynced: last, reason: "unexplained_rewrite" },
    );
  }
}

async function classify(
  storeDir: string,
  localHead: string,
  remoteHead: string,
): Promise<SyncClassification> {
  if (remoteHead === localHead) return "up_to_date";
  if (await isAncestor(storeDir, remoteHead, localHead)) return "local_ahead";
  if (await isAncestor(storeDir, localHead, remoteHead)) return "fast_forward";
  // Histories with no common ancestor classify as diverged once identity
  // validation passes: every Replica represents the same logical Store.
  return "diverged";
}

async function isAncestor(storeDir: string, maybeAncestor: string, of: string): Promise<boolean> {
  const result = await git(["merge-base", "--is-ancestor", maybeAncestor, of], storeDir);
  if (result.exitCode === 0) return true;
  if (result.exitCode === 1) return false;
  throw new GliaError("GIT_FAILED", `git merge-base failed: ${result.stderr.trim()}`);
}

function isNonFastForwardRejection(stderr: string): boolean {
  return (
    stderr.includes("[rejected]") ||
    stderr.includes("non-fast-forward") ||
    stderr.includes("fetch first") ||
    stderr.includes("failed to update ref") ||
    stderr.includes("stale info")
  );
}

async function emptyTreeOf(storeDir: string): Promise<string> {
  return (await gitOrThrow(["hash-object", "-t", "tree", "/dev/null"], storeDir)).trim();
}

interface ChangedPaths {
  units: Set<string>;
  unclaimed: string[];
}

function unitFor(modules: readonly SessionModule[], path: string): string | null {
  for (const module of modules) {
    const unit = module.storeUnitFor?.(path);
    if (unit !== null && unit !== undefined) return unit;
  }
  return null;
}

/**
 * The module that owns a diverged Store unit: it must claim the unit and
 * offer a way to reconcile it — a deterministic merge, or a conflict
 * capture. Undefined when no module does, which is a typed error.
 */
function mergeOwnerOf(modules: readonly SessionModule[], unit: string): SessionModule | undefined {
  return modules.find(
    (p) =>
      p.storeUnitFor?.(unit) === unit &&
      ((p.mergeStoreUnitFor?.(unit) === true && p.mergeStoreUnit) || p.onStoreUnitConflict),
  );
}

async function changedPaths(
  storeDir: string,
  modules: readonly SessionModule[],
  from: string,
  to: string,
): Promise<ChangedPaths> {
  const out = await gitOrThrow(["diff", "--name-only", "-z", from, to], storeDir);
  const units = new Set<string>();
  const unclaimed: string[] = [];
  for (const path of out.split("\0")) {
    if (path.length === 0) continue;
    const unit = unitFor(modules, path);
    if (unit !== null) units.add(unit);
    else unclaimed.push(path);
  }
  return { units, unclaimed };
}

async function countUnits(
  storeDir: string,
  modules: readonly SessionModule[],
  from: string,
  to: string,
  excluded: Set<string>,
): Promise<number> {
  if (from === to) return 0;
  const changed = await changedPaths(storeDir, modules, from, to);
  let n = 0;
  for (const unit of changed.units) if (!excluded.has(unit)) n += 1;
  return n;
}

interface MergeOutcome {
  merged: number;
  conflicted: string[];
}

/**
 * Diverged histories merge at the Git tree level. The divergence unit is
 * the module-owned directory, never the Git path: Git's file-level
 * auto-merge never decides content inside a unit, so a stitched-together
 * state neither side ever held can never come into existence. Git
 * conflict markers never reach any stored file — every divergent unit is
 * rewritten whole by its owning module's deterministic merge or conflict
 * hook, and the Deletion Ledger with the epoch marker is reconciled
 * deterministically by core.
 */
async function mergeDiverged(
  project: LoadedProject,
  modules: readonly SessionModule[],
  store: ProjectStore,
  localHead: string,
  remoteHead: string,
  renumberLocal: boolean,
): Promise<MergeOutcome> {
  const storeDir = store.dir;
  const baseProbe = await git(["merge-base", localHead, remoteHead], storeDir);
  const base = baseProbe.exitCode === 0 ? baseProbe.stdout.trim() : await emptyTreeOf(storeDir);

  const [local, remote] = await Promise.all([
    changedPaths(storeDir, modules, base, localHead),
    changedPaths(storeDir, modules, base, remoteHead),
  ]);

  // A divergence no module claims is a typed error before any mutation.
  // The Store marker and the Deletion Ledger are core-claimed: they merge
  // by deterministic reconciliation below, never by file-level auto-merge.
  const coreClaimed = (path: string): boolean =>
    path === STORE_MARKER_FILE || isLedgerPath(modules, path);
  const unclaimedRemote = new Set(remote.unclaimed);
  for (const path of local.unclaimed) {
    if (coreClaimed(path)) continue;
    if (!unclaimedRemote.has(path)) continue;
    if (!(await sameTree(storeDir, localHead, remoteHead, path))) {
      throw new GliaError(
        "INTERNAL",
        `store path ${path} diverged but the Session module does not claim it; the synchronization did not complete`,
        { path },
      );
    }
  }

  const divergent: string[] = [];
  const deterministicallyMerged: string[] = [];
  let merged = 0;
  for (const unit of local.units) {
    if (!remote.units.has(unit)) continue;
    if (await sameTree(storeDir, localHead, remoteHead, unit)) merged += 1;
    else divergent.push(unit);
  }
  // Resolved once per unit, before the merge starts: an unowned unit is a
  // typed error before any mutation, and the merge loop below reuses the
  // answer rather than rescanning the modules for it.
  const owners = new Map<string, SessionModule>();
  for (const unit of divergent) {
    const owner = mergeOwnerOf(modules, unit);
    if (!owner) {
      throw new GliaError(
        "INTERNAL",
        `store unit ${unit} diverged but the Session module provides no merge hook; the synchronization did not complete`,
        { unit },
      );
    }
    owners.set(unit, owner);
    if (owner.mergeStoreUnitFor?.(unit) === true && owner.mergeStoreUnit) {
      deterministicallyMerged.push(unit);
    }
  }

  const mergeRun = await git(
    [
      ...COMMIT_IDENTITY,
      "merge",
      "--no-commit",
      "--no-ff",
      "--allow-unrelated-histories",
      remoteHead,
    ],
    storeDir,
  );
  const mergeHead = await Bun.file(join(storeDir, ".git", "MERGE_HEAD")).exists();
  if (!mergeHead) {
    throw new GliaError("GIT_FAILED", `git merge failed: ${mergeRun.stderr.trim()}`, {
      localHead,
      remoteHead,
    });
  }

  try {
    for (const unit of divergent.sort()) {
      const owner = owners.get(unit)!;
      // The unit is rewritten whole: whatever Git staged for it is discarded.
      await rm(join(storeDir, unit), { recursive: true, force: true });
      const sides = {
        unitDir: unit,
        local: conflictSide(storeDir, localHead, unit),
        remote: conflictSide(storeDir, remoteHead, unit),
      };
      if (owner.mergeStoreUnitFor?.(unit) === true && owner.mergeStoreUnit) {
        await owner.mergeStoreUnit(project, sides);
        merged += 1;
      } else {
        await owner.onStoreUnitConflict!(project, sides);
      }
    }

    // Reconcile the Deletion Ledger and the epoch: the union of both
    // sides under each namespace's merge rule, written deterministically,
    // with the merged epoch the larger of the two.
    const localEvents = await readLedgerAtRev(storeDir, localHead, modules);
    const remoteEvents = await readLedgerAtRev(storeDir, remoteHead, modules);
    if (localEvents.length > 0 || remoteEvents.length > 0) {
      const reconciled = reconcileLedgers(modules, localEvents, remoteEvents, renumberLocal);
      for (const write of ledgerWritesOf(reconciled.events)) {
        const hook = modules.find((p) => p.id === write.contextId)?.deletion;
        if (!hook) continue;
        const file = hook.serializeLedgerFile(write.events);
        const dest = join(storeDir, file.path);
        await mkdir(dirname(dest), { recursive: true });
        await Bun.write(dest, file.content);
      }
      const localEpoch = markerEpoch(await readStoreMarkerAtRev(storeDir, localHead, storeDir));
      const remoteEpoch = markerEpoch(await readStoreMarkerAtRev(storeDir, remoteHead, storeDir));
      const epoch = Math.max(localEpoch, remoteEpoch, maxEpoch(reconciled.events));
      await Bun.write(
        join(storeDir, STORE_MARKER_FILE),
        deletionMarkerBytes(project.declaration.projectId, epoch),
      );
    }

    await gitOrThrow(["add", "-A"], storeDir);
    const unmerged = await gitOrThrow(["ls-files", "-u"], storeDir);
    if (unmerged.trim().length > 0) {
      throw new GliaError(
        "INTERNAL",
        "the merge left unresolved paths outside every module's conflict handling; the synchronization did not complete",
        { unmerged: unmerged.trim().split("\n").slice(0, 20) },
      );
    }
    const trailer = JSON.stringify({
      op: "store.sync.merge",
      projectId: project.declaration.projectId,
      merged: deterministicallyMerged.sort(),
      conflicted: divergent.filter((unit) => !deterministicallyMerged.includes(unit)).sort(),
    });
    await gitOrThrow(
      [
        ...COMMIT_IDENTITY,
        "commit",
        "--no-gpg-sign",
        "-m",
        `glia: merge remote store history\n\nglia-op: ${trailer}`,
      ],
      storeDir,
    );
  } catch (err) {
    await git(["merge", "--abort"], storeDir);
    throw err;
  }

  return {
    merged,
    conflicted: divergent.filter((unit) => !deterministicallyMerged.includes(unit)).sort(),
  };
}

async function sameTree(
  storeDir: string,
  localHead: string,
  remoteHead: string,
  unit: string,
): Promise<boolean> {
  const a = await git(["rev-parse", `${localHead}:${unit}`], storeDir);
  const b = await git(["rev-parse", `${remoteHead}:${unit}`], storeDir);
  const idA = a.exitCode === 0 ? a.stdout.trim() : `absent:${localHead}`;
  const idB = b.exitCode === 0 ? b.stdout.trim() : `absent:${remoteHead}`;
  return idA === idB;
}

/** Materializes one side's complete unit content out of the Store history. */
function conflictSide(storeDir: string, head: string, unit: string): StoreConflictSide {
  return {
    head,
    async materialize(destDir: string): Promise<void> {
      await mkdir(destDir, { recursive: true });
      const listing = await gitOrThrow(
        ["ls-tree", "-r", "--name-only", "-z", head, "--", unit],
        storeDir,
      );
      for (const path of listing.split("\0")) {
        if (path.length === 0) continue;
        const bytes = await gitBytes(["show", `${head}:${path}`], storeDir);
        const dest = join(destDir, path.slice(unit.length + 1));
        await mkdir(dirname(dest), { recursive: true });
        await Bun.write(dest, bytes);
      }
    },
  };
}
