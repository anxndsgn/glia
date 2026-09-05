import { afterEach, beforeEach, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { createProjectionSchema } from "../../src/session/projection/schema.ts";
import {
  searchFileTouches,
  searchText,
  type SearchParams,
} from "../../src/session/projection/query.ts";

let db: Database;
beforeEach(() => {
  db = new Database(":memory:");
  createProjectionSchema(db);
  db.run(`INSERT INTO sessions
    (session_id, harness_id, source_session_id, association_mode, revision_digest,
     accepted_at, archive_state)
    VALUES ('session', 'claude-code', 'source', 'inferred', 'digest', '2026-07-15', 'active')`);
});
afterEach(() => db.close());

function event(seq: number, text: string, timestamp = "2026-07-15T10:00:00.000Z"): void {
  const result = db
    .query(`INSERT INTO events
    (session_id, seq, kind, source_file, source_cursor, timestamp, text, run_first_seq, run_last_seq)
    VALUES ('session', ?, 'message', 'source', ?, ?, ?, ?, ?)`)
    .run(seq, `line:${seq}`, timestamp, text, seq, seq);
  db.query("INSERT INTO events_fts (rowid, text) VALUES (?, ?)").run(
    Number(result.lastInsertRowid),
    text,
  );
}

function params(overrides: Partial<SearchParams> = {}): SearchParams {
  return {
    query: "needle",
    file: null,
    harness: null,
    since: null,
    filters: [],
    limit: 20,
    perSession: 3,
    sort: "relevance",
    includeArchived: false,
    word: false,
    ...overrides,
  };
}

test.each(["relevance", "time"] as const)(
  "%s selects the best remaining matches before restoring source order",
  (sort) => {
    event(1, "needle padding padding padding");
    event(2, "needle needle needle");
    event(3, "needle needle");
    const result = searchText(db, params({ sort, limit: 2 }));
    expect(result.groups[0]!.matches.map((match) => match.eventSeq)).toEqual([2, 3]);
    expect(result.totalMatches).toBe(3);
  },
);

test.each(["foo_bar.ts", "foo%bar.ts", "foo\\bar.ts"])(
  "file suffix %s is literal in both search modes",
  (file) => {
    event(1, "needle");
    db.query(`INSERT INTO file_touches (session_id, event_id, operation, source_path)
    VALUES ('session', 1, 'read', 'src/fooXbar.ts')`).run();
    expect(searchFileTouches(db, params({ query: null, file })).totalMatches).toBe(0);
    expect(searchText(db, params({ file })).totalMatches).toBe(0);
    db.query("UPDATE file_touches SET source_path = ?").run(`src/${file}`);
    expect(searchFileTouches(db, params({ query: null, file })).totalMatches).toBe(1);
    expect(searchText(db, params({ file })).totalMatches).toBe(1);
  },
);

test.each([
  ["2026-07-15", 1],
  ["2026-07-15T10:00:00Z", 1],
  ["2026-07-15T10:00:00.000000Z", 1],
  ["2026-07-15T17:00:00+08:00", 1],
  ["2026-07-15T18:00:00+0800", 1],
  ["2026-07-15 10:00", 1],
  ["2026-07-15 11:00:00Z", 0],
  ["2026-07-15T10:00:00.001Z", 0],
] as const)("since %s compares instants", (since, count) => {
  event(1, "needle");
  expect(searchText(db, params({ since })).totalMatches).toBe(count);
});

test.each(["2026-07-15T18:00:00+0800", "2026-07-15 18:00:00+08:00"])(
  "source timestamp %s remains original",
  (timestamp) => {
    event(1, "needle", timestamp);
    const result = searchText(db, params({ since: "2026-07-15T10:00:00Z" }));
    expect(result.totalMatches).toBe(1);
    expect(result.groups[0]!.matches[0]!.timestamp).toBe(timestamp);
    expect(searchText(db, params({ since: "2026-07-15T11:00:00Z" })).totalMatches).toBe(0);
  },
);

test.each([
  ["2026-07-15T10:00:00.000001Z", "2026-07-15T18:00:00.000001000+0800", 1],
  ["2026-07-15T10:00:00.000001Z", "2026-07-15T18:00:00.000002+08:00", 0],
  ["2026-07-15T18:00:00.000001000+0800", "2026-07-15T10:00:00.000001Z", 1],
  ["2026-07-15T18:00:00.000001+08:00", "2026-07-15T10:00:00.000002Z", 0],
  ["2026-07-15T10:00:00.999999Z", "2026-07-15T10:00:01Z", 0],
] as const)("source %s and since %s retain submillisecond precision", (timestamp, since, count) => {
  event(1, "needle", timestamp);
  expect(searchText(db, params({ since })).totalMatches).toBe(count);
});
