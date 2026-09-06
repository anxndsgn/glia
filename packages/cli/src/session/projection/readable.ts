import { Database } from "bun:sqlite";
import { join } from "node:path";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { withProgress } from "../../core/output/progress.ts";
import type { CommandRunContext, LoadedProject } from "../../core/session-module.ts";
import { WriterLease, writerLeaseTimeoutMs } from "../../core/store/lease.ts";
import { ProjectStore } from "../../core/store/store.ts";
import { adapterFor } from "../adapters/index.ts";
import type { SessionCandidate } from "../adapters/types.ts";
import { readJsonlLines } from "../adapters/jsonl.ts";
import { discoverCandidates } from "../domain/discover.ts";
import { listArchiveMarkers } from "../domain/archive.ts";
import { readSessionConflict } from "../domain/conflict.ts";
import { locallyForgotten } from "../domain/local-state.ts";
import { readCacheRoot, readCacheLock } from "../../core/project/read-cache.ts";
import { loadProjectForRead } from "../../core/project/load.ts";
import { GliaError } from "../../core/output/errors.ts";
import { bundleDigest, manifestOf } from "../storage/bundle.ts";
import {
  listSessionIds,
  readSessionMeta,
  readStoredBundle,
  SESSION_META_SCHEMA_VERSION,
} from "../storage/store-layout.ts";
import {
  projectInputs,
  removeProjectedSession,
  validateProjection,
  type ProjectionInput,
} from "./build.ts";
import { createProjectionSchema, PROJECTION_VERSION, EMPTY_PROJECTION_PATH } from "./schema.ts";
import { detectFamilies } from "./family.ts";
import { ensureProjection } from "./publish.ts";
import { openProjection } from "./query.ts";

export interface ReadSource {
  source: "local" | "store";
  saved: boolean;
  revisionDigest: string;
  savedRevisionDigest: string | null;
  savedVersionBehind: boolean;
  /** Resolves bundle-relative locators to the actual source; absent for Store evidence. */
  files?: Record<string, string>;
}
export interface ReadIssue {
  harnessId?: string;
  sessionId?: string;
  message: string;
}
export interface ReadableProjection {
  db: Database;
  storeCommit: string;
  stale: boolean;
  sources: Record<string, ReadSource>;
  issues: ReadIssue[];
}

export function queryProjection(
  ctx: CommandRunContext,
  savedOnly = false,
): Promise<ReadableProjection> {
  return withProgress(
    ctx,
    "Refreshing Session search index",
    (handle) =>
      handle.issues.length > 0 ? "Search index ready (partial sources)" : "Search index ready",
    () => ensureReadableProjection(ctx.project, ctx.env, savedOnly),
  );
}

async function signature(candidate: SessionCandidate): Promise<string> {
  const files = await Promise.all(
    candidate.sourceFiles.map(async (ref) => {
      const info = await stat(ref.absolutePath);
      return [ref.bundlePath, ref.absolutePath, info.size, info.mtimeMs, info.ctimeMs, info.ino];
    }),
  );
  return JSON.stringify([
    candidate.identity,
    candidate.openingPath,
    candidate.continuation,
    candidate.subagent,
    files,
  ]);
}

/** Query a coherent SQLite snapshot containing saved evidence and current local Sessions.
 * Only changed Sessions are normalized. Raw local captures are temporary and never enter Git.
 * Missing/failed sources cannot keep an old local cache masquerading as live evidence. */
export async function ensureReadableProjection(
  project: LoadedProject,
  env: Record<string, string | undefined>,
  savedOnly = false,
): Promise<ReadableProjection> {
  const hasStore = await new ProjectStore(project.paths.storeDir).exists();
  if (savedOnly && !hasStore) {
    return {
      db: openProjection(EMPTY_PROJECTION_PATH),
      storeCommit: "",
      stale: false,
      sources: {},
      issues:
        project.declaration.store.remote === undefined
          ? []
          : [
              {
                message:
                  "The declared remote Store has not been synchronized locally; run glia sync",
              },
            ],
    };
  }
  if (savedOnly) {
    const handle = await ensureProjection(project, env);
    const db = openProjection(handle.dbPath);
    db.run("BEGIN");
    const rows = db
      .query("SELECT session_id AS id, revision_digest AS digest FROM sessions")
      .all() as { id: string; digest: string }[];
    return {
      db,
      storeCommit: handle.storeCommit,
      stale: handle.stale,
      issues: [],
      sources: Object.fromEntries(
        rows.map((r) => [
          r.id,
          {
            source: "store",
            saved: true,
            revisionDigest: r.digest,
            savedRevisionDigest: r.digest,
            savedVersionBehind: false,
          },
        ]),
      ),
    };
  }
  // Serialize with Store import/sync/deletion before observing its working tree.
  const storeLease = hasStore
    ? await WriterLease.acquire(project.paths.writerLockFile, writerLeaseTimeoutMs(env))
    : null;
  let cacheLease: WriterLease | null = null;
  let db: Database | null = null;
  let staging: string | null = null;
  try {
    cacheLease = await WriterLease.acquire(readCacheLock(project.home), writerLeaseTimeoutMs(env));
    // A reader resolved before enrollment must not recreate the retired cache.
    if (project.enrollment.kind === "unenrolled") {
      const current = await loadProjectForRead(project.worktree, project.home);
      if (current.declaration.projectId !== project.declaration.projectId) {
        throw new GliaError(
          "BINDING_CHANGED",
          "Project was enrolled during query preparation; repeat the query",
        );
      }
    }
    const root = readCacheRoot(project.home);
    await mkdir(root, { recursive: true, mode: 0o700 });
    // The cache writer lease proves any prior capture directory is crash residue.
    for (const entry of await readdir(root, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith("capture-"))
        await rm(join(root, entry.name), { recursive: true, force: true });
    }
    const dbPath = join(root, `${project.declaration.projectId}-v${PROJECTION_VERSION}.sqlite`);
    const exists = await Bun.file(dbPath).exists();
    db = new Database(dbPath, { create: true });
    db.run("PRAGMA journal_mode = WAL");
    db.run("PRAGMA secure_delete = ON");
    if (
      !exists ||
      db.query("SELECT name FROM sqlite_master WHERE name = 'sessions'").get() === null
    ) {
      db.run("BEGIN");
      createProjectionSchema(db);
      db.run(
        "CREATE TABLE read_sources (session_id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, source_json TEXT NOT NULL)",
      );
      db.run("COMMIT");
    }
    db.run("BEGIN IMMEDIATE");
    const previous = new Map(
      (
        db
          .query("SELECT session_id AS id, fingerprint, source_json AS source FROM read_sources")
          .all() as { id: string; fingerprint: string; source: string }[]
      ).map((r) => [r.id, r]),
    );
    const sources: Record<string, ReadSource> = {};
    const issues: ReadIssue[] = [];
    if (!hasStore && project.declaration.store.remote !== undefined) {
      issues.push({
        message:
          "The declared remote Store has not been synchronized on this machine; run glia sync for saved evidence",
      });
    }
    const seen = new Set<string>();
    const forgotten = await locallyForgotten(project.home);
    const discovery = await discoverCandidates(project, env, null);
    issues.push(
      ...discovery.adapterFailures.map((f) => ({ harnessId: f.harnessId, message: f.message })),
    );
    // An absent Harness is normal. Configured but unreadable roots are reported by adapters.
    const candidates = new Map(
      discovery.candidates
        .filter(
          (c) => c.classification.kind === "associated" && !forgotten.has(c.candidate.candidateId),
        )
        .map((c) => [c.candidate.candidateId, c.candidate]),
    );
    const storedIds = hasStore ? await listSessionIds(project.paths.storeDir) : [];
    const archiveStates = new Map(
      (hasStore ? await listArchiveMarkers(project.paths.storeDir) : []).map((m) => [
        m.sessionId,
        m.state,
      ]),
    );
    const ids = [...new Set([...storedIds, ...candidates.keys()])].sort();
    staging = await mkdtemp(join(root, "capture-"));
    const database = db;
    let changed = false;
    const upsert = async (
      id: string,
      fingerprint: string,
      source: ReadSource,
      input: () => Promise<ProjectionInput>,
    ) => {
      if (previous.get(id)?.fingerprint !== fingerprint) {
        changed = true;
        database.run("SAVEPOINT session_update");
        try {
          const value = await input();
          await projectInputs(
            database,
            (async function* () {
              yield value;
            })(),
          );
          database.run("RELEASE session_update");
        } catch (error) {
          database.run("ROLLBACK TO session_update");
          database.run("RELEASE session_update");
          throw error;
        }
      }
      if (
        previous.get(id)?.fingerprint !== fingerprint ||
        previous.get(id)?.source !== JSON.stringify(source)
      ) {
        database.run("INSERT OR REPLACE INTO read_sources VALUES (?, ?, ?)", [
          id,
          fingerprint,
          JSON.stringify(source),
        ]);
      }
      sources[id] = source;
      seen.add(id);
    };
    for (const id of ids) {
      if (forgotten.has(id)) continue;
      // Frozen saved evidence must not be silently resolved by a local source.
      if (hasStore && (await readSessionConflict(project.paths.storeDir, id))) {
        issues.push({ sessionId: id, message: "Session has an unresolved Store conflict" });
        continue;
      }
      const saved = hasStore ? await readSessionMeta(project.paths.storeDir, id) : null;
      const archiveState = archiveStates.get(id) ?? "active";
      const candidate = candidates.get(id);
      if (candidate !== undefined) {
        const captureDir = join(staging, id);
        try {
          const before = await signature(candidate);
          const fingerprint = JSON.stringify([before, saved, archiveState]);
          const cached = previous.get(id);
          if (cached?.fingerprint === fingerprint) {
            sources[id] = JSON.parse(cached.source) as ReadSource;
            seen.add(id);
            continue;
          }
          const captured = await adapterFor(candidate.identity.harnessId).capture(candidate, {
            dir: captureDir,
          });
          const manifest = manifestOf(captured);
          const digest = bundleDigest(manifest);
          // Appends during a query are a valid snapshot, but require refresh next time.
          const after = await signature(candidate);
          if (before !== after)
            issues.push({
              sessionId: id,
              message: "Source changed during indexing; query again for newer content",
            });
          for (const file of manifest.files.filter((f) => f.path.endsWith(".jsonl"))) {
            if (
              (await readJsonlLines(join(captureDir, file.path))).some(
                (line) => line.value === null,
              )
            ) {
              issues.push({
                sessionId: id,
                message: `Unparseable source records in ${file.path}; results are partial`,
              });
            }
          }
          // A shorter native copy must not replace a saved superset received from another machine.
          if (saved !== null && digest !== saved.currentRevision.digest) {
            const storedBundle = await readStoredBundle(project.paths.storeDir, id);
            let prefix = true;
            for (const file of manifest.files) {
              const retained = storedBundle.manifest.files.find((f) => f.path === file.path);
              if (retained === undefined || retained.size < file.size) {
                prefix = false;
                break;
              }
              const localBytes = await Bun.file(join(captureDir, file.path)).bytes();
              const savedBytes = await Bun.file(join(storedBundle.dir, file.path)).bytes();
              if (
                !Buffer.from(savedBytes.subarray(0, localBytes.length)).equals(
                  Buffer.from(localBytes),
                )
              ) {
                prefix = false;
                break;
              }
            }
            if (prefix) {
              await upsert(
                id,
                fingerprint,
                {
                  source: "store",
                  saved: true,
                  revisionDigest: saved.currentRevision.digest,
                  savedRevisionDigest: saved.currentRevision.digest,
                  savedVersionBehind: false,
                },
                async () => ({ meta: saved, bundle: storedBundle, archiveState }),
              );
              continue;
            }
          }
          const source: ReadSource = {
            source: saved?.currentRevision.digest === digest ? "store" : "local",
            saved: saved !== null,
            revisionDigest: digest,
            savedRevisionDigest: saved?.currentRevision.digest ?? null,
            savedVersionBehind: saved !== null && saved.currentRevision.digest !== digest,
            files: Object.fromEntries(
              candidate.sourceFiles.map((f) => [f.bundlePath, f.absolutePath]),
            ),
          };
          if (source.source === "store") delete source.files;
          await upsert(
            id,
            before === after && !issues.some((i) => i.sessionId === id)
              ? fingerprint
              : `${fingerprint}:retry`,
            source,
            async () => ({
              meta: {
                schemaVersion: SESSION_META_SCHEMA_VERSION,
                sessionId: id,
                harnessId: candidate.identity.harnessId,
                sourceSessionId: candidate.identity.sourceSessionId,
                openingPath: candidate.openingPath,
                association: saved?.association ?? {
                  mode: "inferred",
                  evidence: "Local Project scope",
                },
                continuation: candidate.continuation,
                ...(candidate.subagent ? { subagent: candidate.subagent } : {}),
                currentRevision: {
                  digest,
                  acceptedAt:
                    digest === saved?.currentRevision.digest
                      ? saved.currentRevision.acceptedAt
                      : null,
                },
              },
              bundle: { sessionId: id, dir: captureDir, manifest },
              archiveState,
            }),
          );
          continue;
        } catch (error) {
          issues.push({
            sessionId: id,
            harnessId: candidate.identity.harnessId,
            message: error instanceof Error ? error.message : String(error),
          });
        } finally {
          await rm(captureDir, { recursive: true, force: true });
        }
      }
      if (saved !== null) {
        const digest = saved.currentRevision.digest;
        try {
          await upsert(
            id,
            JSON.stringify(["store", saved, archiveState]),
            {
              source: "store",
              saved: true,
              revisionDigest: digest,
              savedRevisionDigest: digest,
              savedVersionBehind: false,
            },
            async () => ({
              meta: saved,
              bundle: await readStoredBundle(project.paths.storeDir, id),
              archiveState,
            }),
          );
        } catch (error) {
          issues.push({
            sessionId: id,
            message: error instanceof Error ? error.message : String(error),
          });
        }
      }
    }
    for (const id of previous.keys())
      if (!seen.has(id)) {
        changed = true;
        removeProjectedSession(db, id);
        db.run("DELETE FROM read_sources WHERE session_id = ?", [id]);
      }
    if (changed) {
      db.run("DELETE FROM session_families");
      detectFamilies(db);
      validateProjection(db, seen.size);
    }
    const storeCommit = hasStore ? await new ProjectStore(project.paths.storeDir).head() : "";
    db.run("COMMIT");
    // Pin the exact data snapshot before releasing either writer lease.
    db.run("BEGIN");
    db.query("SELECT count(*) FROM sessions").get();
    const handle = { db, storeCommit, stale: false, sources, issues };
    db = null;
    return handle;
  } finally {
    db?.close();
    if (staging !== null) await rm(staging, { recursive: true, force: true });
    cacheLease?.release();
    storeLease?.release();
  }
}

/** Evidence metadata is emitted once per visible Session, including compact search layouts. */
export function readableProjectionJson(handle: ReadableProjection, sessionIds: string[]): object {
  return {
    storeCommit: handle.storeCommit,
    stale: handle.stale,
    partial: handle.issues.length > 0,
    ...(handle.issues.length > 0 ? { issues: handle.issues } : {}),
    sources: Object.fromEntries(
      [...new Set(sessionIds)]
        .filter((id) => handle.sources[id] !== undefined)
        .map((id) => [id, handle.sources[id]]),
    ),
  };
}

export function readableNotes(handle: ReadableProjection, sessionIds: string[]): string {
  const notes = [...new Set(sessionIds)].flatMap((id) => {
    const source = handle.sources[id];
    if (source === undefined || source.source === "store") return [];
    return [
      `  ${id}: ${!source.saved ? "local source; not saved" : source.savedVersionBehind ? "local source; saved version differs (use --saved to read it)" : "local source; saved"}`,
    ];
  });
  for (const issue of handle.issues)
    notes.push(
      `Partial results: ${issue.sessionId ?? issue.harnessId ?? "source"}: ${issue.message}`,
    );
  return notes.length > 0 ? `\n${notes.join("\n")}` : "";
}
