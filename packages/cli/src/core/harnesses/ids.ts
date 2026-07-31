export const HARNESS_IDS = ["codex", "claude-code"] as const;

export type HarnessId = (typeof HARNESS_IDS)[number];

export function isHarnessId(value: string): value is HarnessId {
  return (HARNESS_IDS as readonly string[]).includes(value);
}
