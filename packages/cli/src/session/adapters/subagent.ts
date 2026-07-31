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

export function isSubagentBundlePath(path: string): boolean {
  return path.startsWith(SUBAGENT_BUNDLE_PREFIX);
}

/** `source/subagents/agent-<agentId>.jsonl` → `<agentId>`. */
export function subagentIdOf(bundlePath: string): string {
  return basename(bundlePath, ".jsonl").replace(/^agent-/, "");
}

/**
 * A short, stable form for display. Subagent ids are UUID-shaped in real
 * transcripts; the leading segment identifies one within a Session without
 * spending a line on it.
 */
export function shortSubagentId(agentId: string): string {
  return agentId.split("-")[0] ?? agentId;
}
