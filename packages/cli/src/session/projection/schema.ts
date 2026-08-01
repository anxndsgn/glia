import type { Database } from "bun:sqlite";

/**
 * Bump whenever adapter normalization or the projection schema changes,
 * so published projections rebuild even for an unchanged Store commit.
 */
export const PROJECTION_VERSION = 2;

/**
 * The projection is a disposable normalized view. SQLite paths, tables,
 * columns, and SQL are private; the public contract is typed CLI results
 * and evidence locators.
 */
export function createProjectionSchema(db: Database): void {
  db.run(`
    CREATE TABLE projection_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE sessions (
      session_id TEXT PRIMARY KEY,
      harness_id TEXT NOT NULL,
      source_session_id TEXT NOT NULL,
      opening_path TEXT,
      association_mode TEXT NOT NULL,
      continuation_parent TEXT,
      revision_digest TEXT NOT NULL,
      accepted_at TEXT NOT NULL,
      archive_state TEXT NOT NULL,
      event_count INTEGER NOT NULL DEFAULT 0,
      first_timestamp TEXT,
      last_timestamp TEXT,
      -- Session Label, read from this Session's own evidence at build:
      -- the text, which event kind it was read from, and the sequence of
      -- the event that carries it, so every displayed Label addresses the
      -- evidence it came from.
      label TEXT,
      label_source TEXT,
      label_seq INTEGER,
      -- Subagent facts, read from source evidence. The first two describe
      -- a Session that *is* a Harness-spawned subagent (Codex); the third
      -- counts subagent transcripts a Session *carries* (Claude Code).
      -- The parent is the parent's source Session ID, resolved to a Session
      -- ID at query time only when that parent is itself imported; NULL
      -- means the source stated none, never that one was guessed.
      -- Whether the source marked this Session a subagent at all. Kind and
      -- parent are both optional, so their NULLs cannot carry the fact: a
      -- rollout stating only thread_source=subagent is still a subagent.
      subagent_origin INTEGER NOT NULL DEFAULT 0,
      subagent_kind TEXT,
      subagent_parent TEXT,
      subagent_count INTEGER NOT NULL DEFAULT 0
    );
    CREATE TABLE events (
      event_id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(session_id),
      seq INTEGER NOT NULL,
      kind TEXT NOT NULL,
      role TEXT,
      source_event_id TEXT,
      -- Canonical Shared Event Identity digest. Null exactly when
      -- source_event_id is null; every family consumer uses this column
      -- instead of independently re-encoding the identity rule.
      identity_key TEXT,
      source_file TEXT NOT NULL,
      source_cursor TEXT NOT NULL,
      timestamp TEXT,
      text TEXT,
      payload_json TEXT,
      -- Adjacent duplicate runs, computed at build: strictly consecutive
      -- events of one kind (and one speaker where the kind carries one)
      -- with byte-identical normalized text share one run. The run's
      -- first member is its representative; readers treat one run as one
      -- logical event.
      run_first_seq INTEGER NOT NULL,
      run_last_seq INTEGER NOT NULL
    );
    CREATE INDEX idx_events_session_seq ON events(session_id, seq);
    CREATE INDEX idx_events_kind ON events(kind);
    -- Fork Family detection self-joins events on canonical Shared Event
    -- Identity at build time.
    CREATE INDEX idx_events_identity_key ON events(identity_key);
    -- Fork Families: connected components of Sessions linked by Shared
    -- Event Identity or source-provided Continuation edges, computed at
    -- build from normalized events. Projection-local only — a family has
    -- no persistent identifier, so the component key is simply the
    -- component's smallest Session ID, and nothing here is ever written
    -- back to the Store.
    CREATE TABLE session_families (
      session_id TEXT PRIMARY KEY REFERENCES sessions(session_id),
      family_key TEXT NOT NULL
    );
    CREATE INDEX idx_session_families_key ON session_families(family_key);
    CREATE TABLE artifacts (
      session_id TEXT NOT NULL REFERENCES sessions(session_id),
      path TEXT NOT NULL,
      size INTEGER NOT NULL,
      media_type TEXT NOT NULL,
      sha256 TEXT NOT NULL
    );
    CREATE TABLE file_touches (
      touch_id INTEGER PRIMARY KEY,
      session_id TEXT NOT NULL REFERENCES sessions(session_id),
      event_id INTEGER NOT NULL REFERENCES events(event_id),
      operation TEXT NOT NULL,
      source_path TEXT NOT NULL,
      normalized_path TEXT
    );
    CREATE INDEX idx_touches_paths ON file_touches(source_path, normalized_path);
    CREATE TABLE event_tool_names (
      event_id INTEGER NOT NULL REFERENCES events(event_id),
      -- Harness-attested tool name, stored as attested: session view
      -- renders it back. Matching stays case-insensitive on the full
      -- name through the folded column (SQLite LOWER is ASCII-only).
      name TEXT NOT NULL,
      name_folded TEXT NOT NULL
    );
    CREATE INDEX idx_tool_names ON event_tool_names(name_folded, event_id);
    -- Trigram tokenization makes MATCH a substring match, so Chinese prose
    -- and identifier fragments are findable by any piece of >= 3 characters.
    CREATE VIRTUAL TABLE events_fts USING fts5(text, content='events', content_rowid='event_id', tokenize='trigram');
  `);
}
