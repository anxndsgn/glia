import { dirname, join } from "node:path";
import { mkdir } from "node:fs/promises";
import type { LoadedProject, StoreDeletionEvent } from "../../core/session-module.ts";
import type { HarnessId } from "../../core/harnesses/ids.ts";
import { GliaError } from "../../core/output/errors.ts";
import { compareDeletionEvents } from "../../core/store/deletion.ts";
import { git, gitBytes, gitOrThrow } from "../../core/store/git.ts";
import { requireSupportedSchemaVersion } from "../../core/state/schema-version.ts";
import { ProjectStore } from "../../core/store/store.ts";
import { readDiscoveryState, writeDiscoveryState } from "./discovery-state.ts";
import { isSessionConflicted, readSessionConflict, type SessionConflictDoc } from "./conflict.ts";
import {
  readSessionMeta,
  sessionDir,
  sessionUnitPath,
  type SessionMeta,
} from "../storage/store-layout.ts";

export const LEDGER_SCHEMA_VERSION = 1;

/**
 * The Session module's Deletion Ledger namespace inside the Store:
 * one file per Source Identity (keyed by its deterministic Session ID),
 * holding the ordered list of that identity's deletion events:
 *
 *   session/deletions/<sessionId>.json
 *
 * Ledger files are Store content: they synchronize like everything else,
 * are append-only for the life of the Store, and carry no payload bytes,
 * no excerpts, and no content digests.
 */
export const SESSION_LEDGER_DIR = "session/deletions";

interface LedgerDoc {
  schemaVersion: number;
  sessionId: string;
  sourceIdentity: { harnessId: string; sourceSessionId: string };
  events: { replicaId: string; deletedAt: string; epoch: number }[];
}

function sortEvents(events: StoreDeletionEvent[]): StoreDeletionEvent[] {
  return [...events].sort(compareDeletionEvents);
}

export function ledgerFilePath(sessionId: string): string {
  return `${SESSION_LEDGER_DIR}/${sessionId}.json`;
}

export function parseLedgerFile(path: string, content: string): StoreDeletionEvent[] {
  if (!path.startsWith(SESSION_LEDGER_DIR + "/") || !path.endsWith(".json")) return [];
  let doc: LedgerDoc;
  try {
    doc = JSON.parse(content) as LedgerDoc;
  } catch {
    return [];
  }
  requireSupportedSchemaVersion("Deletion Ledger", path, doc.schemaVersion, LEDGER_SCHEMA_VERSION);
  if (!Array.isArray(doc.events) || typeof doc.sessionId !== "string") return [];
  return doc.events.map((e) => ({
    unitId: doc.sessionId,
    sourceIdentity: {
      harnessId: doc.sourceIdentity.harnessId,
      sourceSessionId: doc.sourceIdentity.sourceSessionId,
    },
    replicaId: e.replicaId,
    deletedAt: e.deletedAt,
    epoch: e.epoch,
  }));
}

/** Serializes one identity's ordered events; deterministic bytes. */
export function serializeLedgerFile(events: StoreDeletionEvent[]): {
  path: string;
  content: string;
} {
  const ordered = sortEvents(events);
  const first = ordered[0];
  if (!first) throw new Error("a ledger file needs at least one event");
  const doc: LedgerDoc = {
    schemaVersion: LEDGER_SCHEMA_VERSION,
    sessionId: first.unitId,
    sourceIdentity: {
      harnessId: first.sourceIdentity["harnessId"] ?? "",
      sourceSessionId: first.sourceIdentity["sourceSessionId"] ?? "",
    },
    events: ordered.map((e) => ({
      replicaId: e.replicaId,
      deletedAt: e.deletedAt,
      epoch: e.epoch,
    })),
  };
  return { path: ledgerFilePath(first.unitId), content: JSON.stringify(doc, null, 2) + "\n" };
}

/**
 * The same-path ledger merge rule is deterministically mergeable, never
 * a frozen conflict: the union of both sides' events, with concurrent
 * duplicates competing for one epoch slot resolved by earlier deletion
 * timestamp, tie-broken by Replica ID. The losing metadata remains
 * traceable in Store history like any merge input.
 */
export function mergeLedgerEvents(
  a: StoreDeletionEvent[],
  b: StoreDeletionEvent[],
): StoreDeletionEvent[] {
  const bySlot = new Map<number, StoreDeletionEvent>();
  for (const event of sortEvents([...a, ...b])) {
    const existing = bySlot.get(event.epoch);
    if (existing === undefined) {
      bySlot.set(event.epoch, event);
      continue;
    }
    if (existing.replicaId === event.replicaId && existing.deletedAt === event.deletedAt) continue;
    // Earlier timestamp wins the slot; sortEvents already ordered them.
  }
  return sortEvents([...bySlot.values()]);
}

/** Purge both the evidence unit and any archive marker for this identity. */
export function purgePathsFor(event: StoreDeletionEvent): string[] {
  return [sessionUnitPath(event.unitId), `session/archive/${event.unitId}.json`];
}

/**
 * Preserves one Session's content at `commit` into `destDir`,
 * export-shaped — the Store may no longer hold it after the rewrite, so
 * the preserved copy must stand alone.
 */
export async function preserveSessionUnit(
  project: LoadedProject,
  commit: string,
  event: StoreDeletionEvent,
  destDir: string,
): Promise<void> {
  const storeDir = project.paths.storeDir;
  const unit = sessionUnitPath(event.unitId);
  const listing = await gitOrThrow(
    ["ls-tree", "-r", "--name-only", "-z", commit, "--", unit],
    storeDir,
  );
  await mkdir(destDir, { recursive: true });
  for (const path of listing.split("\0")) {
    if (path.length === 0) continue;
    const bytes = await gitBytes(["show", `${commit}:${path}`], storeDir);
    const relative = path.slice(unit.length + 1);
    // Export shape: the bundle's source files under source/, metadata at
    // the root; conflict-layout files keep their layout-relative paths.
    const dest = relative.startsWith("bundle/source/")
      ? join(destDir, "source", relative.slice("bundle/source/".length))
      : join(destDir, relative);
    await mkdir(dirname(dest), { recursive: true });
    await Bun.write(dest, bytes);
  }
  const metaProbe = await git(["show", `${commit}:${unit}/session.json`], storeDir);
  if (metaProbe.exitCode === 0) {
    const meta = JSON.parse(metaProbe.stdout) as SessionMeta;
    const preservationDoc = {
      preservedFrom: { commit, sessionId: event.unitId },
      reason: "unsynchronized local changes to a Session deleted elsewhere",
      sessionId: meta.sessionId,
      revision: meta.currentRevision.digest,
      sourceIdentity: { harnessId: meta.harnessId, sourceSessionId: meta.sourceSessionId },
      acceptedAt: meta.currentRevision.acceptedAt,
    };
    await Bun.write(
      join(destDir, "preserved.json"),
      JSON.stringify(preservationDoc, null, 2) + "\n",
    );
  }
}

/**
 * Collapses machine-local discovery state referencing a deleted Source
 * Identity: explicit associations and persisted evaluations drop; the
 * tombstone classification derives from the ledger at discovery time.
 */
export async function collapseLocalState(
  project: LoadedProject,
  events: StoreDeletionEvent[],
): Promise<void> {
  if (events.length === 0) return;
  const state = await readDiscoveryState(project.paths.discoveryFile);
  let changed = false;
  for (const event of events) {
    if (event.unitId in state.associations) {
      delete state.associations[event.unitId];
      changed = true;
    }
    if (event.unitId in state.evaluations) {
      delete state.evaluations[event.unitId];
      changed = true;
    }
    if (state.ignored.includes(event.unitId)) {
      state.ignored = state.ignored.filter((id) => id !== event.unitId);
      changed = true;
    }
  }
  if (changed) await writeDiscoveryState(project.paths.discoveryFile, state);
}

/** Reads the Deletion Ledger from the Store working tree (local head). */
export async function readLocalLedgerEvents(storeDir: string): Promise<StoreDeletionEvent[]> {
  const dir = join(storeDir, SESSION_LEDGER_DIR);
  const events: StoreDeletionEvent[] = [];
  try {
    const { readdir } = await import("node:fs/promises");
    for (const name of (await readdir(dir)).sort()) {
      if (!name.endsWith(".json")) continue;
      const content = await Bun.file(join(dir, name)).text();
      events.push(...parseLedgerFile(`${SESSION_LEDGER_DIR}/${name}`, content));
    }
  } catch {
    // No ledger namespace yet: a Store that has never deleted.
  }
  return sortEvents(events);
}

/** The deletion events persisted for one Session ID, oldest first. */
export async function ledgerEventsFor(
  storeDir: string,
  sessionId: string,
): Promise<StoreDeletionEvent[]> {
  const file = Bun.file(join(storeDir, ledgerFilePath(sessionId)));
  if (!(await file.exists())) return [];
  return sortEvents(parseLedgerFile(ledgerFilePath(sessionId), await file.text()));
}

/**
 * The one-sentence blocking rule: automatic acceptance is blocked exactly
 * when the identity has a Deletion Ledger entry and no live Session.
 */
export async function isTombstoned(
  storeDir: string,
  sessionId: string,
  events?: StoreDeletionEvent[],
): Promise<boolean> {
  events ??= await ledgerEventsFor(storeDir, sessionId);
  if (events.length === 0) return false;
  const live = await Bun.file(join(sessionDir(storeDir, sessionId), "session.json")).exists();
  return !live && !(await isSessionConflicted(storeDir, sessionId));
}

export interface TombstoneSummary {
  sessionId: string;
  harnessId: HarnessId | string;
  sourceSessionId: string;
  replicaId: string;
  deletedAt: string;
  epoch: number;
}

export function tombstoneSummaries(events: StoreDeletionEvent[]): TombstoneSummary[] {
  return sortEvents(events).map((e) => ({
    sessionId: e.unitId,
    harnessId: e.sourceIdentity["harnessId"] ?? "",
    sourceSessionId: e.sourceIdentity["sourceSessionId"] ?? "",
    replicaId: e.replicaId,
    deletedAt: e.deletedAt,
    epoch: e.epoch,
  }));
}

/**
 * The absent-Session answer. Scripts must distinguish "never existed" from
 * "deleted": a tombstoned Source Identity answers SESSION_DELETED, and only
 * an unknown one answers NOT_FOUND. Every reading surface throws this so
 * the two codes can never drift apart.
 */
/**
 * Resolves the Session's Source Identity for a mutation preview: the
 * Store must be realized, and a Session missing outright answers with
 * `missingSessionError`. A conflict-frozen Session has no Current
 * Revision, so its identity falls back to the first conflict candidate.
 */
export async function resolveSessionIdentity(
  storeDir: string,
  sessionId: string,
): Promise<{
  meta: SessionMeta | null;
  conflict: SessionConflictDoc | null;
  harnessId: string;
  sourceSessionId: string;
}> {
  if (!(await new ProjectStore(storeDir).exists())) {
    throw new GliaError(
      "STORE_NOT_REALIZED",
      "this Project has no local Store; run `glia sync` first",
    );
  }
  const meta = await readSessionMeta(storeDir, sessionId);
  const conflict = await readSessionConflict(storeDir, sessionId);
  if (!meta && !conflict) throw await missingSessionError(storeDir, sessionId);
  const identity = meta
    ? { harnessId: meta.harnessId as string, sourceSessionId: meta.sourceSessionId }
    : {
        harnessId: conflict!.candidates[0]?.harnessId ?? "(unknown)",
        sourceSessionId: conflict!.candidates[0]?.sourceSessionId ?? "(unknown)",
      };
  return { meta, conflict, ...identity };
}

export async function missingSessionError(storeDir: string, sessionId: string): Promise<GliaError> {
  const events = await ledgerEventsFor(storeDir, sessionId);
  const last = events[events.length - 1];
  if (last) {
    return new GliaError(
      "SESSION_DELETED",
      `session ${sessionId} was deleted at ${last.deletedAt} by replica ${last.replicaId} (epoch ${last.epoch})`,
      { sessionId, deletedAt: last.deletedAt, replicaId: last.replicaId, epoch: last.epoch },
    );
  }
  return new GliaError("NOT_FOUND", `no session ${sessionId}`, { sessionId });
}
