import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { claudeCodeAdapter } from "../../src/session/adapters/claude-code/adapter.ts";
import { codexAdapter } from "../../src/session/adapters/codex/adapter.ts";
import type { NormalizedEvent, SessionCandidate } from "../../src/session/adapters/types.ts";
import { manifestOf } from "../../src/session/storage/bundle.ts";
import {
  FAKE_KEY,
  makeTestEnv,
  writeClaudeSession,
  writeCodexSession,
  type TestEnv,
} from "../helpers.ts";

let env: TestEnv;
beforeEach(async () => {
  env = await makeTestEnv();
});
afterEach(async () => {
  await env.cleanup();
});

async function discoverAll(adapter: typeof claudeCodeAdapter): Promise<SessionCandidate[]> {
  const out: SessionCandidate[] = [];
  for await (const c of adapter.discover({ env: env.env })) out.push(c);
  return out;
}

async function projectAll(
  adapter: typeof claudeCodeAdapter,
  candidate: SessionCandidate,
): Promise<NormalizedEvent[]> {
  const staging = { dir: join(env.root, "staging", candidate.candidateId) };
  const captured = await adapter.capture(candidate, staging);
  const bundle = {
    sessionId: candidate.candidateId,
    dir: staging.dir,
    manifest: manifestOf(captured),
  };
  const events: NormalizedEvent[] = [];
  for await (const e of adapter.project(bundle)) events.push(e);
  return events;
}

describe("claude-code adapter", () => {
  test("discovers session id and opening path from source events", async () => {
    await writeClaudeSession(env.claudeHome, { sessionId: "aaaa-1", cwd: env.worktree });
    const candidates = await discoverAll(claudeCodeAdapter);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.identity.sourceSessionId).toBe("aaaa-1");
    expect(candidates[0]?.openingPath).toBe(env.worktree);
  });

  test("preserves fork parentage as continuation metadata", async () => {
    await writeClaudeSession(env.claudeHome, {
      sessionId: "bbbb-2",
      cwd: env.worktree,
      parentSessionId: "aaaa-1",
    });
    const candidates = await discoverAll(claudeCodeAdapter);
    expect(candidates[0]?.continuation).toEqual({ parentSessionId: "aaaa-1" });
  });

  test("projects events with evidence locators, and file touches only from objective events", async () => {
    await writeClaudeSession(env.claudeHome, { sessionId: "cccc-3", cwd: env.worktree });
    const candidates = await discoverAll(claudeCodeAdapter);
    const events = await projectAll(claudeCodeAdapter, candidates[0]!);
    expect(events.map((e) => e.kind)).toEqual(["message", "tool_call", "tool_result"]);
    expect(events.every((e) => e.sourceCursor.startsWith("line:"))).toBeTrue();

    const touches = events.flatMap((e) => e.fileTouches);
    // One Read + one update result; the prose mention of docs/plan.md and
    // the ambiguous Bash command must not be promoted to touches.
    expect(touches).toHaveLength(2);
    expect(touches.map((t) => t.operation).sort()).toEqual(["modified", "read"]);
    expect(touches.some((t) => t.sourcePath.includes("ambiguous"))).toBeFalse();
    expect(events.flatMap((e) => e.text ?? "").join(" ")).toContain("docs/plan.md");
  });

  test("labels a session with its first user message when no title exists", async () => {
    await writeClaudeSession(env.claudeHome, { sessionId: "eeee-5", cwd: env.worktree });
    const candidates = await discoverAll(claudeCodeAdapter);
    expect(candidates[0]?.label).toBe("please fix the flaky auth token test");
  });

  test("a harness-provided title outranks the first user message", async () => {
    const path = await writeClaudeSession(env.claudeHome, {
      sessionId: "ffff-6",
      cwd: env.worktree,
    });
    await Bun.write(
      path,
      (await Bun.file(path).text()) +
        JSON.stringify({ type: "custom-title", customTitle: "fix auth", sessionId: "ffff-6" }) +
        "\n",
    );
    const candidates = await discoverAll(claudeCodeAdapter);
    expect(candidates[0]?.label).toBe("fix auth");
  });

  test("a label never carries a format-self-evident credential", async () => {
    await writeClaudeSession(env.claudeHome, {
      sessionId: "gggg-7",
      cwd: env.worktree,
      userText: `use my key ${FAKE_KEY} for the test`,
    });
    const candidates = await discoverAll(claudeCodeAdapter);
    expect(candidates[0]?.label).not.toContain(FAKE_KEY);
    expect(candidates[0]?.label).toContain("sk-ant-…");
  });

  test("keeps unparseable lines locatable as unknown events", async () => {
    const path = await writeClaudeSession(env.claudeHome, {
      sessionId: "dddd-4",
      cwd: env.worktree,
    });
    await Bun.write(path, (await Bun.file(path).text()) + "this is not json\n");
    const candidates = await discoverAll(claudeCodeAdapter);
    const events = await projectAll(claudeCodeAdapter, candidates[0]!);
    const last = events[events.length - 1]!;
    expect(last.kind).toBe("unknown");
    expect(last.sourceCursor).toBe("line:4");
  });

  test("captures sibling subagent transcripts into the parent's bundle, sorted", async () => {
    await writeClaudeSession(env.claudeHome, {
      sessionId: "subs-1",
      cwd: env.worktree,
      subagents: [{ agentId: "zeta" }, { agentId: "alpha" }],
    });
    const candidates = await discoverAll(claudeCodeAdapter);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.sourceFiles.map((f) => f.bundlePath)).toEqual([
      "source/transcript.jsonl",
      "source/subagents/agent-alpha.jsonl",
      "source/subagents/agent-zeta.jsonl",
    ]);
  });

  test("keys the subagent directory on the file stem, not the event session id", async () => {
    // The transcript's events name a different sessionId than the file
    // stem; the sibling directory Claude Code writes is stem-keyed.
    await writeClaudeSession(env.claudeHome, {
      sessionId: "stem-1",
      cwd: env.worktree,
      subagents: [{ agentId: "alpha" }],
    });
    const dir = join(env.claudeHome, "projects", env.worktree.replaceAll("/", "-"));
    const transcript = join(dir, "stem-1.jsonl");
    const rewritten = (await Bun.file(transcript).text()).replaceAll(
      `"sessionId":"stem-1"`,
      `"sessionId":"renamed-in-events"`,
    );
    await Bun.write(transcript, rewritten);

    const candidates = await discoverAll(claudeCodeAdapter);
    expect(candidates[0]?.identity.sourceSessionId).toBe("renamed-in-events");
    expect(candidates[0]?.sourceFiles.map((f) => f.bundlePath)).toContain(
      "source/subagents/agent-alpha.jsonl",
    );
  });

  test("a session with no subagent directory is unchanged", async () => {
    await writeClaudeSession(env.claudeHome, { sessionId: "plain-1", cwd: env.worktree });
    const candidates = await discoverAll(claudeCodeAdapter);
    expect(candidates[0]?.sourceFiles).toHaveLength(1);
    const events = await projectAll(claudeCodeAdapter, candidates[0]!);
    expect(events.every((e) => e.sourceFile === "source/transcript.jsonl")).toBeTrue();
  });

  test("projects subagent evidence after the main transcript, marked and attributed", async () => {
    await writeClaudeSession(env.claudeHome, {
      sessionId: "subs-2",
      cwd: env.worktree,
      subagents: [
        {
          agentId: "alpha",
          lines: [
            {
              type: "assistant",
              uuid: "alpha-a1",
              sessionId: "subs-2",
              agentId: "alpha",
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
    const candidates = await discoverAll(claudeCodeAdapter);
    const events = await projectAll(claudeCodeAdapter, candidates[0]!);

    const main = events.filter((e) => e.sourceFile === "source/transcript.jsonl");
    const sub = events.filter((e) => e.sourceFile === "source/subagents/agent-alpha.jsonl");
    expect(main).toHaveLength(3);
    expect(sub).toHaveLength(2);
    // Parent evidence precedes the subagent evidence it spawned.
    expect(events.indexOf(sub[0]!)).toBeGreaterThan(events.indexOf(main[main.length - 1]!));

    expect(sub.every((e) => e.payload?.["subagentId"] === "alpha")).toBeTrue();
    // The spawn prompt is the parent harness speaking through the user channel.
    expect(sub[0]?.role).toBe("user");
    expect(sub[0]?.payload?.["harnessInjected"]).toBeTrue();
    // Subagent tool traffic is real, searchable evidence.
    expect(sub[1]?.kind).toBe("tool_call");
    expect(sub[1]?.fileTouches.map((t) => t.sourcePath)).toEqual([`${env.worktree}/src/retry.ts`]);
    expect(sub[1]?.sourceCursor).toBe("line:2");
  });

  test("a subagent spawn prompt never becomes the session label", async () => {
    await writeClaudeSession(env.claudeHome, {
      sessionId: "subs-3",
      cwd: env.worktree,
      userText: "the human's opening request",
      subagents: [{ agentId: "alpha", spawnPrompt: "harness-authored spawn instructions" }],
    });
    const candidates = await discoverAll(claudeCodeAdapter);
    const events = await projectAll(claudeCodeAdapter, candidates[0]!);
    const labelable = events.filter(
      (e) => e.kind === "message" && e.role === "user" && e.payload?.["harnessInjected"] !== true,
    );
    expect(labelable.map((e) => e.text)).toEqual(["the human's opening request"]);
  });

  test("marks a legacy inline sidechain line in the main transcript", async () => {
    await writeClaudeSession(env.claudeHome, {
      sessionId: "subs-4",
      cwd: env.worktree,
      extraLines: [
        {
          type: "user",
          uuid: "legacy-u1",
          sessionId: "subs-4",
          agentId: "legacy-agent",
          isSidechain: true,
          timestamp: "2026-07-15T10:00:30Z",
          message: { role: "user", content: "inline sidechain prompt" },
        },
      ],
    });
    const candidates = await discoverAll(claudeCodeAdapter);
    const events = await projectAll(claudeCodeAdapter, candidates[0]!);
    const inline = events[events.length - 1]!;
    expect(inline.sourceFile).toBe("source/transcript.jsonl");
    expect(inline.payload?.["harnessInjected"]).toBeTrue();
    expect(inline.payload?.["subagentId"]).toBe("legacy-agent");
  });
});

describe("codex adapter", () => {
  test("reads session id and opening path from session_meta", async () => {
    await writeCodexSession(env.codexHome, {
      sessionId: "11111111-2222-3333-4444-555555555555",
      cwd: env.worktree,
    });
    const candidates = await discoverAll(codexAdapter);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.identity.sourceSessionId).toBe("11111111-2222-3333-4444-555555555555");
    expect(candidates[0]?.openingPath).toBe(env.worktree);
  });

  test("preserves resumed_from as continuation metadata", async () => {
    await writeCodexSession(env.codexHome, {
      sessionId: "22222222-2222-3333-4444-555555555555",
      cwd: env.worktree,
      resumedFrom: "11111111-2222-3333-4444-555555555555",
    });
    const candidates = await discoverAll(codexAdapter);
    expect(candidates[0]?.continuation).toEqual({
      parentSessionId: "11111111-2222-3333-4444-555555555555",
    });
  });

  test("labels a session with its earliest user message", async () => {
    await writeCodexSession(env.codexHome, {
      sessionId: "44444444-2222-3333-4444-555555555555",
      cwd: env.worktree,
    });
    const candidates = await discoverAll(codexAdapter);
    expect(candidates[0]?.label).toBe("add retry logic to the sync loop");
  });

  test("excludes unmirrored modern harness context from the session label", async () => {
    await writeCodexSession(env.codexHome, {
      sessionId: "55555555-2222-3333-4444-555555555555",
      cwd: env.worktree,
      mirrorUserMessage: true,
      preambleLines: [
        {
          timestamp: "2026-07-15T09:00:02Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "# AGENTS.md instructions for /workspace\n\n<INSTRUCTIONS>...</INSTRUCTIONS>",
              },
            ],
          },
        },
        {
          timestamp: "2026-07-15T09:00:02Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              {
                type: "input_text",
                text: "<recommended_plugins>module context</recommended_plugins>",
              },
            ],
          },
        },
      ],
    });

    const candidates = await discoverAll(codexAdapter);
    expect(candidates[0]?.label).toBe("add retry logic to the sync loop");

    const events = await projectAll(codexAdapter, candidates[0]!);
    const userEvents = events.filter((event) => event.role === "user");
    expect(userEvents.map((event) => event.payload?.["harnessInjected"] === true)).toEqual([
      true,
      true,
      false,
      false,
    ]);
  });

  test("keeps the tagged-preamble fallback for legacy response-item-only rollouts", async () => {
    await writeCodexSession(env.codexHome, {
      sessionId: "66666666-2222-3333-4444-555555555555",
      cwd: env.worktree,
      preambleLines: [
        {
          timestamp: "2026-07-15T09:00:01Z",
          type: "response_item",
          payload: {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "<environment_context>...</environment_context>" },
            ],
          },
        },
      ],
    });

    const candidates = await discoverAll(codexAdapter);
    expect(candidates[0]?.label).toBe("add retry logic to the sync loop");

    const events = await projectAll(codexAdapter, candidates[0]!);
    const userEvents = events.filter((event) => event.role === "user");
    expect(userEvents.map((event) => event.payload?.["harnessInjected"] === true)).toEqual([
      true,
      false,
    ]);
  });

  test("does not label a subagent session with harness-authored instructions", async () => {
    await writeCodexSession(env.codexHome, {
      sessionId: "77777777-2222-3333-4444-555555555555",
      cwd: env.worktree,
      mirrorUserMessage: true,
      subagent: true,
    });

    const candidates = await discoverAll(codexAdapter);
    expect(candidates[0]?.label).toBeNull();

    const events = await projectAll(codexAdapter, candidates[0]!);
    const userEvents = events.filter((event) => event.role === "user");
    expect(userEvents).toHaveLength(2);
    expect(userEvents.every((event) => event.payload?.["harnessInjected"] === true)).toBeTrue();
  });

  test("reads subagent kind and parent thread id from every observed source shape", async () => {
    await writeCodexSession(env.codexHome, {
      sessionId: "aaaaaaa1-2222-3333-4444-555555555555",
      cwd: env.worktree,
      subagent: { kind: "review", parentThreadId: "parent-thread-1" },
    });
    await writeCodexSession(env.codexHome, {
      sessionId: "aaaaaaa2-2222-3333-4444-555555555555",
      cwd: env.worktree,
      subagent: { kind: "guardian", parentThreadId: "parent-thread-2", nestedKind: true },
    });
    // The legacy shape: flagged a subagent, but stating no parent.
    await writeCodexSession(env.codexHome, {
      sessionId: "aaaaaaa3-2222-3333-4444-555555555555",
      cwd: env.worktree,
      subagent: true,
    });
    await writeCodexSession(env.codexHome, {
      sessionId: "aaaaaaa4-2222-3333-4444-555555555555",
      cwd: env.worktree,
    });

    const bySourceId = new Map(
      (await discoverAll(codexAdapter)).map((c) => [c.identity.sourceSessionId, c]),
    );
    expect(bySourceId.get("aaaaaaa1-2222-3333-4444-555555555555")?.subagent).toEqual({
      kind: "review",
      parentSourceSessionId: "parent-thread-1",
    });
    expect(bySourceId.get("aaaaaaa2-2222-3333-4444-555555555555")?.subagent).toEqual({
      kind: "guardian",
      parentSourceSessionId: "parent-thread-2",
    });
    // No parent is ever inferred for a rollout that states none.
    expect(bySourceId.get("aaaaaaa3-2222-3333-4444-555555555555")?.subagent).toEqual({
      kind: "guardian",
      parentSourceSessionId: null,
    });
    expect(bySourceId.get("aaaaaaa4-2222-3333-4444-555555555555")?.subagent).toBeNull();
  });

  test("a subagent relation is never read as continuation", async () => {
    await writeCodexSession(env.codexHome, {
      sessionId: "aaaaaaa5-2222-3333-4444-555555555555",
      cwd: env.worktree,
      subagent: { kind: "review", parentThreadId: "parent-thread-1" },
    });
    const candidates = await discoverAll(codexAdapter);
    expect(candidates[0]?.continuation).toBeNull();
  });

  test("projects patch changes as file touches and keeps unknown kinds locatable", async () => {
    await writeCodexSession(env.codexHome, {
      sessionId: "33333333-2222-3333-4444-555555555555",
      cwd: env.worktree,
    });
    const candidates = await discoverAll(codexAdapter);
    const events = await projectAll(codexAdapter, candidates[0]!);
    expect(events.map((e) => e.kind)).toEqual([
      "lifecycle",
      "message",
      "message",
      "tool_result",
      "message",
      "unknown",
    ]);
    const touches = events.flatMap((e) => e.fileTouches);
    expect(touches.map((t) => `${t.operation}:${t.sourcePath}`).sort()).toEqual([
      "created:src/retry.ts",
      "modified:src/sync.ts",
    ]);
  });

  test("missing cwd yields a candidate with no opening path", async () => {
    await writeCodexSession(env.codexHome, {
      sessionId: "44444444-2222-3333-4444-555555555555",
      cwd: null,
    });
    const candidates = await discoverAll(codexAdapter);
    expect(candidates[0]?.openingPath).toBeNull();
  });
});
