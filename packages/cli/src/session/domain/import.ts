import { join } from "node:path";
import { rm, stat } from "node:fs/promises";
import type { LoadedProject } from "../../core/session-module.ts";
import type { HarnessId } from "../../core/harnesses/ids.ts";
import { GliaError } from "../../core/output/errors.ts";
import { WriterLease, writerLeaseTimeoutMs } from "../../core/store/lease.ts";
import { prepareStoreForWrite } from "../../core/store/marker.ts";
import { ProjectStore } from "../../core/store/store.ts";
import { BindingIndex } from "../../core/project/bindings.ts";
import { isSessionConflicted } from "./conflict.ts";
import { isTombstoned, ledgerEventsFor } from "./deletion.ts";
import { adapterFor } from "../adapters/index.ts";
import { sourceCaptureStatus, stagingMatchesCapture } from "../adapters/capture.ts";
import type { CapturedBundle, SessionCandidate } from "../adapters/types.ts";
import { bundleDigest, manifestOf } from "../storage/bundle.ts";
import {
  readSessionMeta,
  SESSION_META_SCHEMA_VERSION,
  writeAcceptedRevision,
  type SessionMeta,
} from "../storage/store-layout.ts";
import { buildAndPublishLocked } from "../projection/publish.ts";
import { candidateSummary, discoverCandidates, type DiscoveryResult } from "./discover.ts";
import type { ClassifiedCandidate } from "./classify.ts";
import {
  associateCandidate,
  readDiscoveryState,
  writeDiscoveryState,
  type DiscoveryState,
} from "./discovery-state.ts";
import {
  addStoredIdentities,
  candidateIdentities,
  familyHintOf,
  readStoredIdentities,
  type CandidateIdentities,
  type FamilyHint,
  type PrecapturedCandidate,
  type StoredIdentityIndex,
} from "./family-hint.ts";
import {
  RULESET_VERSION,
  detectSecrets,
  withholdsAcceptance,
  type DetectionResult,
  type PersistedEvaluation,
} from "./secret-detection.ts";
import { appendWithheldLosses, type WithheldLossRecord } from "./withheld-loss.ts";

export interface ImportOptions {
  harness: HarnessId | null;
  dryRun: boolean;
  /** When set (session accept and interactive import follow-ups), only
   *  these candidates are considered for acceptance. */
  onlyCandidateIds: string[] | null;
  /**
   * Accept flagged bytes with a persisted override instead of withholding
   * them. Set only where the acceptance is itself the explicit decision
   * (`session accept`, the interactive flagged prompt) — a restricted run
   * that merely re-imports newly associated Candidates keeps the gate.
   */
  overrideFlagged?: boolean;
  /**
   * Accept path only, after the tombstone-override confirmation: re-admit
   * a tombstoned Source Identity as a fresh Session with a persisted override.
   */
  acceptTombstoned?: boolean;
  /**
   * Bundles the consent-time family preview already captured, keyed by
   * Candidate ID. Adopted instead of a fresh capture so preview + accept
   * cost one capture and one normalization per Candidate, not two.
   * Sources are still revalidated under the writer lease, and the caller
   * keeps ownership of the preview staging's lifetime.
   */
  precaptured?: Map<string, PrecapturedCandidate>;
}

export interface AcceptedChange {
  sessionId: string;
  harnessId: HarnessId;
  sourceSessionId: string;
  revision: string;
  /** Rule IDs of the persisted override when flagged bytes were accepted explicitly. */
  flaggedRules: string[];
  /** Shared Event Identity overlap with stored Sessions, when any exists. */
  familyHint: FamilyHint | null;
}

export interface ImportReport {
  dryRun: boolean;
  accepted: AcceptedChange[];
  unchanged: number;
  outOfScope: number;
  ignored: number;
  pending: Record<string, unknown>[];
  /** Candidates withheld by secret detection: suspected secrets, not accepted. */
  flagged: Record<string, unknown>[];
  /** Advisory gate status; dry-run never evaluates (it captures nothing). */
  secretDetection: { enabled: boolean; rulesetVersion: number; evaluated: boolean };
  /** Candidates skipped because their Session is frozen in a Session Conflict. */
  conflicted: Record<string, unknown>[];
  /** Tombstoned identities skipped: never accepted automatically again. */
  tombstoned: Record<string, unknown>[];
  wouldAccept: Record<string, unknown>[];
  unavailableHarnesses: { harnessId: HarnessId; reason: string | null }[];
  adapterFailures: { harnessId: HarnessId; message: string }[];
  sourceErrors: { candidateId: string; message: string }[];
  /** Withheld evaluations pruned after their Harness source disappeared. */
  prunedWithheld: WithheldLossRecord[];
  /** Head of the recovery commit for crashed-operation residue, when one was needed. */
  recoveryCommit: string | null;
  storeCommit: string | null;
  projectionFresh: boolean;
}

interface StagedCandidate {
  classified: ClassifiedCandidate;
  stagingDir: string;
  captured: CapturedBundle;
  digest: string;
  /** Accept path only: the evaluation of the bytes being accepted. */
  detection: DetectionResult | null;
  /** Accept path only: the deletion event being explicitly overridden. */
  tombstone: { deletedAt: string; deletedBy: string; epoch: number } | null;
  /** This Candidate's own identity keys; the hint is intersected from these. */
  familyIdentities: CandidateIdentities;
}

interface EvaluationCapture {
  classified: ClassifiedCandidate;
  stagingDir: string;
  captured: CapturedBundle;
}

type CandidateProjectOwnership = "owned" | "other" | "unresolved";

/**
 * Import sequence: discover and classify, capture into machine-local
 * staging, then under the writer lease revalidate, accept, commit the
 * Store once, and rebuild + atomically publish the projection.
 */
export async function runImport(
  project: LoadedProject,
  env: Record<string, string | undefined>,
  options: ImportOptions,
): Promise<ImportReport> {
  // Evaluation updates are committed with compare-and-swap semantics against
  // this snapshot. A concurrent explicit decision therefore wins over an
  // older hook capture instead of being resurrected by its final write.
  const discoveryBaseline = await readDiscoveryState(project.paths.discoveryFile);
  const discovery = await discoverCandidates(project, env, options.harness);
  const report = emptyReport(discovery, options.dryRun);
  const detectionEnabled = project.declaration.secretDetection.enabled !== false;
  report.secretDetection = {
    enabled: detectionEnabled,
    rulesetVersion: RULESET_VERSION,
    evaluated: detectionEnabled && !options.dryRun,
  };

  const toConsider: ClassifiedCandidate[] = [];
  for (const classified of discovery.candidates) {
    if (
      options.onlyCandidateIds !== null &&
      !options.onlyCandidateIds.includes(classified.candidate.candidateId)
    ) {
      continue;
    }
    switch (classified.classification.kind) {
      case "associated":
        // A conflicted Session's Candidate is skipped and reported: it
        // blocks nothing and fails nothing — the source Session stays in
        // the Harness, and the next import after resolution accepts the
        // newest bytes.
        if (await isSessionConflicted(project.paths.storeDir, classified.candidate.candidateId)) {
          report.conflicted.push(candidateSummary(classified.candidate));
          break;
        }
        toConsider.push(classified);
        break;
      case "out_of_scope":
        report.outOfScope += 1;
        break;
      case "ignored":
        report.ignored += 1;
        break;
      case "pending":
        report.pending.push(candidateSummary(classified.candidate));
        break;
      case "tombstoned":
        // Blocked from automatic acceptance, skipped without failing;
        // only the confirmed `session accept` override path proceeds.
        if (options.onlyCandidateIds !== null && options.acceptTombstoned === true) {
          toConsider.push(classified);
        } else {
          report.tombstoned.push({
            ...candidateSummary(classified.candidate),
            deletedAt: classified.classification.deletedAt,
            deletedBy: classified.classification.deletedBy,
            epoch: classified.classification.epoch,
          });
        }
        break;
    }
  }

  if (options.dryRun) {
    report.wouldAccept = toConsider.map((c) => candidateSummary(c.candidate));
    return report;
  }

  // Consent-time Fork Family hints derive from the stored Sessions'
  // identity keys in the published projection; a dry run never reaches
  // here and `session candidates` never captures, so both stay silent.
  const storedIdentities: StoredIdentityIndex =
    toConsider.length > 0
      ? await readStoredIdentities(project)
      : { sessions: new Map(), holders: new Map() };

  // 1. Capture associated Candidates into machine-local staging.
  const runId = `${Date.now().toString(36)}-${process.pid}`;
  const stagingRunDir = join(project.paths.stagingRoot, runId);
  const staged: StagedCandidate[] = [];
  // Evaluations outlive transient staging: flagged Candidates persist
  // theirs into machine-local discovery state; a re-evaluated or
  // accepted Candidate replaces or clears the stale entry (null).
  const evalUpdates = new Map<string, PersistedEvaluation | null>();
  const evaluationCaptures = new Map<string, EvaluationCapture>();
  const clearDigests = new Map<string, string>();
  const clearEvaluation = (candidateId: string, digest: string): void => {
    evalUpdates.set(candidateId, null);
    clearDigests.set(candidateId, digest);
  };
  let storeLeaseBusy = false;
  let evaluationCommitHandled = false;
  try {
    for (const classified of toConsider) {
      const { candidate } = classified;
      try {
        // A preview capture from the same consent flow is adopted as-is;
        // the lease-time source revalidation below still guards staleness.
        const pre = options.precaptured?.get(candidate.candidateId);
        const stagingDir = pre?.stagingDir ?? join(stagingRunDir, candidate.candidateId);
        const captured =
          pre?.captured ??
          (await adapterFor(candidate.identity.harnessId).capture(candidate, {
            dir: stagingDir,
          }));
        const digest = bundleDigest(manifestOf(captured));
        const existing = await readSessionMeta(project.paths.storeDir, candidate.candidateId);
        const matchesStoredRevision = existing?.currentRevision.digest === digest;
        const familyIdentities =
          pre?.familyIdentities ?? (await candidateIdentities(candidate, stagingDir, captured));
        let detection: DetectionResult | null = null;
        // A byte-identical Store revision still enters the lease-time source
        // gate below. Declaring it unchanged here would miss an append or a
        // late subagent created after capture. Do not re-gate bytes that are
        // already accepted unless that validation proves they changed and
        // recaptures them under the lease.
        if (detectionEnabled && !matchesStoredRevision) {
          detection = await detectSecrets(stagingDir, captured);
          if (withholdsAcceptance(detection)) {
            if (options.overrideFlagged !== true) {
              // Withheld, not failed: it blocks nothing and produces no
              // INPUT_REQUIRED; only an explicit override decision proceeds.
              evalUpdates.set(candidate.candidateId, evaluationOf(candidate, detection, digest));
              evaluationCaptures.set(candidate.candidateId, {
                classified,
                stagingDir,
                captured,
              });
              const hint = familyHintOf(candidate.candidateId, familyIdentities, storedIdentities);
              report.flagged.push(flaggedSummary(candidate, detection, hint));
              continue;
            }
          } else {
            detection = null;
          }
        }
        const tombstone =
          classified.classification.kind === "tombstoned"
            ? {
                deletedAt: classified.classification.deletedAt,
                deletedBy: classified.classification.deletedBy,
                epoch: classified.classification.epoch,
              }
            : null;
        staged.push({
          classified,
          stagingDir,
          captured,
          digest,
          detection,
          tombstone,
          familyIdentities,
        });
      } catch (err) {
        report.sourceErrors.push({
          candidateId: candidate.candidateId,
          message: err instanceof GliaError ? err.message : String(err),
        });
      }
    }

    const store = new ProjectStore(project.paths.storeDir);
    if (staged.length === 0) {
      report.storeCommit = (await store.exists()) ? await store.head() : null;
      return report;
    }

    // 2. Acquire the Project writer lease.
    let lease: WriterLease;
    let bindingsLease: WriterLease | null = null;
    try {
      lease = await WriterLease.acquire(project.paths.writerLockFile, writerLeaseTimeoutMs(env));
    } catch (error) {
      if (error instanceof GliaError && error.code === "PROJECT_BUSY") storeLeaseBusy = true;
      throw error;
    }
    try {
      try {
        bindingsLease = await WriterLease.acquire(
          project.paths.bindingsLockFile,
          writerLeaseTimeoutMs(env),
        );
      } catch (error) {
        // This acquisition already consumed the configured timeout. Do not
        // enter the evaluation fallback and wait for the same global lease a
        // second time; a later automation run will re-evaluate the source.
        evaluationCommitHandled = true;
        throw error;
      }
      // Residue of a crashed operation is committed on its own first, so
      // this operation's commit never silently absorbs it; the store.json
      // marker backfill runs here too, as its own commit.
      const prepared = await prepareStoreForWrite(store, project.declaration.projectId, {
        recoveryDetails: {
          projectId: project.declaration.projectId,
          replicaId: project.replicaId,
        },
      });
      report.recoveryCommit = prepared.recoveryCommit;
      // Explicit decisions use this same writer lease. Once acquired, this
      // snapshot cannot be superseded by a well-behaved ignore/association
      // command before the Store write below.
      const decisionState = await readDiscoveryState(project.paths.discoveryFile);
      let restoredTombstoneAssociation = false;

      // 3.–4. Revalidate sources, accept Source Bundles, commit the Store once.
      for (const item of staged) {
        let candidate = item.classified.candidate;
        if (decisionState.ignored.includes(candidate.candidateId)) {
          report.ignored += 1;
          continue;
        }
        // A sync inside the capture window may have frozen this Session.
        if (await isSessionConflicted(project.paths.storeDir, candidate.candidateId)) {
          report.conflicted.push(candidateSummary(candidate));
          continue;
        }
        let familyHint: FamilyHint | null = null;
        try {
          // Discovery is a pre-lease snapshot. Refresh both the complete
          // adapter allowlist (new/removed subagent artifacts included) and
          // Binding ownership before accepting any captured bytes.
          const liveCandidate = await rediscoverCandidate(candidate, env);
          if (liveCandidate === null) {
            throw new GliaError(
              "SOURCE_INCOMPLETE",
              `candidate source disappeared before acceptance: ${candidate.candidateId}`,
            );
          }
          candidate = liveCandidate;
          item.classified = { ...item.classified, candidate };
          let confirmedTombstoneOverride =
            options.acceptTombstoned === true &&
            item.classified.classification.kind === "tombstoned";
          const tombstonedNow = await isTombstoned(project.paths.storeDir, candidate.candidateId);
          if (tombstonedNow) {
            const events = await ledgerEventsFor(project.paths.storeDir, candidate.candidateId);
            const last = events.at(-1)!;
            const consent = item.tombstone;
            if (
              !confirmedTombstoneOverride ||
              consent === null ||
              consent.epoch !== last.epoch ||
              consent.deletedAt !== last.deletedAt ||
              consent.deletedBy !== last.replicaId
            ) {
              // Consent is for one objective deletion event. A newer event
              // that landed while this import waited needs its own explicit
              // confirmation; never silently session an override for it with
              // stale epoch metadata.
              report.tombstoned.push({
                ...candidateSummary(candidate),
                deletedAt: last.deletedAt,
                deletedBy: last.replicaId,
                epoch: last.epoch,
              });
              continue;
            }
          } else if (confirmedTombstoneOverride) {
            // A concurrent explicit re-admission already resolved the event
            // this command confirmed. Continue only as an ordinary owned
            // Revision and never overwrite its provenance with stale consent.
            item.tombstone = null;
            confirmedTombstoneOverride = false;
          }
          if (
            !confirmedTombstoneOverride &&
            (await candidateProjectOwnership(project, decisionState, candidate)) !== "owned"
          ) {
            report.outOfScope += 1;
            continue;
          }

          let recaptured = false;
          let captureStatus = await sourceCaptureStatus(candidate, item.captured);
          if (
            captureStatus === "current" &&
            !(await stagingMatchesCapture(item.stagingDir, item.captured))
          ) {
            captureStatus = "changed";
          }
          if (captureStatus === "missing") {
            throw new GliaError(
              "SOURCE_INCOMPLETE",
              `required candidate evidence disappeared before acceptance: ${candidate.candidateId}`,
            );
          }
          if (captureStatus === "changed") {
            const adapter = adapterFor(candidate.identity.harnessId);
            await rm(item.stagingDir, { recursive: true, force: true });
            item.captured = await adapter.capture(candidate, { dir: item.stagingDir });
            item.digest = bundleDigest(manifestOf(item.captured));
            recaptured = true;
            // The recaptured bytes are the bytes that may be accepted, so
            // identity keys and secret detection both recompute below.
            item.familyIdentities = await candidateIdentities(
              candidate,
              item.stagingDir,
              item.captured,
            );

            // Capture and Harness writes are not mutually locked. Refresh
            // once more after recapture so a newly-created allowlisted file
            // cannot be omitted from the accepted Revision.
            const verifiedCandidate = await rediscoverCandidate(candidate, env);
            if (
              verifiedCandidate === null ||
              (await sourceCaptureStatus(verifiedCandidate, item.captured)) !== "current"
            ) {
              throw new GliaError(
                "SOURCE_INCOMPLETE",
                `candidate changed while being captured: ${candidate.candidateId}`,
              );
            }
            candidate = verifiedCandidate;
            item.classified = { ...item.classified, candidate };
          }

          // Another writer may have accepted these bytes after the
          // pre-lease snapshot. Re-read under the lease so a byte-identical
          // import remains a no-op even across that capture window. The live
          // source gate must still pass after the digest comparison: otherwise
          // an append during capture could be mislabeled unchanged forever.
          const current = await readSessionMeta(project.paths.storeDir, candidate.candidateId);
          if (current?.currentRevision.digest === item.digest) {
            candidate = await revalidateAcceptedCapture(candidate, item, env);
            item.classified = { ...item.classified, candidate };
            report.unchanged += 1;
            clearEvaluation(candidate.candidateId, item.digest);
            continue;
          }

          // Earlier Candidates accepted by this run are stored Sessions by
          // now, so the hint is intersected fresh against the live set.
          // Only the intersection repeats; normalization does not.
          familyHint = familyHintOf(candidate.candidateId, item.familyIdentities, storedIdentities);

          // The persisted evaluation is of the exact bytes accepted, so
          // recaptured bytes are re-evaluated before acceptance.
          if (detectionEnabled && recaptured) {
            const detection = await detectSecrets(item.stagingDir, item.captured);
            if (withholdsAcceptance(detection)) {
              if (options.overrideFlagged !== true) {
                evalUpdates.set(
                  candidate.candidateId,
                  evaluationOf(candidate, detection, item.digest),
                );
                evaluationCaptures.set(candidate.candidateId, {
                  classified: item.classified,
                  stagingDir: item.stagingDir,
                  captured: item.captured,
                });
                report.flagged.push(flaggedSummary(candidate, detection, familyHint));
                continue;
              }
              item.detection = detection;
            } else {
              item.detection = null;
            }
          }
          // Hashing, family analysis, and detection can be long enough for a
          // Harness to append evidence or add a late subagent. Refresh the
          // complete allowlist after those operations and prove the captured
          // bytes stayed stable before any Store write. Project decisions and
          // Binding mutations remain excluded by the leases already held, so
          // this un-lockable source check can stay the final gate.
          candidate = await revalidateAcceptedCapture(candidate, item, env);
          item.classified = { ...item.classified, candidate };
        } catch (err) {
          report.sourceErrors.push({
            candidateId: candidate.candidateId,
            message: err instanceof GliaError ? err.message : String(err),
          });
          continue;
        }
        const manifest = manifestOf(item.captured);
        const meta = sessionMetaFor(item, manifest.files.length);
        await writeAcceptedRevision(project.paths.storeDir, meta, manifest, item.stagingDir);
        if (item.tombstone !== null) {
          // Re-admission restores its explicit association in the same writer
          // transaction as acceptance. A delete can therefore run only before
          // both facts (and be overridden) or after both facts (and collapse
          // the association); it can never leave a stale association pointing
          // at a newer tombstone.
          associateCandidate(decisionState, candidate.candidateId, project.declaration.projectId);
          restoredTombstoneAssociation = true;
        }
        addStoredIdentities(storedIdentities, candidate.candidateId, item.familyIdentities);
        clearEvaluation(candidate.candidateId, item.digest);
        report.accepted.push({
          sessionId: meta.sessionId,
          harnessId: meta.harnessId,
          sourceSessionId: meta.sourceSessionId,
          revision: meta.currentRevision.digest,
          flaggedRules: meta.secretDetectionOverride?.ruleIds ?? [],
          familyHint,
        });
      }

      if (report.accepted.length === 0) {
        report.storeCommit = await store.head();
        return report;
      }

      const operation = options.onlyCandidateIds !== null ? "session.accept" : "session.import";
      const trailer = JSON.stringify({
        op: operation,
        projectId: project.declaration.projectId,
        replicaId: project.replicaId,
        sessions: report.accepted.map((a) => ({ sessionId: a.sessionId, revision: a.revision })),
      });
      const head = await store.commitAll(
        `session: accept ${report.accepted.length} revision(s)\n\nglia-op: ${trailer}`,
      );
      report.storeCommit = head;
      if (restoredTombstoneAssociation) {
        await writeDiscoveryState(project.paths.discoveryFile, decisionState);
      }

      // Ownership-sensitive Store and evaluation state are now committed.
      // Release the machine-global Binding lease before the potentially long
      // projection rebuild so unrelated Projects remain independent.
      evaluationCommitHandled = true;
      await commitEvaluationState(
        project,
        env,
        discoveryBaseline,
        discovery,
        options,
        evalUpdates,
        clearDigests,
        evaluationCaptures,
        report,
        true,
        true,
      );
      bindingsLease.release();
      bindingsLease = null;

      // 5.–7. Build, validate, and atomically publish the projection.
      try {
        await buildAndPublishLocked(project, head);
        report.projectionFresh = true;
      } catch {
        // Accepted evidence stays authoritative; the projection remains
        // stale and the next prepare rebuilds it.
        report.projectionFresh = false;
      }
    } finally {
      try {
        // Keep Store acceptance and its evaluation clear under one lease so
        // a concurrent hook cannot interleave between those two facts.
        if (!evaluationCommitHandled) {
          evaluationCommitHandled = true;
          await commitEvaluationState(
            project,
            env,
            discoveryBaseline,
            discovery,
            options,
            evalUpdates,
            clearDigests,
            evaluationCaptures,
            report,
            true,
            bindingsLease !== null,
          );
        }
      } finally {
        bindingsLease?.release();
        lease.release();
      }
    }
  } finally {
    await rm(stagingRunDir, { recursive: true, force: true });
    // A failed Store-lease acquisition already waited the full configured
    // timeout. Do not immediately wait it a second time merely to commit
    // advisory state; the next automation run will re-evaluate the source.
    if (!storeLeaseBusy && !evaluationCommitHandled) {
      await commitEvaluationState(
        project,
        env,
        discoveryBaseline,
        discovery,
        options,
        evalUpdates,
        clearDigests,
        evaluationCaptures,
        report,
      );
    }
  }
  return report;
}

function annotateFlaggedTimes(state: DiscoveryState, report: ImportReport): void {
  if (report.flagged.length === 0) return;
  for (const flagged of report.flagged) {
    const candidateId = String(flagged["candidateId"]);
    const evaluation = state.evaluations[candidateId];
    if (evaluation !== undefined) {
      flagged["firstFlaggedAt"] = evaluation.firstFlaggedAt ?? evaluation.evaluatedAt;
    }
  }
}

async function commitEvaluationState(
  project: LoadedProject,
  env: Record<string, string | undefined>,
  baseline: DiscoveryState,
  discovery: DiscoveryResult,
  options: ImportOptions,
  updates: Map<string, PersistedEvaluation | null>,
  clearDigests: Map<string, string>,
  evaluationCaptures: Map<string, EvaluationCapture>,
  report: ImportReport,
  leaseAlreadyHeld = false,
  bindingsLeaseAlreadyHeld = false,
): Promise<void> {
  const fullDiscovery = options.harness === null && options.onlyCandidateIds === null;
  const mayReconcile =
    fullDiscovery &&
    Object.keys(baseline.evaluations).some((candidateId) => {
      const live = discovery.candidates.find(
        (entry) => entry.candidate.candidateId === candidateId,
      );
      return (
        live === undefined ||
        live.classification.kind === "out_of_scope" ||
        live.classification.kind === "ignored" ||
        live.classification.kind === "tombstoned"
      );
    });
  if (updates.size === 0 && !mayReconcile) {
    annotateFlaggedTimes(baseline, report);
    return;
  }

  const commitLocked = async (): Promise<void> => {
    const state = await readDiscoveryState(project.paths.discoveryFile);
    const pruned = fullDiscovery
      ? await collectPrunedEvaluations(project, baseline, state, discovery, updates)
      : { losses: [], resolvedCandidateIds: [] };
    const losses = pruned.losses;
    const captureStatuses = new Map<string, Awaited<ReturnType<typeof sourceCaptureStatus>>>();
    const resolvedEvaluations = new Set<string>(pruned.resolvedCandidateIds);
    for (const [candidateId, evaluation] of updates) {
      if (evaluation === null) continue;
      const original = baseline.evaluations[candidateId];
      const currentEvaluation = state.evaluations[candidateId];
      const accepted = await readSessionMeta(project.paths.storeDir, candidateId);
      if (state.ignored.includes(candidateId)) {
        removeFlaggedSummary(report, candidateId);
        report.ignored += 1;
        resolvedEvaluations.add(candidateId);
        continue;
      }
      if (accepted?.currentRevision.digest === evaluation.bundleDigest) {
        removeFlaggedSummary(report, candidateId);
        report.unchanged += 1;
        resolvedEvaluations.add(candidateId);
        continue;
      }
      if (await isTombstoned(project.paths.storeDir, candidateId)) {
        removeFlaggedSummary(report, candidateId);
        resolvedEvaluations.add(candidateId);
        continue;
      }
      if (!evaluationsEqual(currentEvaluation, original)) {
        // A concurrent explicit clear wins over this older observation. A
        // concurrent newer evaluation still leaves the Candidate withheld.
        if (currentEvaluation === undefined) removeFlaggedSummary(report, candidateId);
        continue;
      }
      const capture = evaluationCaptures.get(candidateId);
      if (capture === undefined) continue;
      const liveCandidate = await rediscoverCandidate(capture.classified.candidate, env).catch(
        () => undefined,
      );
      // A failed re-discovery is indeterminate and preserves the old state;
      // a successful discovery that no longer contains the candidate is loss.
      if (
        liveCandidate !== undefined &&
        (await candidateProjectOwnership(
          project,
          state,
          liveCandidate ?? capture.classified.candidate,
        )) === "other"
      ) {
        // Binding inference is a snapshot too. A concurrently opted-in
        // nested Project owns its Candidate immediately; the former parent
        // neither persists nor reports its masked evaluation as debt/loss.
        resolvedEvaluations.add(candidateId);
        if (removeFlaggedSummary(report, candidateId)) report.outOfScope += 1;
        continue;
      }
      let status =
        liveCandidate === undefined
          ? "current"
          : liveCandidate === null
            ? "missing"
            : await sourceCaptureStatus(liveCandidate, capture.captured);
      if (status === "changed" && liveCandidate !== undefined && liveCandidate !== null) {
        try {
          await rm(capture.stagingDir, { recursive: true, force: true });
          const refreshed = await adapterFor(liveCandidate.identity.harnessId).capture(
            liveCandidate,
            { dir: capture.stagingDir },
          );
          const digest = bundleDigest(manifestOf(refreshed));
          const detection = await detectSecrets(capture.stagingDir, refreshed);
          const verifiedCandidate = await rediscoverCandidate(liveCandidate, env);
          const verifiedStatus =
            verifiedCandidate === null
              ? "missing"
              : await sourceCaptureStatus(verifiedCandidate, refreshed);
          const alreadyAccepted = await readSessionMeta(project.paths.storeDir, candidateId);
          if (alreadyAccepted?.currentRevision.digest === digest) {
            updates.set(candidateId, null);
            clearDigests.set(candidateId, digest);
            evaluationCaptures.delete(candidateId);
            removeFlaggedSummary(report, candidateId);
            report.unchanged += 1;
            status = "current";
          } else if (verifiedStatus === "missing") {
            status = "missing";
          } else if (withholdsAcceptance(detection)) {
            const freshEvaluation = evaluationOf(
              verifiedCandidate ?? liveCandidate,
              detection,
              digest,
            );
            updates.set(candidateId, freshEvaluation);
            evaluationCaptures.set(candidateId, {
              classified: {
                ...capture.classified,
                candidate: verifiedCandidate ?? liveCandidate,
              },
              stagingDir: capture.stagingDir,
              captured: refreshed,
            });
            replaceFlaggedSummary(
              report,
              verifiedCandidate ?? liveCandidate,
              detection,
              candidateId,
            );
            // A masked evaluation is conservative evidence, not accepted
            // bytes. If the Harness appended again during verification, keep
            // the newest observed flagged digest visible for the next sweep.
            status = "current";
          } else if (verifiedStatus === "current") {
            updates.set(candidateId, null);
            clearDigests.set(candidateId, digest);
            evaluationCaptures.delete(candidateId);
            removeFlaggedSummary(report, candidateId);
            status = "current";
          } else {
            // The recaptured bytes were clean but changed again before they
            // could be proven current. Preserve the earlier masked warning;
            // a later sweep will resolve it from a stable capture.
            status = "current";
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") {
            status = "missing";
          } else {
            report.sourceErrors.push({
              candidateId,
              message: error instanceof GliaError ? error.message : String(error),
            });
            // The already captured flagged observation remains useful,
            // masked evidence when a refresh itself is indeterminate.
            status = "current";
          }
        }
      }
      captureStatuses.set(candidateId, status);
      if (fullDiscovery && status === "missing" && evaluation.identity !== undefined) {
        removeFlaggedSummary(report, candidateId);
        losses.push({
          candidateId,
          identity: evaluation.identity,
          firstFlaggedAt:
            original?.firstFlaggedAt ??
            original?.evaluatedAt ??
            evaluation.firstFlaggedAt ??
            evaluation.evaluatedAt,
          prunedAt: new Date().toISOString(),
        });
      }
    }
    report.prunedWithheld = losses;

    // Record evidence before deleting its evaluation. If the following state
    // write fails, the next run deduplicates the loss record and retries the
    // deletion; the evidence is never lost in the opposite order.
    await appendWithheldLosses(project.paths.withheldLossFile, losses);

    let changed = false;
    for (const [candidateId, evaluation] of updates) {
      const original = baseline.evaluations[candidateId];
      const current = state.evaluations[candidateId];
      if (evaluation === null) {
        const clearDigest = clearDigests.get(candidateId);
        // An accept/unchanged result can clear a concurrent re-evaluation of
        // the same bytes. A newer evaluation of different bytes survives.
        if (
          current !== undefined &&
          (evaluationsEqual(current, original) || current.bundleDigest === clearDigest)
        ) {
          delete state.evaluations[candidateId];
          changed = true;
        }
      } else if (evaluationsEqual(current, original)) {
        if (resolvedEvaluations.has(candidateId)) {
          if (current !== undefined) {
            delete state.evaluations[candidateId];
            changed = true;
          }
          continue;
        }
        const captureStatus = captureStatuses.get(candidateId);
        if (captureStatus === "changed") {
          continue;
        }
        if (captureStatus === "missing") {
          if (fullDiscovery) {
            if (current !== undefined) {
              delete state.evaluations[candidateId];
              changed = true;
            }
            continue;
          }
          // Narrowed runs never declare loss. Preserve the masked observation
          // so a later full discovery can reconcile it into durable evidence.
          if (current !== undefined) continue;
        }
        const latestCapture = evaluationCaptures.get(candidateId);
        if (
          latestCapture !== undefined &&
          (await candidateProjectOwnership(project, state, latestCapture.classified.candidate)) ===
            "other"
        ) {
          if (current !== undefined) {
            delete state.evaluations[candidateId];
            changed = true;
          }
          if (removeFlaggedSummary(report, candidateId)) report.outOfScope += 1;
          continue;
        }
        state.evaluations[candidateId] = {
          ...evaluation,
          firstFlaggedAt:
            current?.firstFlaggedAt ??
            current?.evaluatedAt ??
            evaluation.firstFlaggedAt ??
            evaluation.evaluatedAt,
        };
        changed = true;
      }
    }
    for (const candidateId of pruned.resolvedCandidateIds) {
      if (evaluationsEqual(state.evaluations[candidateId], baseline.evaluations[candidateId])) {
        delete state.evaluations[candidateId];
        changed = true;
      }
    }
    for (const loss of losses) {
      if (
        evaluationsEqual(
          state.evaluations[loss.candidateId],
          baseline.evaluations[loss.candidateId],
        )
      ) {
        delete state.evaluations[loss.candidateId];
        changed = true;
      }
    }
    if (changed) await writeDiscoveryState(project.paths.discoveryFile, state);
    annotateFlaggedTimes(state, report);
  };

  const commitWithBindingsLocked = async (): Promise<void> => {
    if (bindingsLeaseAlreadyHeld) {
      await commitLocked();
      return;
    }
    const lease = await WriterLease.acquire(
      project.paths.bindingsLockFile,
      writerLeaseTimeoutMs(env),
    );
    try {
      await commitLocked();
    } finally {
      lease.release();
    }
  };

  if (leaseAlreadyHeld) {
    await commitWithBindingsLocked();
    return;
  }

  // Flagged-only and pruning-only runs never needed the Store write section,
  // so they acquire the same Project lease only for this short state commit.
  const lease = await WriterLease.acquire(project.paths.writerLockFile, writerLeaseTimeoutMs(env));
  try {
    await commitWithBindingsLocked();
  } finally {
    lease.release();
  }
}

function evaluationsEqual(
  left: PersistedEvaluation | undefined,
  right: PersistedEvaluation | undefined,
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function evaluationOf(
  candidate: SessionCandidate,
  detection: DetectionResult,
  bundleDigest: string,
): PersistedEvaluation {
  const at = new Date().toISOString();
  return {
    identity: candidate.identity,
    bundleDigest,
    rulesetVersion: detection.rulesetVersion,
    evaluatedAt: at,
    firstFlaggedAt: at,
    hits: detection.hits,
    unscanned: detection.unscanned,
  };
}

/**
 * A full, unfiltered discovery may prove that a withheld Candidate's source
 * disappeared. Narrowed and failed-Harness runs deliberately preserve it.
 */
async function collectPrunedEvaluations(
  project: LoadedProject,
  baseline: DiscoveryState,
  current: DiscoveryState,
  discovery: DiscoveryResult,
  updates: Map<string, PersistedEvaluation | null>,
): Promise<{ losses: WithheldLossRecord[]; resolvedCandidateIds: string[] }> {
  const discovered = new Map(
    discovery.candidates.map((entry) => [entry.candidate.candidateId, entry] as const),
  );
  const exemptHarnesses = new Set<HarnessId>([
    ...discovery.unavailableHarnesses.map((entry) => entry.harnessId),
    ...discovery.adapterFailures.map((entry) => entry.harnessId),
  ]);
  const prunedAt = new Date().toISOString();
  const losses: WithheldLossRecord[] = [];
  const resolvedCandidateIds: string[] = [];
  for (const [candidateId, evaluation] of Object.entries(baseline.evaluations)) {
    if (updates.has(candidateId)) continue;
    const live = discovered.get(candidateId);
    if (live !== undefined) {
      if (
        live.classification.kind === "out_of_scope" ||
        live.classification.kind === "ignored" ||
        live.classification.kind === "tombstoned"
      ) {
        if (evaluationsEqual(current.evaluations[candidateId], evaluation)) {
          resolvedCandidateIds.push(candidateId);
        }
      }
      continue;
    }
    // Legacy evaluations did not persist Source Identity. Preserve them:
    // without a Harness ID, a failed discovery cannot be ruled out.
    if (evaluation.identity === undefined || exemptHarnesses.has(evaluation.identity.harnessId)) {
      continue;
    }
    // Only prune what this run actually observed at discovery start. A newer
    // evaluation introduced by a concurrent run is not evidence of loss.
    if (!evaluationsEqual(current.evaluations[candidateId], evaluation)) continue;
    const accepted = await readSessionMeta(project.paths.storeDir, candidateId);
    if (
      current.ignored.includes(candidateId) ||
      accepted?.currentRevision.digest === evaluation.bundleDigest ||
      (await isTombstoned(project.paths.storeDir, candidateId))
    ) {
      // A completed explicit decision may have crashed before clearing its
      // disposable evaluation. The bytes are preserved (or deliberately
      // resolved), so remove residue without inventing source-loss evidence.
      resolvedCandidateIds.push(candidateId);
      continue;
    }
    losses.push({
      candidateId,
      identity: evaluation.identity,
      firstFlaggedAt: evaluation.firstFlaggedAt ?? evaluation.evaluatedAt,
      prunedAt,
    });
  }
  return { losses, resolvedCandidateIds };
}

/** Finds the current allowlisted file set for one previously discovered identity. */
async function rediscoverCandidate(
  candidate: SessionCandidate,
  env: Record<string, string | undefined>,
): Promise<SessionCandidate | null> {
  const adapter = adapterFor(candidate.identity.harnessId);
  for await (const live of adapter.discover({ env })) {
    if (live.candidateId === candidate.candidateId) return live;
  }
  return null;
}

async function revalidateAcceptedCapture(
  candidate: SessionCandidate,
  item: StagedCandidate,
  env: Record<string, string | undefined>,
): Promise<SessionCandidate> {
  if (!(await stagingMatchesCapture(item.stagingDir, item.captured))) {
    throw new GliaError(
      "SOURCE_INCOMPLETE",
      `captured candidate evidence changed before acceptance: ${candidate.candidateId}`,
    );
  }

  const live = await rediscoverCandidate(candidate, env);
  if (live === null) {
    throw new GliaError(
      "SOURCE_INCOMPLETE",
      `candidate source disappeared before acceptance: ${candidate.candidateId}`,
    );
  }
  const before = await sourceVersionSnapshot(live);
  if ((await sourceCaptureStatus(live, item.captured)) !== "current") {
    throw new GliaError(
      "SOURCE_INCOMPLETE",
      `candidate changed during acceptance validation: ${candidate.candidateId}`,
    );
  }

  // Re-discovery after hashing catches source-set growth during the hash
  // itself (notably Claude Code creating a subagent transcript). File stats
  // catch an append/replacement to an existing allowlisted file in the same
  // interval without paying for a third full content hash.
  const verified = await rediscoverCandidate(live, env);
  const after = verified === null ? null : await sourceVersionSnapshot(verified);
  if (
    verified === null ||
    !sameSourceAllowlist(live, verified) ||
    after === null ||
    !sameStringArray(before, after)
  ) {
    throw new GliaError(
      "SOURCE_INCOMPLETE",
      `candidate changed during acceptance validation: ${candidate.candidateId}`,
    );
  }
  return verified;
}

async function sourceVersionSnapshot(candidate: SessionCandidate): Promise<string[]> {
  const versions: string[] = [];
  for (const ref of candidate.sourceFiles) {
    try {
      const info = await stat(ref.absolutePath);
      versions.push(
        [
          ref.bundlePath,
          ref.absolutePath,
          info.dev,
          info.ino,
          info.size,
          info.mtimeMs,
          info.ctimeMs,
        ].join("\0"),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new GliaError(
          "SOURCE_INCOMPLETE",
          `required candidate evidence disappeared: ${ref.absolutePath}`,
          { candidateId: candidate.candidateId, path: ref.absolutePath },
        );
      }
      throw error;
    }
  }
  return versions.sort();
}

function sameSourceAllowlist(left: SessionCandidate, right: SessionCandidate): boolean {
  const key = (candidate: SessionCandidate): string[] =>
    candidate.sourceFiles
      .map((ref) => [ref.bundlePath, ref.absolutePath, ref.mediaType].join("\0"))
      .sort();
  return sameStringArray(key(left), key(right));
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

async function candidateProjectOwnership(
  project: LoadedProject,
  state: DiscoveryState,
  candidate: SessionCandidate,
): Promise<CandidateProjectOwnership> {
  const explicit = state.associations[candidate.candidateId];
  if (candidate.openingPath !== null) {
    const resolution = await new BindingIndex(project.home).resolveOpeningPath(
      candidate.openingPath,
    );
    if (resolution.mapping !== null) {
      return resolution.mapping.projectId === project.declaration.projectId ? "owned" : "other";
    }
    if (!resolution.resolved && explicit === undefined) return "unresolved";
  }
  if (explicit !== undefined) {
    return explicit.projectId === project.declaration.projectId ? "owned" : "other";
  }
  // A live Opening Path whose exact worktree has no Binding is definitively
  // outside this Project. A missing/unknown Opening Path is only unresolved:
  // Store acceptance stays closed, while masked evidence can be reconciled
  // conservatively instead of being mistaken for another Project's data.
  return candidate.openingPath === null ? "unresolved" : "other";
}

function replaceFlaggedSummary(
  report: ImportReport,
  candidate: SessionCandidate,
  detection: DetectionResult,
  candidateId: string,
): void {
  const index = report.flagged.findIndex((entry) => String(entry["candidateId"]) === candidateId);
  const familyHint = index >= 0 ? (report.flagged[index]?.["familyHint"] ?? null) : null;
  const summary = flaggedSummary(candidate, detection, familyHint as FamilyHint | null);
  if (index >= 0) report.flagged[index] = summary;
  else report.flagged.push(summary);
}

function removeFlaggedSummary(report: ImportReport, candidateId: string): boolean {
  const before = report.flagged.length;
  report.flagged = report.flagged.filter((entry) => String(entry["candidateId"]) !== candidateId);
  return report.flagged.length !== before;
}

function flaggedSummary(
  candidate: SessionCandidate,
  detection: DetectionResult,
  familyHint: FamilyHint | null,
): Record<string, unknown> {
  return {
    ...candidateSummary(candidate),
    rulesetVersion: detection.rulesetVersion,
    suspectedSecrets: detection.hits,
    unscanned: detection.unscanned,
    familyHint,
  };
}

function emptyReport(discovery: DiscoveryResult, dryRun: boolean): ImportReport {
  return {
    dryRun,
    accepted: [],
    unchanged: 0,
    outOfScope: 0,
    ignored: 0,
    pending: [],
    flagged: [],
    secretDetection: { enabled: true, rulesetVersion: RULESET_VERSION, evaluated: false },
    conflicted: [],
    tombstoned: [],
    wouldAccept: [],
    unavailableHarnesses: discovery.unavailableHarnesses,
    adapterFailures: discovery.adapterFailures,
    sourceErrors: [],
    prunedWithheld: [],
    recoveryCommit: null,
    storeCommit: null,
    projectionFresh: false,
  };
}

function sessionMetaFor(item: StagedCandidate, fileCount: number): SessionMeta {
  const { candidate, classification } = item.classified;
  const via =
    classification.kind === "associated"
      ? classification.via
      : classification.kind === "tombstoned"
        ? "explicit"
        : "binding";
  const override =
    item.detection === null
      ? {}
      : {
          secretDetectionOverride: {
            rulesetVersion: item.detection.rulesetVersion,
            ruleIds: [...new Set(item.detection.hits.map((h) => h.ruleId))].sort(),
            hits: item.detection.hits,
            unscanned: item.detection.unscanned,
          },
        };
  // Re-admitting a tombstoned identity is a persisted override: which
  // epoch's deletion event was overridden, and when, stays traceable in
  // the Session's objective metadata — exactly as a detection override does.
  const tombstoneOverride =
    item.tombstone === null
      ? {}
      : {
          tombstoneOverride: {
            overriddenEpoch: item.tombstone.epoch,
            deletedAt: item.tombstone.deletedAt,
            deletedBy: item.tombstone.deletedBy,
            overriddenAt: new Date().toISOString(),
          },
        };
  return {
    ...override,
    ...tombstoneOverride,
    schemaVersion: SESSION_META_SCHEMA_VERSION,
    sessionId: candidate.candidateId,
    harnessId: candidate.identity.harnessId,
    sourceSessionId: candidate.identity.sourceSessionId,
    openingPath: candidate.openingPath,
    association: {
      mode: via === "explicit" ? "explicit" : "inferred",
      evidence:
        via === "explicit"
          ? "explicit user decision (session accept)"
          : `opening path ${candidate.openingPath ?? "(unknown)"} mapped through a machine-local binding`,
    },
    continuation: candidate.continuation,
    // Written only when the source states it, so a non-subagent Session's
    // metadata is byte-identical to what it was before the field existed.
    ...(candidate.subagent ? { subagent: candidate.subagent } : {}),
    currentRevision: {
      digest: item.digest,
      acceptedAt: new Date().toISOString(),
      fileCount,
      totalBytes: item.captured.files.reduce((sum, f) => sum + f.size, 0),
    },
  };
}
