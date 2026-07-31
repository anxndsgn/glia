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
  /** That Session's display Label, when the projection knows one. */
  withSessionLabel: string | null;
  /** Count of further stored Sessions the Candidate also overlaps. */
  furtherSessions: number;
}

/**
 * The stored Sessions' Shared Event Identity, inverted for hint
 * intersection: each identity key names the Sessions holding a copy, so
 * overlap counting is proportional to the Candidate's own keys instead of
 * to the whole stored set.
 */
export interface StoredIdentityIndex {
  /** Session ID to Harness and display Label (null when not derivable). */
  sessions: Map<string, { harnessId: string; label: string | null }>;
  /** Identity key to the distinct Session IDs holding an event with it. */
  holders: Map<string, string[]>;
}

/** A Candidate's own Shared Event Identity keys, computed once per capture. */
export interface CandidateIdentities {
  harnessId: string;
  keys: Set<string>;
  totalEvents: number;
}

/** A preview capture kept alive so the accept path can adopt it. */
export interface PrecapturedCandidate {
  stagingDir: string;
  captured: CapturedBundle;
  familyIdentities: CandidateIdentities;
}

export interface FamilyPreview {
  hints: Map<string, FamilyHint>;
  /**
   * The preview's captured bundles, keyed by Candidate ID, for the accept
   * path to adopt instead of capturing the same bytes a second time. The
   * accept path still revalidates sources under the writer lease.
   */
  precaptured: Map<string, PrecapturedCandidate>;
  /** Removes the preview's staging; call once the acceptance run is over. */
  dispose(): Promise<void>;
}

/**
 * Reads the stored Sessions' Shared Event Identity keys from the
 * published projection. Import-time detection reuses the projection
 * when it is current. When that disposable cache is absent or stale,
 * normalize the authoritative stored bundles instead: a missing cache
 * must not make a non-empty Store look empty at the consent gate. This
 * fallback stays read-only and never takes the writer lease.
 */
export async function readStoredIdentities(project: LoadedProject): Promise<StoredIdentityIndex> {
  try {
    const dbPath = await currentProjectionPath(project);
    if (dbPath !== null) return readProjectedIdentities(dbPath);
  } catch {
    // Advisory projection reads fall back to authoritative Store bytes.
  }
  return await readStoredBundleIdentities(project);
}

/**
 * Registers a just-accepted Session so later Candidates in the same run
 * intersect against the live stored set. Only additions are recorded: a
 * Revision that replaced earlier bytes may leave its old keys behind for
 * the rest of the run, which can only widen an advisory hint.
 */
export function addStoredIdentities(
  index: StoredIdentityIndex,
  sessionId: string,
  identities: CandidateIdentities,
): void {
  index.sessions.set(sessionId, { harnessId: identities.harnessId, label: null });
  for (const key of identities.keys) {
    const holders = index.holders.get(key);
    if (holders === undefined) {
      index.holders.set(key, [sessionId]);
    } else if (!holders.includes(sessionId)) {
      holders.push(sessionId);
    }
  }
}

function emptyIndex(): StoredIdentityIndex {
  return { sessions: new Map(), holders: new Map() };
}

function readProjectedIdentities(dbPath: string): StoredIdentityIndex {
  const db = openProjection(dbPath);
  try {
    const index = emptyIndex();
    const sessions = db
      .query("SELECT session_id AS sessionId, harness_id AS harnessId, label FROM sessions")
      .all() as { sessionId: string; harnessId: string; label: string | null }[];
    for (const row of sessions) {
      index.sessions.set(row.sessionId, { harnessId: row.harnessId, label: row.label });
    }
    // DISTINCT keeps one holder entry per (key, Session) even when a
    // Session repeats a key across duplicate runs, so overlap counts stay
    // counts of shared keys, not of stored rows.
    const rows = db
      .query(
        `SELECT DISTINCT e.identity_key AS identityKey, e.session_id AS sessionId
         FROM events e
         WHERE e.identity_key IS NOT NULL`,
      )
      .all() as { identityKey: string; sessionId: string }[];
    for (const row of rows) {
      const holders = index.holders.get(row.identityKey);
      if (holders === undefined) {
        index.holders.set(row.identityKey, [row.sessionId]);
      } else {
        holders.push(row.sessionId);
      }
    }
    return index;
  } finally {
    db.close();
  }
}

async function readStoredBundleIdentities(project: LoadedProject): Promise<StoredIdentityIndex> {
  const index = emptyIndex();
  for (const sessionId of await listSessionIds(project.paths.storeDir)) {
    try {
      const meta = await readSessionMeta(project.paths.storeDir, sessionId);
      // A Session Conflict has no Current Revision and contributes no
      // readable Session until resolution, matching projection build.
      if (meta === null) continue;
      const bundle = await readStoredBundle(project.paths.storeDir, sessionId);
      const { keys } = await identitiesOf(meta.harnessId, bundle);
      addStoredIdentities(index, sessionId, {
        harnessId: meta.harnessId,
        keys,
        totalEvents: keys.size,
      });
    } catch {
      // A hint is advisory: one unreadable stored Session must not block
      // previews against every other readable Session.
    }
  }
  return index;
}

/**
 * Capture and normalize Candidates solely to put Fork Family facts in
 * front of an acceptance decision. Only machine-local transient staging
 * is written; the Store, projection, and discovery decisions are
 * untouched. The staging outlives this call so the accept path can adopt
 * the captured bytes — the caller owns `dispose()`.
 */
export async function previewCandidateFamilies(
  project: LoadedProject,
  candidates: SessionCandidate[],
): Promise<FamilyPreview> {
  const hints = new Map<string, FamilyHint>();
  const precaptured = new Map<string, PrecapturedCandidate>();
  const runId = `family-preview-${Date.now().toString(36)}-${process.pid}`;
  const stagingRunDir = join(project.paths.stagingRoot, runId);
  const dispose = async (): Promise<void> => {
    await rm(stagingRunDir, { recursive: true, force: true });
  };
  if (candidates.length === 0) return { hints, precaptured, dispose };
  const stored = await readStoredIdentities(project);
  for (const candidate of candidates) {
    const stagingDir = join(stagingRunDir, candidate.candidateId);
    try {
      const adapter = adapterFor(candidate.identity.harnessId);
      const captured = await adapter.capture(candidate, { dir: stagingDir });
      const familyIdentities = await candidateIdentities(candidate, stagingDir, captured);
      precaptured.set(candidate.candidateId, { stagingDir, captured, familyIdentities });
      const hint = familyHintOf(candidate.candidateId, familyIdentities, stored);
      if (hint !== null) hints.set(candidate.candidateId, hint);
    } catch {
      // The import path reports the Candidate's concrete source error;
      // an advisory preview never invents a gate of its own.
    }
  }
  return { hints, precaptured, dispose };
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
 * events with itself without being a fork. Overlaps are tallied through
 * the inverted index, so the cost follows the Candidate's own keys.
 */
export function familyHintOf(
  candidateId: string,
  identities: CandidateIdentities,
  stored: StoredIdentityIndex,
): FamilyHint | null {
  if (identities.keys.size === 0) return null;
  const shared = new Map<string, number>();
  for (const key of identities.keys) {
    const holders = stored.holders.get(key);
    if (holders === undefined) continue;
    for (const sessionId of holders) {
      if (sessionId === candidateId) continue;
      if (stored.sessions.get(sessionId)?.harnessId !== identities.harnessId) continue;
      shared.set(sessionId, (shared.get(sessionId) ?? 0) + 1);
    }
  }
  let best: { sessionId: string; shared: number } | null = null;
  for (const [sessionId, count] of shared) {
    if (
      best === null ||
      count > best.shared ||
      (count === best.shared && sessionId.localeCompare(best.sessionId) < 0)
    ) {
      best = { sessionId, shared: count };
    }
  }
  return best === null
    ? null
    : {
        sharedEvents: best.shared,
        totalEvents: identities.totalEvents,
        withSessionId: best.sessionId,
        withSessionLabel: stored.sessions.get(best.sessionId)?.label ?? null,
        furtherSessions: shared.size - 1,
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
