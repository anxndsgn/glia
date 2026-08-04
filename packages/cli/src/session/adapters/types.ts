import type { HarnessId } from "../../core/harnesses/ids.ts";
import type { SourceIdentity } from "../domain/identity.ts";

export interface DiscoveryContext {
  env: Record<string, string | undefined>;
}

export interface HarnessAvailability {
  available: boolean;
  root: string | null;
  reason: string | null;
}

export interface SessionCandidate {
  identity: SourceIdentity;
  candidateId: string;
  /** Source-native Opening Path; null when missing or unresolvable. */
  openingPath: string | null;
  /** Absolute source paths in the adapter's explicit allowlist. */
  sourceFiles: SourceFileRef[];
  /** Objective continuation metadata when the source records it. */
  continuation: { parentSessionId: string } | null;
  /**
   * Present when the source marks this Session as a Harness-spawned
   * subagent. `parentSourceSessionId` is null when the source carries no
   * parent link — a parent is never inferred from time, path, or adjacency.
   *
   * A subagent relation is display-only: it is deliberately not fed into
   * `continuation`, which would place subagents into Fork Families and
   * change what a family means.
   */
  subagent: SubagentOrigin | null;
  /**
   * Source-provided Session time (the earliest source timestamp the
   * adapter reads during discovery); null when the source carries none.
   * Ordering metadata only — never fabricated from file system facts.
   */
  sessionTime: string | null;
  /**
   * Session Label: a source-provided, human-readable identifier — a
   * Harness-provided title when the source carries one, otherwise the
   * Session's earliest user message. Display metadata only, read from
   * source evidence, never generated; null when the source records neither.
   */
  label: string | null;
}

export interface SubagentOrigin {
  /** Source-native subagent kind, e.g. `review`; null when unnamed. */
  kind: string | null;
  /** The parent's source Session ID; null when the source states none. */
  parentSourceSessionId: string | null;
}

export interface SourceFileRef {
  /** Absolute path of the Harness-owned source file. */
  absolutePath: string;
  /** Bundle-relative destination, e.g. `source/transcript.jsonl`. */
  bundlePath: string;
  mediaType: string;
}

export interface StagingArea {
  dir: string;
}

export interface BundleFile {
  path: string;
  size: number;
  mediaType: string;
  sha256: string;
}

export interface CapturedBundle {
  files: BundleFile[];
}

export interface BundleManifest {
  schemaVersion: number;
  files: BundleFile[];
}

export interface StoredSourceBundle {
  sessionId: string;
  /** Absolute path of the bundle directory holding manifest.json and source/. */
  dir: string;
  manifest: BundleManifest;
}

export type NormalizedEventKind =
  | "message"
  | "tool_call"
  | "tool_result"
  | "system"
  | "lifecycle"
  | "unknown";

export type FileTouchOperation = "read" | "created" | "modified" | "deleted" | "renamed";

export interface FileTouch {
  operation: FileTouchOperation;
  sourcePath: string;
  /** Deterministically resolvable normalized path, else null. */
  normalizedPath: string | null;
}

export interface NormalizedEvent {
  kind: NormalizedEventKind;
  /** Bundle-relative source file the event came from. */
  sourceFile: string;
  /** Source line or equivalent cursor, e.g. `line:12`. */
  sourceCursor: string;
  sourceEventId: string | null;
  timestamp: string | null;
  role: string | null;
  /** Searchable text content; null when the event carries none. */
  text: string | null;
  /** Adapter-projected fields that do not yet justify stable columns. */
  payload: Record<string, unknown> | null;
  /**
   * Harness-native names of the tools a `tool_call` event attests, read
   * from source evidence (built-in shell and patch mechanisms included).
   * No cross-harness aliasing: the same tool concept may carry different
   * names per harness.
   */
  toolNames: string[];
  fileTouches: FileTouch[];
}

/** The fields an adapter derives from one source record. */
export type ProjectedFields = Pick<
  NormalizedEvent,
  "kind" | "sourceEventId" | "role" | "text" | "payload" | "toolNames" | "fileTouches"
>;

/**
 * A projected event of `kind` attesting nothing further, with only the
 * fields the source actually carries overridden. Most source records
 * project to one or two meaningful fields; spelling the rest out at every
 * call site is how they drift apart when `NormalizedEvent` grows a field.
 */
export function projected(
  kind: NormalizedEventKind,
  fields: Partial<Omit<ProjectedFields, "kind">> = {},
): ProjectedFields {
  return {
    kind,
    sourceEventId: null,
    role: null,
    text: null,
    payload: null,
    toolNames: [],
    fileTouches: [],
    ...fields,
  };
}

/**
 * Adapters discover and capture Harness evidence and parse stored Source
 * Bundles into normalized sessions. They do not open SQLite, know projection
 * tables, manage transactions, render CLI output, or decide Project
 * association.
 */
export interface SessionHarnessAdapter {
  readonly harnessId: HarnessId;

  inspectAvailability(context: DiscoveryContext): Promise<HarnessAvailability>;
  discover(context: DiscoveryContext): AsyncIterable<SessionCandidate>;
  capture(candidate: SessionCandidate, staging: StagingArea): Promise<CapturedBundle>;
  project(bundle: StoredSourceBundle): AsyncIterable<NormalizedEvent>;
}
