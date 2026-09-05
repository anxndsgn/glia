import { basename, dirname, join } from "node:path";
import { readdir } from "node:fs/promises";
import { claudeHome } from "../../../core/harnesses/home.ts";
import { asObject, asString, readJsonlLines } from "../jsonl.ts";
import { LABEL_PAYLOAD_KEY, META_PAYLOAD_KEY, sessionLabel } from "../label.ts";
import { captureAllowlisted, directoryExists, touch } from "../capture.ts";
import {
  isSubagentTranscriptPath,
  subagentIdOf,
  subagentSidecarPathFor,
  SUBAGENT_BUNDLE_PREFIX,
  SUBAGENT_PAYLOAD_KEY,
  SUBAGENT_TYPE_PAYLOAD_KEY,
} from "../subagent.ts";
import { candidateIdOf } from "../../domain/identity.ts";
import { projected } from "../types.ts";
import type {
  CapturedBundle,
  DiscoveryContext,
  FileTouch,
  HarnessAvailability,
  NormalizedEvent,
  NormalizedEventKind,
  SessionHarnessAdapter,
  SessionCandidate,
  SourceFileRef,
  StagingArea,
  StoredSourceBundle,
} from "../types.ts";

const TRANSCRIPT_BUNDLE_PATH = "source/transcript.jsonl";

/**
 * Claude Code stores Sessions as JSONL transcripts under
 * `$CLAUDE_CONFIG_DIR/projects/<munged-path>/<session-id>.jsonl`.
 *
 * Source-native behavior this adapter depends on:
 * - The stable Session ID is the `sessionId` field carried by transcript
 *   events (falling back to the file name stem, which Claude Code derives
 *   from the same ID).
 * - A subagent invocation gets its own transcript beside the main one, at
 *   `<stem>/subagents/agent-<agentId>.jsonl` (the directory is keyed by the
 *   transcript's file stem, not by the event-carried `sessionId`). Those
 *   records share the main envelope and additionally carry `agentId`,
 *   `isSidechain: true`, and the parent's `sessionId`. They are evidence of
 *   the parent Session — captured into its bundle, never a Session of their
 *   own — so `sessionIdOf` and Fork Family semantics are untouched.
 * - The Opening Path is the `cwd` of the earliest event that carries one;
 *   the munged directory name is not authoritative.
 * - Resuming appends to the same session file; a desktop fork creates a
 *   new session file with a new session ID, copying the shared prefix
 *   events with `uuid`, `timestamp`, and `message` intact while rewriting
 *   envelope fields (`sessionId` always; `gitBranch`, `cwd`, `attachment`
 *   sometimes) and recording no `parentSessionId` (validated against
 *   Claude Code desktop transcripts, 2026-07). Each source session ID
 *   stays one Session; fork twins are related through Shared Event
 *   Identity at the projection layer.
 *   A top-level `parentSessionId` is still preserved as continuation
 *   metadata whenever an event carries one.
 */
export const claudeCodeAdapter: SessionHarnessAdapter = {
  harnessId: "claude-code",

  async inspectAvailability(context: DiscoveryContext): Promise<HarnessAvailability> {
    const root = claudeHome(context.env);
    const projectsDir = join(root, "projects");
    const available = await directoryExists(projectsDir);
    return {
      available,
      root: available ? root : null,
      reason: available ? null : `no Claude Code session directory at ${projectsDir}`,
    };
  },

  async *discover(context: DiscoveryContext): AsyncIterable<SessionCandidate> {
    const projectsDir = join(claudeHome(context.env), "projects");
    if (!(await directoryExists(projectsDir))) return;
    for (const entry of await sortedSubdirectories(projectsDir)) {
      const dir = join(projectsDir, entry);
      const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort();
      for (const fileName of files) {
        yield await candidateFromTranscript(join(dir, fileName));
      }
    }
  },

  async refreshCandidate(candidate: SessionCandidate): Promise<SessionCandidate | null> {
    const transcript = candidate.sourceFiles.find(
      (file) => file.bundlePath === TRANSCRIPT_BUNDLE_PATH,
    );
    if (transcript === undefined) return null;
    try {
      return await candidateFromTranscript(transcript.absolutePath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  },

  async capture(candidate: SessionCandidate, staging: StagingArea): Promise<CapturedBundle> {
    return await captureAllowlisted(candidate, staging);
  },

  async *project(bundle: StoredSourceBundle): AsyncIterable<NormalizedEvent> {
    // The main transcript first, then each subagent transcript in manifest
    // path order, so a Session's evidence reads parent-before-children and
    // one bundle always projects in the same order.
    yield* projectFile(bundle, TRANSCRIPT_BUNDLE_PATH, null, null);
    for (const path of subagentBundlePaths(bundle)) {
      // The sidecar is metadata about the transcript, not evidence of its
      // own: it names the agent, it never becomes an event.
      yield* projectFile(bundle, path, subagentIdOf(path), await subagentTypeOf(bundle, path));
    }
  },
};

/** Re-reads one transcript and its current sibling evidence allowlist. */
async function candidateFromTranscript(transcriptPath: string): Promise<SessionCandidate> {
  const lines = await readJsonlLines(transcriptPath);
  let sessionId: string | null = null;
  let openingPath: string | null = null;
  let parentSessionId: string | null = null;
  let sessionTime: string | null = null;
  let customTitle: string | null = null;
  let aiTitle: string | null = null;
  let summary: string | null = null;
  let firstUserText: string | null = null;
  // Titles appear anywhere in the file, so the whole scan runs; the
  // lines are already in memory, so this costs no extra I/O. A
  // re-titled Session records another title line, so the latest one
  // of a kind is the title the source currently carries.
  for (const line of lines) {
    const value = line.value;
    if (!value) continue;
    sessionId ??= asString(value["sessionId"]);
    openingPath ??= asString(value["cwd"]);
    parentSessionId ??= asString(value["parentSessionId"]);
    sessionTime ??= asString(value["timestamp"]);
    switch (value["type"]) {
      case "custom-title":
        customTitle = asString(value["customTitle"]) ?? customTitle;
        break;
      case "ai-title":
        aiTitle = asString(value["aiTitle"]) ?? aiTitle;
        break;
      case "summary":
        summary = asString(value["summary"]) ?? summary;
        break;
      case "user": {
        if (firstUserText !== null || value["isMeta"] === true) break;
        const message = asObject(value["message"]);
        if (message && !hasBlockOfType(message, "tool_result")) {
          firstUserText = extractText(message);
        }
        break;
      }
    }
  }
  const stem = basename(transcriptPath, ".jsonl");
  sessionId ??= stem;
  const identity = { harnessId: "claude-code" as const, sourceSessionId: sessionId };
  return {
    identity,
    candidateId: candidateIdOf(identity),
    // Claude Code subagents are evidence inside their parent Session,
    // never Sessions of their own, so no candidate is ever a subagent.
    subagent: null,
    openingPath,
    sourceFiles: [
      {
        absolutePath: transcriptPath,
        bundlePath: TRANSCRIPT_BUNDLE_PATH,
        mediaType: "application/jsonl",
      },
      ...(await subagentSourceFiles(join(dirname(transcriptPath), stem))),
    ],
    continuation: parentSessionId ? { parentSessionId } : null,
    sessionTime,
    label: sessionLabel(customTitle ?? aiTitle ?? summary ?? firstUserText),
  };
}

/**
 * The subagent transcripts a bundle carries, read from its manifest rather
 * than the filesystem: the manifest is the accepted Revision's file list, so
 * projection never sees anything capture did not attest.
 */
function subagentBundlePaths(bundle: StoredSourceBundle): string[] {
  return bundle.manifest.files
    .map((file) => file.path)
    .filter(isSubagentTranscriptPath)
    .sort();
}

/**
 * One transcript file's events. `subagentId` is non-null for a subagent
 * transcript, where every user-role record is the parent Harness speaking —
 * the spawn prompt it authored and the tool_result envelopes it relays — so
 * the events are marked injected and never read as the Session's Label.
 */
async function* projectFile(
  bundle: StoredSourceBundle,
  bundlePath: string,
  subagentId: string | null,
  subagentType: string | null,
): AsyncIterable<NormalizedEvent> {
  const lines = await readJsonlLines(join(bundle.dir, bundlePath));
  for (const line of lines) {
    const base = {
      sourceFile: bundlePath,
      sourceCursor: `line:${line.line}`,
    };
    if (!line.value) {
      yield { ...base, ...projected("unknown"), timestamp: null };
      continue;
    }
    const value = line.value;
    const type = asString(value["type"]);
    const message = asObject(value["message"]);
    const kind = classify(type, message);
    const title = titleOf(type, value);
    // A main-file line may itself be sidechain evidence in transcripts
    // older than the sibling-directory layout. Read it as the subagent
    // evidence it is; per-agent grouping is not reconstructed.
    const inlineSubagentId =
      subagentId ?? (value["isSidechain"] === true ? (asString(value["agentId"]) ?? "") : null);
    const harnessInjected =
      (inlineSubagentId !== null && type === "user") ||
      (type === "user" && value["isMeta"] === true);
    yield {
      ...base,
      kind,
      sourceEventId: asString(value["uuid"]),
      timestamp: asString(value["timestamp"]),
      role: message ? asString(message["role"]) : null,
      // A title line carries its title as the event's text: it is
      // source-provided evidence, and dropping it lost the one readable
      // name the Session has.
      text: title?.text ?? extractText(message),
      payload: eventPayload(title, harnessInjected, inlineSubagentId, subagentType),
      toolNames: kind === "tool_call" ? extractToolNames(message) : [],
      fileTouches: extractFileTouches(value, message),
    };
  }
}

function eventPayload(
  title: { source: "custom_title" | "ai_title" | "summary" } | null,
  harnessInjected: boolean,
  subagentId: string | null,
  subagentType: string | null,
): Record<string, unknown> | null {
  const payload: Record<string, unknown> = {};
  if (title) payload[LABEL_PAYLOAD_KEY] = title.source;
  if (harnessInjected) payload[META_PAYLOAD_KEY] = true;
  // Written whenever the event is subagent evidence, including the empty
  // string a legacy inline sidechain line with no `agentId` yields: the
  // key's presence is the provenance fact, its value only names the agent.
  if (subagentId !== null) payload[SUBAGENT_PAYLOAD_KEY] = subagentId;
  if (subagentType) payload[SUBAGENT_TYPE_PAYLOAD_KEY] = subagentType;
  return Object.keys(payload).length > 0 ? payload : null;
}

/**
 * The subagent transcripts sitting beside a main transcript. A missing
 * directory is the ordinary case (most Sessions spawn none) and yields
 * nothing; names are sorted so manifests and Revision digests stay
 * deterministic.
 */
async function subagentSourceFiles(sessionSubdir: string): Promise<SourceFileRef[]> {
  const dir = join(sessionSubdir, "subagents");
  if (!(await directoryExists(dir))) return [];
  const present = new Set(await readdir(dir));
  const files: SourceFileRef[] = [];
  for (const name of [...present].filter(isSubagentTranscriptName).sort()) {
    files.push({
      absolutePath: join(dir, name),
      bundlePath: `${SUBAGENT_BUNDLE_PREFIX}${name}`,
      mediaType: "application/jsonl",
    });
    // The sidecar is optional: transcripts written before Claude Code
    // wrote one are captured alone rather than failing the Candidate.
    const sidecar = name.replace(/\.jsonl$/, ".meta.json");
    if (!present.has(sidecar)) continue;
    files.push({
      absolutePath: join(dir, sidecar),
      bundlePath: `${SUBAGENT_BUNDLE_PREFIX}${sidecar}`,
      mediaType: "application/json",
    });
  }
  return files;
}

function isSubagentTranscriptName(name: string): boolean {
  return name.startsWith("agent-") && name.endsWith(".jsonl");
}

/**
 * The subagent's type as its sidecar states it, or null when the sidecar is
 * absent or unreadable. A malformed sidecar degrades the badge to the bare
 * agent id; it never fails the projection of real transcript evidence.
 */
async function subagentTypeOf(
  bundle: StoredSourceBundle,
  bundlePath: string,
): Promise<string | null> {
  const sidecar = subagentSidecarPathFor(bundlePath);
  if (!bundle.manifest.files.some((file) => file.path === sidecar)) return null;
  try {
    const parsed = asObject(JSON.parse(await Bun.file(join(bundle.dir, sidecar)).text()));
    return parsed ? asString(parsed["agentType"]) : null;
  } catch {
    return null;
  }
}

/**
 * The Session titles Claude Code records as their own transcript lines: a
 * user-authored `custom-title`, a Harness-generated `ai-title`, and the
 * compaction `summary`. Read exactly as persisted — never combined, never
 * rewritten.
 */
function titleOf(
  type: string | null,
  value: Record<string, unknown>,
): { text: string; source: "custom_title" | "ai_title" | "summary" } | null {
  const read = (field: string, source: "custom_title" | "ai_title" | "summary") => {
    const text = asString(value[field]);
    return text ? { text, source } : null;
  };
  switch (type) {
    case "custom-title":
      return read("customTitle", "custom_title");
    case "ai-title":
      return read("aiTitle", "ai_title");
    case "summary":
      return read("summary", "summary");
    default:
      return null;
  }
}

async function sortedSubdirectories(path: string): Promise<string[]> {
  const entries = await readdir(path, { withFileTypes: true });
  return entries
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

function classify(
  type: string | null,
  message: Record<string, unknown> | null,
): NormalizedEventKind {
  switch (type) {
    case "user":
      return hasBlockOfType(message, "tool_result") ? "tool_result" : "message";
    case "assistant":
      return hasBlockOfType(message, "tool_use") ? "tool_call" : "message";
    case "system":
      return "system";
    // Harness-injected context (attached files, deferred-tool deltas).
    case "attachment":
      return "system";
    case "summary":
    case "file-history-snapshot":
    case "last-prompt":
    case "custom-title":
    case "ai-title":
    case "queue-operation":
      return "lifecycle";
    default:
      return "unknown";
  }
}

function contentBlocks(message: Record<string, unknown> | null): Record<string, unknown>[] {
  const content = message?.["content"];
  if (!Array.isArray(content)) return [];
  return content.map(asObject).filter((b): b is Record<string, unknown> => b !== null);
}

function hasBlockOfType(message: Record<string, unknown> | null, blockType: string): boolean {
  return contentBlocks(message).some((b) => b["type"] === blockType);
}

function extractText(message: Record<string, unknown> | null): string | null {
  if (!message) return null;
  const content = message["content"];
  if (typeof content === "string") return content.length > 0 ? content : null;
  const parts: string[] = [];
  for (const block of contentBlocks(message)) {
    const text = asString(block["text"]);
    if (text) parts.push(text);
    if (
      block["type"] === "tool_result" &&
      typeof block["content"] === "string" &&
      block["content"].length > 0
    ) {
      parts.push(block["content"]);
    }
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

/**
 * Claude Code records tool invocations as `tool_use` content blocks whose
 * `name` is the source-native tool name (built-in shell is the `Bash`
 * tool, patching is `Edit`/`Write`), so the blocks are the attestation.
 */
function extractToolNames(message: Record<string, unknown> | null): string[] {
  const names: string[] = [];
  for (const block of contentBlocks(message)) {
    if (block["type"] !== "tool_use") continue;
    const name = asString(block["name"]);
    if (name) names.push(name);
  }
  return names;
}

/**
 * A File Touch requires an objective source event. Assistant `Read` tool
 * calls objectively record reads; Claude Code tool results carry a
 * `toolUseResult` with the written file and whether it was created or
 * updated. Bash commands and textual path mentions never become touches.
 */
function extractFileTouches(
  value: Record<string, unknown>,
  message: Record<string, unknown> | null,
): FileTouch[] {
  const touches: FileTouch[] = [];
  for (const block of contentBlocks(message)) {
    if (block["type"] !== "tool_use" || block["name"] !== "Read") continue;
    const input = asObject(block["input"]);
    const filePath = input ? asString(input["file_path"]) : null;
    if (filePath) touches.push(touch("read", filePath));
  }
  const toolUseResult = asObject(value["toolUseResult"]);
  if (toolUseResult) {
    const filePath = asString(toolUseResult["filePath"]);
    if (filePath) {
      const resultType = asString(toolUseResult["type"]);
      touches.push(touch(resultType === "create" ? "created" : "modified", filePath));
    }
  }
  return touches;
}
