import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runImport } from "../../src/session/domain/import.ts";
import { sessionIdOf } from "../../src/session/domain/identity.ts";
import { candidatesCommand } from "../../src/session/commands/candidates.ts";
import { listCommand } from "../../src/session/commands/list.ts";
import { searchCommand } from "../../src/session/commands/search.ts";
import { exportCommand } from "../../src/session/commands/export.ts";
import { showCommand } from "../../src/session/commands/show.ts";
import { viewCommand } from "../../src/session/commands/view.ts";
import type { CommandRunContext, LoadedProject } from "../../src/core/session-module.ts";
import {
  readSessionMeta,
  SESSION_META_SCHEMA_VERSION,
} from "../../src/session/storage/store-layout.ts";
import { requireSupportedSchemaVersion } from "../../src/core/state/schema-version.ts";
import {
  initProject,
  makeTestEnv,
  writeClaudeSession,
  writeCodexSession,
  type TestEnv,
} from "../helpers.ts";

let env: TestEnv;
let project: LoadedProject;
let ctx: CommandRunContext;

const CC_PARENT = "cc-with-subagents";
const CODEX_PARENT = "11111111-2222-3333-4444-555555555555";
const CODEX_CHILD = "22222222-2222-3333-4444-555555555555";
const CODEX_ORPHAN = "33333333-2222-3333-4444-555555555555";

const ccParentId = sessionIdOf({ harnessId: "claude-code", sourceSessionId: CC_PARENT });
const codexParentId = sessionIdOf({ harnessId: "codex", sourceSessionId: CODEX_PARENT });
const codexChildId = sessionIdOf({ harnessId: "codex", sourceSessionId: CODEX_CHILD });
const codexOrphanId = sessionIdOf({ harnessId: "codex", sourceSessionId: CODEX_ORPHAN });

beforeAll(async () => {
  env = await makeTestEnv();
  project = await initProject(env);
  ctx = { project, env: env.env, jsonMode: false, inputDisabled: true };

  await writeClaudeSession(env.claudeHome, {
    sessionId: CC_PARENT,
    cwd: env.worktree,
    userText: "the human's own opening request",
    subagents: [
      {
        agentId: "alpha-1111",
        spawnPrompt: "SUBPROBE find every retry helper",
        meta: { agentType: "Explore" },
        lines: [
          {
            type: "assistant",
            uuid: "alpha-a1",
            sessionId: CC_PARENT,
            agentId: "alpha-1111",
            isSidechain: true,
            timestamp: "2026-07-15T10:00:22Z",
            message: {
              role: "assistant",
              content: [
                {
                  type: "tool_use",
                  id: "st1",
                  name: "Read",
                  input: { file_path: `${env.worktree}/src/retry.ts` },
                },
              ],
            },
          },
        ],
      },
    ],
  });
  await writeCodexSession(env.codexHome, {
    sessionId: CODEX_PARENT,
    cwd: env.worktree,
    userText: "the codex parent thread's request",
    agentText: "the codex parent thread's answer",
  });
  await writeCodexSession(env.codexHome, {
    sessionId: CODEX_CHILD,
    cwd: env.worktree,
    userText: "SUBPROBE the codex subagent's instructions",
    agentText: "the codex subagent's answer",
    subagent: { kind: "review", parentThreadId: CODEX_PARENT },
  });
  await writeCodexSession(env.codexHome, {
    sessionId: CODEX_ORPHAN,
    cwd: env.worktree,
    userText: "the orphan subagent's instructions",
    agentText: "the orphan subagent's answer",
    subagent: { kind: "guardian" },
  });
});
afterAll(async () => {
  await env.cleanup();
});

const importAll = () =>
  runImport(project, env.env, { harness: null, dryRun: false, onlyCandidateIds: null });

describe("subagent lifecycle across the command surface", () => {
  test("candidates state what a Session carries before it is accepted", async () => {
    const outcome = await candidatesCommand.run(ctx, [], { all: true, status: ["associated"] });
    const human = outcome.human ?? "";
    // The Claude Code parent explains why its Revision covers more than one file.
    expect(human).toContain("+1 subagent transcript");
    // A Codex subagent rollout says what it is.
    expect(human).toContain("subagent(review)");
  });

  test("list badges both directions of the relation and resolves imported parents", async () => {
    await importAll();
    const outcome = await listCommand.run(ctx, [], {});
    const human = outcome.human ?? "";

    expect(human).toContain("1 subagent");
    expect(human).toContain(`subagent(review) of ${codexParentId}`);
    // A subagent whose parent was never imported says so rather than guessing.
    expect(human).toContain("subagent(guardian) of parent unknown");

    const sessions = (outcome.json as { sessions: Record<string, unknown>[] }).sessions;
    const byId = new Map(sessions.map((s) => [s["sessionId"] as string, s]));
    expect(byId.get(ccParentId)?.["subagentCount"]).toBe(1);
    expect(byId.get(codexChildId)?.["subagentParentSession"]).toBe(codexParentId);
    expect(byId.get(codexOrphanId)?.["subagentParent"]).toBeNull();
  });

  test("search marks subagent matches and --filter subagent selects only them", async () => {
    const all = await searchCommand.run(ctx, ["SUBPROBE"], {});
    const allJson = all.json as { totalMatches: number };
    // Both the Claude Code subagent transcript and the Codex subagent rollout.
    expect(allJson.totalMatches).toBe(2);
    expect(all.human ?? "").toContain("subagent Explore(alpha)");

    const only = await searchCommand.run(ctx, ["SUBPROBE"], { filter: ["subagent"] });
    const onlyJson = only.json as {
      totalMatches: number;
      matches: { sessionId: string; locator: { sourceFile: string } }[];
    };
    // The Codex subagent's own rollout is its main transcript, so a
    // provenance slice must not sweep it in.
    expect(onlyJson.totalMatches).toBe(1);
    expect(onlyJson.matches[0]?.sessionId).toBe(ccParentId);
    expect(onlyJson.matches[0]?.locator.sourceFile).toBe("source/subagents/agent-alpha-1111.jsonl");
  });

  test("view attributes each event and states the relation in both directions", async () => {
    const parent = await viewCommand.run(ctx, [ccParentId], { all: true });
    const parentHuman = parent.human ?? "";
    expect(parentHuman).toContain("1 subagent");
    expect(parentHuman).toContain("source/subagents/agent-alpha-1111.jsonl");
    // Subagent tool traffic is part of the parent's readable timeline.
    // The sidecar's agentType names the agent; the id says which invocation.
    expect(parentHuman).toContain("subagent Explore(alpha)");
    expect(parentHuman).toContain("Read");

    // The Codex parent names the Sessions it spawned.
    const codexParent = await viewCommand.run(ctx, [codexParentId], {});
    expect(codexParent.human ?? "").toContain(`spawned subagent sessions: ${codexChildId}`);

    const child = await viewCommand.run(ctx, [codexChildId], {});
    expect(child.human ?? "").toContain(`subagent(review) of ${codexParentId}`);
  });

  test("show reports the subagent meta in human and JSON", async () => {
    const outcome = await showCommand.run(ctx, [codexChildId], {});
    expect(outcome.human ?? "").toContain(`subagent: subagent(review) of ${codexParentId}`);

    const session = (outcome.json as { session: Record<string, unknown> }).session;
    expect(session["subagent"]).toEqual({
      isSubagent: true,
      kind: "review",
      parentSourceSessionId: CODEX_PARENT,
      parentSessionId: codexParentId,
      transcriptCount: 0,
      spawnedSessionIds: [],
    });

    const parent = await showCommand.run(ctx, [codexParentId], {});
    const parentSession = (parent.json as { session: Record<string, unknown> }).session;
    expect(parentSession["subagent"]).toMatchObject({
      kind: null,
      spawnedSessionIds: [codexChildId],
    });

    const ccParent = await showCommand.run(ctx, [ccParentId], {});
    expect(ccParent.human ?? "").toContain("subagent: 1 subagent");
    expect(
      (ccParent.json as { session: Record<string, unknown> }).session["subagent"],
    ).toMatchObject({ transcriptCount: 1 });
  });

  test("export carries the subagent transcripts with the parent's bundle", async () => {
    const output = join(env.root, "subagent-export");
    await exportCommand.run(ctx, [ccParentId], { output });
    const doc = JSON.parse(await Bun.file(join(output, "session.json")).text()) as {
      files: { path: string }[];
    };
    expect(doc.files.map((f) => f.path)).toEqual(
      expect.arrayContaining([
        "source/subagents/agent-alpha-1111.jsonl",
        "source/subagents/agent-alpha-1111.meta.json",
      ]),
    );
    // The bytes travel with the export, not just the manifest entry.
    const exported = await Bun.file(
      join(output, "source", "subagents", "agent-alpha-1111.jsonl"),
    ).text();
    expect(exported).toContain("SUBPROBE find every retry helper");
  });

  test("an exported subagent Session keeps its parent link", async () => {
    const output = join(env.root, "codex-subagent-export");
    await exportCommand.run(ctx, [codexChildId], { output });
    const doc = JSON.parse(await Bun.file(join(output, "session.json")).text()) as {
      subagent: { kind: string; parentSourceSessionId: string } | null;
      continuation: unknown;
    };
    // Exported evidence stands alone: a subagent that lost its parent would not.
    expect(doc.subagent).toEqual({ kind: "review", parentSourceSessionId: CODEX_PARENT });

    const plain = join(env.root, "codex-parent-export");
    await exportCommand.run(ctx, [codexParentId], { output: plain });
    const plainDoc = JSON.parse(await Bun.file(join(plain, "session.json")).text()) as {
      subagent: unknown;
    };
    expect(plainDoc.subagent).toBeNull();
  });

  test("a Store carrying subagent evidence stops an older writer", async () => {
    // The read side alone would tolerate the new field; the write side
    // would not, so the constant moved rather than staying additive.
    expect(SESSION_META_SCHEMA_VERSION).toBe(2);
    const meta = await readSessionMeta(project.paths.storeDir, ccParentId);
    expect(meta?.schemaVersion).toBe(2);
    // A CLI that predates subagent evidence supports version 1 and must
    // refuse rather than re-capture the Session without its subagent files.
    expect(() =>
      requireSupportedSchemaVersion("Session metadata", "session.json", meta?.schemaVersion, 1),
    ).toThrow(expect.objectContaining({ code: "STATE_TOO_NEW" }));
  });

  test("a subagent stating neither kind nor parent keeps its relation", async () => {
    await writeCodexSession(env.codexHome, {
      sessionId: "44444444-2222-3333-4444-555555555555",
      cwd: env.worktree,
      userText: "a bare subagent thread",
      agentText: "its answer",
      subagent: { bare: true },
    });
    await importAll();
    const bareId = sessionIdOf({
      harnessId: "codex",
      sourceSessionId: "44444444-2222-3333-4444-555555555555",
    });

    const shown = await showCommand.run(ctx, [bareId], {});
    // Neither kind nor parent is stated, so neither column can carry the
    // fact that the source called this a subagent at all.
    expect(shown.human ?? "").toContain("subagent: subagent of parent unknown");
    expect((shown.json as { session: Record<string, unknown> }).session["subagent"]).toMatchObject({
      isSubagent: true,
      kind: null,
      parentSourceSessionId: null,
    });
  });

  test("the subagent filter reaches inline sidechain records in older transcripts", async () => {
    await writeClaudeSession(env.claudeHome, {
      sessionId: "cc-inline",
      cwd: env.worktree,
      userText: "the human's own request",
      extraLines: [
        {
          type: "user",
          uuid: "inline-u1",
          sessionId: "cc-inline",
          agentId: "legacy-9999",
          isSidechain: true,
          timestamp: "2026-07-15T10:00:30Z",
          message: { role: "user", content: "INLINEPROBE legacy sidechain prompt" },
        },
        {
          type: "user",
          uuid: "inline-u2",
          sessionId: "cc-inline",
          isSidechain: true,
          timestamp: "2026-07-15T10:00:31Z",
          message: { role: "user", content: "INLINEPROBE unnamed sidechain prompt" },
        },
      ],
    });
    await importAll();

    // These records live in the main transcript, so a path-based slice
    // would miss them entirely.
    const only = await searchCommand.run(ctx, ["INLINEPROBE"], { filter: ["subagent"] });
    const json = only.json as {
      totalMatches: number;
      matches: { locator: { sourceFile: string } }[];
    };
    expect(json.totalMatches).toBe(2);
    expect(
      json.matches.every((m) => m.locator.sourceFile === "source/transcript.jsonl"),
    ).toBeTrue();
    // Named and unnamed inline evidence both badge; only the named one has
    // an id to show.
    expect(only.human ?? "").toContain("subagent legacy");
    expect(only.human ?? "").toMatch(/subagent(?! legacy)\s*$/m);
  });

  test("a subagent spawn prompt never becomes the parent's label", async () => {
    const outcome = await listCommand.run(ctx, [], {});
    const sessions = (outcome.json as { sessions: Record<string, unknown>[] }).sessions;
    const parent = sessions.find((s) => s["sessionId"] === ccParentId);
    expect(parent?.["label"]).toBe("the human's own opening request");
  });
});
