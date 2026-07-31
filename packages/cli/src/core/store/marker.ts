import { join } from "node:path";
import { GliaError } from "../output/errors.ts";
import { git } from "./git.ts";
import type { ProjectStore } from "./store.ts";

/** The newest Store format this Glia understands. */
export const STORE_FORMAT_VERSION = 1;

export const STORE_MARKER_FILE = "store.json";

/** The Store identity and format marker at the Store repository root. */
export interface StoreMarker {
  storeFormatVersion: number;
  projectId: string;
  /** Total order of sanctioned rewrites. */
  epoch: number;
}

/**
 * Marker bytes for a Store at `epoch`. Deterministic — two Replicas
 * writing the same epoch produce byte-identical content, so their commits
 * merge cleanly. One code path, because that byte-identity is the point.
 */
export function deletionMarkerBytes(projectId: string, epoch: number): string {
  const marker: StoreMarker = {
    storeFormatVersion: STORE_FORMAT_VERSION,
    projectId,
    epoch,
  };
  return JSON.stringify(marker, null, 2) + "\n";
}

/** Marker bytes for a Store that has never been rewritten. */
export function storeMarkerBytes(projectId: string): string {
  return deletionMarkerBytes(projectId, 0);
}

export function markerEpoch(marker: StoreMarker | null): number {
  return marker?.epoch ?? 0;
}

function parseMarker(text: string, source: string): StoreMarker {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new GliaError("STORE_MISMATCH", `${source} carries a malformed store.json`, { source });
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj["storeFormatVersion"] !== "number" || typeof obj["projectId"] !== "string") {
    throw new GliaError("STORE_MISMATCH", `${source} carries a malformed store.json`, { source });
  }
  return {
    storeFormatVersion: obj["storeFormatVersion"],
    projectId: obj["projectId"],
    epoch: typeof obj["epoch"] === "number" ? obj["epoch"] : 0,
  };
}

/** Reads the marker from a Store working tree; null when unmigrated. */
export async function readLocalStoreMarker(storeDir: string): Promise<StoreMarker | null> {
  const file = Bun.file(join(storeDir, STORE_MARKER_FILE));
  if (!(await file.exists())) return null;
  return parseMarker(await file.text(), storeDir);
}

/** Reads the marker committed at `rev`; null when that commit has none. */
export async function readStoreMarkerAtRev(
  storeDir: string,
  rev: string,
  source: string,
): Promise<StoreMarker | null> {
  const result = await git(["show", `${rev}:${STORE_MARKER_FILE}`], storeDir);
  if (result.exitCode !== 0) return null;
  return parseMarker(result.stdout, source);
}

/**
 * Refuses a Store that is not this Project's, or one written by a newer
 * Glia. A `null` marker on an existing history is a `STORE_MISMATCH`: no
 * Glia release able to push has ever existed without the marker, so an
 * unmarked history is not a Store.
 */
export function validateStoreMarker(
  marker: StoreMarker | null,
  projectId: string,
  source: string,
): void {
  if (marker === null) {
    throw new GliaError(
      "STORE_MISMATCH",
      `${source} has history but no store.json marker, so it is not a Glia Store; check the URL`,
      { source, reason: "missing_marker" },
    );
  }
  if (marker.projectId !== projectId) {
    throw new GliaError(
      "STORE_MISMATCH",
      `${source} belongs to project ${marker.projectId}, not ${projectId}; check the URL`,
      { source, reason: "project_mismatch", expected: projectId, actual: marker.projectId },
    );
  }
  if (marker.storeFormatVersion > STORE_FORMAT_VERSION) {
    throw new GliaError(
      "STATE_TOO_NEW",
      `${source} uses store format ${marker.storeFormatVersion}, newer than this Glia understands (${STORE_FORMAT_VERSION}); upgrade Glia`,
      { source, storeFormatVersion: marker.storeFormatVersion, supported: STORE_FORMAT_VERSION },
    );
  }
}

export interface StorePreparation {
  /** Head of the recovery commit for crashed-operation residue, when one was needed. */
  recoveryCommit: string | null;
  /** Head of the one-time marker backfill commit, when the migration ran. */
  backfillCommit: string | null;
}

export interface PrepareStoreOptions {
  /** Extra fields for the recovery commit's trailer. */
  recoveryDetails?: Record<string, unknown>;
  /**
   * When false, crashed-operation residue is committed only if the
   * marker backfill needs a clean tree — a projection rebuild triggered
   * by a query should not otherwise mutate the Store.
   */
  recoverAlways?: boolean;
}

/**
 * Runs at the start of any operation that acquires the writer lease:
 * commits crashed-operation residue first (so the backfill commit never
 * silently absorbs it), then backfills a missing `store.json` as its own
 * Store commit — the one-time migration every Store converges through —
 * then validates the marker. The caller owns the writer lease.
 */
export async function prepareStoreForWrite(
  store: ProjectStore,
  projectId: string,
  options: PrepareStoreOptions = {},
): Promise<StorePreparation> {
  const recoverAlways = options.recoverAlways !== false;
  const needsBackfill = (await readLocalStoreMarker(store.dir)) === null;

  let recoveryCommit: string | null = null;
  if (recoverAlways || needsBackfill) {
    recoveryCommit = await store.commitRecoveryIfDirty(options.recoveryDetails ?? { projectId });
  }
  let backfillCommit: string | null = null;
  if (needsBackfill) {
    await Bun.write(join(store.dir, STORE_MARKER_FILE), storeMarkerBytes(projectId));
    backfillCommit = await store.commitAll(
      `glia: mark store format (storeFormatVersion ${STORE_FORMAT_VERSION})\n\nglia-op: ${JSON.stringify({ op: "store.mark", projectId })}`,
    );
  }
  validateStoreMarker(await readLocalStoreMarker(store.dir), projectId, store.dir);
  return { recoveryCommit, backfillCommit };
}
