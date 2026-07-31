import { oneLine, truncate } from "../../core/output/terminal.ts";
import { redactSecrets } from "../domain/secret-detection.ts";

/** Display cap keeping discovered candidates light; the full text stays in
 * the source evidence and is never lost by this truncation. */
const MAX_LABEL_LENGTH = 120;

/**
 * Where a Session Label was read from, worst-to-best is the reverse of this
 * order: a Harness-provided title outranks the earliest user message, and a
 * user-authored title outranks a Harness-generated one. Adapters attest the
 * title kinds through the event payload; `user_message` needs no attestation
 * because the normalized event already carries speaker and kind.
 */
export const LABEL_SOURCES = ["custom_title", "ai_title", "summary", "user_message"] as const;
export type SessionLabelSource = (typeof LABEL_SOURCES)[number];

/** The `payload` key an adapter marks a title-bearing event with. */
export const LABEL_PAYLOAD_KEY = "sessionLabel";

/**
 * The `payload` key an adapter marks Harness-injected user-role evidence
 * with. Such an event is the Harness speaking through the user channel, so
 * it is never read as a Session Label — it stays an event like any other.
 */
export const META_PAYLOAD_KEY = "harnessInjected";

/**
 * Normalize source text into a Session Label: collapse whitespace, mask
 * any format-self-evident credential, and cap the length. Returns null
 * when nothing readable remains — a Label is always read from source
 * evidence, never fabricated.
 */
export function sessionLabel(text: string | null): string | null {
  if (text === null) return null;
  const collapsed = redactSecrets(oneLine(text));
  if (collapsed.length === 0) return null;
  return truncate(collapsed, MAX_LABEL_LENGTH);
}

/** The attested title kind an adapter persisted on an event, if any. */
export function labelSourceOf(payload: Record<string, unknown> | null): SessionLabelSource | null {
  const value = payload?.[LABEL_PAYLOAD_KEY];
  return LABEL_SOURCES.find((source) => source === value) ?? null;
}

export function isHarnessInjected(payload: Record<string, unknown> | null): boolean {
  return payload?.[META_PAYLOAD_KEY] === true;
}
