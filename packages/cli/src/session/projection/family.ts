import type { Database } from "bun:sqlite";
import type { ArchiveState } from "../domain/archive.ts";

/** One Session's membership in a Fork Family, as projected at build. */
export interface FamilyRow {
  sessionId: string;
  familyKey: string;
}

/** Family facts over a visible set: the anchor and the visible member count. */
export interface FamilyFacts {
  anchor: string;
  memberCount: number;
}

/**
 * Detects Fork Families from the events and sessions just projected and
 * sessions them in `session_families`. Two edge kinds connect Sessions of
 * one Harness: at least one pair of identity-sharing events, or a
 * source-provided Continuation naming the other's source Session. A
 * family is a connected component over both kinds; a component of one
 * Session is not a family and stores nothing. Detection of exact identity
 * only — when identifiers match but text differs, or identifiers are
 * absent, there is no edge: the failure direction is always to show
 * more, never to collapse distinct content.
 */
export function detectFamilies(db: Database): void {
  const edges: { a: string; b: string }[] = [];
  // An unordered pair needs only one direction: union-find treats the
  // edge the same either way, and `>` halves the join's output rows.
  const shared = db
    .query(
      `SELECT DISTINCT e1.session_id AS a, e2.session_id AS b
       FROM events e1
       JOIN sessions r1 ON r1.session_id = e1.session_id
       JOIN events e2 ON e2.identity_key = e1.identity_key
         AND e2.session_id > e1.session_id
       JOIN sessions r2 ON r2.session_id = e2.session_id AND r2.harness_id = r1.harness_id
       WHERE e1.identity_key IS NOT NULL`,
    )
    .all() as { a: string; b: string }[];
  edges.push(...shared);
  const continuations = db
    .query(
      `SELECT r1.session_id AS a, r2.session_id AS b
       FROM sessions r1
       JOIN sessions r2 ON r2.source_session_id = r1.continuation_parent
         AND r2.harness_id = r1.harness_id
         AND r2.session_id <> r1.session_id
       WHERE r1.continuation_parent IS NOT NULL`,
    )
    .all() as { a: string; b: string }[];
  edges.push(...continuations);

  // Connected components over both edge kinds by union-find.
  const parent = new Map<string, string>();
  const find = (x: string): string => {
    let root = x;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let node = x;
    while (parent.get(node) !== node) {
      const next = parent.get(node)!;
      parent.set(node, root);
      node = next;
    }
    return root;
  };
  const ensure = (x: string): void => {
    if (!parent.has(x)) parent.set(x, x);
  };
  for (const { a, b } of edges) {
    ensure(a);
    ensure(b);
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  const components = Map.groupBy([...parent.keys()], find);
  const insert = db.prepare("INSERT INTO session_families (session_id, family_key) VALUES (?, ?)");
  for (const members of components.values()) {
    if (members.length < 2) continue;
    const familyKey = members.reduce((lowest, id) => (id < lowest ? id : lowest));
    for (const sessionId of members) insert.run(sessionId, familyKey);
  }
}

/** Session ID to family key, the index every visible-set rule reads. */
export function familyKeyIndex(familyRows: FamilyRow[]): Map<string, string> {
  return new Map(familyRows.map((row) => [row.sessionId, row.familyKey]));
}

/** Every projected family membership; empty when the Store holds no families. */
export function listFamilyRows(db: Database): FamilyRow[] {
  return db
    .query("SELECT session_id AS sessionId, family_key AS familyKey FROM session_families")
    .all() as FamilyRow[];
}

/**
 * The one timestamp ordering the reading surfaces share: earliest
 * non-null timestamp first, null timestamps last, ties broken by
 * ascending Session ID. The Fork Family anchor and `--sort time` group
 * order are the same rule, so they read it from the same place.
 */
export function compareByTimestampThenId(
  a: { timestamp: string | null; sessionId: string },
  b: { timestamp: string | null; sessionId: string },
): number {
  if (a.timestamp !== b.timestamp) {
    if (a.timestamp === null) return 1;
    if (b.timestamp === null) return -1;
    return a.timestamp < b.timestamp ? -1 : 1;
  }
  return a.sessionId.localeCompare(b.sessionId);
}

/**
 * The anchor of a member set: the member with the earliest non-null
 * first event timestamp; members without timestamps order last and ties
 * break by ascending Session ID.
 */
export function chooseAnchor(
  members: { sessionId: string; firstTimestamp: string | null }[],
): string {
  let anchor = members[0]!;
  for (const member of members) {
    const ordering = compareByTimestampThenId(
      { timestamp: member.firstTimestamp, sessionId: member.sessionId },
      { timestamp: anchor.firstTimestamp, sessionId: anchor.sessionId },
    );
    if (ordering < 0) anchor = member;
  }
  return anchor.sessionId;
}

/**
 * Family facts over a visible set — the Sessions one query actually
 * returns after its filters. The anchor is chosen among visible members
 * and member counts count visible members, so a family note never
 * references a Session the reader cannot see in the same output. A
 * family with one visible member yields no facts.
 */
export function visibleFamilyFacts(
  familyRows: FamilyRow[],
  visible: { sessionId: string; firstTimestamp: string | null }[],
): Map<string, FamilyFacts> {
  const familyOf = familyKeyIndex(familyRows);
  const byFamily = Map.groupBy(visible, (member) => familyOf.get(member.sessionId));
  const facts = new Map<string, FamilyFacts>();
  for (const [familyKey, members] of byFamily) {
    if (familyKey === undefined || members.length < 2) continue;
    const anchor = chooseAnchor(members);
    for (const member of members) {
      facts.set(member.sessionId, { anchor, memberCount: members.length });
    }
  }
  return facts;
}

export interface FamilyMemberDetail {
  sessionId: string;
  archiveState: ArchiveState;
}

export interface FamilyDetail {
  anchor: string;
  members: FamilyMemberDetail[];
}

/**
 * One Session's family over the whole Store — the direct-address rule:
 * archive filtering does not apply, and archived members are reported
 * with their state so the caller can mark them.
 */
export function sessionFamilyDetail(db: Database, sessionId: string): FamilyDetail | null {
  const row = db
    .query("SELECT family_key AS familyKey FROM session_families WHERE session_id = ?")
    .get(sessionId) as { familyKey: string } | null;
  if (!row) return null;
  const members = db
    .query(
      `SELECT f.session_id AS sessionId, r.archive_state AS archiveState,
              r.first_timestamp AS firstTimestamp
       FROM session_families f
       JOIN sessions r ON r.session_id = f.session_id
       WHERE f.family_key = ?`,
    )
    .all(row.familyKey) as (FamilyMemberDetail & { firstTimestamp: string | null })[];
  const anchor = chooseAnchor(members);
  members.sort((a, b) => {
    if (a.sessionId === anchor) return -1;
    if (b.sessionId === anchor) return 1;
    return a.sessionId.localeCompare(b.sessionId);
  });
  return {
    anchor,
    members: members.map(({ sessionId, archiveState }) => ({ sessionId, archiveState })),
  };
}
