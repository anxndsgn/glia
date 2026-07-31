import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { runImport } from "../../src/session/domain/import.ts";
import { ensureProjection } from "../../src/session/projection/publish.ts";
import {
  listSessions,
  openProjection,
  searchFileTouches,
  searchText,
} from "../../src/session/projection/query.ts";
import { parseFilterValue } from "../../src/session/commands/search.ts";
import { probeSqliteFts5 } from "../../src/core/store/sqlite-probe.ts";
import { ProjectStore } from "../../src/core/store/store.ts";
import type { LoadedProject } from "../../src/core/session-module.ts";
import {
  initProject,
  makeTestEnv,
  writeClaudeSession,
  writeCodexSession,
  type TestEnv,
} from "../helpers.ts";

let env: TestEnv;
let project: LoadedProject;
beforeEach(async () => {
  env = await makeTestEnv();
  project = await initProject(env);
  await writeClaudeSession(env.claudeHome, { sessionId: "aaaa-1", cwd: env.worktree });
  await writeCodexSession(env.codexHome, {
    sessionId: "11111111-2222-3333-4444-555555555555",
    cwd: env.worktree,
  });
  await runImport(project, env.env, { harness: null, dryRun: false, onlyCandidateIds: null });
});
afterEach(async () => {
  await env.cleanup();
});

describe("session projection", () => {
  test("the runtime passes the SQLite FTS5 capability probe", () => {
    expect(() => probeSqliteFts5()).not.toThrow();
  });

  test("a deleted projection rebuilds to equivalent query results", async () => {
    const first = await ensureProjection(project, env.env);
    const db1 = openProjection(first.dbPath);
    const before = {
      sessions: listSessions(db1),
      matches: searchText(db1, params({ query: "flaky auth" })),
    };
    db1.close();

    await rm(project.paths.sessionCacheDir, { recursive: true, force: true });
    const rebuilt = await ensureProjection(project, env.env);
    const db2 = openProjection(rebuilt.dbPath);
    const after = {
      sessions: listSessions(db2),
      matches: searchText(db2, params({ query: "flaky auth" })),
    };
    db2.close();

    expect(after.sessions).toEqual(before.sessions);
    expect(after.matches).toEqual(before.matches);
  });

  test("text and file-touch matches trace back to source evidence locators", async () => {
    const handle = await ensureProjection(project, env.env);
    const db = openProjection(handle.dbPath);
    try {
      const text = searchText(db, params({ query: "exponential backoff" }));
      expect(text.totalMatches).toBe(1);
      const textMatch = text.groups[0]!.matches[0]!;
      expect(textMatch.locator.sourceFile).toBe("source/transcript.jsonl");
      expect(textMatch.locator.sourceCursor).toMatch(/^line:\d+$/);
      expect(text.groups[0]!.revisionDigest).toMatch(/^[0-9a-f]{64}$/);

      const touches = searchFileTouches(db, params({ file: "src/retry.ts" }));
      expect(touches.totalMatches).toBe(1);
      expect(touches.groups[0]!.matches[0]!.operation).toBe("created");
      expect(touches.groups[0]!.matches[0]!.locator.sourceCursor).toMatch(/^line:\d+$/);
    } finally {
      db.close();
    }
  });

  test("path mentions and ambiguous shell commands never become file touches", async () => {
    const handle = await ensureProjection(project, env.env);
    const db = openProjection(handle.dbPath);
    try {
      // docs/plan.md is only mentioned in prose; the Bash rm is ambiguous.
      expect(searchFileTouches(db, params({ file: "docs/plan.md" })).totalMatches).toBe(0);
      expect(searchFileTouches(db, params({ file: "/somewhere/ambiguous" })).totalMatches).toBe(0);
      // But the text remains retrievable as ordinary event evidence.
      expect(searchText(db, params({ query: "docs/plan.md" })).totalMatches).toBeGreaterThan(0);
    } finally {
      db.close();
    }
  });

  test("mechanical filters restrict by harness and event slice", async () => {
    const handle = await ensureProjection(project, env.env);
    const db = openProjection(handle.dbPath);
    try {
      const claudeOnly = searchText(db, params({ query: "flaky", harness: "claude-code" }));
      expect(claudeOnly.totalMatches).toBe(1);
      const codexOnly = searchText(db, params({ query: "flaky", harness: "codex" }));
      expect(codexOnly.totalMatches).toBe(0);
      const patchResults = searchText(
        db,
        params({ query: "apply_patch", filters: [parseFilterValue("toolresult")] }),
      );
      expect(patchResults.totalMatches).toBe(1);
    } finally {
      db.close();
    }
  });

  test("search never changes the store", async () => {
    const store = new ProjectStore(project.paths.storeDir);
    const head = await store.head();
    await rm(project.paths.sessionCacheDir, { recursive: true, force: true });
    const handle = await ensureProjection(project, env.env);
    const db = openProjection(handle.dbPath);
    searchText(db, params({ query: "flaky" }));
    db.close();
    expect(await store.head()).toBe(head);
    expect(await store.isClean()).toBeTrue();
  });

  test("a projection built by older projection code rebuilds even for the same store commit", async () => {
    const first = await ensureProjection(project, env.env);
    // Simulate a pointer left behind by an older Glia: same store commit,
    // older projection version.
    const pointerFile = project.paths.currentProjectionFile;
    const pointer = JSON.parse(await Bun.file(pointerFile).text()) as Record<string, unknown>;
    pointer["projectionVersion"] = (pointer["projectionVersion"] as number) - 1;
    await Bun.write(pointerFile, JSON.stringify(pointer) + "\n");

    const again = await ensureProjection(project, env.env);
    expect(again.stale).toBeFalse();
    const rewritten = JSON.parse(await Bun.file(pointerFile).text()) as Record<string, unknown>;
    expect(rewritten["projectionVersion"]).toBe((pointer["projectionVersion"] as number) + 1);
    expect(again.storeCommit).toBe(first.storeCommit);
  });

  test("projects subagent columns for both directions of the relation", async () => {
    await writeClaudeSession(env.claudeHome, {
      sessionId: "cc-parent",
      cwd: env.worktree,
      subagents: [{ agentId: "alpha" }, { agentId: "beta" }],
    });
    await writeCodexSession(env.codexHome, {
      sessionId: "22222222-2222-3333-4444-555555555555",
      cwd: env.worktree,
      subagent: { kind: "review", parentThreadId: "11111111-2222-3333-4444-555555555555" },
    });
    // A subagent whose parent thread was never imported.
    await writeCodexSession(env.codexHome, {
      sessionId: "33333333-2222-3333-4444-555555555555",
      cwd: env.worktree,
      subagent: { kind: "guardian", parentThreadId: "never-imported-thread" },
    });
    await runImport(project, env.env, { harness: null, dryRun: false, onlyCandidateIds: null });

    const handle = await ensureProjection(project, env.env);
    const db = openProjection(handle.dbPath);
    try {
      const bySource = new Map(listSessions(db).map((s) => [s.sourceSessionId, s]));

      const parent = bySource.get("cc-parent")!;
      expect(parent.subagentCount).toBe(2);
      expect(parent.subagentKind).toBeNull();

      const resolved = bySource.get("22222222-2222-3333-4444-555555555555")!;
      expect(resolved.subagentKind).toBe("review");
      expect(resolved.subagentParent).toBe("11111111-2222-3333-4444-555555555555");
      // The parent rollout is imported, so it resolves to a Session ID.
      expect(resolved.subagentParentSession).toBe(
        bySource.get("11111111-2222-3333-4444-555555555555")!.sessionId,
      );

      // An unimported parent stays the raw source ID; it never becomes null,
      // and no other Session is guessed into its place.
      const unresolved = bySource.get("33333333-2222-3333-4444-555555555555")!;
      expect(unresolved.subagentParent).toBe("never-imported-thread");
      expect(unresolved.subagentParentSession).toBeNull();

      // A Session carrying no subagents states so, rather than null.
      expect(bySource.get("aaaa-1")!.subagentCount).toBe(0);
    } finally {
      db.close();
    }
  });

  test("session timestamps span every transcript in the bundle, not stream order", async () => {
    // The subagent transcript's events all predate the main transcript's
    // last event, so first/last-seen ordering would report the subagent's
    // time as the Session's end.
    await writeClaudeSession(env.claudeHome, {
      sessionId: "cc-times",
      cwd: env.worktree,
      subagents: [
        {
          agentId: "alpha",
          lines: [
            {
              type: "assistant",
              uuid: "alpha-a1",
              sessionId: "cc-times",
              agentId: "alpha",
              isSidechain: true,
              timestamp: "2026-07-15T09:59:00Z",
              message: { role: "assistant", content: [{ type: "text", text: "early" }] },
            },
          ],
        },
      ],
    });
    await runImport(project, env.env, { harness: null, dryRun: false, onlyCandidateIds: null });

    const handle = await ensureProjection(project, env.env);
    const db = openProjection(handle.dbPath);
    try {
      const session = listSessions(db).find((s) => s.sourceSessionId === "cc-times")!;
      expect(session.firstTimestamp).toBe("2026-07-15T09:59:00Z");
      expect(session.lastTimestamp).toBe("2026-07-15T10:00:20Z");
    } finally {
      db.close();
    }
  });

  test("the subagent filter selects only subagent-file events", async () => {
    await writeClaudeSession(env.claudeHome, {
      sessionId: "cc-filter",
      cwd: env.worktree,
      userText: "shared needle in the main transcript",
      subagents: [{ agentId: "alpha", spawnPrompt: "shared needle in the subagent transcript" }],
    });
    await runImport(project, env.env, { harness: null, dryRun: false, onlyCandidateIds: null });

    const handle = await ensureProjection(project, env.env);
    const db = openProjection(handle.dbPath);
    try {
      const all = searchText(db, params({ query: "shared needle" }));
      const onlySubagent = searchText(
        db,
        params({ query: "shared needle", filters: [parseFilterValue("subagent")] }),
      );
      expect(all.totalMatches).toBe(2);
      expect(onlySubagent.totalMatches).toBe(1);
      const group = onlySubagent.groups[0];
      expect(group?.matches[0]?.locator.sourceFile).toBe("source/subagents/agent-alpha.jsonl");
      // Match group headers carry the same subagent facts a listing does.
      expect(group?.subagentCount).toBe(1);
    } finally {
      db.close();
    }
  });

  test("fts query input is literal text, never operators", async () => {
    const handle = await ensureProjection(project, env.env);
    const db = openProjection(handle.dbPath);
    try {
      // Raw FTS would reject or reinterpret these; literal quoting must not throw.
      expect(() => searchText(db, params({ query: 'AND OR NOT "unbalanced' }))).not.toThrow();
    } finally {
      db.close();
    }
  });
});

function params(
  overrides: Partial<Parameters<typeof searchText>[1]>,
): Parameters<typeof searchText>[1] {
  return {
    query: null,
    file: null,
    harness: null,
    since: null,
    filters: [],
    limit: 20,
    perSession: 3,
    sort: "relevance",
    includeArchived: false,
    ...overrides,
  };
}
