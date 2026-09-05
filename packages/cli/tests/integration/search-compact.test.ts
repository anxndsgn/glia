import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { searchCommand } from "../../src/session/commands/search.ts";
import { archiveCommand } from "../../src/session/commands/archive.ts";
import { runImport } from "../../src/session/domain/import.ts";
import { sessionIdOf } from "../../src/session/domain/identity.ts";
import type { CommandRunContext } from "../../src/core/session-module.ts";
import {
  initProject,
  makeTestEnv,
  writeClaudeSession,
  writeCodexSession,
  type TestEnv,
} from "../helpers.ts";

type Entry = Record<string, any>;
let env: TestEnv;
let ctx: CommandRunContext;

/** Independent consumer: reconstruct the existing flat wire contract. */
function expand(groups: Entry[]): Entry[] {
  return groups.flatMap((group) => {
    const restore = (entry: Entry): Entry => ({
      ...entry,
      locator: { sourceFile: group.sourceFile, ...entry.locator },
    });
    const contexts = new Map((group.context ?? []).map((entry: Entry) => [entry.seq, entry]));
    return group.matches.map(({ contextSeqs, ...match }: Entry) => ({
      sessionId: group.sessionId,
      harnessId: group.harnessId,
      ...(group.archiveState !== undefined ? { archiveState: group.archiveState } : {}),
      ...restore(match),
      ...(contextSeqs !== undefined
        ? { context: contextSeqs.map((seq: number) => restore(contexts.get(seq) as Entry)) }
        : {}),
    }));
  });
}

async function search(args: readonly (string | undefined)[], options: Entry = {}) {
  return (await searchCommand.run(ctx, [...args], options)).json as Entry;
}

beforeAll(async () => {
  env = await makeTestEnv();
  const project = await initProject(env);
  ctx = { project, env: env.env, jsonMode: true, inputDisabled: true };
  const line = (uuid: string, text: string) => ({
    type: "user",
    uuid,
    sessionId: "compact-parent",
    cwd: env.worktree,
    timestamp: "2026-07-15T10:01:00Z",
    message: { role: "user", content: text },
  });
  const shared = line("shared-opening", "COMPACTPROBE opening");
  await writeClaudeSession(env.claudeHome, {
    sessionId: "compact-parent",
    cwd: env.worktree,
    extraLines: [
      shared,
      line("compact-twin-1", "COMPACTPROBE duplicate"),
      line("compact-twin-2", "COMPACTPROBE duplicate"),
      // Missing source identity and timestamp must remain explicit nulls.
      { type: "system", message: { role: "system", content: "shared neighbor" } },
      line("compact-last", "COMPACTPROBE closing"),
    ],
    subagents: [
      { agentId: "alpha", spawnPrompt: "COMPACTPROBE 子代理原文", meta: { agentType: "Explore" } },
      { agentId: "", spawnPrompt: "COMPACTPROBE anonymous subagent" },
    ],
  });
  await writeClaudeSession(env.claudeHome, {
    sessionId: "compact-child",
    parentSessionId: "compact-parent",
    cwd: env.worktree,
    userText: "child's own request",
    extraLines: [shared],
  });
  await writeCodexSession(env.codexHome, {
    sessionId: "compact-codex",
    cwd: env.worktree,
    userText: "COMPACTPROBE codex request",
    agentText: "COMPACTPROBE codex answer",
  });
  await runImport(project, env.env, { harness: null, dryRun: false, onlyCandidateIds: null });
  await archiveCommand.run(
    ctx,
    [sessionIdOf({ harnessId: "codex", sourceSessionId: "compact-codex" })],
    { yes: true },
  );
});

afterAll(async () => {
  await env.cleanup();
});

describe("compact search is lossless", () => {
  test.each([
    { args: ["COMPACTPROBE"], options: {} },
    { args: ["COMPACTPROBE"], options: { context: "2", perSession: "20" } },
    { args: ["COMPACTPROBE"], options: { context: "4", limit: "1" } },
    { args: ["COMPACTPROBE"], options: { includeArchived: true, sort: "time" } },
    { args: ["COMPACTPROBE"], options: { filter: ["subagent"], context: "2" } },
    { args: [undefined], options: { file: "auth.test.ts", context: "2" } },
    { args: ["absent-evidence"], options: { context: "2" } },
  ])("restores every field and result order: %j", async ({ args, options }) => {
    const flat = await search(args, options);
    const compact = await search(args, { ...options, compact: true });
    if (compact.layout !== "grouped") {
      expect(compact).toEqual(flat);
      return;
    }
    const { matches, ...flatMetadata } = flat;
    const { layout, groups, ...compactMetadata } = compact;
    expect(layout).toBe("grouped");
    expect(compact.matches).toBeUndefined();
    expect(compactMetadata).toEqual(flatMetadata);
    expect(expand(groups)).toEqual(matches);
  });

  test("inherits only shared fields and preserves subagent overrides, runs, and family copies", async () => {
    const compact = await search(["COMPACTPROBE"], {
      compact: true,
      context: "2",
      perSession: "20",
      includeArchived: true,
    });
    const restored = expand(compact.groups);
    expect(restored.some((m) => m.archiveState === "archived")).toBeTrue();
    expect(restored.some((m) => m.alsoIn?.length > 0)).toBeTrue();
    expect(restored.some((m) => m.memberSeqs?.length === 2)).toBeTrue();
    expect(restored.some((m) => m.subagentId === "")).toBeTrue();
    expect(restored.some((m) => m.subagentType === "Explore")).toBeTrue();
    expect(restored.some((m) => m.locator.sourceFile.includes("agent-alpha.jsonl"))).toBeTrue();
    for (const group of compact.groups) {
      expect(group.sourceFile).toBeString();
      for (const match of group.matches) {
        expect(match.sessionId).toBeUndefined();
        expect(match.harnessId).toBeUndefined();
        expect(match.archiveState).toBeUndefined();
        expect(match.locator.sourceCursor).toBeString();
        expect(match.locator.sourceEventId).not.toBeUndefined();
      }
      const seqs = (group.context ?? []).map((entry: Entry) => entry.seq);
      expect(new Set(seqs).size).toBe(seqs.length);
    }
    const flat = await search(["COMPACTPROBE"], {
      context: "2",
      perSession: "20",
      includeArchived: true,
    });
    const repeated = flat.matches.flatMap((m: Entry) => m.context ?? []).length;
    const shared = compact.groups.flatMap((g: Entry) => g.context ?? []).length;
    expect(shared).toBeLessThan(repeated);
    expect(JSON.stringify(compact).length).toBeLessThan(JSON.stringify(flat).length);
  });

  test("requires JSON mode", async () => {
    await expect(
      searchCommand.run({ ...ctx, jsonMode: false }, ["COMPACTPROBE"], { compact: true }),
    ).rejects.toMatchObject({ code: "USAGE", message: "--compact requires --json" });
  });

  test("keeps flat output for empty and sparse results when grouping would cost more", async () => {
    for (const query of ["absent-evidence", "closing"]) {
      const flat = await search([query]);
      expect(flat.matches.length).toBeLessThanOrEqual(1);
      const compact = await search([query], { compact: true });
      expect(compact).toEqual(flat);
    }
  });
});
