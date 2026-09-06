import type { CommandDefinition } from "../../core/session-module.ts";
import type { CommandOutcome } from "../../core/output/result.ts";
import { GliaError } from "../../core/output/errors.ts";
import {
  LABEL_WIDTH,
  assertEveryFieldConsidered,
  lineText,
  nonNegativeInt,
  positiveInt,
  repeatedValues,
  seqRange,
} from "./shared.ts";
import { alsoInMarker, familyNote } from "./family-display.ts";
import { subagentMatchMarker, subagentNote } from "./subagent-display.ts";
import { queryProjection, readableProjectionJson, readableNotes } from "../projection/readable.ts";
import {
  getLogicalEventsBySeqs,
  listLogicalSeqs,
  searchFileTouches,
  searchText,
  type EventFilter,
  type EvidenceLocator,
  type FileTouchMatch,
  type SessionMatchGroup,
  type SearchParams,
  type SearchResult,
  type SearchSort,
  type SubagentEvidence,
  type TextMatch,
  type ViewEvent,
} from "../projection/query.ts";
import { parseHarnessOption } from "./import.ts";
import type { Database } from "bun:sqlite";
import { discoverCandidates } from "../domain/discover.ts";
import {
  advisoriesForDiscovery,
  renderDiscoveryAdvisories,
  type SessionAdvisory,
} from "../domain/advisories.ts";

const DEFAULT_LIMIT = 20;
const DEFAULT_PER_SESSION = 3;

export const FILTER_VOCABULARY =
  "user, agent, toolcall, toolcall:<name>, toolresult, message, lifecycle, system, unknown, subagent";

/** The `--file` matching rule, stated where the decision is made. */
export const FILE_MATCH_RULE =
  "matches a touched path exactly, or as whole trailing path segments after a '/'" +
  " (auth.ts matches src/lib/auth.ts; src/lib matches nothing)";

const SORT_MODES = "relevance, time";

export const searchCommand: CommandDefinition = {
  name: "search",
  projectAccess: "read",
  unenrolledRead: "empty",
  description: "search local and saved evidence; never imports and never changes the Store",
  arguments: [
    { name: "[query]", description: "text query; every term matches as a substring (see --word)" },
  ],
  options: [
    { flags: "--saved", description: "read only saved Store evidence" },
    {
      flags: "--compact",
      description:
        "use grouped JSON when smaller, inheriting Session fields and reusing context (--json required)",
    },
    {
      flags: "--word",
      description:
        "match query terms only at word boundaries (ASCII letters, digits, _);" +
        " term edges outside that alphabet, notably CJK, keep substring matching",
    },
    {
      flags: "--file <path>",
      description: `restrict to Sessions with a matching File Touch; the value ${FILE_MATCH_RULE}`,
    },
    { flags: "--harness <id>", description: "filter by harness (codex or claude-code)" },
    {
      flags: "--since <time>",
      description: "filter events at or after an ISO 8601 date or timestamp",
    },
    {
      flags: "--filter <value>",
      description: `slice events by ${FILTER_VOCABULARY}; repeatable, values union`,
      repeatable: true,
    },
    {
      flags: "--per-session <n>",
      description: `matches shown per Session (default ${DEFAULT_PER_SESSION})`,
    },
    { flags: "--limit <count>", description: `maximum matches shown (default ${DEFAULT_LIMIT})` },
    {
      flags: "-C, --context <n>",
      description:
        "show up to <n> neighboring events around each match, from the Session unfiltered (default 0)",
    },
    {
      flags: "--sort <mode>",
      description: `order Session groups by ${SORT_MODES}; time is oldest-first by earliest matching event (default relevance)`,
    },
    {
      flags: "--include-archived",
      description: "include matches from Archived Sessions and label them",
    },
  ],
  async run(ctx, args, options): Promise<CommandOutcome> {
    const compact = options["compact"] === true;
    if (compact && !ctx.jsonMode) {
      throw new GliaError("USAGE", "--compact requires --json");
    }
    const query = args[0] ?? null;
    const file = options["file"] !== undefined ? String(options["file"]) : null;
    if (query === null && file === null) {
      throw new GliaError("USAGE", "glia search requires a text query, --file, or both");
    }
    const word = options["word"] === true;
    if (word && query === null) {
      throw new GliaError("USAGE", "--word requires a text query");
    }
    const filterValues = repeatedValues(options["filter"]);
    const context = nonNegativeInt(options["context"], "--context", 0);
    const params: SearchParams = {
      query,
      file,
      harness: parseHarnessOption(options["harness"]),
      since: normalizeSince(options["since"]),
      filters: filterValues.map(parseFilterValue),
      limit: positiveInt(options["limit"], "--limit", DEFAULT_LIMIT),
      perSession: positiveInt(options["perSession"], "--per-session", DEFAULT_PER_SESSION),
      sort: parseSortMode(options["sort"]),
      includeArchived: options["includeArchived"] === true,
      word,
    };
    const parameters = {
      query,
      word,
      file,
      harness: params.harness,
      since: params.since,
      filter: filterValues,
      perSession: params.perSession,
      limit: params.limit,
      context,
      sort: params.sort,
      includeArchived: params.includeArchived,
    };

    const handle = await queryProjection(ctx, options["saved"] === true);
    const db = handle.db;
    try {
      const finish = async <M extends { eventSeq: number; runLastSeq: number }>(
        mode: string,
        result: SearchResult<M>,
        matchJson: (match: M) => MatchJson,
        renderMatch: (match: M, seqWidth: number, prefix: string) => string[],
        noun: string,
      ): Promise<CommandOutcome> => {
        const contexts = computeContexts(db, result.groups, context);
        const flat = { matches: flattenGroups(result.groups, contexts, matchJson) };
        let entries: object = flat;
        if (compact) {
          const grouped = {
            layout: "grouped",
            groups: compactGroups(result.groups, contexts, matchJson),
          };
          // Sparse queries can cost more as groups. Compare the complete
          // alternative payloads, including their discriminator and keys.
          // Bytes are deterministic; token savings depend on the tokenizer.
          if (
            Buffer.byteLength(JSON.stringify(grouped)) < Buffer.byteLength(JSON.stringify(flat))
          ) {
            entries = grouped;
          }
        }
        const outcome: CommandOutcome = {
          json: {
            mode,
            totalMatches: result.totalMatches,
            familyCollapsedMatches: result.familyCollapsedMatches,
            ...entries,
            parameters,
            projection: readableProjectionJson(
              handle,
              result.groups.map((g) => g.sessionId),
            ),
          },
          human:
            renderGroups(result, params, contexts, renderMatch, noun) +
            readableNotes(
              handle,
              result.groups.map((g) => g.sessionId),
            ),
        };
        return options["saved"] === true
          ? await addZeroResultAdvisories(ctx, result.totalMatches, outcome)
          : outcome;
      };
      if (params.query !== null) {
        return await finish(
          "text",
          searchText(db, params),
          textMatchJson,
          renderTextMatch,
          "matches",
        );
      }
      return await finish(
        "file_touches",
        searchFileTouches(db, params),
        fileTouchMatchJson,
        renderFileTouchMatch,
        "file touches",
      );
    } finally {
      db.close();
    }
  },
};

async function addZeroResultAdvisories(
  ctx: Parameters<CommandDefinition["run"]>[0],
  totalMatches: number,
  outcome: CommandOutcome,
): Promise<CommandOutcome> {
  if (totalMatches !== 0) return outcome;
  const discovery = await discoverCandidates(ctx.project, ctx.env, null);
  const advisories: SessionAdvisory[] = await advisoriesForDiscovery(ctx.project, discovery);
  if (advisories.length === 0) return outcome;
  return {
    json: { ...(outcome.json as Record<string, unknown>), advisories },
    human: [outcome.human, ...renderDiscoveryAdvisories(advisories)].join("\n"),
  };
}

export function parseFilterValue(value: string): EventFilter {
  switch (value) {
    case "user":
      return { slice: "speaker", value, role: "user" };
    case "agent":
      return { slice: "speaker", value, role: "assistant" };
    case "toolcall":
      return { slice: "kind", value, eventKind: "tool_call" };
    case "toolresult":
      return { slice: "kind", value, eventKind: "tool_result" };
    case "message":
    case "lifecycle":
    case "system":
    case "unknown":
      return { slice: "kind", value, eventKind: value };
    // Not an event kind but a provenance slice: the evidence a subagent
    // transcript contributed, whatever kinds it holds.
    case "subagent":
      return { slice: "subagent", value };
  }
  if (value.startsWith("toolcall:")) {
    const name = value.slice("toolcall:".length);
    if (name.length > 0) return { slice: "tool", value, toolName: name };
  }
  throw new GliaError("USAGE", `--filter accepts ${FILTER_VOCABULARY}; got: ${value}`);
}

function parseSortMode(raw: unknown): SearchSort {
  if (raw === undefined) return "relevance";
  const value = String(raw);
  if (value === "relevance" || value === "time") return value;
  throw new GliaError("USAGE", `--sort accepts ${SORT_MODES}; got: ${value}`);
}

function normalizeSince(value: unknown): string | null {
  if (value === undefined) return null;
  const raw = String(value);
  const isoLike = /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?)?$/;
  if (!isoLike.test(raw)) {
    throw new GliaError("USAGE", `--since must be an ISO 8601 date or timestamp, got ${raw}`);
  }
  return raw;
}

/** The visible multiplicity marker for a collapsed run; empty for a singleton. */
export function multiplicityMarker(eventSeq: number, runLastSeq: number): string {
  const count = runLastSeq - eventSeq + 1;
  return count > 1 ? ` ×${count}` : "";
}

interface GroupContext {
  /** Context-only logical events for the group (shown matches excluded), by seq. */
  events: ViewEvent[];
  /** Each shown match's own context window seqs, in seq order. */
  perMatch: Map<number, number[]>;
}

/**
 * `-C` neighborhoods: up to `n` logical events on each side of every
 * shown match, drawn from the Session unfiltered. Windows overlap-merge,
 * and an event shown as a match never repeats as context.
 */
function computeContexts<M extends { eventSeq: number }>(
  db: Database,
  groups: SessionMatchGroup<M>[],
  n: number,
): Map<string, GroupContext> {
  const contexts = new Map<string, GroupContext>();
  if (n === 0) return contexts;
  for (const group of groups) {
    const logical = listLogicalSeqs(db, group.sessionId);
    const position = new Map<number, number>();
    logical.forEach((entry, index) => position.set(entry.seq, index));
    const shown = new Set(group.matches.map((m) => m.eventSeq));
    const perMatch = new Map<number, number[]>();
    const contextSeqs = new Set<number>();
    for (const match of group.matches) {
      const at = position.get(match.eventSeq);
      if (at === undefined) continue;
      const window: number[] = [];
      for (let i = Math.max(0, at - n); i <= Math.min(logical.length - 1, at + n); i += 1) {
        const seq = logical[i]!.seq;
        if (shown.has(seq)) continue;
        window.push(seq);
        contextSeqs.add(seq);
      }
      perMatch.set(match.eventSeq, window);
    }
    contexts.set(group.sessionId, {
      events: getLogicalEventsBySeqs(db, group.sessionId, [...contextSeqs]),
      perMatch,
    });
  }
  return contexts;
}

/**
 * The JSON match array: display order, Session identity on every match.
 *
 * Identity and citation are exempt from the omission rule — `sessionId`,
 * `eventSeq`, `harnessId`, and `locator` are what make a flat match
 * self-describing, so they appear whatever their value. Everything else
 * follows "absent means default": a default-valued field (null, the empty
 * string, `archiveState: "active"`, a singleton `memberSeqs`) is omitted
 * from these per-match objects, whose count scales with `--limit`. The
 * per-Session `revisionDigest` leaves entirely; its homes are `show`,
 * `conflicts`, and the once-per-document `view` Session header.
 */
function flattenGroups<M extends { eventSeq: number; runLastSeq: number }>(
  groups: SessionMatchGroup<M>[],
  contexts: Map<string, GroupContext>,
  matchJson: (match: M) => MatchJson,
): object[] {
  const flat: object[] = [];
  for (const group of groups) {
    const groupContext = contexts.get(group.sessionId);
    const bySeq = new Map<number, ViewEvent>();
    for (const event of groupContext?.events ?? []) bySeq.set(event.seq, event);
    for (const match of group.matches) {
      const contextSeqs = groupContext?.perMatch.get(match.eventSeq);
      flat.push({
        sessionId: group.sessionId,
        harnessId: group.harnessId,
        ...(group.archiveState === "archived" ? { archiveState: group.archiveState } : {}),
        ...matchJson(match),
        ...memberSeqsJson(match.eventSeq, match.runLastSeq),
        ...(contextSeqs
          ? {
              context: contextSeqs
                .map((seq) => bySeq.get(seq))
                .filter((e): e is ViewEvent => e !== undefined)
                .map((e) => contextEntryJson(e)),
            }
          : {}),
      });
    }
  }
  return flat;
}

/** Every match keeps a locator, including its source-native event identity. */
interface MatchJson {
  eventSeq: number;
  locator: EvidenceLocator;
}

/**
 * Lossless alternative to the flat JSON layout. Identity belongs to its
 * Session group; a locator inherits only sourceFile. A different transcript
 * (including subagent evidence) states its own sourceFile explicitly.
 * Context windows reference one shared entry per logical event, preserving
 * each match's window even when neighboring matches overlap.
 */
function compactGroups<M extends { eventSeq: number; runLastSeq: number }>(
  groups: SessionMatchGroup<M>[],
  contexts: Map<string, GroupContext>,
  matchJson: (match: M) => MatchJson,
): object[] {
  return groups.map((group) => {
    const matches = group.matches.map(matchJson);
    const sourceFile = matches[0]!.locator.sourceFile;
    const groupContext = contexts.get(group.sessionId);
    const inheritSource = <T extends { locator: EvidenceLocator }>(entry: T) => {
      const { sourceFile: file, ...locator } = entry.locator;
      return {
        ...entry,
        locator: file === sourceFile ? locator : entry.locator,
      };
    };
    return {
      sessionId: group.sessionId,
      harnessId: group.harnessId,
      ...(group.archiveState === "archived" ? { archiveState: group.archiveState } : {}),
      sourceFile,
      matches: matches.map((match, index) => {
        const contextSeqs = groupContext?.perMatch.get(match.eventSeq);
        return {
          ...inheritSource(match),
          ...memberSeqsJson(match.eventSeq, group.matches[index]!.runLastSeq),
          ...(contextSeqs !== undefined ? { contextSeqs } : {}),
        };
      }),
      ...(groupContext !== undefined
        ? { context: groupContext.events.map((event) => inheritSource(contextEntryJson(event))) }
        : {}),
    };
  });
}

/** A collapsed run states its members; a singleton says it with `eventSeq`. */
function memberSeqsJson(firstSeq: number, lastSeq: number): object {
  return lastSeq > firstSeq ? { memberSeqs: seqRange(firstSeq, lastSeq) } : {};
}

/**
 * What an event says about the subagent that produced it. A match from the
 * parent's own transcript states nothing, so it carries neither field.
 */
function subagentEvidenceJson(evidence: SubagentEvidence): object {
  return {
    ...(evidence.subagentId !== null ? { subagentId: evidence.subagentId } : {}),
    ...(evidence.subagentType !== null ? { subagentType: evidence.subagentType } : {}),
  };
}

/**
 * Both match serializers destructure their match rather than reading it
 * field by field, so a field added to the query result fails the build here
 * instead of silently missing the match objects. `runLastSeq` is the one
 * field with no key of its own: it is what `memberSeqs` is derived from.
 */
function textMatchJson(match: TextMatch) {
  const {
    eventSeq,
    runLastSeq: _runLastSeq,
    eventKind,
    role,
    timestamp,
    excerpt,
    locator,
    subagentId,
    subagentType,
    alsoIn,
    ...unconsidered
  } = match;
  assertEveryFieldConsidered(unconsidered);
  return {
    eventSeq,
    eventKind,
    ...(role !== null ? { role } : {}),
    timestamp,
    excerpt,
    locator,
    ...subagentEvidenceJson({ subagentId, subagentType }),
    ...(alsoIn ? { alsoIn } : {}),
  };
}

function fileTouchMatchJson(match: FileTouchMatch) {
  const {
    eventSeq,
    runLastSeq: _runLastSeq,
    operation,
    sourcePath,
    normalizedPath,
    locator,
    subagentId,
    subagentType,
    alsoIn,
    ...unconsidered
  } = match;
  assertEveryFieldConsidered(unconsidered);
  return {
    eventSeq,
    operation,
    sourcePath,
    ...(normalizedPath !== null ? { normalizedPath } : {}),
    locator,
    ...subagentEvidenceJson({ subagentId, subagentType }),
    ...(alsoIn ? { alsoIn } : {}),
  };
}

/** A `-C` context entry follows the same rule as the match it accompanies. */
function contextEntryJson(event: ViewEvent) {
  const line = lineText(event);
  return {
    seq: event.seq,
    ...(line === "" ? {} : { line }),
    ...memberSeqsJson(event.runFirstSeq, event.runLastSeq),
    locator: event.locator,
  };
}

/** Speaker and event labels use the `--filter` vocabulary. */
export function eventLabel(kind: string, role: string | null): string {
  if (kind === "message") {
    if (role === "user") return "user";
    if (role === "assistant") return "agent";
    return "message";
  }
  if (kind === "tool_call") return "toolcall";
  if (kind === "tool_result") return "toolresult";
  return kind;
}

function renderTextMatch(match: TextMatch, seqWidth: number, prefix: string): string[] {
  const seq = `#${match.eventSeq}`.padEnd(seqWidth);
  const label = eventLabel(match.eventKind, match.role).padEnd(LABEL_WIDTH);
  const timestamp = match.timestamp ?? "-";
  const mark = multiplicityMarker(match.eventSeq, match.runLastSeq);
  const copies = alsoInMarker(match.alsoIn);
  const line = `${prefix}${seq} ${label} ${timestamp}  ${match.excerpt}${mark}${copies}`;
  // The locator already names the subagent transcript; the marker says so
  // in the vocabulary the reader filters by.
  const from = subagentMatchMarker(match);
  const locator = `${" ".repeat(2 + seqWidth + 1)}${match.locator.sourceFile}:${match.locator.sourceCursor}${from}`;
  return [line, locator];
}

function renderFileTouchMatch(match: FileTouchMatch, seqWidth: number, prefix: string): string[] {
  const seq = `#${match.eventSeq}`.padEnd(seqWidth);
  const path = match.sourcePath.replace(/\s+/g, " ");
  const mark = multiplicityMarker(match.eventSeq, match.runLastSeq);
  const copies = alsoInMarker(match.alsoIn);
  const from = subagentMatchMarker(match);
  return [
    `${prefix}${seq} ${match.operation} ${path}  ${match.locator.sourceFile}:${match.locator.sourceCursor}${from}${mark}${copies}`,
  ];
}

/** A context line renders as context: unmarked text, distinctly unhighlighted. */
function renderContextLine(event: ViewEvent, seqWidth: number): string {
  const seq = `#${event.seq}`.padEnd(seqWidth);
  const label = eventLabel(event.kind, event.role).padEnd(LABEL_WIDTH);
  const timestamp = event.timestamp ?? "-";
  const mark = multiplicityMarker(event.seq, event.runLastSeq);
  return `  ${seq} ${label} ${timestamp}  ${lineText(event)}${mark}`;
}

function renderGroups<M extends { eventSeq: number; runLastSeq: number }>(
  result: SearchResult<M>,
  params: SearchParams,
  contexts: Map<string, GroupContext>,
  renderMatch: (match: M, seqWidth: number, prefix: string) => string[],
  noun: string,
): string {
  const lines: string[] = [];
  let shown = 0;
  for (const group of result.groups) {
    if (lines.length > 0) lines.push("");
    lines.push(sessionHeader(group));
    const groupContext = contexts.get(group.sessionId);
    const contextEvents = groupContext?.events ?? [];
    const seqWidth = Math.max(
      ...group.matches.map((m) => `#${m.eventSeq}`.length),
      ...contextEvents.map((e) => `#${e.seq}`.length),
    );
    // With context, matches carry a `»` mark so context lines read as
    // context; without it, output keeps its exact unprefixed shape.
    const matchPrefix = groupContext !== undefined ? "» " : "  ";
    const entries: { seq: number; render: () => string[] }[] = [];
    for (const match of group.matches) {
      entries.push({
        seq: match.eventSeq,
        render: () => renderMatch(match, seqWidth, matchPrefix),
      });
      shown += 1;
    }
    for (const event of contextEvents) {
      entries.push({ seq: event.seq, render: () => [renderContextLine(event, seqWidth)] });
    }
    entries.sort((a, b) => a.seq - b.seq);
    for (const entry of entries) lines.push(...entry.render());
    const hidden = group.totalInSession - group.matches.length;
    if (hidden > 0) {
      const hint =
        group.matches.length >= params.perSession ? " (raise --per-session to see them)" : "";
      lines.push(
        `  … ${hidden} more ${hidden === 1 ? "match" : "matches"} in this Session${hint}.`,
      );
    }
  }
  if (lines.length > 0) lines.push("");
  if (result.totalMatches > shown) {
    const hint = shown >= params.limit ? " (raise --limit to see more)" : "";
    lines.push(`${shown} of ${result.totalMatches} ${noun} shown${hint}.`);
  } else {
    lines.push(`${result.totalMatches} ${noun}.`);
  }
  return lines.join("\n");
}

function sessionHeader(group: SessionMatchGroup<unknown>): string {
  const parts = [group.sessionId, group.harnessId];
  const range = dateRange(group.firstTimestamp, group.lastTimestamp);
  if (range) parts.push(range);
  if (group.continuationParent) parts.push(`(continues ${group.continuationParent})`);
  const subagent = subagentNote(group);
  if (subagent !== null) parts.push(subagent);
  const family = familyNote(group.sessionId, group.family);
  if (family !== null) parts.push(family);
  if (group.archiveState === "archived") parts.push("[archived]");
  return parts.join("  ");
}

export function dateRange(first: string | null, last: string | null): string | null {
  const from = first?.slice(0, 10) ?? null;
  const to = last?.slice(0, 10) ?? null;
  if (!from) return to;
  if (!to || to === from) return from;
  return `${from} → ${to}`;
}
