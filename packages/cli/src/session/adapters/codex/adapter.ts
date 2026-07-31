import { homedir } from "node:os";
import { basename, join } from "node:path";
import { readdir } from "node:fs/promises";
import { asObject, asString, readJsonlLines } from "../jsonl.ts";
import { META_PAYLOAD_KEY, sessionLabel } from "../label.ts";
import { captureAllowlisted, directoryExists, touch } from "../capture.ts";
import { candidateIdOf } from "../../domain/identity.ts";
import { projected } from "../types.ts";
import type {
  CapturedBundle,
  DiscoveryContext,
  FileTouch,
  HarnessAvailability,
  NormalizedEvent,
  ProjectedFields,
  SessionHarnessAdapter,
  SessionCandidate,
  StagingArea,
  StoredSourceBundle,
} from "../types.ts";

const TRANSCRIPT_BUNDLE_PATH = "source/transcript.jsonl";

/**
 * Codex stores Sessions as rollout JSONL files under
 * `$CODEX_HOME/sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl`.
 *
 * Source-native behavior this adapter depends on (validated against
 * Codex Desktop 0.144 rollouts):
 * - The first `session_meta` session carries the stable Session ID
 *   (`payload.id`, mirrored as `payload.session_id`) and the Opening Path
 *   (`payload.cwd`).
 * - Current Codex versions resume by appending further `session_meta`
 *   sessions to the same rollout file, so the whole file stays one Session
 *   identified by its first meta. A resume that instead creates a new file
 *   with `resumed_from` becomes its own Session with continuation metadata
 *   (kept as contract; no non-null `resumed_from` observed in real
 *   rollouts as of 2026-07).
 * - Patch application is persisted by `patch_apply_end` events whose
 *   `changes` map each path to `{ type: add | delete | update }`; older
 *   shapes nest the kind as `{ add: {...} }` keys. Both are objective
 *   File Touch evidence.
 */
export const codexAdapter: SessionHarnessAdapter = {
  harnessId: "codex",

  async inspectAvailability(context: DiscoveryContext): Promise<HarnessAvailability> {
    const root = codexHome(context.env);
    const sessionsDir = join(root, "sessions");
    const available = await directoryExists(sessionsDir);
    return {
      available,
      root: available ? root : null,
      reason: available ? null : `no Codex session directory at ${sessionsDir}`,
    };
  },

  async *discover(context: DiscoveryContext): AsyncIterable<SessionCandidate> {
    const sessionsDir = join(codexHome(context.env), "sessions");
    if (!(await directoryExists(sessionsDir))) return;
    for (const transcriptPath of await collectJsonlFiles(sessionsDir)) {
      const lines = await readJsonlLines(transcriptPath);
      const meta = lines.find((l) => l.value?.["type"] === "session_meta")?.value;
      const payload = meta ? asObject(meta["payload"]) : null;
      const sessionId =
        (payload ? asString(payload["id"]) : null) ?? sessionIdFromFileName(transcriptPath);
      if (!sessionId) continue;
      const resumedFrom = payload ? asString(payload["resumed_from"]) : null;
      const identity = { harnessId: "codex" as const, sourceSessionId: sessionId };
      // Codex rollouts session no session title; the earliest user message
      // is the only source-provided Label the format offers.
      const firstUserText = isSubagentSession(payload)
        ? null
        : (sourceAuthoredUserMessages(lines)[0]?.text ?? firstLegacyUserMessage(lines));
      yield {
        identity,
        candidateId: candidateIdOf(identity),
        openingPath: payload ? asString(payload["cwd"]) : null,
        sourceFiles: [
          {
            absolutePath: transcriptPath,
            bundlePath: TRANSCRIPT_BUNDLE_PATH,
            mediaType: "application/jsonl",
          },
        ],
        continuation: resumedFrom ? { parentSessionId: resumedFrom } : null,
        sessionTime:
          (meta ? asString(meta["timestamp"]) : null) ??
          (payload ? asString(payload["timestamp"]) : null),
        label: sessionLabel(firstUserText),
      };
    }
  },

  async capture(candidate: SessionCandidate, staging: StagingArea): Promise<CapturedBundle> {
    return await captureAllowlisted(candidate, staging);
  },

  async *project(bundle: StoredSourceBundle): AsyncIterable<NormalizedEvent> {
    const lines = await readJsonlLines(join(bundle.dir, TRANSCRIPT_BUNDLE_PATH));
    const authoredUserMessages = sourceAuthoredUserMessages(lines);
    const meta = lines.find((line) => line.value?.["type"] === "session_meta")?.value;
    const subagentSession = isSubagentSession(meta ? asObject(meta["payload"]) : null);
    for (const line of lines) {
      const base = { sourceFile: TRANSCRIPT_BUNDLE_PATH, sourceCursor: `line:${line.line}` };
      if (!line.value) {
        yield { ...base, ...projected("unknown"), timestamp: null };
        continue;
      }
      const value = line.value;
      const payload = asObject(value["payload"]);
      const timestamp = asString(value["timestamp"]);
      const type = asString(value["type"]);

      if (
        type === "session_meta" ||
        type === "turn_context" ||
        type === "world_state" ||
        type === "compacted" ||
        type === "inter_agent_communication_metadata"
      ) {
        yield { ...base, ...projected("lifecycle"), timestamp };
        continue;
      }
      if (type === "response_item" && payload) {
        const userMessage = responseItemUserMessage(payload, timestamp);
        const harnessInjected =
          userMessage !== null &&
          (subagentSession ||
            (authoredUserMessages.length > 0
              ? !isMirroredAuthoredUserMessage(userMessage, authoredUserMessages)
              : isInjectedPreamble(userMessage.text)));
        yield { ...base, ...projectResponseItem(payload, harnessInjected), timestamp };
        continue;
      }
      if (type === "event_msg" && payload) {
        yield { ...base, ...projectEventMsg(payload, subagentSession), timestamp };
        continue;
      }
      yield { ...base, ...projected("unknown"), timestamp };
    }
  },
};

/**
 * Codex opens a rollout by writing its own preamble — the environment
 * context and the configured user instructions — through the user channel.
 * Those tags are the Harness speaking, not the Session's opening prompt, so
 * the evidence is marked injected and never read as a Session Label.
 */
const INJECTED_PREAMBLE_TAGS = ["<environment_context>", "<user_instructions>"];

function isInjectedPreamble(text: string | null): boolean {
  const head = text?.trimStart() ?? "";
  return INJECTED_PREAMBLE_TAGS.some((tag) => head.startsWith(tag));
}

/** The user's own text, or null where the Harness spoke through the channel. */
function userText(text: string | null): string | null {
  return isInjectedPreamble(text) ? null : text;
}

interface SourceAuthoredUserMessage {
  timestamp: string | null;
  text: string;
}

/**
 * A Codex subagent receives instructions from the Harness through its user
 * channel. The rollout is still valid source evidence, but those instructions
 * are not a human-authored Session Label.
 */
function isSubagentSession(meta: Record<string, unknown> | null): boolean {
  if (meta?.["thread_source"] === "subagent") return true;
  const source = meta ? asObject(meta["source"]) : null;
  return source !== null && source["subagent"] !== undefined;
}

/**
 * Modern Codex rollouts mirror source-authored input as an
 * `event_msg.user_message`. Harness context still travels through user-role
 * `response_item` sessions, but has no matching event message. Prefer this
 * source distinction over an open-ended list of injected preamble strings.
 */
function sourceAuthoredUserMessages(
  lines: Awaited<ReturnType<typeof readJsonlLines>>,
): SourceAuthoredUserMessage[] {
  const messages: SourceAuthoredUserMessage[] = [];
  for (const line of lines) {
    const value = line.value;
    if (value?.["type"] !== "event_msg") continue;
    const payload = asObject(value["payload"]);
    if (payload?.["type"] !== "user_message") continue;
    const text = asString(payload["message"]);
    if (text === null || text.length === 0) continue;
    messages.push({ timestamp: asString(value["timestamp"]), text });
  }
  return messages;
}

/** Older rollouts may only carry user input as a response item. */
function firstLegacyUserMessage(lines: Awaited<ReturnType<typeof readJsonlLines>>): string | null {
  for (const line of lines) {
    const value = line.value;
    if (value?.["type"] !== "response_item") continue;
    const payload = asObject(value["payload"]);
    if (payload?.["type"] !== "message" || payload["role"] !== "user") continue;
    const text = userText(textFromContent(payload["content"]));
    if (text !== null && text.length > 0) return text;
  }
  return null;
}

function responseItemUserMessage(
  payload: Record<string, unknown>,
  timestamp: string | null,
): SourceAuthoredUserMessage | null {
  if (payload["type"] !== "message" || payload["role"] !== "user") return null;
  const text = textFromContent(payload["content"]);
  return text === null ? null : { timestamp, text };
}

function isMirroredAuthoredUserMessage(
  responseItem: SourceAuthoredUserMessage,
  authored: SourceAuthoredUserMessage[],
): boolean {
  return authored.some((eventMessage) => {
    if (eventMessage.text !== responseItem.text) return false;
    if (eventMessage.timestamp === null || responseItem.timestamp === null) return true;
    const eventTime = Date.parse(eventMessage.timestamp);
    const responseTime = Date.parse(responseItem.timestamp);
    return (
      Number.isFinite(eventTime) &&
      Number.isFinite(responseTime) &&
      Math.abs(eventTime - responseTime) <= 1_000
    );
  });
}

function projectResponseItem(
  payload: Record<string, unknown>,
  harnessInjected = false,
): ProjectedFields {
  const itemType = asString(payload["type"]);
  const sourceEventId = asString(payload["id"]);
  switch (itemType) {
    case "message": {
      const role = asString(payload["role"]);
      return projected("message", {
        sourceEventId,
        role,
        text: textFromContent(payload["content"]),
        payload: role === "user" && harnessInjected ? { [META_PAYLOAD_KEY]: true } : null,
      });
    }
    case "function_call":
      return projected("tool_call", {
        sourceEventId,
        role: "assistant",
        text: asString(payload["name"]),
        payload: { arguments: payload["arguments"] ?? null },
        toolNames: attestedName(payload),
      });
    case "custom_tool_call":
      return projected("tool_call", {
        sourceEventId,
        role: "assistant",
        text: asString(payload["name"]),
        payload: { arguments: payload["input"] ?? null },
        toolNames: attestedName(payload),
      });
    case "function_call_output":
    case "custom_tool_call_output":
      return projected("tool_result", {
        sourceEventId,
        text: asString(payload["output"]) ?? textFromContent(payload["output"]),
      });
    case "agent_message":
      return projected("message", {
        sourceEventId,
        role: "assistant",
        text: textFromContent(payload["content"]),
      });
    case "reasoning":
      return projected("message", { sourceEventId, role: "assistant" });
    default:
      return projected("unknown", { sourceEventId });
  }
}

function projectEventMsg(
  payload: Record<string, unknown>,
  harnessInjectedUserMessage = false,
): ProjectedFields {
  const eventType = asString(payload["type"]);
  switch (eventType) {
    case "user_message":
    case "agent_message":
      return projected("message", {
        role: eventType === "user_message" ? "user" : "assistant",
        text: asString(payload["message"]),
        payload:
          eventType === "user_message" && harnessInjectedUserMessage
            ? { [META_PAYLOAD_KEY]: true }
            : null,
      });
    case "agent_reasoning":
      return projected("message", { role: "assistant", text: asString(payload["text"]) });
    case "patch_apply_begin":
    case "patch_apply_end":
      return projected(eventType === "patch_apply_begin" ? "tool_call" : "tool_result", {
        role: "assistant",
        text: "apply_patch",
        // Codex's built-in patch mechanism, attested under its source name.
        toolNames: eventType === "patch_apply_begin" ? ["apply_patch"] : [],
        fileTouches: touchesFromPatchChanges(asObject(payload["changes"])),
      });
    case "web_search_end":
      return projected("tool_result", { text: asString(payload["query"]) });
    case "task_started":
    case "task_complete":
    case "thread_settings_applied":
    case "turn_aborted":
    case "context_compacted":
    case "thread_rolled_back":
    case "sub_agent_activity":
    case "token_count":
      return projected("lifecycle");
    case "exec_command_begin":
      // A shell command is ambiguous evidence; it never becomes a File Touch.
      return projected("tool_call", {
        role: "assistant",
        text: asString(payload["command"]) ?? commandFromArray(payload["command"]),
        // Codex's built-in shell, attested under the name "shell".
        toolNames: ["shell"],
      });
    case "exec_command_end":
      return projected("tool_result");
    default:
      return projected("unknown");
  }
}

/**
 * Codex patch events objectively session per-path add/update/delete changes.
 * Current rollouts use `{ "<path>": { type: "add" | "delete" | "update" } }`;
 * older shapes nest the kind as `{ add: {...} }` keys. Both are handled.
 */
function touchesFromPatchChanges(changes: Record<string, unknown> | null): FileTouch[] {
  if (!changes) return [];
  const touches: FileTouch[] = [];
  for (const [path, change] of Object.entries(changes)) {
    const changeObj = asObject(change);
    if (!changeObj) continue;
    const kind = asString(changeObj["type"]);
    if (kind === "add" || "add" in changeObj) touches.push(touch("created", path));
    else if (kind === "delete" || "delete" in changeObj) touches.push(touch("deleted", path));
    else if (kind === "update" || "update" in changeObj) {
      const update = kind === "update" ? changeObj : asObject(changeObj["update"]);
      const movePath = update ? asString(update["move_path"]) : null;
      touches.push(touch(movePath ? "renamed" : "modified", path));
    }
  }
  return touches;
}

function attestedName(payload: Record<string, unknown>): string[] {
  const name = asString(payload["name"]);
  return name ? [name] : [];
}

function textFromContent(content: unknown): string | null {
  if (!Array.isArray(content)) return null;
  const parts: string[] = [];
  for (const item of content) {
    const obj = asObject(item);
    const text = obj ? asString(obj["text"]) : null;
    if (text) parts.push(text);
  }
  return parts.length > 0 ? parts.join("\n") : null;
}

function commandFromArray(command: unknown): string | null {
  if (!Array.isArray(command)) return null;
  const parts = command.filter((c): c is string => typeof c === "string");
  return parts.length > 0 ? parts.join(" ") : null;
}

function sessionIdFromFileName(path: string): string | null {
  const match = basename(path).match(
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i,
  );
  return match ? match[0] : null;
}

function codexHome(env: Record<string, string | undefined>): string {
  return env["CODEX_HOME"] ?? join(homedir(), ".codex");
}

async function collectJsonlFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  for (const entry of entries) {
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      out.push(join(entry.parentPath, entry.name));
    }
  }
  return out.sort();
}
