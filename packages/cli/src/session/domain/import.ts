import { join } from "node:path";
import { rm } from "node:fs/promises";
import type { LoadedProject } from "../../core/session-module.ts";
import type { HarnessId } from "../../core/harnesses/ids.ts";
import { GliaError } from "../../core/output/errors.ts";
import { WriterLease, writerLeaseTimeoutMs } from "../../core/store/lease.ts";
import { prepareStoreForWrite } from "../../core/store/marker.ts";
import { ProjectStore } from "../../core/store/store.ts";
import { isSessionConflicted } from "./conflict.ts";
import { adapterFor } from "../adapters/index.ts";
import { sourcesMatchCapture } from "../adapters/capture.ts";
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
import { readDiscoveryState, writeDiscoveryState } from "./discovery-state.ts";
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
        if (existing && existing.currentRevision.digest === digest) {
          report.unchanged += 1;
          evalUpdates.set(candidate.candidateId, null);
          continue;
        }
        const familyIdentities =
          pre?.familyIdentities ?? (await candidateIdentities(candidate, stagingDir, captured));
        let detection: DetectionResult | null = null;
        if (detectionEnabled) {
          detection = await detectSecrets(stagingDir, captured);
          if (withholdsAcceptance(detection)) {
            if (options.overrideFlagged !== true) {
              // Withheld, not failed: it blocks nothing and produces no
              // INPUT_REQUIRED; only an explicit override decision proceeds.
              evalUpdates.set(candidate.candidateId, evaluationOf(detection, digest));
              const hint = familyHintOf(candidate.candidateId, familyIdentities, storedIdentities);
              report.flagged.push(flaggedSummary(candidate, detection, hint));
              continue;
            }
          } else {
            detection = null;
          }
        }
        evalUpdates.set(candidate.candidateId, null);
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
    const lease = await WriterLease.acquire(
      project.paths.writerLockFile,
      writerLeaseTimeoutMs(env),
    );
    try {
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

      // 3.–4. Revalidate sources, accept Source Bundles, commit the Store once.
      for (const item of staged) {
        const { candidate } = item.classified;
        // A sync inside the capture window may have frozen this Session.
        if (await isSessionConflicted(project.paths.storeDir, candidate.candidateId)) {
          report.conflicted.push(candidateSummary(candidate));
          continue;
        }
        let familyHint: FamilyHint | null = null;
        try {
          let recaptured = false;
          if (!(await sourcesMatchCapture(candidate, item.captured))) {
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
          }

          // Another writer may have accepted these bytes after the
          // pre-lease snapshot. Re-read under the lease so a byte-identical
          // import remains a no-op even across that capture window.
          const current = await readSessionMeta(project.paths.storeDir, candidate.candidateId);
          if (current?.currentRevision.digest === item.digest) {
            report.unchanged += 1;
            evalUpdates.set(candidate.candidateId, null);
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
                evalUpdates.set(candidate.candidateId, evaluationOf(detection, item.digest));
                report.flagged.push(flaggedSummary(candidate, detection, familyHint));
                continue;
              }
              item.detection = detection;
            } else {
              item.detection = null;
            }
          }
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
        addStoredIdentities(storedIdentities, candidate.candidateId, item.familyIdentities);
        evalUpdates.set(candidate.candidateId, null);
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
      lease.release();
    }
  } finally {
    await rm(stagingRunDir, { recursive: true, force: true });
    await applyEvaluationUpdates(project.paths.discoveryFile, evalUpdates);
  }
  return report;
}

async function applyEvaluationUpdates(
  discoveryFile: string,
  updates: Map<string, PersistedEvaluation | null>,
): Promise<void> {
  if (updates.size === 0) return;
  const state = await readDiscoveryState(discoveryFile);
  let changed = false;
  for (const [candidateId, evaluation] of updates) {
    if (evaluation === null) {
      if (candidateId in state.evaluations) {
        delete state.evaluations[candidateId];
        changed = true;
      }
    } else {
      state.evaluations[candidateId] = evaluation;
      changed = true;
    }
  }
  if (changed) await writeDiscoveryState(discoveryFile, state);
}

function evaluationOf(detection: DetectionResult, bundleDigest: string): PersistedEvaluation {
  return {
    bundleDigest,
    rulesetVersion: detection.rulesetVersion,
    evaluatedAt: new Date().toISOString(),
    hits: detection.hits,
    unscanned: detection.unscanned,
  };
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
