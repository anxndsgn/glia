import { join } from "node:path";
import { rm } from "node:fs/promises";
import type { LoadedProject } from "../../core/session-module.ts";
import type { HarnessId } from "../../core/harnesses/ids.ts";
import { currentProjectionPath } from "../projection/publish.ts";
import { identityKeyOf } from "./event-identity.ts";
import { openProjection } from "../projection/query.ts";
import { adapterFor } from "../adapters/index.ts";
import { manifestOf } from "../storage/bundle.ts";
import { listSessionIds, readSessionMeta, readStoredBundle } from "../storage/store-layout.ts";
import type { CapturedBundle, SessionCandidate, StoredSourceBundle } from "../adapters/types.ts";

/**
 * The consent-time Fork Family hint: how many of a Candidate's
 * normalized events share identity with the stored Session that overlaps
 * most, and how many further stored Sessions also overlap. Advisory only
 * — never a gate, never an auto-skip, never a new exit state.
 */
export interface FamilyHint {
  sharedEvents: number;
  totalEvents: number;
  /** The stored Session with the largest overlap (ties by ascending Session ID). */
  withSessionId: string;
  /** Count of further stored Sessions the Candidate also overlaps. */
  furtherSessions: number;
}

export interface StoredIdentities {
  harnessId: string;
  keys: Set<string>;
}

/** A Candidate's own Shared Event Identity keys, computed once per capture. */
export interface CandidateIdentities extends StoredIdentities {
  totalEvents: number;
}

/**
 * Reads the stored Sessions' Shared Event Identity keys from the
 * published projection. Import-time detection reuses the projection
 * when it is current. When that disposable cache is absent or stale,
 * normalize the authoritative stored bundles instead: a missing cache
 * must not make a non-empty Store look empty at the consent gate. This
 * fallback stays read-only and never takes the writer lease.
 */
export async function readStoredIdentities(
  project: LoadedProject,
): Promise<Map<string, StoredIdentities>> {
  try {
    const dbPath = await currentProjectionPath(project);
    if (dbPath !== null) return readProjectedIdentities(dbPath);
  } catch {
    // Advisory projection reads fall back to authoritative Store bytes.
  }
  return await readStoredBundleIdentities(project);
}

function readProjectedIdentities(dbPath: string): Map<string, StoredIdentities> {
  const db = openProjection(dbPath);
  try {
    const rows = db
      .query(
        `SELECT e.session_id AS sessionId, r.harness_id AS harnessId,
                e.identity_key AS identityKey
         FROM events e
         JOIN sessions r ON r.session_id = e.session_id
         WHERE e.identity_key IS NOT NULL`,
      )
      .all() as {
      sessionId: string;
      harnessId: string;
      identityKey: string;
    }[];
    const stored = new Map<string, StoredIdentities>();
    for (const row of rows) {
      let entry = stored.get(row.sessionId);
      if (entry === undefined) {
        entry = { harnessId: row.harnessId, keys: new Set() };
        stored.set(row.sessionId, entry);
      }
      entry.keys.add(row.identityKey);
    }
    return stored;
  } finally {
    db.close();
  }
}

async function readStoredBundleIdentities(
  project: LoadedProject,
): Promise<Map<string, StoredIdentities>> {
  const stored = new Map<string, StoredIdentities>();
  for (const sessionId of await listSessionIds(project.paths.storeDir)) {
    try {
      const meta = await readSessionMeta(project.paths.storeDir, sessionId);
      // A Session Conflict has no Current Revision and contributes no
      // readable Session until resolution, matching projection build.
      if (meta === null) continue;
      const bundle = await readStoredBundle(project.paths.storeDir, sessionId);
      const { keys } = await identitiesOf(meta.harnessId, bundle);
      stored.set(sessionId, { harnessId: meta.harnessId, keys });
    } catch {
      // A hint is advisory: one unreadable stored Session must not block
      // previews against every other readable Session.
    }
  }
  return stored;
}

/**
 * Capture and normalize Candidates solely to put Fork Family facts in
 * front of an acceptance decision. Only machine-local transient staging
 * is written; the Store, projection, and discovery decisions are untouched.
 */
export async function previewCandidateFamilyHints(
  project: LoadedProject,
  candidates: SessionCandidate[],
): Promise<Map<string, FamilyHint>> {
  const hints = new Map<string, FamilyHint>();
  if (candidates.length === 0) return hints;
  const stored = await readStoredIdentities(project);
  const runId = `family-preview-${Date.now().toString(36)}-${process.pid}`;
  const stagingRunDir = join(project.paths.stagingRoot, runId);
  try {
    for (const candidate of candidates) {
      const stagingDir = join(stagingRunDir, candidate.candidateId);
      try {
        const adapter = adapterFor(candidate.identity.harnessId);
        const captured = await adapter.capture(candidate, { dir: stagingDir });
        const identities = await candidateIdentities(candidate, stagingDir, captured);
        const hint = familyHintOf(candidate.candidateId, identities, stored);
        if (hint !== null) hints.set(candidate.candidateId, hint);
      } catch {
        // The import path reports the Candidate's concrete source error;
        // an advisory preview never invents a gate of its own.
      }
    }
  } finally {
    await rm(stagingRunDir, { recursive: true, force: true });
  }
  return hints;
}

/**
 * Normalizes the Candidate's captured bundle — the normalization the
 * import path already runs — into its Shared Event Identity keys. This
 * is the expensive half of family analysis and depends only on the
 * captured bytes, so it is recomputed only when those bytes change.
 */
export async function candidateIdentities(
  candidate: SessionCandidate,
  stagingDir: string,
  captured: CapturedBundle,
): Promise<CandidateIdentities> {
  const { totalEvents, keys } = await identitiesOf(candidate.identity.harnessId, {
    sessionId: candidate.candidateId,
    dir: stagingDir,
    manifest: manifestOf(captured),
  });
  return { harnessId: candidate.identity.harnessId, keys, totalEvents };
}

/**
 * States a Candidate's overlap with stored Sessions of the same Harness.
 * The Candidate's own Session never counts: a growing Revision shares
 * events with itself without being a fork. This half is pure set
 * intersection, so it is cheap to redo as the stored set grows.
 */
export function familyHintOf(
  candidateId: string,
  identities: CandidateIdentities,
  stored: Map<string, StoredIdentities>,
): FamilyHint | null {
  if (identities.keys.size === 0) return null;
  let best: { sessionId: string; shared: number } | null = null;
  let related = 0;
  for (const [sessionId, entry] of stored) {
    if (sessionId === candidateId) continue;
    if (entry.harnessId !== identities.harnessId) continue;
    let shared = 0;
    for (const key of identities.keys) {
      if (entry.keys.has(key)) shared += 1;
    }
    if (shared === 0) continue;
    related += 1;
    if (
      best === null ||
      shared > best.shared ||
      (shared === best.shared && sessionId.localeCompare(best.sessionId) < 0)
    ) {
      best = { sessionId, shared };
    }
  }
  return best === null
    ? null
    : {
        sharedEvents: best.shared,
        totalEvents: identities.totalEvents,
        withSessionId: best.sessionId,
        furtherSessions: related - 1,
      };
}

async function identitiesOf(
  harnessId: HarnessId,
  bundle: StoredSourceBundle,
): Promise<{ totalEvents: number; keys: Set<string> }> {
  let totalEvents = 0;
  const keys = new Set<string>();
  for await (const event of adapterFor(harnessId).project(bundle)) {
    totalEvents += 1;
    if (event.sourceEventId !== null) {
      keys.add(identityKeyOf(event.sourceEventId, event.timestamp, event.text));
    }
  }
  return { totalEvents, keys };
}
