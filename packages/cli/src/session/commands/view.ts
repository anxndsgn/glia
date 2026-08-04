import type { CommandDefinition } from "../../core/session-module.ts";
import type { CommandOutcome } from "../../core/output/result.ts";
import { GliaError } from "../../core/output/errors.ts";
import { LABEL_WIDTH, lineText, positiveIntOrNull, repeatedValues, seqRange } from "./shared.ts";
import { ensureProjection } from "../projection/publish.ts";
import {
  getEventBySeq,
  getSession,
  getSessionSourceFiles,
  openProjection,
  spawnedSubagentSessions,
  viewTimeline,
  type SessionRow,
  type SubagentColumns,
  type ViewEvent,
  type ViewTimeline,
  type ViewWindow,
} from "../projection/query.ts";
import { requireSessionUnconflicted } from "../domain/conflict.ts";
import { missingSessionError } from "../domain/deletion.ts";
import {
  FILTER_VOCABULARY,
  dateRange,
  eventLabel,
  multiplicityMarker,
  parseFilterValue,
} from "./search.ts";
import { subagentMatchMarker, subagentNote } from "./subagent-display.ts";

const DEFAULT_LIMIT = 50;
/** Fixed-width timestamp column; a missing timestamp pads to the same width. */
const TIMESTAMP_WIDTH = "2026-07-15T09:12:41Z".length;

export const viewCommand: CommandDefinition = {
  name: "view",
  projectAccess: "read",
  unenrolledRead: "error",
  description: "render one Session's event timeline in source order; read-only",
  arguments: [{ name: "session-id", description: "the Session ID" }],
  options: [
    {
      flags: "--filter <value>",
      description: `slice events by ${FILTER_VOCABULARY}; repeatable, values union`,
      repeatable: true,
    },
    { flags: "--limit <n>", description: `maximum events shown (default ${DEFAULT_LIMIT})` },
    { flags: "--all", description: "show every filtered event (mutually exclusive with --limit)" },
    { flags: "--tail <n>", description: "show the last <n> filtered events" },
    { flags: "--from <seq>", description: "start at the first event with sequence >= <seq>" },
    { flags: "--seq <n>", description: "render exactly one event in full (detail mode)" },
  ],
  async run(ctx, args, options): Promise<CommandOutcome> {
    const sessionId = args[0];
    if (!sessionId) throw new GliaError("USAGE", "session view requires a <session-id>");
    const filterValues = repeatedValues(options["filter"]);
    const filters = filterValues.map(parseFilterValue);
    const limit = positiveIntOrNull(options["limit"], "--limit");
    const all = options["all"] === true;
    const tail = positiveIntOrNull(options["tail"], "--tail");
    const from = positiveIntOrNull(options["from"], "--from");
    const seq = positiveIntOrNull(options["seq"], "--seq");

    // Every exclusion is USAGE before the projection is touched.
    if (seq !== null) {
      if (filters.length > 0 || limit !== null || all || tail !== null || from !== null) {
        throw new GliaError(
          "USAGE",
          "--seq renders one event and combines with no timeline option (--filter, --limit, --all, --tail, --from)",
        );
      }
    }
    if (all && limit !== null) {
      throw new GliaError("USAGE", "--all and --limit are mutually exclusive");
    }
    if (tail !== null && (from !== null || limit !== null || all)) {
      throw new GliaError(
        "USAGE",
        "--tail is a window of its own; it combines with none of --from, --limit, --all",
      );
    }

    await requireSessionUnconflicted(ctx.project.paths.storeDir, sessionId);

    const handle = await ensureProjection(ctx.project, ctx.env);
    const db = openProjection(handle.dbPath);
    try {
      const session = getSession(db, sessionId);
      if (!session) throw await missingSessionError(ctx.project.paths.storeDir, sessionId);
      const sourceFiles = getSessionSourceFiles(db, sessionId);
      const spawned = spawnedSubagentSessions(db, sessionId);
      const header = sessionHeaderJson(session, sourceFiles, spawned);
      const projection = { storeCommit: handle.storeCommit, stale: handle.stale };

      if (seq !== null) {
        const event = getEventBySeq(db, sessionId, seq);
        if (!event) {
          throw new GliaError("NOT_FOUND", `session ${sessionId} has no event #${seq}`, {
            sessionId,
            seq,
          });
        }
        return {
          json: { session: header, event: detailEventJson(event), projection },
          human: renderDetail(session, sourceFiles, event, spawned),
        };
      }

      const window: ViewWindow =
        tail !== null
          ? { mode: "tail", count: tail }
          : { mode: "range", from, limit: all ? null : (limit ?? DEFAULT_LIMIT) };
      const timeline = viewTimeline(db, sessionId, filters, window);
      return {
        json: {
          session: header,
          events: timeline.events.map(timelineEventJson),
          totalEvents: timeline.totalEvents,
          maxSeq: timeline.maxSeq,
          parameters: {
            filter: filterValues,
            limit: all || tail !== null ? null : (limit ?? DEFAULT_LIMIT),
            all,
            tail,
            from,
          },
          projection,
        },
        human: renderTimeline(session, sourceFiles, timeline, window, spawned),
      };
    } finally {
      db.close();
    }
  },
};

function sessionHeaderJson(session: SessionRow, sourceFiles: string[], spawned: string[]): object {
  return {
    sessionId: session.sessionId,
    harnessId: session.harnessId,
    firstTimestamp: session.firstTimestamp,
    lastTimestamp: session.lastTimestamp,
    continuationParent: session.continuationParent,
    revisionDigest: session.revisionDigest,
    archiveState: session.archiveState,
    sourceFiles,
    subagent: subagentJson(session, spawned),
  };
}

/** The Session's subagent facts, in both directions of the relation. */
export function subagentJson(session: SubagentColumns, spawned: string[]): object {
  return {
    // Presence is its own fact: kind and parent are both optional, so a
    // consumer cannot read their nulls as "not a subagent".
    isSubagent: session.subagentOrigin !== 0,
    kind: session.subagentKind,
    parentSourceSessionId: session.subagentParent,
    parentSessionId: session.subagentParentSession,
    transcriptCount: session.subagentCount,
    spawnedSessionIds: spawned,
  };
}

/**
 * The identifying fields both event transports open with, in transport
 * order. `label` is always a filter-vocabulary value; no transport role
 * field.
 */
function eventJsonPrefix(event: ViewEvent): object {
  return {
    seq: event.seq,
    label: eventLabel(event.kind, event.role),
    timestamp: event.timestamp,
    ...(event.kind === "tool_call" ? { toolNames: event.toolNames } : {}),
  };
}

function timelineEventJson(event: ViewEvent): object {
  return {
    ...eventJsonPrefix(event),
    text: lineText(event),
    memberSeqs: seqRange(event.runFirstSeq, event.runLastSeq),
    locator: event.locator,
  };
}

/** Detail mode is the one place `text` means the whole event. */
function detailEventJson(event: ViewEvent): object {
  const runLength = event.runLastSeq - event.runFirstSeq + 1;
  return {
    ...eventJsonPrefix(event),
    text: event.text,
    // The timeline showed only the run's first sequence; membership keeps
    // a mid-run sequence from reading as a phantom event.
    ...(runLength > 1
      ? {
          run: {
            firstSeq: event.runFirstSeq,
            lastSeq: event.runLastSeq,
            count: runLength,
            memberIndex: event.seq - event.runFirstSeq + 1,
          },
        }
      : {}),
    locator: event.locator,
  };
}

function headerLines(session: SessionRow, sourceFiles: string[], spawned: string[] = []): string[] {
  const parts = [session.sessionId, session.harnessId];
  const range = dateRange(session.firstTimestamp, session.lastTimestamp);
  if (range) parts.push(range);
  if (session.continuationParent) parts.push(`(continues ${session.continuationParent})`);
  const subagent = subagentNote(session);
  if (subagent !== null) parts.push(subagent);
  if (session.archiveState === "archived") parts.push("[archived]");
  const lines = [parts.join("  "), `  source: ${sourceFiles.join(", ")}`];
  // The inverse relation: Sessions that name this one as their parent. It
  // is display-only, so it reads as a note rather than a family or a link.
  if (spawned.length > 0) lines.push(`  spawned subagent sessions: ${spawned.join(", ")}`);
  return lines;
}

function renderEventLine(event: ViewEvent, seqWidth: number): string {
  const seq = `#${event.seq}`.padEnd(seqWidth);
  const label = eventLabel(event.kind, event.role).padEnd(LABEL_WIDTH);
  const timestamp = (event.timestamp ?? "-").padEnd(TIMESTAMP_WIDTH);
  const names =
    event.kind === "tool_call" && event.toolNames.length > 0
      ? `${event.toolNames.join(",")}  `
      : "";
  const mark = multiplicityMarker(event.runFirstSeq, event.runLastSeq);
  // Which subagent contributed the event, so a timeline mixing the parent's
  // own evidence with its subagents' stays attributable.
  const from = subagentMatchMarker(event);
  return `  ${seq} ${label} ${timestamp}  ${names}${lineText(event)}${mark}${from}`;
}

function renderTimeline(
  session: SessionRow,
  sourceFiles: string[],
  timeline: ViewTimeline,
  window: ViewWindow,
  spawned: string[],
): string {
  const lines = headerLines(session, sourceFiles, spawned);
  const events = timeline.events;
  const seqWidth = Math.max(0, ...events.map((e) => `#${e.seq}`.length));
  for (const event of events) lines.push(renderEventLine(event, seqWidth));

  const shown = events.length;
  if (shown === 0) {
    let summary = `  showing 0 of ${timeline.totalEvents} events`;
    if (
      window.mode === "range" &&
      window.from !== null &&
      timeline.maxSeq !== null &&
      window.from > timeline.maxSeq
    ) {
      summary += ` · highest sequence is #${timeline.maxSeq}`;
    }
    lines.push(summary);
  } else if (shown === timeline.totalEvents && window.mode === "range" && window.from === null) {
    lines.push(`  ${shown} ${shown === 1 ? "event" : "events"}.`);
  } else {
    const first = events[0]!.seq;
    const lastEvent = events[events.length - 1]!;
    const last = lastEvent.seq;
    let summary = `  showing events #${first}–#${last} of ${timeline.totalEvents}`;
    // A continuation hint only when filtered events actually follow; the
    // cursor resumes past the last shown run's last member, no overlap.
    if (
      window.mode === "range" &&
      timeline.maxFilteredSeq !== null &&
      lastEvent.runLastSeq < timeline.maxFilteredSeq
    ) {
      summary += ` · continue with --from ${lastEvent.runLastSeq + 1}`;
    }
    lines.push(summary);
  }
  return lines.join("\n");
}

function renderDetail(
  session: SessionRow,
  sourceFiles: string[],
  event: ViewEvent,
  spawned: string[],
): string {
  const label = eventLabel(event.kind, event.role);
  const names =
    event.kind === "tool_call" && event.toolNames.length > 0
      ? `  ${event.toolNames.join(",")}`
      : "";
  const locator = `${event.locator.sourceFile}:${event.locator.sourceCursor}`;
  const eventId = event.locator.sourceEventId ? `  event ${event.locator.sourceEventId}` : "";
  const runLength = event.runLastSeq - event.runFirstSeq + 1;
  const membership =
    runLength > 1
      ? [
          `  member ${event.seq - event.runFirstSeq + 1} of ${runLength} in a collapsed duplicate run spanning #${event.runFirstSeq}–#${event.runLastSeq}`,
        ]
      : [];
  return [
    ...headerLines(session, sourceFiles, spawned),
    `  #${event.seq}  ${label}  ${event.timestamp ?? "-"}${names}`,
    `  ${locator}${eventId}`,
    ...membership,
    "",
    event.text ?? "(this event has no text)",
  ].join("\n");
}
