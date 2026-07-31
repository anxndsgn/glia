import type { HarnessId } from "../../core/harnesses/ids.ts";
import type { SessionHarnessAdapter } from "./types.ts";
import { claudeCodeAdapter } from "./claude-code/adapter.ts";
import { codexAdapter } from "./codex/adapter.ts";

export const sessionAdapters: readonly SessionHarnessAdapter[] = [codexAdapter, claudeCodeAdapter];

export function adapterFor(harnessId: HarnessId): SessionHarnessAdapter {
  const adapter = sessionAdapters.find((a) => a.harnessId === harnessId);
  if (!adapter) throw new Error(`no session adapter for harness ${harnessId}`);
  return adapter;
}
