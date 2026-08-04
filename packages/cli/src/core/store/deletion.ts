import { dirname, join } from "node:path";
import { mkdir, readdir, rm } from "node:fs/promises";
import type { SessionModule, StoreDeletionEvent } from "../session-module.ts";
import { GliaError } from "../output/errors.ts";
import { writeJsonAtomic } from "../state/atomic-file.ts";
import { requireSupportedSchemaVersion } from "../state/schema-version.ts";
import { git, gitOrThrow } from "./git.ts";
import { COMMIT_IDENTITY_ENV } from "./store.ts";
import { deletionMarkerBytes, STORE_MARKER_FILE } from "./marker.ts";

/**
 * The verbatim erasure-limitation statement every successful deletion
 * output must include, in both human and JSON form.
 */
export const DELETION_LIMITATION =
  "Glia has removed the content from this Replica and will propagate the deletion through synchronization, but it cannot erase independent remotes, offline copies, or backups it does not control.";

/** A deletion event tagged with the module namespace that owns it. */
export interface OwnedDeletionEvent {
  contextId: string;
  event: StoreDeletionEvent;
}

/** The ledger file one event belongs to: its namespace and unit. */
function unitKey(owned: OwnedDeletionEvent): string {
  return `${owned.contextId}\n${owned.event.unitId}`;
}

/** One unit's epoch slot — the granularity concurrent deletions compete for. */
function slotKey(owned: OwnedDeletionEvent): string {
  return `${unitKey(owned)}\n${owned.event.epoch}`;
}

/** The stable identity of one ledger event across Replicas. */
export function eventKey(owned: OwnedDeletionEvent): string {
  const e = owned.event;
  return `${slotKey(owned)}\n${e.deletedAt}\n${e.replicaId}`;
}

/** The deterministic total order of events: epoch, timestamp, Replica ID. */
export function compareDeletionEvents(a: StoreDeletionEvent, b: StoreDeletionEvent): number {
  if (a.epoch !== b.epoch) return a.epoch - b.epoch;
  const byTime = a.deletedAt.localeCompare(b.deletedAt);
  if (byTime !== 0) return byTime;
  return a.replicaId.localeCompare(b.replicaId);
}

/** The same total order over namespace-tagged events. */
export function compareEvents(a: OwnedDeletionEvent, b: OwnedDeletionEvent): number {
  return compareDeletionEvents(a.event, b.event);
}

function hookOf(modules: readonly SessionModule[], contextId: string) {
  const module = modules.find((p) => p.id === contextId);
  if (!module?.deletion) {
    throw new GliaError("INTERNAL", `no deletion hook for context ${contextId}`, { contextId });
  }
  return module.deletion;
}

/** True when a Store-relative path belongs to a Deletion Ledger namespace. */
export function isLedgerPath(modules: readonly SessionModule[], path: string): boolean {
  return modules.some((p) => p.deletion && path.startsWith(p.deletion.ledgerDir + "/"));
}

/** Reads every module's complete Deletion Ledger as committed at `rev`. */
export async function readLedgerAtRev(
  storeDir: string,
  rev: string,
  modules: readonly SessionModule[],
): Promise<OwnedDeletionEvent[]> {
  const events: OwnedDeletionEvent[] = [];
  for (const module of modules) {
    if (!module.deletion) continue;
    const listing = await git(
      ["ls-tree", "-r", "--name-only", "-z", rev, "--", module.deletion.ledgerDir],
      storeDir,
    );
    if (listing.exitCode !== 0) continue;
    for (const path of listing.stdout.split("\0")) {
      if (path.length === 0) continue;
      const content = await gitOrThrow(["show", `${rev}:${path}`], storeDir);
      for (const event of module.deletion.parseLedgerFile(path, content)) {
        events.push({ contextId: module.id, event });
      }
    }
  }
  return events.sort(compareEvents);
}

/** Events present in `at` but absent from `base`, in deterministic order. */
export function eventsBeyond(
  at: OwnedDeletionEvent[],
  base: OwnedDeletionEvent[],
): OwnedDeletionEvent[] {
  const known = new Set(base.map(eventKey));
  return at.filter((e) => !known.has(eventKey(e))).sort(compareEvents);
}

/** The purge paths for a set of events, deduplicated, in event order. */
export function purgePathsOf(
  modules: readonly SessionModule[],
  events: OwnedDeletionEvent[],
): string[] {
  const paths: string[] = [];
  const seen = new Set<string>();
  for (const owned of [...events].sort(compareEvents)) {
    for (const path of hookOf(modules, owned.contextId).purgePathsFor(owned.event)) {
      if (seen.has(path)) continue;
      seen.add(path);
      paths.push(path);
    }
  }
  return paths;
}

export function maxEpoch(events: OwnedDeletionEvent[]): number {
  return events.reduce((max, e) => Math.max(max, e.event.epoch), 0);
}

export interface RewriteResult {
  newHead: string;
  /** Every reachable pre-rewrite commit mapped to its rewritten image. */
  map: Map<string, string>;
}

/**
 * The deterministic replay engine is a pure function of the pre-rewrite
 * history and the ordered purge paths. Every commit maps
 * one-to-one — the raw commit object is reproduced byte-for-byte with
 * only the tree and parent lines replaced, so author, committer,
 * timestamps, message, and order are preserved exactly, tree-unchanged
 * commits are kept rather than dropped, and any two Replicas produce
 * byte-identical rewritten histories. Objects are written aside into the
 * object database; no reference moves here.
 */
export async function rewriteHistoryPurging(
  storeDir: string,
  headRev: string,
  purgePaths: string[],
): Promise<RewriteResult> {
  const head = (await gitOrThrow(["rev-parse", `${headRev}^{commit}`], storeDir)).trim();
  if (purgePaths.length === 0) return { newHead: head, map: new Map([[head, head]]) };
  const listing = await gitOrThrow(["rev-list", "--topo-order", "--reverse", head], storeDir);
  const commits = listing
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0);

  const map = new Map<string, string>();
  const treeCache = new Map<string, string>();
  const indexFile = join(storeDir, ".git", `glia-rewrite-index-${process.pid}`);
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    for (const commit of commits) {
      const raw = await gitOrThrow(["cat-file", "commit", commit], storeDir);
      const split = raw.indexOf("\n\n");
      const header = split === -1 ? raw : raw.slice(0, split);
      const rest = split === -1 ? "" : raw.slice(split);

      const lines = header.split("\n");
      const newLines: string[] = [];
      for (const line of lines) {
        if (line.startsWith("tree ")) {
          const tree = line.slice("tree ".length).trim();
          let filtered = treeCache.get(tree);
          if (filtered === undefined) {
            await gitOrThrow(["read-tree", tree], storeDir, { env });
            const removal = await git(
              ["rm", "-r", "-f", "--cached", "--ignore-unmatch", "-q", "--", ...purgePaths],
              storeDir,
              { env },
            );
            if (removal.exitCode !== 0) {
              throw new GliaError("GIT_FAILED", `git rm failed: ${removal.stderr.trim()}`, {
                tree,
              });
            }
            filtered = (await gitOrThrow(["write-tree"], storeDir, { env })).trim();
            treeCache.set(tree, filtered);
          }
          newLines.push(`tree ${filtered}`);
        } else if (line.startsWith("parent ")) {
          const parent = line.slice("parent ".length).trim();
          const mapped = map.get(parent);
          if (mapped === undefined) {
            throw new GliaError("INTERNAL", `rewrite met unmapped parent ${parent}`, { commit });
          }
          newLines.push(`parent ${mapped}`);
        } else {
          newLines.push(line);
        }
      }
      const rewritten = (
        await gitOrThrow(["hash-object", "-t", "commit", "-w", "--stdin"], storeDir, {
          stdin: newLines.join("\n") + rest,
        })
      ).trim();
      map.set(commit, rewritten);
    }
  } finally {
    await rm(indexFile, { force: true });
  }
  const newHead = map.get(head);
  if (newHead === undefined) {
    throw new GliaError("INTERNAL", `rewrite produced no image for head ${head}`);
  }
  return { newHead, map };
}

/**
 * Builds the commit sessioning ledger events and the epoch increment on
 * top of `parent`, aside via a temporary index — the working tree and
 * every reference stay untouched until the caller's atomic switch.
 */
export async function buildLedgerCommit(
  storeDir: string,
  parent: string,
  projectId: string,
  epoch: number,
  ledgerFiles: { path: string; content: string }[],
  message: string,
): Promise<string> {
  const indexFile = join(storeDir, ".git", `glia-ledger-index-${process.pid}`);
  const env = { GIT_INDEX_FILE: indexFile };
  try {
    await gitOrThrow(["read-tree", `${parent}^{tree}`], storeDir, { env });
    const files: { path: string; content: string }[] = [
      { path: STORE_MARKER_FILE, content: deletionMarkerBytes(projectId, epoch) },
      ...ledgerFiles,
    ];
    for (const file of files) {
      const blob = (
        await gitOrThrow(["hash-object", "-w", "--stdin"], storeDir, { stdin: file.content })
      ).trim();
      await gitOrThrow(
        ["update-index", "--add", "--cacheinfo", `100644,${blob},${file.path}`],
        storeDir,
        { env },
      );
    }
    const tree = (await gitOrThrow(["write-tree"], storeDir, { env })).trim();
    return (
      await gitOrThrow(["commit-tree", tree, "-p", parent], storeDir, {
        env: { ...env, ...COMMIT_IDENTITY_ENV },
        stdin: message,
      })
    ).trim();
  } finally {
    await rm(indexFile, { force: true });
  }
}

/**
 * Purges unreachable objects — deleted payload, and payload transiently
 * re-materialized by fetching from a not-yet-rewritten remote — so the
 * Replica's cleanliness invariant holds when the operation reports done.
 */
export async function purgeUnreachableObjects(storeDir: string): Promise<void> {
  // FETCH_HEAD may still name a pre-rewrite remote head; drop it so the
  // transiently fetched payload objects below are truly unreachable.
  await rm(join(storeDir, ".git", "FETCH_HEAD"), { force: true });
  await gitOrThrow(["reflog", "expire", "--expire=now", "--all"], storeDir);
  await gitOrThrow(["gc", "--prune=now", "--quiet"], storeDir);
}

/**
 * Machine-local propagation state for deletions this Replica performed
 * but has not yet pushed. `baseHead` is the pre-rewrite last synchronized
 * state — kept as a bare SHA, never a ref, so it retains no objects.
 */
export interface DeletionPendingState {
  schemaVersion: number;
  /** Pre-rewrite last synchronized remote head; null when never synced. */
  baseHead: string | null;
  events: OwnedDeletionEvent[];
}

export async function readDeletionPending(file: string): Promise<DeletionPendingState | null> {
  const f = Bun.file(file);
  if (!(await f.exists())) return null;
  let raw: DeletionPendingState;
  try {
    raw = JSON.parse(await f.text()) as DeletionPendingState;
  } catch {
    return null;
  }
  requireSupportedSchemaVersion("deletion propagation state", file, raw.schemaVersion, 1);
  if (!Array.isArray(raw.events)) return null;
  return { schemaVersion: 1, baseHead: raw.baseHead ?? null, events: raw.events };
}

export async function writeDeletionPending(
  file: string,
  state: DeletionPendingState | null,
): Promise<void> {
  if (state === null) {
    await rm(file, { force: true });
    return;
  }
  await writeJsonAtomic(file, state);
}

/** Counts preserved bystander items awaiting explicit disposition. */
export async function countPreservedItems(preservedDir: string): Promise<number> {
  try {
    const runs = await readdir(preservedDir, { withFileTypes: true });
    let count = 0;
    for (const run of runs) {
      if (!run.isDirectory()) continue;
      const items = await readdir(join(preservedDir, run.name), { withFileTypes: true });
      count += items.filter((i) => i.isDirectory()).length;
    }
    return count;
  } catch {
    return 0;
  }
}

/**
 * Reconciles ledger events when two histories merge: the union of both
 * sides, same-slot duplicates resolved by each namespace's merge rule.
 *
 * In a merge without a rewrite relationship (ordinary divergence, or the
 * no-common-ancestor case) epochs are kept as-is: equal epoch numbers
 * from disjoint prefixes are harmless, and the merged epoch is the larger
 * of the two. When `renumberLocal` is set — the concurrent-push loser
 * re-deriving its deletion on top of the winner's verified rewrite — the
 * events only the local side holds are renumbered to consecutive epochs
 * after the remote's maximum: they were never published, so renumbering
 * breaks no other Replica's verification chain, while remote events keep
 * the slots other Replicas already verified against.
 */
export function reconcileLedgers(
  modules: readonly SessionModule[],
  local: OwnedDeletionEvent[],
  remote: OwnedDeletionEvent[],
  renumberLocal: boolean,
): { events: OwnedDeletionEvent[]; epoch: number } {
  let localEvents = local;
  if (renumberLocal) {
    const remoteKeys = new Set(remote.map(eventKey));
    // A local event competing with a remote event for the same unit's
    // same slot is a concurrent duplicate — the merge rule resolves it;
    // renumbering would turn one deletion into two.
    const remoteSlots = new Set(remote.map(slotKey));
    const kept = local.filter((e) => remoteKeys.has(eventKey(e)) || remoteSlots.has(slotKey(e)));
    const pending = local.filter((e) => !kept.includes(e)).sort(compareEvents);
    const remoteMax = maxEpoch(remote);
    const collides = pending.some((e) => e.event.epoch <= remoteMax);
    if (collides) {
      localEvents = [
        ...kept,
        ...pending.map((owned, i) => ({
          contextId: owned.contextId,
          event: { ...owned.event, epoch: remoteMax + 1 + i },
        })),
      ];
    }
  }

  // Per-namespace, per-unit union under the module's own merge rule.
  const byFile = new Map<
    string,
    { contextId: string; a: StoreDeletionEvent[]; b: StoreDeletionEvent[] }
  >();
  for (const [side, list] of [
    ["a", localEvents],
    ["b", remote],
  ] as const) {
    for (const owned of list) {
      const key = unitKey(owned);
      let entry = byFile.get(key);
      if (!entry) {
        entry = { contextId: owned.contextId, a: [], b: [] };
        byFile.set(key, entry);
      }
      entry[side].push(owned.event);
    }
  }
  const merged: OwnedDeletionEvent[] = [];
  for (const entry of byFile.values()) {
    const hook = hookOf(modules, entry.contextId);
    for (const event of hook.mergeLedgerEvents(entry.a, entry.b)) {
      merged.push({ contextId: entry.contextId, event });
    }
  }
  const events = merged.sort(compareEvents);
  return { events, epoch: maxEpoch(events) };
}

/** Groups events by owning namespace for ledger serialization. */
export function ledgerWritesOf(
  events: OwnedDeletionEvent[],
): { contextId: string; unitId: string; events: StoreDeletionEvent[] }[] {
  const byUnit = new Map<
    string,
    { contextId: string; unitId: string; events: StoreDeletionEvent[] }
  >();
  for (const owned of [...events].sort(compareEvents)) {
    const key = unitKey(owned);
    let entry = byUnit.get(key);
    if (!entry) {
      entry = { contextId: owned.contextId, unitId: owned.event.unitId, events: [] };
      byUnit.set(key, entry);
    }
    entry.events.push(owned.event);
  }
  return [...byUnit.values()];
}
