import { Database } from "bun:sqlite";
import { GliaError } from "../../core/output/errors.ts";
import { renderExcerpt } from "./excerpt.ts";
import {
  chooseAnchor,
  compareByTimestampThenId,
  familyKeyIndex,
  listFamilyRows,
  sessionFamilyDetail,
  visibleFamilyFacts,
  type FamilyDetail,
  type FamilyFacts,
  type FamilyRow,
} from "./family.ts";
import type { ArchiveState } from "../domain/archive.ts";
import type { SessionLabelSource } from "../adapters/label.ts";
import { SUBAGENT_BUNDLE_PREFIX } from "../adapters/subagent.ts";
import { createProjectionSchema, EMPTY_PROJECTION_PATH } from "./schema.ts";

export interface SessionRow extends SubagentColumns {
  sessionId: string;
  harnessId: string;
  sourceSessionId: string;
  openingPath: string | null;
  associationMode: string;
  continuationParent: string | null;
  revisionDigest: string;
  acceptedAt: string;
  archiveState: ArchiveState;
  eventCount: number;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  /** Session Label read from this Session's evidence; null when it holds none. */
  label: string | null;
  /** Which evidence the Label was read from; null with no Label. */
  labelSource: SessionLabelSource | null;
  /** Sequence of the event carrying the Label; null with no Label. */
  labelSeq: number | null;
}

/**
 * What a Session states about subagents, in the two directions a Session
 * can relate to one: it either *is* a Harness-spawned subagent (Codex, so
 * `subagentKind` is set) or it *carries* subagent transcripts inside its
 * own evidence (Claude Code, so `subagentCount` is above zero).
 */
export interface SubagentColumns {
  /**
   * Whether the source marked this Session a subagent. Kind and parent are
   * both optional, so neither can stand in for the fact itself.
   */
  subagentOrigin: number;
  /** Source-native subagent kind when this Session is a subagent. */
  subagentKind: string | null;
  /**
   * The parent's source Session ID, exactly as the source stated it. Null
   * when the source stated none — the parent is unknown, never guessed.
   */
  subagentParent: string | null;
  /** The parent's Session ID, when that parent is itself imported. */
  subagentParentSession: string | null;
  /** Subagent transcripts carried inside this Session's own bundle. */
  subagentCount: number;
}

/**
 * What an event says about the subagent that produced it. The transcript it
 * came from is already in the locator; this adds the source-native type
 * Claude Code records in the sidecar, so a badge can name the agent rather
 * than only identify it.
 */
export interface SubagentEvidence {
  /**
   * The subagent that produced this event; null when it is not subagent
   * evidence at all. The empty string is a subagent whose agent the source
   * did not name, which is still subagent evidence.
   */
  subagentId: string | null;
  /** Source-native agent type, when a sidecar named one. */
  subagentType: string | null;
}

export interface EvidenceLocator {
  sourceFile: string;
  sourceCursor: string;
  sourceEventId: string | null;
}

/** One `--filter` value in parsed form; the raw CLI value is echoed back. */
export type EventFilter =
  | { slice: "speaker"; value: string; role: "user" | "assistant" }
  | { slice: "kind"; value: string; eventKind: string }
  | { slice: "tool"; value: string; toolName: string }
  | { slice: "subagent"; value: string };

export type SearchSort = "relevance" | "time";

export interface SearchParams {
  query: string | null;
  file: string | null;
  harness: string | null;
  since: string | null;
  filters: EventFilter[];
  limit: number;
  perSession: number;
  sort: SearchSort;
  includeArchived: boolean;
}

export interface TextMatch extends SubagentEvidence {
  eventSeq: number;
  /** Last member sequence of the match's duplicate run; equals eventSeq for a singleton. */
  runLastSeq: number;
  eventKind: string;
  role: string | null;
  timestamp: string | null;
  excerpt: string;
  locator: EvidenceLocator;
  /** Other visible family members holding a copy of this match's event, when collapsed. */
  alsoIn?: string[];
}

export interface FileTouchMatch extends SubagentEvidence {
  eventSeq: number;
  /** Last member sequence of the match's duplicate run; equals eventSeq for a singleton. */
  runLastSeq: number;
  operation: string;
  sourcePath: string;
  normalizedPath: string | null;
  locator: EvidenceLocator;
  /** Other visible family members holding a copy of this match's event, when collapsed. */
  alsoIn?: string[];
}

/** One Session's shown matches, capped at `perSession` of `totalInSession`. */
export interface SessionMatchGroup<M> extends SubagentColumns {
  sessionId: string;
  revisionDigest: string;
  harnessId: string;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  /** Source-provided continuation parent Session, when one exists. */
  continuationParent: string | null;
  archiveState: ArchiveState;
  /** Fork Family facts over the query's visible set; null outside any family. */
  family: FamilyFacts | null;
  totalInSession: number;
  matches: M[];
}

export interface SearchResult<M> {
  /** True match count under the same filters, ignoring limit and per-Session cap. */
  totalMatches: number;
  /** Cross-Session copies suppressed by Fork Family collapse. */
  familyCollapsedMatches: number;
  groups: SessionMatchGroup<M>[];
}

export function openProjection(dbPath: string): Database {
  if (dbPath === EMPTY_PROJECTION_PATH) {
    const db = new Database(":memory:");
    createProjectionSchema(db);
    return db;
  }
  return new Database(dbPath, { readonly: true });
}

/** The Session-identity columns a match group's header renders from. */
function sessionMatchColumns(prefix: string): string {
  return `${prefix}revision_digest AS revisionDigest, ${prefix}harness_id AS harnessId,
    ${prefix}first_timestamp AS firstTimestamp, ${prefix}last_timestamp AS lastTimestamp,
    ${prefix}continuation_parent AS continuationParent,
    ${prefix}archive_state AS archiveState, ${subagentColumns(prefix)}`;
}

/**
 * A subagent's parent is stated as a source Session ID, so it resolves to a
 * Session ID only when that parent Harness Session is itself imported —
 * matched within the same Harness, since source IDs are only unique there.
 * An unresolved parent stays the raw source ID rather than becoming null:
 * the source did state a parent, we just do not hold it.
 */
function subagentColumns(prefix: string): string {
  // The correlated subquery selects from `sessions` too, so the outer row
  // must be named explicitly: unqualified columns inside it would bind to
  // the inner table and silently resolve every parent to null.
  const outer = prefix === "" ? "sessions." : prefix;
  return `${outer}subagent_origin AS subagentOrigin,
    ${outer}subagent_kind AS subagentKind, ${outer}subagent_parent AS subagentParent,
    ${outer}subagent_count AS subagentCount,
    (SELECT p.session_id FROM sessions p
      WHERE p.source_session_id = ${outer}subagent_parent
        AND p.harness_id = ${outer}harness_id) AS subagentParentSession`;
}

const SESSION_COLUMNS = `session_id AS sessionId, source_session_id AS sourceSessionId,
  opening_path AS openingPath, association_mode AS associationMode,
  ${sessionMatchColumns("")}, accepted_at AS acceptedAt, event_count AS eventCount,
  label, label_source AS labelSource, label_seq AS labelSeq`;

/**
 * Sessions ordered by latest event time, newest first — "what was I most
 * recently working in". A Session with no event timestamps falls back to
 * its acceptance time as its sort key; ties break by Session ID.
 */
export function listSessions(db: Database, includeArchived = false): SessionRow[] {
  return db
    .query(
      `SELECT ${SESSION_COLUMNS} FROM sessions
       ${includeArchived ? "" : "WHERE archive_state = 'active'"}
       ORDER BY COALESCE(last_timestamp, accepted_at) DESC, session_id`,
    )
    .all() as SessionRow[];
}

export function getSession(db: Database, sessionId: string): SessionRow | null {
  const row = db
    .query(`SELECT ${SESSION_COLUMNS} FROM sessions WHERE session_id = ?`)
    .get(sessionId);
  return (row as SessionRow) ?? null;
}

export interface SessionDetail extends SessionRow {
  eventKinds: Record<string, number>;
  fileTouchCount: number;
  artifacts: { path: string; size: number; mediaType: string; sha256: string }[];
  /** The Session's Fork Family over the whole Store; null outside any family. */
  family: FamilyDetail | null;
  /** Imported Sessions naming this one as the subagent parent. */
  spawnedSubagents: string[];
}

/**
 * The Sessions that name this one as their subagent parent. This is the
 * inverse of `subagentParentSession` and is display-only: it is not a
 * Continuation edge and forms no Fork Family.
 */
export function spawnedSubagentSessions(db: Database, sessionId: string): string[] {
  return (
    db
      .query(
        `SELECT c.session_id AS sessionId FROM sessions c
         JOIN sessions p ON p.source_session_id = c.subagent_parent AND p.harness_id = c.harness_id
         WHERE p.session_id = ? ORDER BY c.session_id`,
      )
      .all(sessionId) as { sessionId: string }[]
  ).map((row) => row.sessionId);
}

export function getSessionDetail(db: Database, sessionId: string): SessionDetail | null {
  const session = getSession(db, sessionId);
  if (!session) return null;
  const kindRows = db
    .query("SELECT kind, COUNT(*) AS n FROM events WHERE session_id = ? GROUP BY kind")
    .all(sessionId) as { kind: string; n: number }[];
  const eventKinds: Record<string, number> = {};
  for (const row of kindRows) eventKinds[row.kind] = row.n;
  const touches = db
    .query("SELECT COUNT(*) AS n FROM file_touches WHERE session_id = ?")
    .get(sessionId) as {
    n: number;
  };
  const artifacts = db
    .query(
      "SELECT path, size, media_type AS mediaType, sha256 FROM artifacts WHERE session_id = ? ORDER BY path",
    )
    .all(sessionId) as SessionDetail["artifacts"];
  return {
    ...session,
    eventKinds,
    fileTouchCount: touches.n,
    artifacts,
    family: sessionFamilyDetail(db, sessionId),
    spawnedSubagents: spawnedSubagentSessions(db, sessionId),
  };
}

/**
 * Query grammar: whitespace-split terms, every term a literal substring
 * (AND). Terms of >= 3 characters are served by the trigram index and
 * carry the relevance signal; shorter terms — most importantly
 * two-character Chinese words — apply as literal substring scans.
 */
interface QueryTerms {
  terms: string[];
  indexable: string[];
  short: string[];
}

function splitQuery(query: string): QueryTerms {
  const terms = query.split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0) throw new GliaError("USAGE", "search query must not be empty");
  const indexable = terms.filter((t) => [...t].length >= 3);
  const short = terms.filter((t) => [...t].length < 3);
  return { terms, indexable, short };
}

/** Quotes every term so user input is literal FTS text, never operators. */
function ftsLiteral(terms: string[]): string {
  return terms.map((t) => `"${t.replaceAll('"', '""')}"`).join(" ");
}

/** LIKE pattern matching the term as a literal substring. */
function likePattern(term: string): string {
  return `%${term.replace(/[\\%_]/g, "\\$&")}%`;
}

const FILE_MATCH_SQL = `(t.source_path = $file OR t.normalized_path = $file
  OR t.source_path LIKE '%/' || $file OR t.normalized_path LIKE '%/' || $file)`;

type Bindings = Record<string, string | number>;

/** Shared mechanical filters: `--harness`, `--since`, `--filter`, `--file`. */
function mechanicalClauses(params: SearchParams, bind: Bindings): string[] {
  const clauses: string[] = [];
  if (!params.includeArchived) clauses.push("r.archive_state = 'active'");
  if (params.harness) {
    clauses.push("r.harness_id = $harness");
    bind["$harness"] = params.harness;
  }
  if (params.since) {
    clauses.push("e.timestamp >= $since");
    bind["$since"] = params.since;
  }
  const filterUnion = params.filters.map((f, i) => filterClause(f, i, bind));
  if (filterUnion.length > 0) clauses.push(`(${filterUnion.join(" OR ")})`);
  return clauses;
}

/**
 * One `--filter` value as SQL. Values on the same axis union; the union
 * intersects with the other options. Speaker slices select only message
 * events with that speaker, so roles that transport formats attach to
 * non-message events never influence a slice.
 */
function filterClause(filter: EventFilter, index: number, bind: Bindings): string {
  switch (filter.slice) {
    case "speaker": {
      const key = `$filterRole${index}`;
      bind[key] = filter.role;
      return `(e.kind = 'message' AND e.role = ${key})`;
    }
    case "kind": {
      const key = `$filterKind${index}`;
      bind[key] = filter.eventKind;
      return `e.kind = ${key}`;
    }
    case "tool": {
      const key = `$filterTool${index}`;
      bind[key] = filter.toolName.toLowerCase();
      return `(e.kind = 'tool_call' AND EXISTS (
        SELECT 1 FROM event_tool_names n WHERE n.event_id = e.event_id AND n.name_folded = ${key}))`;
    }
    case "subagent":
      // The adapter marks every subagent event as it projects it, so the
      // slice reads that marker rather than the bundle path: transcripts
      // older than the sibling-directory layout carry their sidechain
      // records inline in the main transcript and are subagent evidence
      // just the same.
      return `json_extract(e.payload_json, '$.subagentId') IS NOT NULL`;
  }
}

/** The Session-identity and event-identity columns every matched row carries. */
interface MatchedRow extends SubagentColumns {
  /** Subagent provenance of this event; see `SubagentEvidence`. */
  subagentType: string | null;
  subagentId: string | null;
  sessionId: string;
  revisionDigest: string;
  harnessId: string;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
  continuationParent: string | null;
  archiveState: ArchiveState;
  eventSeq: number;
  runLastSeq: number;
  timestamp: string | null;
  sourceFile: string;
  sourceCursor: string;
  sourceEventId: string | null;
  /** Canonical Shared Event Identity; null without a source event ID. */
  identityKey: string | null;
  /** Relevance signal; 0 where no text relevance exists (file-touch listing). */
  rank: number;
}

interface TextMatchRow extends MatchedRow {
  eventKind: string;
  role: string | null;
  text: string;
}

interface BoundedMatchedRow extends MatchedRow {
  totalInSession: number;
}

/**
 * SQL ordering for the no-family fast path. SQL has already chosen each
 * Session's best-ranked matches; eventSeq restores source order for display.
 */
function groupOrderSql(sort: SearchSort): string {
  return sort === "time"
    ? "(c.timeKey IS NULL), c.timeKey, c.sessionId, c.eventSeq"
    : "c.bestRank, c.sessionId, c.eventSeq";
}

/**
 * Session groups order by the sort mode: `relevance` keeps the best FTS
 * rank among a Session's matches (recency when no term is
 * index-servable); `time` orders groups oldest-first by minimum non-null
 * matching timestamp, all-null Sessions last, ties broken by Session ID —
 * the same rule the Fork Family anchor uses. Matches stay in source
 * order within a Session either way.
 */
function orderGroups<R extends MatchedRow>(groups: R[][], sort: SearchSort): R[][] {
  const decorated = groups.map((rows) => {
    let bestRank = Infinity;
    let timeKey: string | null = null;
    for (const row of rows) {
      if (row.rank < bestRank) bestRank = row.rank;
      if (row.timestamp !== null && (timeKey === null || row.timestamp < timeKey)) {
        timeKey = row.timestamp;
      }
    }
    return { rows, bestRank, timeKey, sessionId: rows[0]!.sessionId };
  });
  decorated.sort((a, b) => {
    if (sort === "time") {
      return compareByTimestampThenId(
        { timestamp: a.timeKey, sessionId: a.sessionId },
        { timestamp: b.timeKey, sessionId: b.sessionId },
      );
    }
    const byRank = a.bestRank - b.bestRank;
    return byRank !== 0 ? byRank : a.sessionId.localeCompare(b.sessionId);
  });
  return decorated.map((entry) => entry.rows);
}

/**
 * Turns matched rows into grouped results: cross-Session Fork Family
 * collapse first, then the per-Session cap, group ordering, and `--limit`.
 *
 * Matches whose events share identity across visible members of one
 * family render once, attributed to the family's visible-set anchor
 * (among the members holding a copy), so archive filtering and
 * `--include-archived` move attribution consistently rather than
 * dropping matches. The surviving match carries the other members'
 * Session IDs; `totalMatches` counts the collapsed match once, and the
 * suppressed copies are reported as `familyCollapsedMatches`. Collapse
 * never drops distinct content: only strict identity-sharing events
 * collapse, and every copy stays reachable through `session view`.
 */
function finishSearch<
  R extends MatchedRow,
  M extends { eventSeq: number; runLastSeq: number; alsoIn?: string[] },
>(familyRows: FamilyRow[], rows: R[], params: SearchParams, shape: (row: R) => M): SearchResult<M> {
  const familyOf = familyKeyIndex(familyRows);

  const copies = Map.groupBy(rows, (row) => {
    const familyKey = familyOf.get(row.sessionId);
    return familyKey === undefined || row.identityKey === null
      ? null
      : `${familyKey}\n${row.identityKey}`;
  });
  copies.delete(null);
  const suppressed = new Set<R>();
  const alsoInOf = new Map<R, string[]>();
  let familyCollapsedMatches = 0;
  for (const set of copies.values()) {
    const bySession = Map.groupBy(set, (row) => row.sessionId);
    if (bySession.size < 2) continue;
    const anchor = chooseAnchor(
      [...bySession.entries()].map(([sessionId, held]) => ({
        sessionId,
        firstTimestamp: held[0]!.firstTimestamp,
      })),
    );
    const others = [...bySession.keys()].filter((id) => id !== anchor).sort();
    // Every copy the anchor's Session holds survives; only other members'
    // copies collapse. Within-Session multiplicity stays the Session's own
    // fact (its duplicate runs), never family collapse's business.
    for (const row of bySession.get(anchor)!) alsoInOf.set(row, others);
    for (const [sessionId, held] of bySession) {
      if (sessionId === anchor) continue;
      for (const row of held) {
        suppressed.add(row);
        familyCollapsedMatches += 1;
      }
    }
  }
  const survivors = rows.filter((row) => !suppressed.has(row));

  const bySession = Map.groupBy(survivors, (row) => row.sessionId);
  const ordered = orderGroups([...bySession.values()], params.sort);
  let remaining = params.limit;
  const windowed: { groupRows: R[]; shown: R[] }[] = [];
  for (const groupRows of ordered) {
    if (remaining <= 0) break;
    const shown = [...groupRows]
      .sort((a, b) => a.rank - b.rank || a.eventSeq - b.eventSeq)
      .slice(0, Math.min(params.perSession, remaining))
      .sort((a, b) => a.eventSeq - b.eventSeq);
    remaining -= shown.length;
    windowed.push({ groupRows, shown });
  }

  // Family facts follow the final result window. A suppressed copy-holder
  // remains visible only when a shown match names it through (also in …);
  // an omitted group can never leak its anchor into a rendered header.
  const firstTimestampOf = new Map<string, string | null>();
  for (const row of rows) {
    if (!firstTimestampOf.has(row.sessionId)) {
      firstTimestampOf.set(row.sessionId, row.firstTimestamp);
    }
  }
  const visible = new Set<string>();
  for (const { groupRows, shown } of windowed) {
    visible.add(groupRows[0]!.sessionId);
    for (const row of shown) {
      for (const copySessionId of alsoInOf.get(row) ?? []) {
        if (firstTimestampOf.has(copySessionId)) visible.add(copySessionId);
      }
    }
  }
  const facts = visibleFamilyFacts(
    familyRows,
    [...visible].map((sessionId) => ({
      sessionId,
      firstTimestamp: firstTimestampOf.get(sessionId) ?? null,
    })),
  );

  const groups = [...windowed].map(({ groupRows, shown }) =>
    toGroup(groupRows[0]!, groupRows.length, facts.get(groupRows[0]!.sessionId) ?? null, () =>
      shown.map((row) => {
        const match = shape(row);
        const alsoIn = alsoInOf.get(row);
        if (alsoIn !== undefined) match.alsoIn = alsoIn;
        return match;
      }),
    ),
  );
  return { totalMatches: survivors.length, familyCollapsedMatches, groups };
}

/** The one place a `SessionMatchGroup` is assembled from its Session's row. */
function toGroup<M>(
  first: MatchedRow,
  totalInSession: number,
  family: FamilyFacts | null,
  matches: () => M[],
): SessionMatchGroup<M> {
  return {
    sessionId: first.sessionId,
    revisionDigest: first.revisionDigest,
    harnessId: first.harnessId,
    firstTimestamp: first.firstTimestamp,
    lastTimestamp: first.lastTimestamp,
    continuationParent: first.continuationParent,
    archiveState: first.archiveState,
    subagentOrigin: first.subagentOrigin,
    subagentKind: first.subagentKind,
    subagentParent: first.subagentParent,
    subagentParentSession: first.subagentParentSession,
    subagentCount: first.subagentCount,
    family,
    totalInSession,
    matches: matches(),
  };
}

/**
 * Shapes rows already capped and globally limited by SQL. Stores without
 * Fork Families need no cross-Session materialization, so event text in JS
 * stays bounded by --limit instead of total Store matches.
 */
function finishBoundedSearch<
  R extends BoundedMatchedRow,
  M extends { eventSeq: number; runLastSeq: number },
>(rows: R[], totalMatches: number, shape: (row: R) => M): SearchResult<M> {
  const groups = [...Map.groupBy(rows, (row) => row.sessionId).values()].map((groupRows) => {
    groupRows.sort((a, b) => a.eventSeq - b.eventSeq);
    const first = groupRows[0]!;
    return toGroup(first, first.totalInSession, null, () => groupRows.map(shape));
  });
  return { totalMatches, familyCollapsedMatches: 0, groups };
}

const SESSION_MATCH_COLUMNS = sessionMatchColumns("r.");

/**
 * Wraps a matched-rows CTE in the per-Session cap, group ordering, and
 * global limit. This is the SQL half of the search window contract,
 * written once so the two search kinds cannot drift from each other.
 */
function cappedQuery(matchedCte: string, sort: SearchSort): string {
  return `WITH matched AS (${matchedCte}),
     capped AS (
       SELECT m.*,
              ROW_NUMBER() OVER (PARTITION BY m.sessionId ORDER BY m.rank, m.eventSeq) AS rn,
              COUNT(*) OVER (PARTITION BY m.sessionId) AS totalInSession,
              MIN(m.rank) OVER (PARTITION BY m.sessionId) AS bestRank,
              MIN(m.timestamp) OVER (PARTITION BY m.sessionId) AS timeKey
       FROM matched m
     )
     SELECT c.*, ${SESSION_MATCH_COLUMNS}
     FROM capped c
     JOIN sessions r ON r.session_id = c.sessionId
     WHERE c.rn <= $perSession
     ORDER BY ${groupOrderSql(sort)}
     LIMIT $limit`;
}

/**
 * The whole matched set, uncapped: Fork Family collapse decides which
 * copy survives across Sessions, so it must see every copy before any
 * cap applies. `finishSearch` then applies the same window in JS.
 */
function uncappedQuery(matchedCte: string): string {
  return `WITH matched AS (${matchedCte})
     SELECT m.*, ${SESSION_MATCH_COLUMNS}
     FROM matched m
     JOIN sessions r ON r.session_id = m.sessionId`;
}

export function searchText(db: Database, params: SearchParams): SearchResult<TextMatch> {
  if (params.query === null) throw new GliaError("INTERNAL", "searchText requires a query");
  const { terms, indexable, short } = splitQuery(params.query);
  const bind: Bindings = {};
  // A duplicate run is one logical event: only run representatives match,
  // and every count below counts a run once.
  const clauses: string[] = ["e.seq = e.run_first_seq"];

  // Index-servable terms go through trigram FTS and carry the relevance
  // signal; short terms apply as literal substring scan conditions. Both
  // paths share filter semantics and rendering.
  const ranked = indexable.length > 0;
  let from: string;
  if (ranked) {
    from = `FROM events_fts f
      JOIN events e ON e.event_id = f.rowid
      JOIN sessions r ON r.session_id = e.session_id`;
    clauses.push("f.text MATCH $match");
    bind["$match"] = ftsLiteral(indexable);
  } else {
    from = `FROM events e
      JOIN sessions r ON r.session_id = e.session_id`;
    clauses.push("e.text IS NOT NULL");
  }
  short.forEach((term, i) => {
    clauses.push(`e.text LIKE $short${i} ESCAPE '\\'`);
    bind[`$short${i}`] = likePattern(term);
  });
  clauses.push(...mechanicalClauses(params, bind));
  if (params.file) {
    clauses.push(
      `r.session_id IN (SELECT t.session_id FROM file_touches t WHERE ${FILE_MATCH_SQL})`,
    );
    bind["$file"] = params.file;
  }
  const where = clauses.join(" AND ");

  // With no index-servable term there is no relevance signal; matches
  // rank by recency instead (newest events first). Stores without a
  // family cap in SQL; family Stores defer collapse and caps to
  // finishSearch so suppressed copies consume no Session's quota.
  const rank = ranked
    ? "bm25(events_fts)"
    : "ROW_NUMBER() OVER (ORDER BY e.timestamp DESC NULLS LAST, e.event_id DESC)";
  const matchedCte = `SELECT e.session_id AS sessionId, e.seq AS eventSeq, e.run_last_seq AS runLastSeq,
       e.kind AS eventKind, e.role AS role, e.timestamp AS timestamp, e.text AS text,
       e.source_file AS sourceFile, e.source_cursor AS sourceCursor,
       e.source_event_id AS sourceEventId, e.identity_key AS identityKey,
       json_extract(e.payload_json, '$.subagentType') AS subagentType,
       json_extract(e.payload_json, '$.subagentId') AS subagentId,
       ${rank} AS rank
     ${from}
     WHERE ${where}`;
  const shape = (row: TextMatchRow): TextMatch => ({
    eventSeq: row.eventSeq,
    runLastSeq: row.runLastSeq,
    eventKind: row.eventKind,
    role: row.role,
    timestamp: row.timestamp,
    excerpt: renderExcerpt(row.text, terms),
    locator: locatorOf(row),
    subagentType: row.subagentType,
    subagentId: row.subagentId,
  });

  const familyRows = listFamilyRows(db);
  if (familyRows.length === 0) {
    const total = db.query(`SELECT COUNT(*) AS n ${from} WHERE ${where}`).get(bind as never) as {
      n: number;
    };
    const rows = db.query(cappedQuery(matchedCte, params.sort)).all({
      ...bind,
      $perSession: params.perSession,
      $limit: params.limit,
    } as never) as (TextMatchRow & BoundedMatchedRow)[];
    return finishBoundedSearch(rows, total.n, shape);
  }
  const rows = db.query(uncappedQuery(matchedCte)).all(bind as never) as TextMatchRow[];
  return finishSearch(familyRows, rows, params, shape);
}

interface FileTouchRow extends MatchedRow {
  operation: string;
  sourcePath: string;
  normalizedPath: string | null;
}

export function searchFileTouches(
  db: Database,
  params: SearchParams,
): SearchResult<FileTouchMatch> {
  if (params.file === null) throw new GliaError("INTERNAL", "searchFileTouches requires --file");
  const bind: Bindings = { $file: params.file };
  // Touches on a duplicate run's members list once, from the representative.
  const clauses: string[] = [
    FILE_MATCH_SQL,
    "e.seq = e.run_first_seq",
    ...mechanicalClauses(params, bind),
  ];
  const from = `FROM file_touches t
    JOIN events e ON e.event_id = t.event_id
    JOIN sessions r ON r.session_id = t.session_id`;
  const where = clauses.join(" AND ");

  // File-touch listing has no text relevance to rank by; `relevance`
  // keeps (session_id, seq) ordering with the same grouping and caps.
  const matchedCte = `SELECT e.session_id AS sessionId, e.seq AS eventSeq, e.run_last_seq AS runLastSeq,
       e.timestamp AS timestamp, t.operation AS operation,
       t.source_path AS sourcePath, t.normalized_path AS normalizedPath,
       e.source_file AS sourceFile, e.source_cursor AS sourceCursor,
       e.source_event_id AS sourceEventId, e.identity_key AS identityKey,
       json_extract(e.payload_json, '$.subagentType') AS subagentType,
       json_extract(e.payload_json, '$.subagentId') AS subagentId,
       0 AS rank
     ${from}
     WHERE ${where}`;
  const shape = (row: FileTouchRow): FileTouchMatch => ({
    eventSeq: row.eventSeq,
    runLastSeq: row.runLastSeq,
    operation: row.operation,
    sourcePath: row.sourcePath,
    normalizedPath: row.normalizedPath,
    locator: locatorOf(row),
    subagentType: row.subagentType,
    subagentId: row.subagentId,
  });

  const familyRows = listFamilyRows(db);
  if (familyRows.length === 0) {
    const total = db.query(`SELECT COUNT(*) AS n ${from} WHERE ${where}`).get(bind as never) as {
      n: number;
    };
    const rows = db.query(cappedQuery(matchedCte, params.sort)).all({
      ...bind,
      $perSession: params.perSession,
      $limit: params.limit,
    } as never) as (FileTouchRow & BoundedMatchedRow)[];
    return finishBoundedSearch(rows, total.n, shape);
  }
  const rows = db.query(uncappedQuery(matchedCte)).all(bind as never) as FileTouchRow[];
  return finishSearch(familyRows, rows, params, shape);
}

/** The timeline window: a forward range, or the filtered tail. */
export type ViewWindow =
  | { mode: "range"; from: number | null; limit: number | null }
  | { mode: "tail"; count: number };

export interface ViewEvent extends SubagentEvidence {
  seq: number;
  /** The event's duplicate-run bounds; a singleton has runFirstSeq === runLastSeq === seq. */
  runFirstSeq: number;
  runLastSeq: number;
  kind: string;
  role: string | null;
  timestamp: string | null;
  /** Full stored event text; rendering (collapse or whole) is the caller's. */
  text: string | null;
  /** Harness-attested tool names, as attested; non-empty only on tool calls. */
  toolNames: string[];
  locator: EvidenceLocator;
}

export interface ViewTimeline {
  /** True logical event count (a duplicate run counts once) under the same filters. */
  totalEvents: number;
  /** Highest sequence the Session holds, before filtering; null when empty. */
  maxSeq: number | null;
  /** Highest member sequence under the same filters; null when none match. */
  maxFilteredSeq: number | null;
  events: ViewEvent[];
}

interface ViewEventRow {
  eventId: number;
  seq: number;
  runFirstSeq: number;
  runLastSeq: number;
  kind: string;
  role: string | null;
  timestamp: string | null;
  text: string | null;
  sourceFile: string;
  sourceCursor: string;
  sourceEventId: string | null;
  subagentType: string | null;
  subagentId: string | null;
}

const VIEW_EVENT_COLUMNS = `e.event_id AS eventId, e.seq AS seq,
  e.run_first_seq AS runFirstSeq, e.run_last_seq AS runLastSeq,
  e.kind AS kind, e.role AS role,
  e.timestamp AS timestamp, e.text AS text, e.source_file AS sourceFile,
  e.source_cursor AS sourceCursor, e.source_event_id AS sourceEventId,
  json_extract(e.payload_json, '$.subagentType') AS subagentType,
  json_extract(e.payload_json, '$.subagentId') AS subagentId`;

/**
 * One Session's event timeline in source (`seq`) order — never re-ranked.
 * Filters reuse the search `--filter` model; the window applies after
 * filtering, and `totalEvents` ignores it so truncation stays honest.
 * The timeline is logical: a duplicate run renders once, positioned at
 * its first member and never partially — a `--from` cursor into the
 * middle of a run admits the whole run.
 */
export function viewTimeline(
  db: Database,
  sessionId: string,
  filters: EventFilter[],
  window: ViewWindow,
): ViewTimeline {
  const bind: Bindings = { $session: sessionId };
  const clauses = ["e.session_id = $session", "e.seq = e.run_first_seq"];
  const filterUnion = filters.map((f, i) => filterClause(f, i, bind));
  if (filterUnion.length > 0) clauses.push(`(${filterUnion.join(" OR ")})`);
  const filteredWhere = clauses.join(" AND ");

  const totalRow = db
    .query(`SELECT COUNT(*) AS n, MAX(e.run_last_seq) AS m FROM events e WHERE ${filteredWhere}`)
    .get(bind as never) as { n: number; m: number | null };
  const maxRow = db
    .query("SELECT MAX(seq) AS m FROM events e WHERE e.session_id = $session")
    .get({ $session: sessionId } as never) as { m: number | null };

  let rows: ViewEventRow[];
  if (window.mode === "tail") {
    rows = (
      db
        .query(
          `SELECT ${VIEW_EVENT_COLUMNS} FROM events e WHERE ${filteredWhere}
           ORDER BY e.seq DESC LIMIT $tail`,
        )
        .all({ ...bind, $tail: window.count } as never) as ViewEventRow[]
    ).reverse();
  } else {
    const windowed = [...clauses];
    if (window.from !== null) {
      // A run holding any member at or past the cursor shows whole.
      windowed.push("e.run_last_seq >= $from");
      bind["$from"] = window.from;
    }
    const limitSql = window.limit !== null ? " LIMIT $limit" : "";
    if (window.limit !== null) bind["$limit"] = window.limit;
    rows = db
      .query(
        `SELECT ${VIEW_EVENT_COLUMNS} FROM events e WHERE ${windowed.join(" AND ")}
         ORDER BY e.seq${limitSql}`,
      )
      .all(bind as never) as ViewEventRow[];
  }

  return {
    totalEvents: totalRow.n,
    maxSeq: maxRow.m,
    maxFilteredSeq: totalRow.m,
    events: shapeViewEvents(db, rows),
  };
}

/**
 * One source event by sequence within a Session, whole; null when absent.
 * Every member sequence of a duplicate run is addressable and returns
 * that member's own row; its run bounds state the membership.
 */
export function getEventBySeq(db: Database, sessionId: string, seq: number): ViewEvent | null {
  const row = db
    .query(`SELECT ${VIEW_EVENT_COLUMNS} FROM events e WHERE e.session_id = ? AND e.seq = ?`)
    .get(sessionId, seq) as ViewEventRow | null;
  if (!row) return null;
  return shapeViewEvents(db, [row])[0]!;
}

/**
 * Every logical event position of a Session, unfiltered: each duplicate
 * run's representative sequence with its last member sequence. Search
 * context windows count neighbors over this list.
 */
export function listLogicalSeqs(
  db: Database,
  sessionId: string,
): { seq: number; runLastSeq: number }[] {
  return db
    .query(
      `SELECT seq, run_last_seq AS runLastSeq FROM events
       WHERE session_id = ? AND seq = run_first_seq ORDER BY seq`,
    )
    .all(sessionId) as { seq: number; runLastSeq: number }[];
}

/** Logical events by representative sequence, in `seq` order. */
export function getLogicalEventsBySeqs(
  db: Database,
  sessionId: string,
  seqs: number[],
): ViewEvent[] {
  if (seqs.length === 0) return [];
  const placeholders = seqs.map(() => "?").join(", ");
  const rows = db
    .query(
      `SELECT ${VIEW_EVENT_COLUMNS} FROM events e
       WHERE e.session_id = ? AND e.seq IN (${placeholders}) ORDER BY e.seq`,
    )
    .all(sessionId, ...seqs) as ViewEventRow[];
  return shapeViewEvents(db, rows);
}

/**
 * The Current Revision's source files, in Source Bundle manifest order.
 * Read from the manifest, not from event locators: a Session whose
 * transcript normalizes to zero events still names its bundle files.
 */
export function getSessionSourceFiles(db: Database, sessionId: string): string[] {
  const rows = db
    .query("SELECT path AS f FROM artifacts WHERE session_id = ? ORDER BY rowid")
    .all(sessionId) as { f: string }[];
  return rows.map((r) => r.f);
}

/** Tool names for a whole page in one query; per-row lookup is an N+1 that
 * `search -C` would then pay once per result group. */
function toolNamesFor(db: Database, rows: ViewEventRow[]): Map<number, string[]> {
  const names = new Map<number, string[]>();
  const CHUNK = 500;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const ids = rows.slice(i, i + CHUNK).map((r) => r.eventId);
    if (ids.length === 0) continue;
    const placeholders = ids.map(() => "?").join(", ");
    const found = db
      .query(
        `SELECT event_id AS eventId, name FROM event_tool_names
         WHERE event_id IN (${placeholders}) ORDER BY event_id, rowid`,
      )
      .all(...ids) as { eventId: number; name: string }[];
    for (const { eventId, name } of found) {
      const list = names.get(eventId);
      if (list === undefined) names.set(eventId, [name]);
      else list.push(name);
    }
  }
  return names;
}

function shapeViewEvents(db: Database, rows: ViewEventRow[]): ViewEvent[] {
  const names = toolNamesFor(db, rows);
  return rows.map((row) => ({
    seq: row.seq,
    runFirstSeq: row.runFirstSeq,
    runLastSeq: row.runLastSeq,
    kind: row.kind,
    role: row.role,
    timestamp: row.timestamp,
    text: row.text,
    toolNames: names.get(row.eventId) ?? [],
    locator: locatorOf(row),
    subagentType: row.subagentType,
    subagentId: row.subagentId,
  }));
}

function locatorOf(row: {
  sourceFile: string;
  sourceCursor: string;
  sourceEventId: string | null;
}): EvidenceLocator {
  return {
    sourceFile: row.sourceFile,
    sourceCursor: row.sourceCursor,
    sourceEventId: row.sourceEventId,
  };
}
