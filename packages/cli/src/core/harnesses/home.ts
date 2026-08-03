import { homedir } from "node:os";
import { join } from "node:path";
import type { HarnessId } from "./ids.ts";

export function claudeHome(env: Record<string, string | undefined> = Bun.env): string {
  return env["CLAUDE_CONFIG_DIR"] ?? join(homedir(), ".claude");
}

export function codexHome(env: Record<string, string | undefined> = Bun.env): string {
  return env["CODEX_HOME"] ?? join(homedir(), ".codex");
}

export function harnessHome(
  harnessId: HarnessId,
  env: Record<string, string | undefined> = Bun.env,
): string {
  return harnessId === "claude-code" ? claudeHome(env) : codexHome(env);
}
