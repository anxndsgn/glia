import { Database } from "bun:sqlite";
import { GliaError } from "../../core/output/errors.ts";
import { adapterFor } from "../adapters/index.ts";
import {
  isHarnessInjected,
  labelSourceOf,
  LABEL_SOURCES,
  sessionLabel,
  type SessionLabelSource,
} from "../adapters/label.ts";
import type { NormalizedEvent, StoredSourceBundle } from "../adapters/types.ts";
import { isSubagentBundlePath } from "../adapters/subagent.ts";
import { listSessionIds, readSessionMeta, readStoredBundle } from "../storage/store-layout.ts";
import { createProjectionSchema, PROJECTION_VERSION } from "./schema.ts";
import { listArchiveMarkers } from "../domain/archive.ts";
import { detectFamilies } from "./family.ts";
import { identityKeyOf } from "../domain/event-identity.ts";

/**
 * Rebuilds the complete projection for one Store commit into `dbPath`.
 * The caller owns the writer lease and the atomic publication step.
 */
export async function buildProjection(
  storeDir: string,
  storeCommit: string,
  dbPath: string,
): Promise<void> {
  const db = new Database(dbPath, { create: true });
  try {
    createProjectionSchema(db);
    db.run("BEGIN");
    const setMeta = db.prepare("INSERT INTO projection_meta (key, value) VALUES (?, ?)");
    setMeta.run("projectionVersion", String(PROJECTION_VERSION));
    setMeta.run("storeCommit", storeCommit);
    setMeta.run("builtAt", new Date().toISOString());

    const insertSession = db.prepare(
      `INSERT INTO sessions
         (session_id, harness_id, source_session_id, opening_path, association_mode,
          continuation_parent, revision_digest, accepted_at, archive_state, event_count,
          first_timestamp, last_timestamp, label, label_source, label_seq,
          subagent_kind, subagent_parent, subagent_count)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertEvent = db.prepare(
      `INSERT INTO events
         (session_id, seq, kind, role, source_event_id, identity_key, source_file, source_cursor,
          timestamp, text, payload_json, run_first_seq, run_last_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const closeRun = db.prepare(
      "UPDATE events SET run_last_seq = ? WHERE session_id = ? AND run_first_seq = ?",
    );
    const insertFts = db.prepare("INSERT INTO events_fts (rowid, text) VALUES (?, ?)");
    const insertToolName = db.prepare(
      "INSERT INTO event_tool_names (event_id, name, name_folded) VALUES (?, ?, ?)",
    );
    const insertArtifact = db.prepare(
      "INSERT INTO artifacts (session_id, path, size, media_type, sha256) VALUES (?, ?, ?, ?, ?)",
    );
    const insertTouch = db.prepare(
      "INSERT INTO file_touches (session_id, event_id, operation, source_path, normalized_path) VALUES (?, ?, ?, ?, ?)",
    );

    // One readdir for the whole marker directory: most Sessions have no
    // marker, and probing per Session costs a filesystem op each.
    const archiveStates = new Map(
      (await listArchiveMarkers(storeDir)).map((marker) => [marker.sessionId, marker.state]),
    );

    const projectedIds: string[] = [];
    for (const sessionId of await listSessionIds(storeDir)) {
      const meta = await readSessionMeta(storeDir, sessionId);
      // A Session Conflict has no Current Revision: the frozen Session is
      // left out of the projection until it is explicitly resolved.
      if (!meta) continue;
      projectedIds.push(sessionId);
      const bundle = await readStoredBundle(storeDir, sessionId);
      const archiveState = archiveStates.get(sessionId) ?? "active";
      const adapter = adapterFor(meta.harnessId);

      let seq = 0;
      let eventCount = 0;
      let firstTimestamp: string | null = null;
      let lastTimestamp: string | null = null;
      // Adjacent duplicate collapse: a run is strictly consecutive events
      // sharing one kind, one speaker where the kind carries one (message),
      // and byte-identical normalized text. Adjacency is a fact of the
      // Session, fixed here at build — never of a filtered view.
      let runFirstSeq = 0;
      let prevRun: { kind: string; role: string | null; text: string | null } | null = null;
      const labelCandidates = new Map<SessionLabelSource, { text: string; seq: number }>();
      for await (const event of adapter.project(bundle)) {
        seq += 1;
        collectLabelCandidate(labelCandidates, event, seq);
        const continuesRun =
          prevRun !== null &&
          prevRun.kind === event.kind &&
          event.text !== null &&
          prevRun.text === event.text &&
          (event.kind !== "message" || prevRun.role === event.role);
        if (continuesRun) {
          closeRun.run(seq, sessionId, runFirstSeq);
        } else {
          runFirstSeq = seq;
        }
        prevRun = { kind: event.kind, role: event.role, text: event.text };
        const inserted = insertEvent.run(
          sessionId,
          seq,
          event.kind,
          event.role,
          event.sourceEventId,
          event.sourceEventId === null
            ? null
            : identityKeyOf(event.sourceEventId, event.timestamp, event.text),
          event.sourceFile,
          event.sourceCursor,
          event.timestamp,
          event.text,
          event.payload ? JSON.stringify(event.payload) : null,
          runFirstSeq,
          seq,
        );
        const eventRowId = Number(inserted.lastInsertRowid);
        if (event.text !== null) insertFts.run(eventRowId, event.text);
        for (const name of event.toolNames) {
          insertToolName.run(eventRowId, name, name.toLowerCase());
        }
        for (const t of event.fileTouches) {
          insertTouch.run(sessionId, eventRowId, t.operation, t.sourcePath, t.normalizedPath);
        }
        eventCount += 1;
        // Min/max rather than first/last seen: a bundle projects its main
        // transcript before the subagent transcripts it spawned, so the
        // last event in stream order can predate the main transcript's end.
        // Single-file Sessions are unaffected — transcripts append in order.
        if (event.timestamp) {
          if (firstTimestamp === null || event.timestamp < firstTimestamp) {
            firstTimestamp = event.timestamp;
          }
          if (lastTimestamp === null || event.timestamp > lastTimestamp) {
            lastTimestamp = event.timestamp;
          }
        }
      }
      const label = selectLabel(labelCandidates);
      insertSession.run(
        sessionId,
        meta.harnessId,
        meta.sourceSessionId,
        meta.openingPath,
        meta.association.mode,
        meta.continuation?.parentSessionId ?? null,
        meta.currentRevision.digest,
        meta.currentRevision.acceptedAt,
        archiveState,
        eventCount,
        firstTimestamp,
        lastTimestamp,
        label?.text ?? null,
        label?.source ?? null,
        label?.seq ?? null,
        meta.subagent?.kind ?? null,
        meta.subagent?.parentSourceSessionId ?? null,
        subagentTranscriptCount(bundle),
      );
      for (const file of bundle.manifest.files) {
        insertArtifact.run(sessionId, file.path, file.size, file.mediaType, file.sha256);
      }
    }
    // Fork Families derive from the events and continuations just
    // projected; they live only in this disposable projection.
    detectFamilies(db);
    db.run("COMMIT");
    validateProjection(db, storeDir, projectedIds);
  } catch (err) {
    db.close();
    throw err;
  }
  db.close();
}

/** How many subagent transcripts the accepted Revision carries. */
function subagentTranscriptCount(bundle: StoredSourceBundle): number {
  return bundle.manifest.files.filter((file) => isSubagentBundlePath(file.path)).length;
}

/**
 * A Session's Session Label is read from the Session's own evidence: a
 * Harness-provided title event where the adapter attests one, otherwise the
 * Session's earliest user message. Harness-injected user-role evidence is
 * not the user speaking and never becomes a Label. A Session is re-titled by
 * sessioning another title line, so the latest line of a title kind is the
 * title the Harness currently carries; the earliest user message is the
 * opening one, so it keeps the first. The precedence below decides between
 * kinds.
 */
function collectLabelCandidate(
  candidates: Map<SessionLabelSource, { text: string; seq: number }>,
  event: NormalizedEvent,
  seq: number,
): void {
  if (event.text === null) return;
  const attested = labelSourceOf(event.payload);
  const source: SessionLabelSource | null =
    attested ??
    (event.kind === "message" && event.role === "user" && !isHarnessInjected(event.payload)
      ? "user_message"
      : null);
  if (source === null || (source === "user_message" && candidates.has(source))) return;
  candidates.set(source, { text: event.text, seq });
}

function selectLabel(
  candidates: Map<SessionLabelSource, { text: string; seq: number }>,
): { text: string; source: SessionLabelSource; seq: number } | null {
  for (const source of LABEL_SOURCES) {
    const found = candidates.get(source);
    if (found === undefined) continue;
    const text = sessionLabel(found.text);
    if (text !== null) return { text, source, seq: found.seq };
  }
  return null;
}

function validateProjection(db: Database, storeDir: string, sessionIds: string[]): void {
  const row = db.query("SELECT COUNT(*) AS n FROM sessions").get() as { n: number };
  if (row.n !== sessionIds.length) {
    throw new GliaError(
      "INTERNAL",
      `projection validation failed: ${row.n} sessions projected, ${sessionIds.length} in store`,
      {
        storeDir,
      },
    );
  }
  const check = db.query("PRAGMA quick_check").get() as { quick_check?: string } | null;
  if (check && check.quick_check !== "ok") {
    throw new GliaError("INTERNAL", "projection validation failed: quick_check not ok");
  }
}
