import { homedir } from "node:os";
import { basename, join } from "node:path";
import { readdir } from "node:fs/promises";
import { asObject, asString, readJsonlLines } from "../jsonl.ts";
import { LABEL_PAYLOAD_KEY, META_PAYLOAD_KEY, sessionLabel } from "../label.ts";
import { captureAllowlisted, directoryExists, touch } from "../capture.ts";
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
 * - The Opening Path is the `cwd` of the earliest event that carries one;
 *   the munged directory name is not authoritative.
 * - Resuming appends to the same session file; a desktop fork creates a
 *   new session file with a new session ID, copying the shared prefix
 *   events with `uuid`, `timestamp`, and `message` intact while rewriting
 *   envelope fields (`sessionId` always; `gitBranch`, `cwd`, `attachment`
 *   sometimes) and sessioning no `parentSessionId` (validated against
 *   Claude Code desktop transcripts, 2026-07). Each source session ID
 *   stays one Session; fork twins are related through Shared Event
 *   Identity at the projection layer.
 *   A top-level `parentSessionId` is still preserved as continuation
 *   metadata whenever an event carries one.
 */
export const claudeCodeAdapter: SessionHarnessAdapter = {
  harnessId: "claude-code",

  async inspectAvailability(context: DiscoveryContext): Promise<HarnessAvailability> {
    const root = claudeConfigDir(context.env);
    const projectsDir = join(root, "projects");
    const available = await directoryExists(projectsDir);
    return {
      available,
      root: available ? root : null,
      reason: available ? null : `no Claude Code session directory at ${projectsDir}`,
    };
  },

  async *discover(context: DiscoveryContext): AsyncIterable<SessionCandidate> {
    const projectsDir = join(claudeConfigDir(context.env), "projects");
    if (!(await directoryExists(projectsDir))) return;
    for (const entry of await sortedSubdirectories(projectsDir)) {
      const dir = join(projectsDir, entry);
      const files = (await readdir(dir)).filter((f) => f.endsWith(".jsonl")).sort();
      for (const fileName of files) {
        const transcriptPath = join(dir, fileName);
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
        // re-titled Session sessions another title line, so the latest one
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
        sessionId ??= basename(fileName, ".jsonl");
        const identity = { harnessId: "claude-code" as const, sourceSessionId: sessionId };
        yield {
          identity,
          candidateId: candidateIdOf(identity),
          openingPath,
          sourceFiles: [
            {
              absolutePath: transcriptPath,
              bundlePath: TRANSCRIPT_BUNDLE_PATH,
              mediaType: "application/jsonl",
            },
          ],
          continuation: parentSessionId ? { parentSessionId } : null,
          sessionTime,
          label: sessionLabel(customTitle ?? aiTitle ?? summary ?? firstUserText),
        };
      }
    }
  },

  async capture(candidate: SessionCandidate, staging: StagingArea): Promise<CapturedBundle> {
    return await captureAllowlisted(candidate, staging);
  },

  async *project(bundle: StoredSourceBundle): AsyncIterable<NormalizedEvent> {
    const lines = await readJsonlLines(join(bundle.dir, TRANSCRIPT_BUNDLE_PATH));
    for (const line of lines) {
      const base = {
        sourceFile: TRANSCRIPT_BUNDLE_PATH,
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
        payload: title
          ? { [LABEL_PAYLOAD_KEY]: title.source }
          : type === "user" && value["isMeta"] === true
            ? { [META_PAYLOAD_KEY]: true }
            : null,
        toolNames: kind === "tool_call" ? extractToolNames(message) : [],
        fileTouches: extractFileTouches(value, message),
      };
    }
  },
};

/**
 * The Session titles Claude Code sessions as their own transcript lines: a
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

function claudeConfigDir(env: Record<string, string | undefined>): string {
  return env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude");
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
 * Claude Code sessions tool invocations as `tool_use` content blocks whose
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
 * calls objectively session reads; Claude Code tool results carry a
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
