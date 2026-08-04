import { join } from "node:path";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import { GliaError } from "../../core/output/errors.ts";
import { sessionDir, sessionsDir, type SessionMeta } from "../storage/store-layout.ts";

export const CONFLICT_SCHEMA_VERSION = 1;

/**
 * A Session Conflict freezes exactly one Session: both sides' complete
 * candidate Revisions replace the Session directory's ordinary layout so
 * any Replica can resolve the conflict offline:
 *
 *   session/sessions/<sessionId>/conflict/conflict.json
 *   session/sessions/<sessionId>/conflict/candidates/<key>/session.json
 *   session/sessions/<sessionId>/conflict/candidates/<key>/bundle/...
 *
 * The layout is deterministic — candidates are keyed by a digest of their
 * metadata bytes and sorted stably, never stamped with wall-clock time —
 * so two Replicas that capture the same conflict independently produce
 * byte-identical trees and re-merge cleanly.
 */
export interface ConflictCandidateSummary {
  key: string;
  digest: string;
  acceptedAt: string;
  harnessId: string;
  sourceSessionId: string;
}

export interface SessionConflictDoc {
  schemaVersion: number;
  sessionId: string;
  candidates: ConflictCandidateSummary[];
}

export interface ConflictCandidate {
  key: string;
  meta: SessionMeta;
  /** Absolute directory holding this candidate's session.json and bundle/. */
  dir: string;
}

export function conflictDir(storeDir: string, sessionId: string): string {
  return join(sessionDir(storeDir, sessionId), "conflict");
}

function conflictFile(storeDir: string, sessionId: string): string {
  return join(conflictDir(storeDir, sessionId), "conflict.json");
}

export async function isSessionConflicted(storeDir: string, sessionId: string): Promise<boolean> {
  return await Bun.file(conflictFile(storeDir, sessionId)).exists();
}

/**
 * The Session-Conflict rejection every reading surface throws. A Conflict
 * freezes exactly one Session — it has no Current Revision to answer with
 * until explicitly resolved — while every other Session stays available.
 * Centralized so the code and its next-steps can never drift apart.
 */
export async function requireSessionUnconflicted(
  storeDir: string,
  sessionId: string,
): Promise<void> {
  if (!(await isSessionConflicted(storeDir, sessionId))) return;
  throw new GliaError(
    "SESSION_CONFLICT",
    `session ${sessionId} is frozen in an unresolved Session Conflict; inspect it with \`glia conflicts\` and resolve with \`glia resolve ${sessionId} --revision <digest>\``,
    { sessionId },
  );
}

export async function readSessionConflict(
  storeDir: string,
  sessionId: string,
): Promise<SessionConflictDoc | null> {
  const file = Bun.file(conflictFile(storeDir, sessionId));
  if (!(await file.exists())) return null;
  return JSON.parse(await file.text()) as SessionConflictDoc;
}

export async function listConflictedSessionIds(storeDir: string): Promise<string[]> {
  const ids: string[] = [];
  try {
    const entries = await readdir(sessionsDir(storeDir), { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory() && (await isSessionConflicted(storeDir, entry.name))) {
        ids.push(entry.name);
      }
    }
  } catch {
    // No sessions directory yet.
  }
  return ids.sort();
}

function candidateKeyOf(metaBytes: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(metaBytes);
  return hasher.digest("hex").slice(0, 16);
}

/**
 * Reads the candidate Revisions one merge side contributes. A side is
 * either an ordinary Session directory (one candidate) or an existing
 * conflict layout (its candidates carry over), so re-merging a conflict —
 * or two different resolutions of one — re-enters the same capture.
 */
export async function candidatesFromSideDir(sideDir: string): Promise<ConflictCandidate[]> {
  const metaFile = Bun.file(join(sideDir, "session.json"));
  if (await metaFile.exists()) {
    const bytes = await metaFile.text();
    return [
      {
        key: candidateKeyOf(bytes),
        meta: JSON.parse(bytes) as SessionMeta,
        dir: sideDir,
      },
    ];
  }
  const doc = Bun.file(join(sideDir, "conflict", "conflict.json"));
  if (!(await doc.exists())) return [];
  const parsed = JSON.parse(await doc.text()) as SessionConflictDoc;
  const candidates: ConflictCandidate[] = [];
  for (const summary of parsed.candidates) {
    const dir = join(sideDir, "conflict", "candidates", summary.key);
    const file = Bun.file(join(dir, "session.json"));
    if (!(await file.exists())) continue;
    const bytes = await file.text();
    candidates.push({
      key: candidateKeyOf(bytes),
      meta: JSON.parse(bytes) as SessionMeta,
      dir,
    });
  }
  return candidates;
}

function sortCandidates(candidates: ConflictCandidate[]): ConflictCandidate[] {
  return [...candidates].sort((a, b) => {
    const byDigest = a.meta.currentRevision.digest.localeCompare(b.meta.currentRevision.digest);
    if (byDigest !== 0) return byDigest;
    const byAccepted = a.meta.currentRevision.acceptedAt.localeCompare(
      b.meta.currentRevision.acceptedAt,
    );
    if (byAccepted !== 0) return byAccepted;
    return a.key.localeCompare(b.key);
  });
}

/**
 * Replaces the Session directory with the conflict layout holding every
 * distinct candidate. The caller owns the writer lease and the
 * surrounding merge commit.
 */
export async function writeConflictLayout(
  storeDir: string,
  sessionId: string,
  fromSides: ConflictCandidate[],
): Promise<SessionConflictDoc> {
  const distinct = new Map<string, ConflictCandidate>();
  for (const candidate of fromSides) {
    if (!distinct.has(candidate.key)) distinct.set(candidate.key, candidate);
  }
  const candidates = sortCandidates([...distinct.values()]);
  if (candidates.length < 2) {
    throw new GliaError(
      "INTERNAL",
      `session ${sessionId} conflict capture needs at least two distinct candidates, got ${candidates.length}`,
      { sessionId },
    );
  }

  const target = sessionDir(storeDir, sessionId);
  await rm(target, { recursive: true, force: true });
  const candidatesRoot = join(conflictDir(storeDir, sessionId), "candidates");
  await mkdir(candidatesRoot, { recursive: true });
  for (const candidate of candidates) {
    // Copy exactly the candidate Revision — its metadata and bundle —
    // never any other residue the side directory may carry.
    const dest = join(candidatesRoot, candidate.key);
    await mkdir(dest, { recursive: true });
    await cp(join(candidate.dir, "session.json"), join(dest, "session.json"));
    await cp(join(candidate.dir, "bundle"), join(dest, "bundle"), { recursive: true });
  }
  const doc: SessionConflictDoc = {
    schemaVersion: CONFLICT_SCHEMA_VERSION,
    sessionId,
    candidates: candidates.map((c) => ({
      key: c.key,
      digest: c.meta.currentRevision.digest,
      acceptedAt: c.meta.currentRevision.acceptedAt,
      harnessId: c.meta.harnessId,
      sourceSessionId: c.meta.sourceSessionId,
    })),
  };
  await Bun.write(conflictFile(storeDir, sessionId), JSON.stringify(doc, null, 2) + "\n");
  return doc;
}

/**
 * Selects the candidate `glia resolve` promotes. A digest prefix is
 * accepted when it selects one digest unambiguously. Two candidates may
 * share one digest — identical bundles accepted independently on two
 * machines — and the acceptance metadata is then chosen
 * deterministically: the candidate with the earlier acceptance time.
 */
export function selectCandidate(doc: SessionConflictDoc, digest: string): ConflictCandidateSummary {
  const matching = doc.candidates.filter((c) => c.digest.startsWith(digest));
  if (matching.length === 0) {
    throw new GliaError(
      "NOT_FOUND",
      `session ${doc.sessionId} has no conflict candidate with revision ${digest}`,
      { sessionId: doc.sessionId, digest, candidates: doc.candidates.map((c) => c.digest) },
    );
  }
  const digests = new Set(matching.map((c) => c.digest));
  if (digests.size > 1) {
    throw new GliaError(
      "USAGE",
      `revision ${digest} is ambiguous for session ${doc.sessionId}; give more digits`,
      { sessionId: doc.sessionId, digest, candidates: [...digests] },
    );
  }
  const sorted = [...matching].sort((a, b) => {
    const byAccepted = a.acceptedAt.localeCompare(b.acceptedAt);
    if (byAccepted !== 0) return byAccepted;
    return a.key.localeCompare(b.key);
  });
  return sorted[0]!;
}
