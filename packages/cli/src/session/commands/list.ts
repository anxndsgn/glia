import type { CommandDefinition } from "../../core/session-module.ts";
import type { CommandOutcome } from "../../core/output/result.ts";
import { assertEveryFieldConsidered, positiveIntOrNull } from "./shared.ts";
import { queryProjection, readableProjectionJson, readableNotes } from "../projection/readable.ts";
import { listSessions, type SessionRow } from "../projection/query.ts";
import { listFamilyRows, visibleFamilyFacts, type FamilyFacts } from "../projection/family.ts";
import { familyNote } from "./family-display.ts";
import { subagentNote } from "./subagent-display.ts";
import { dateRange } from "./search.ts";
import { dimmer, padWidth, truncateWidth } from "../../core/output/terminal.ts";

/** The group header for a Session whose source left no event timestamps. */
const UNDATED_GROUP = "no event timestamps";

/** Row width the columns are budgeted against; the Label absorbs the slack. */
const ROW_BUDGET = 110;
/** Below this a Label column says too little to be worth its width. */
const MIN_LABEL_WIDTH = 28;
/** Every Session ID is this wide: `ses_` and a 32-character digest. */
const SESSION_ID_WIDTH = 36;

export const listCommand: CommandDefinition = {
  name: "list",
  projectAccess: "read",
  unenrolledRead: "empty",
  description: "list local and saved Sessions by latest event time, newest first",
  options: [
    { flags: "--saved", description: "read only saved Store evidence" },
    {
      flags: "--limit <n>",
      description: "maximum Sessions shown (unbounded by default; the true total is always stated)",
    },
    {
      flags: "--include-archived",
      description: "include Archived Sessions and label them",
    },
  ],
  async run(ctx, _args, options): Promise<CommandOutcome> {
    const limit = positiveIntOrNull(options["limit"], "--limit");
    const includeArchived = options["includeArchived"] === true;
    const handle = await queryProjection(ctx, options["saved"] === true);
    const db = handle.db;
    try {
      const sessions = listSessions(db, includeArchived);
      // Family facts cover the visible set: the Sessions this listing
      // actually renders after archive filtering and the active window.
      const shown = limit === null ? sessions : sessions.slice(0, limit);
      const families = visibleFamilyFacts(listFamilyRows(db), shown);
      const lines = renderListing(sessions, shown, families, dimmer(ctx.colors === true));
      if (shown.length < sessions.length) {
        lines.push(`${shown.length} of ${sessions.length} session(s) shown (raise --limit).`);
      }
      if (handle.stale)
        lines.push("note: the projection is stale; run any query again to rebuild it.");
      if (sessions.length > 0) lines.push("Read one with `glia view <session-id>`.");
      return {
        json: {
          totalSessions: sessions.length,
          sessions: shown.map((session) =>
            sessionEntryJson(session, families.get(session.sessionId) ?? null),
          ),
          parameters: { limit, includeArchived },
          projection: readableProjectionJson(
            handle,
            shown.map((s) => s.sessionId),
          ),
        },
        human:
          lines.join("\n") +
          readableNotes(
            handle,
            shown.map((s) => s.sessionId),
          ),
      };
    } finally {
      db.close();
    }
  },
};

/**
 * One listed Session, under "absent means default": identity, size, and
 * timestamps appear on every entry whatever their value, and every other
 * field is emitted only when it says something — a non-null value, an
 * archived Session, an explicit association, a subagent fact. The
 * `revisionDigest` leaves the listing entirely; `show` is the
 * full-fidelity surface that still carries it.
 *
 * The row is destructured rather than read field by field so a column added
 * to `SessionRow` fails the build here instead of silently missing the
 * listing.
 */
function sessionEntryJson(session: SessionRow, family: FamilyFacts | null): object {
  const {
    sessionId,
    harnessId,
    sourceSessionId,
    openingPath,
    associationMode,
    continuationParent,
    // The listing's one unconditional omission: recoverable from `show`.
    revisionDigest: _revisionDigest,
    acceptedAt,
    archiveState,
    eventCount,
    firstTimestamp,
    lastTimestamp,
    label,
    labelSource,
    labelSeq,
    subagentOrigin,
    subagentKind,
    subagentParent,
    subagentParentSession,
    subagentCount,
    ...unconsidered
  } = session;
  assertEveryFieldConsidered(unconsidered);
  return {
    sessionId,
    harnessId,
    sourceSessionId,
    ...(openingPath !== null ? { openingPath } : {}),
    ...(associationMode !== "inferred" ? { associationMode } : {}),
    ...(continuationParent !== null ? { continuationParent } : {}),
    acceptedAt,
    ...(archiveState !== "active" ? { archiveState } : {}),
    eventCount,
    firstTimestamp,
    lastTimestamp,
    ...(label !== null ? { label } : {}),
    ...(labelSource !== null ? { labelSource } : {}),
    ...(labelSeq !== null ? { labelSeq } : {}),
    ...(subagentOrigin !== 0 ? { subagentOrigin } : {}),
    ...(subagentKind !== null ? { subagentKind } : {}),
    ...(subagentParent !== null ? { subagentParent } : {}),
    ...(subagentParentSession !== null ? { subagentParentSession } : {}),
    ...(subagentCount !== 0 ? { subagentCount } : {}),
    ...(family !== null ? { family } : {}),
  };
}

/**
 * The listing reads as dated groups: one header per run of Sessions that
 * share a latest-event date, the Sessions under it. Facts shared by the
 * whole listing — the date span, a single Harness — are stated once in
 * the summary instead of repeating on every row, and per-Session facts
 * that only sometimes apply (an earlier start, a continuation parent, an
 * archive marker) appear only where they hold.
 */
function renderListing(
  sessions: SessionRow[],
  shown: SessionRow[],
  families: Map<string, FamilyFacts>,
  dim: (text: string) => string,
): string[] {
  const lines = [summaryLine(sessions)];
  if (sessions.length === 0) {
    lines.push("Discover importable Sessions with `glia candidates`.");
    return lines;
  }
  // One Harness across the whole listing is stated in the summary; a mixed
  // listing needs the Harness on each row to stay readable.
  const perRowHarness = new Set(sessions.map((r) => r.harnessId)).size > 1;
  const countWidth = Math.max(...shown.map((r) => String(r.eventCount).length));
  const harnessWidth = perRowHarness ? Math.max(...shown.map((r) => r.harnessId.length)) : 0;
  // The Label column takes whatever the fixed columns leave inside the row
  // budget, and never shrinks past the point of being readable.
  const labelWidth = Math.max(
    MIN_LABEL_WIDTH,
    ROW_BUDGET -
      (2 + SESSION_ID_WIDTH + 2 + (perRowHarness ? harnessWidth + 2 : 0) + countWidth + 9),
  );

  let group: string | null = null;
  for (const session of shown) {
    const key = groupKey(session);
    if (key !== group) {
      lines.push("");
      lines.push(key);
      group = key;
    }
    lines.push(
      sessionLine(
        session,
        key,
        countWidth,
        perRowHarness ? harnessWidth : null,
        labelWidth,
        families.get(session.sessionId) ?? null,
        dim,
      ),
    );
  }
  lines.push("");
  return lines;
}

/** The whole listing's shape: how many, over what dates, from where. */
function summaryLine(sessions: SessionRow[]): string {
  const parts = [`${sessions.length} session(s)`];
  const first = sessions
    .map((r) => r.firstTimestamp)
    .filter((t): t is string => t !== null)
    .sort()[0];
  const last = sessions
    .map((r) => r.lastTimestamp)
    .filter((t): t is string => t !== null)
    .sort()
    .at(-1);
  const span = dateRange(first ?? null, last ?? null);
  if (span !== null) parts.push(span);
  const harnesses = [...new Set(sessions.map((r) => r.harnessId))].sort();
  if (harnesses.length === 1) parts.push(`all ${harnesses[0]}`);
  else if (harnesses.length > 1) parts.push(harnesses.join(", "));
  const archived = sessions.filter((r) => r.archiveState === "archived").length;
  if (archived > 0) parts.push(`${archived} archived`);
  return `${parts.join(", ")}.`;
}

/** A Session groups under its latest event date, never its acceptance date. */
function groupKey(session: SessionRow): string {
  return session.lastTimestamp?.slice(0, 10) ?? UNDATED_GROUP;
}

/**
 * One Session, one row: the identity it is addressed by, its size, the
 * Session Label that says which Session it is, then the notes that only
 * some Sessions carry. The Label is padded so those notes stay a column
 * rather than drifting with the Label's length.
 */
function sessionLine(
  session: SessionRow,
  group: string,
  countWidth: number,
  harnessWidth: number | null,
  labelWidth: number,
  family: FamilyFacts | null,
  dim: (text: string) => string,
): string {
  const parts = [session.sessionId];
  if (harnessWidth !== null) parts.push(session.harnessId.padEnd(harnessWidth));
  const events = (session.eventCount === 1 ? "event" : "events").padEnd("events".length);
  parts.push(`${String(session.eventCount).padStart(countWidth)} ${events}`);

  const notes: string[] = [];
  // The Session's own dates, never a fabricated one: only a Session that
  // started before its group's date carries the earlier bound.
  const from = session.firstTimestamp?.slice(0, 10) ?? null;
  if (from !== null && from !== group) notes.push(`from ${from}`);
  if (session.continuationParent !== null) notes.push(`(continues ${session.continuationParent})`);
  const subagent = subagentNote(session);
  if (subagent !== null) notes.push(subagent);
  const familyNoteText = familyNote(session.sessionId, family);
  if (familyNoteText !== null) notes.push(familyNoteText);
  if (session.archiveState === "archived") notes.push("[archived]");

  // The Label is read, not addressed: it is dimmed so the Session IDs and
  // counts a reader acts on stay the row's foreground.
  // Measured in terminal columns, never code units: a Label is arbitrary
  // source text, and a wide script pads to the wrong width by length.
  const label = session.label === null ? "" : truncateWidth(session.label, labelWidth);
  if (notes.length > 0) parts.push(dim(padWidth(label, labelWidth)));
  else if (label !== "") parts.push(dim(label));
  parts.push(...notes);
  return `  ${parts.join("  ")}`;
}
