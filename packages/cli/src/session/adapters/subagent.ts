import { basename } from "node:path";

/**
 * The bundle-layout contract for subagent evidence, shared by the adapter
 * that writes it, the projection that reads it, and the renderers that
 * badge it. Kept in one place so the path convention is stated once.
 *
 * A Harness whose subagents are separate source Sessions (Codex) carries no
 * such files; its subagent relation lives in Session metadata instead.
 */
export const SUBAGENT_BUNDLE_PREFIX = "source/subagents/";

/** The `payload` key carrying the subagent an event's evidence came from. */
export const SUBAGENT_PAYLOAD_KEY = "subagentId";

/**
 * The `payload` key carrying the source-native subagent type (Claude Code's
 * `agentType`, e.g. `Explore`), read from the sidecar beside the transcript.
 */
export const SUBAGENT_TYPE_PAYLOAD_KEY = "subagentType";

export function isSubagentBundlePath(path: string): boolean {
  return path.startsWith(SUBAGENT_BUNDLE_PREFIX);
}

/** A subagent transcript, as opposed to the sidecar sitting beside it. */
export function isSubagentTranscriptPath(path: string): boolean {
  return isSubagentBundlePath(path) && path.endsWith(".jsonl");
}

/** `source/subagents/agent-<agentId>.jsonl` → `<agentId>`. */
export function subagentIdOf(bundlePath: string): string {
  return basename(bundlePath, ".jsonl").replace(/^agent-/, "");
}

/**
 * The sidecar Claude Code writes beside a subagent transcript, holding what
 * the transcript itself never states: the agent's type, the parent's
 * description of the work, and the `toolUseId` anchoring it to the exact
 * Task call in the parent transcript that spawned it.
 */
export function subagentSidecarPathFor(transcriptBundlePath: string): string {
  return transcriptBundlePath.replace(/\.jsonl$/, ".meta.json");
}

/**
 * A short, stable form for display. Subagent ids are UUID-shaped in real
 * transcripts; the leading segment identifies one within a Session without
 * spending a line on it.
 */
export function shortSubagentId(agentId: string): string {
  return agentId.split("-")[0] ?? agentId;
}
