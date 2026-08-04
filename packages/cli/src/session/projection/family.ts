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
 * records them in `session_families`. Two edge kinds connect Sessions of
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
  // Shared-identity edges come from per-key holder lists, not an events
  // self-join: a join emits one row per shared event per Session pair, so
  // a long fork prefix held by several twins multiplies out before its
  // DISTINCT. Restricting to keys with two or more holding Sessions and
  // deduplicating to (key, Session) keeps the row count at the number of
  // distinct holdings.
  const holdings = db
    .query(
      `WITH shared_keys AS (
         SELECT identity_key FROM events
         WHERE identity_key IS NOT NULL
         GROUP BY identity_key
         HAVING COUNT(DISTINCT session_id) >= 2
       )
       SELECT DISTINCT e.identity_key AS key, e.session_id AS sessionId, r.harness_id AS harnessId
       FROM events e
       JOIN shared_keys s ON s.identity_key = e.identity_key
       JOIN sessions r ON r.session_id = e.session_id`,
    )
    .all() as { key: string; sessionId: string; harnessId: string }[];
  // Within one key, Sessions of one Harness are pairwise connected; for
  // union-find, linking each holder to the group's first member suffices.
  const holdersByKey = Map.groupBy(holdings, (row) => row.key);
  for (const holders of holdersByKey.values()) {
    const firstOfHarness = new Map<string, string>();
    for (const { sessionId, harnessId } of holders) {
      const first = firstOfHarness.get(harnessId);
      if (first === undefined) {
        firstOfHarness.set(harnessId, sessionId);
      } else {
        edges.push({ a: first, b: sessionId });
      }
    }
  }
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
  /** Distinct identity keys this member shares with the addressed Session;
   *  0 for the addressed Session itself and for continuation-only links. */
  sharedEvents: number;
  /** The addressed Session's last event shared with this member — the
   *  point after which the two diverge; null when nothing is shared. */
  lastShared: { seq: number; timestamp: string | null } | null;
}

export interface FamilyDetail {
  anchor: string;
  members: FamilyMemberDetail[];
}

/**
 * One Session's family over the whole Store — the direct-address rule:
 * archive filtering does not apply, and archived members are reported
 * with their state so the caller can mark them. Each member carries its
 * overlap with the addressed Session: how many events are shared, and
 * where in the addressed Session that shared history ends.
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
    .all(row.familyKey) as {
    sessionId: string;
    archiveState: ArchiveState;
    firstTimestamp: string | null;
  }[];
  // Overlap with the addressed Session per member: shared distinct keys
  // and the addressed Session's last shared seq. Membership is restricted
  // to the family so an incidental cross-Harness identity match (equal
  // identifier, timestamp, and text in another Harness) contributes nothing.
  const overlaps = db
    .query(
      `SELECT e2.session_id AS sessionId,
              COUNT(DISTINCT e1.identity_key) AS sharedEvents,
              MAX(e1.seq) AS lastSharedSeq
       FROM events e1
       JOIN events e2 ON e2.identity_key = e1.identity_key
         AND e2.session_id <> e1.session_id
       JOIN session_families f ON f.session_id = e2.session_id AND f.family_key = ?
       WHERE e1.session_id = ? AND e1.identity_key IS NOT NULL
       GROUP BY e2.session_id`,
    )
    .all(row.familyKey, sessionId) as {
    sessionId: string;
    sharedEvents: number;
    lastSharedSeq: number;
  }[];
  const overlapOf = new Map(overlaps.map((o) => [o.sessionId, o]));
  const timestampAt = db.prepare("SELECT timestamp FROM events WHERE session_id = ? AND seq = ?");
  const anchor = chooseAnchor(members);
  members.sort((a, b) => {
    if (a.sessionId === anchor) return -1;
    if (b.sessionId === anchor) return 1;
    return a.sessionId.localeCompare(b.sessionId);
  });
  return {
    anchor,
    members: members.map((member) => {
      const overlap = overlapOf.get(member.sessionId);
      const lastShared =
        overlap === undefined
          ? null
          : {
              seq: overlap.lastSharedSeq,
              timestamp:
                (
                  timestampAt.get(sessionId, overlap.lastSharedSeq) as {
                    timestamp: string | null;
                  } | null
                )?.timestamp ?? null,
            };
      return {
        sessionId: member.sessionId,
        archiveState: member.archiveState,
        sharedEvents: overlap?.sharedEvents ?? 0,
        lastShared,
      };
    }),
  };
}
