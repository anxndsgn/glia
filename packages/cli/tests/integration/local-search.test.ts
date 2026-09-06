import { writeDeclaration } from "../../src/core/config/glia-json.ts";
import { claudeCodeAdapter } from "../../src/session/adapters/claude-code/adapter.ts";
import { ensureReadableProjection } from "../../src/session/projection/readable.ts";
import { setAutoSave } from "../../src/core/project/auto-save.ts";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFile, mkdir, rm, readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  makeTestEnv,
  writeClaudeSession,
  writeCodexSession,
  FAKE_KEY,
  type TestEnv,
} from "../helpers.ts";
import { loadProject, loadProjectForRead } from "../../src/core/project/load.ts";
import { searchCommand } from "../../src/session/commands/search.ts";
import { listCommand } from "../../src/session/commands/list.ts";
import { viewCommand } from "../../src/session/commands/view.ts";
import { deleteCommand } from "../../src/session/commands/delete.ts";
import { importCommand } from "../../src/session/commands/import.ts";
import { runImport } from "../../src/session/domain/import.ts";
import { sessionIdOf } from "../../src/session/domain/identity.ts";
import { autoSaveEnabled } from "../../src/core/project/auto-save.ts";
import { runHookInvocation } from "../../src/session/commands/hook-import.ts";
import { ProjectStore } from "../../src/core/store/store.ts";
import { gitOrThrow } from "../../src/core/store/git.ts";
import { readCacheRoot } from "../../src/session/domain/local-state.ts";
import type { CommandRunContext } from "../../src/core/session-module.ts";

let env: TestEnv;
beforeEach(async () => {
  env = await makeTestEnv();
});
afterEach(async () => {
  await env.cleanup();
});
const id = (name: string) => sessionIdOf({ harnessId: "claude-code", sourceSessionId: name });
async function ctx(path = env.worktree): Promise<CommandRunContext> {
  return {
    project: await loadProjectForRead(path, env.home),
    env: env.env,
    inputDisabled: true,
    jsonMode: true,
  };
}
async function search(query: string, context?: CommandRunContext) {
  return (await searchCommand.run(context ?? (await ctx()), [query], {})).json as any;
}
async function save(path = env.worktree) {
  const project = await loadProject(path, env.home);
  await runImport(project, env.env, { dryRun: false, harness: null, onlyCandidateIds: null });
  return project;
}
function extra(name: string, text: string) {
  return (
    JSON.stringify({
      type: "user",
      sessionId: name,
      uuid: `${name}-${text}`,
      cwd: env.worktree,
      timestamp: "2026-09-06T12:00:00Z",
      message: { role: "user", content: text },
    }) + "\n"
  );
}

describe("local Session search", () => {
  test("search, list and view work without enrollment, preserve sources, and create no Store", async () => {
    const file = await writeClaudeSession(env.claudeHome, {
      sessionId: "local",
      cwd: env.worktree,
      userText: "native searchable evidence",
    });
    const bytes = await Bun.file(file).text();
    const context = await ctx();
    const result = await search("searchable", context);
    expect(result.totalMatches).toBe(1);
    expect(result.projection.sources[id("local")]).toMatchObject({
      source: "local",
      saved: false,
      savedRevisionDigest: null,
    });
    const listing = (await listCommand.run(context, [], {})).json as any;
    expect(listing.totalSessions).toBe(1);
    expect(listing.sessions[0].acceptedAt).toBeNull();
    const view = (
      await viewCommand.run(context, [id("local")], { seq: String(result.matches[0].eventSeq) })
    ).json as any;
    expect(view.event.text).toContain("searchable");
    expect(await Bun.file(file).text()).toBe(bytes);
    expect(await new ProjectStore(context.project.paths.storeDir).exists()).toBe(false);
    expect(await Bun.file(context.project.paths.bindingsFile).exists()).toBe(false);
    expect((await readdir(env.home)).includes("projects")).toBe(false);
    expect((await readdir(readCacheRoot(env.home))).some((n) => n.startsWith("capture-"))).toBe(
      false,
    );
  });

  test("append updates cached events and FTS, source loss removes unsaved cached evidence", async () => {
    const file = await writeClaudeSession(env.claudeHome, {
      sessionId: "append",
      cwd: env.worktree,
      userText: "initial",
    });
    const context = await ctx();
    expect((await search("newlyappended", context)).totalMatches).toBe(0);
    await appendFile(file, extra("append", "newlyappended"));
    expect((await search("newlyappended", context)).totalMatches).toBe(1);
    expect((await search("newlyappended", context)).totalMatches).toBe(1);
    await rm(file);
    expect((await search("newlyappended", context)).totalMatches).toBe(0);
  });

  test("local additions overlay a saved Session without changing Store; --saved and source loss use snapshot", async () => {
    const file = await writeClaudeSession(env.claudeHome, {
      sessionId: "saved",
      cwd: env.worktree,
      userText: "baseline",
    });
    const project = await save();
    const head = await new ProjectStore(project.paths.storeDir).head();
    await appendFile(file, extra("saved", "postsaveaddition"));
    const result = await search("postsaveaddition");
    expect(result.totalMatches).toBe(1);
    expect(result.projection.sources[id("saved")]).toMatchObject({
      saved: true,
      savedVersionBehind: true,
      source: "local",
    });
    expect(((await listCommand.run(await ctx(), [], {})).json as any).totalSessions).toBe(1);
    expect(
      ((await searchCommand.run(await ctx(), ["postsaveaddition"], { saved: true })).json as any)
        .totalMatches,
    ).toBe(0);
    expect(await new ProjectStore(project.paths.storeDir).head()).toBe(head);
    await rm(file);
    expect((await search("baseline")).totalMatches).toBe(1);
    expect((await search("postsaveaddition")).totalMatches).toBe(0);
  });

  test("ordinary directory scope includes descendants but excludes siblings and persists through import", async () => {
    const root = join(env.root, "notes");
    const child = join(root, "topic");
    const sibling = join(env.root, "other-notes");
    await mkdir(child, { recursive: true });
    await mkdir(sibling);
    await writeClaudeSession(env.claudeHome, {
      sessionId: "notes",
      cwd: child,
      userText: "scopematch",
    });
    await writeClaudeSession(env.claudeHome, {
      sessionId: "other",
      cwd: sibling,
      userText: "scopematch",
    });
    expect((await search("scopematch", await ctx(root))).totalMatches).toBe(1);
    const project = await save(root);
    expect((await ctx(child)).project.declaration.projectId).toBe(project.declaration.projectId);
    expect((await search("scopematch", await ctx(root))).totalMatches).toBe(1);
  });

  test("worktrees share native search and saved Project identity without combining independent clones", async () => {
    await gitOrThrow(
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-m",
        "initial",
      ],
      env.worktree,
    );
    const sibling = join(env.root, "linked");
    await gitOrThrow(["worktree", "add", "-b", "linked", sibling], env.worktree);
    await writeClaudeSession(env.claudeHome, {
      sessionId: "main",
      cwd: env.worktree,
      userText: "sharedscope",
    });
    await writeClaudeSession(env.claudeHome, {
      sessionId: "linked",
      cwd: sibling,
      userText: "sharedscope",
    });
    expect((await search("sharedscope", await ctx(sibling))).totalMatches).toBe(2);
    const mainContext = await ctx();
    const siblingContext = await ctx(sibling);
    expect(mainContext.project.declaration.projectId).toBe(
      siblingContext.project.declaration.projectId,
    );
    const project = await save();
    expect((await ctx(sibling)).project.declaration.projectId).toBe(project.declaration.projectId);
    expect((await search("sharedscope", await ctx(sibling))).totalMatches).toBe(2);
  });

  test("forget unsaved evidence survives cache deletion and enrollment without removing original", async () => {
    const file = await writeClaudeSession(env.claudeHome, {
      sessionId: "forget",
      cwd: env.worktree,
      userText: "forgetmarker",
    });
    await search("forgetmarker");
    await deleteCommand.run(await ctx(), [id("forget")], { yes: true });
    expect(await Bun.file(file).exists()).toBe(true);
    expect((await search("forgetmarker")).totalMatches).toBe(0);
    const project = await save();
    expect((await search("forgetmarker")).totalMatches).toBe(0);
    expect(
      await Bun.file(
        join(project.paths.storeDir, "session", "sessions", id("forget"), "session.json"),
      ).exists(),
    ).toBe(false);
  });

  test("delete saved evidence excludes native source and purges read cache", async () => {
    const file = await writeClaudeSession(env.claudeHome, {
      sessionId: "delete",
      cwd: env.worktree,
      userText: "deletemarker",
    });
    await save();
    await search("deletemarker");
    await deleteCommand.run(await ctx(), [id("delete")], { yes: true });
    expect((await search("deletemarker")).totalMatches).toBe(0);
    expect(await Bun.file(file).exists()).toBe(true);
  });

  test("suspected secrets are searchable locally but import still withholds them", async () => {
    await writeClaudeSession(env.claudeHome, {
      sessionId: "secret",
      cwd: env.worktree,
      userText: `secretmarker ${FAKE_KEY}`,
    });
    const project = await save();
    expect((await search("secretmarker")).totalMatches).toBe(1);
    expect(
      await Bun.file(
        join(project.paths.storeDir, "session", "sessions", id("secret"), "session.json"),
      ).exists(),
    ).toBe(false);
  });

  test("malformed records are reported as partial on repeated cached reads", async () => {
    const file = await writeClaudeSession(env.claudeHome, {
      sessionId: "partial",
      cwd: env.worktree,
      userText: "validmarker",
    });
    await appendFile(file, '{"unfinished":');
    for (let i = 0; i < 2; i++) {
      const result = await search("validmarker");
      expect(result.totalMatches).toBe(1);
      expect(result.projection.partial).toBe(true);
      expect(result.projection.issues[0].message).toContain("Unparseable");
    }
  });

  test("view can require the revision cited by search", async () => {
    const file = await writeClaudeSession(env.claudeHome, {
      sessionId: "revision",
      cwd: env.worktree,
      userText: "revisionmarker",
    });
    const result = await search("revisionmarker");
    const revision = result.projection.sources[id("revision")].revisionDigest;
    await appendFile(file, extra("revision", "changed"));
    await expect(
      viewCommand.run(await ctx(), [id("revision")], { revision }),
    ).rejects.toMatchObject({ code: "SOURCE_INCOMPLETE" });
  });

  test("one-time import does not enable automatic saving; on/off are local and explicit", async () => {
    await writeClaudeSession(env.claudeHome, { sessionId: "initial", cwd: env.worktree });
    const project = await save();
    expect(await autoSaveEnabled(project)).toBe(false);
    const file = await writeClaudeSession(env.claudeHome, {
      sessionId: "future",
      cwd: env.worktree,
      userText: "futuremarker",
    });
    const hook = () =>
      runHookInvocation({
        cwd: env.worktree,
        env: { ...env.env, GLIA_HOOK_FOREGROUND: "1" },
        jsonMode: false,
      });
    await hook();
    expect(
      await Bun.file(
        join(project.paths.storeDir, "session", "sessions", id("future"), "session.json"),
      ).exists(),
    ).toBe(false);
    await importCommand.run(await ctx(), [], { autoSave: "on" });
    expect(await autoSaveEnabled(project)).toBe(true);
    await appendFile(file, extra("future", "autonewcontent"));
    await hook();
    expect(
      ((await searchCommand.run(await ctx(), ["autonewcontent"], { saved: true })).json as any)
        .totalMatches,
    ).toBe(1);
    await importCommand.run(await ctx(), [], { autoSave: "off" });
    await appendFile(file, extra("future", "afterdisable"));
    await hook();
    expect(
      ((await searchCommand.run(await ctx(), ["afterdisable"], { saved: true })).json as any)
        .totalMatches,
    ).toBe(0);
    expect((await search("afterdisable")).totalMatches).toBe(1);
  });
  test("native Codex Sessions and subagents are readable before import", async () => {
    await writeCodexSession(env.codexHome, {
      sessionId: "codex-parent",
      cwd: env.worktree,
      userText: "codexnativemarker",
    });
    await writeCodexSession(env.codexHome, {
      sessionId: "codex-child",
      cwd: env.worktree,
      userText: "childnativemarker",
      subagent: { kind: "review", parentThreadId: "codex-parent" },
    });
    const result = await search("codexnativemarker");
    expect(result.totalMatches).toBe(1);
    expect(result.matches[0].harnessId).toBe("codex");
    const childId = sessionIdOf({ harnessId: "codex", sourceSessionId: "codex-child" });
    const view = (await viewCommand.run(await ctx(), [childId], {})).json as any;
    expect(view.session.subagent.isSubagent).toBe(true);
    expect(view.session.subagent.parentSourceSessionId).toBe("codex-parent");
  });

  test("unchanged native Sessions reuse normalization, changed Sessions replace stale FTS hits", async () => {
    await writeClaudeSession(env.claudeHome, {
      sessionId: "cached",
      cwd: env.worktree,
      userText: "oldcachemarker",
    });
    let calls = 0;
    const original = claudeCodeAdapter.project;
    claudeCodeAdapter.project = async function* (bundle) {
      calls++;
      yield* original(bundle);
    };
    try {
      expect((await search("oldcachemarker")).totalMatches).toBe(1);
      expect((await search("oldcachemarker")).totalMatches).toBe(1);
      expect(calls).toBe(1);
      await writeClaudeSession(env.claudeHome, {
        sessionId: "cached",
        cwd: env.worktree,
        userText: "newcachemarker",
      });
      expect((await search("oldcachemarker")).totalMatches).toBe(0);
      expect((await search("newcachemarker")).totalMatches).toBe(1);
      expect(calls).toBe(2);
    } finally {
      claudeCodeAdapter.project = original;
    }
  });

  test("concurrent readers keep coherent SQLite snapshots while native evidence advances", async () => {
    const file = await writeClaudeSession(env.claudeHome, {
      sessionId: "snapshot",
      cwd: env.worktree,
    });
    const context = await ctx();
    const first = await ensureReadableProjection(context.project, env.env);
    try {
      const before = first.db.query("SELECT count(*) AS n FROM events").get();
      await appendFile(file, extra("snapshot", "concurrentaddition"));
      const second = await ensureReadableProjection(context.project, env.env);
      try {
        expect(first.db.query("SELECT count(*) AS n FROM events").get()).toEqual(before);
        expect(second.db.query("SELECT count(*) AS n FROM events").get()).not.toEqual(before);
        expect(first.sources[id("snapshot")]!.revisionDigest).not.toBe(
          second.sources[id("snapshot")]!.revisionDigest,
        );
      } finally {
        second.db.close();
      }
    } finally {
      first.db.close();
    }
  });

  test("a saved superset wins over an older native prefix", async () => {
    const file = await writeClaudeSession(env.claudeHome, {
      sessionId: "prefix",
      cwd: env.worktree,
      userText: "prefixbase",
    });
    const older = await Bun.file(file).text();
    await appendFile(file, extra("prefix", "savednewercontent"));
    await save();
    await Bun.write(file, older);
    const result = await search("savednewercontent");
    expect(result.totalMatches).toBe(1);
    expect(result.projection.sources[id("prefix")]).toMatchObject({
      source: "store",
      saved: true,
      savedVersionBehind: false,
    });
  });

  test("ordinary scopes include unbound nested repositories; their hooks inherit the local opt-in", async () => {
    const folder = join(env.root, "folder");
    const nested = join(folder, "nested-repo");
    await mkdir(nested, { recursive: true });
    await gitOrThrow(["init", "-q", "--initial-branch=main"], nested);
    await writeClaudeSession(env.claudeHome, {
      sessionId: "nested-notes",
      cwd: nested,
      userText: "nestedfoldermarker",
    });
    expect((await search("nestedfoldermarker", await ctx(folder))).totalMatches).toBe(1);
    const project = await save(folder);
    await setAutoSave(project, true);
    await writeClaudeSession(env.claudeHome, {
      sessionId: "nested-auto",
      cwd: nested,
      userText: "nestedautomarker",
    });
    await runHookInvocation({
      cwd: nested,
      env: { ...env.env, GLIA_HOOK_FOREGROUND: "1" },
      jsonMode: false,
    });
    expect(
      await Bun.file(
        join(project.paths.storeDir, "session", "sessions", id("nested-auto"), "session.json"),
      ).exists(),
    ).toBe(true);
  });

  test("independent clones do not share native search even with the same remote", async () => {
    await gitOrThrow(
      [
        "-c",
        "user.name=Test",
        "-c",
        "user.email=test@example.com",
        "commit",
        "--allow-empty",
        "-m",
        "initial",
      ],
      env.worktree,
    );
    const one = join(env.root, "clone-one");
    const two = join(env.root, "clone-two");
    await gitOrThrow(["clone", "-q", env.worktree, one], env.root);
    await gitOrThrow(["clone", "-q", env.worktree, two], env.root);
    await writeClaudeSession(env.claudeHome, {
      sessionId: "clone-one",
      cwd: one,
      userText: "clonescopemarker",
    });
    expect((await search("clonescopemarker", await ctx(one))).totalMatches).toBe(1);
    expect((await search("clonescopemarker", await ctx(two))).totalMatches).toBe(0);
  });

  test("capture failures report partial results and retain only the saved fallback", async () => {
    await writeClaudeSession(env.claudeHome, {
      sessionId: "failing-source",
      cwd: env.worktree,
      userText: "fallbackmarker",
    });
    await save();
    const original = claudeCodeAdapter.capture;
    claudeCodeAdapter.capture = async () => {
      throw new Error("source access denied");
    };
    try {
      const result = await search("fallbackmarker");
      expect(result.totalMatches).toBe(1);
      expect(result.projection.partial).toBe(true);
      expect(result.projection.sources[id("failing-source")].source).toBe("store");
    } finally {
      claudeCodeAdapter.capture = original;
    }
  });
  test("ordinary subdirectories inherit the saved Project declaration and remote", async () => {
    const folder = join(env.root, "declared-notes");
    const child = join(folder, "child");
    await mkdir(child, { recursive: true });
    const project = await save(folder);
    project.declaration.store.remote = "file:///tmp/example-glia-remote.git";
    await writeDeclaration(folder, project.declaration);
    const read = await ctx(child);
    expect(read.project.declaration.store.remote).toBe(project.declaration.store.remote);
    expect((await loadProject(child, env.home)).declaration.store.remote).toBe(
      project.declaration.store.remote,
    );
  });
});
