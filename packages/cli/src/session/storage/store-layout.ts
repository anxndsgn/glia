import { join } from "node:path";
import { cp, mkdir, readdir, rm } from "node:fs/promises";
import type { BundleManifest, StoredSourceBundle } from "../adapters/types.ts";
import type { HarnessId } from "../../core/harnesses/ids.ts";
import { GliaError } from "../../core/output/errors.ts";
import { requireSupportedSchemaVersion } from "../../core/state/schema-version.ts";

export const SESSION_META_SCHEMA_VERSION = 1;

/**
 * The Session module's namespaced layout inside the private Store worktree:
 *
 *   session/sessions/<sessionId>/session.json
 *   session/sessions/<sessionId>/bundle/manifest.json
 *   session/sessions/<sessionId>/bundle/source/...
 *
 * The working tree holds the Current Revision; earlier Revisions remain
 * traceable in Store Git history.
 */
export interface SessionMeta {
  schemaVersion: number;
  sessionId: string;
  harnessId: HarnessId;
  sourceSessionId: string;
  openingPath: string | null;
  association: {
    mode: "inferred" | "explicit";
    evidence: string;
  };
  continuation: { parentSessionId: string } | null;
  currentRevision: {
    digest: string;
    acceptedAt: string;
    fileCount: number;
    totalBytes: number;
  };
  /**
   * Present when detection flagged the accepted bytes and the user
   * accepted anyway: the traceable override, masked hits only.
   */
  secretDetectionOverride?: {
    rulesetVersion: number;
    ruleIds: string[];
    hits: { ruleId: string; file: string; cursor: string; preview: string }[];
    unscanned: { file: string; reason: string }[];
  };
  /**
   * Present when the Source Identity was tombstoned and re-admitted
   * explicitly: which epoch's deletion event was overridden, and when.
   */
  tombstoneOverride?: {
    overriddenEpoch: number;
    deletedAt: string;
    deletedBy: string;
    overriddenAt: string;
  };
}

export function sessionsDir(storeDir: string): string {
  return join(storeDir, "session", "sessions");
}

export function sessionDir(storeDir: string, sessionId: string): string {
  return join(sessionsDir(storeDir), sessionId);
}

export function bundleDir(storeDir: string, sessionId: string): string {
  return join(sessionDir(storeDir, sessionId), "bundle");
}

export async function listSessionIds(storeDir: string): Promise<string[]> {
  try {
    const entries = await readdir(sessionsDir(storeDir), { withFileTypes: true });
    return entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * The file's text, or null when it does not exist — one read rather than
 * an existence probe followed by a second syscall to read it. Session
 * metadata and bundle manifests are read once per Session on every
 * projection rebuild, so the probe is pure overhead at that scale.
 */
async function readTextIfPresent(path: string): Promise<string | null> {
  try {
    return await Bun.file(path).text();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

export async function readSessionMeta(
  storeDir: string,
  sessionId: string,
): Promise<SessionMeta | null> {
  const path = join(sessionDir(storeDir, sessionId), "session.json");
  const text = await readTextIfPresent(path);
  if (text === null) return null;
  const meta = JSON.parse(text) as SessionMeta;
  requireSupportedSchemaVersion(
    "Session metadata",
    path,
    meta.schemaVersion,
    SESSION_META_SCHEMA_VERSION,
  );
  return meta;
}

export async function readStoredBundle(
  storeDir: string,
  sessionId: string,
): Promise<StoredSourceBundle> {
  const dir = bundleDir(storeDir, sessionId);
  const manifestPath = join(dir, "manifest.json");
  const text = await readTextIfPresent(manifestPath);
  if (text === null) {
    throw new GliaError("NOT_FOUND", `session ${sessionId} has no stored bundle`, { sessionId });
  }
  const manifest = JSON.parse(text) as BundleManifest;
  requireSupportedSchemaVersion("Source Bundle manifest", manifestPath, manifest.schemaVersion, 1);
  return { sessionId, dir, manifest };
}

/**
 * Replaces the Session's bundle with the staged capture and writes its
 * metadata. The caller owns the surrounding writer lease and Store commit.
 */
export async function writeAcceptedRevision(
  storeDir: string,
  meta: SessionMeta,
  manifest: BundleManifest,
  stagedBundleDir: string,
): Promise<void> {
  const targetSessionDir = sessionDir(storeDir, meta.sessionId);
  const targetBundleDir = join(targetSessionDir, "bundle");
  await rm(targetBundleDir, { recursive: true, force: true });
  await mkdir(targetBundleDir, { recursive: true });
  await cp(stagedBundleDir, targetBundleDir, { recursive: true });
  await Bun.write(join(targetBundleDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
  await Bun.write(join(targetSessionDir, "session.json"), JSON.stringify(meta, null, 2) + "\n");
}
