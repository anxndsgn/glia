import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { runImport } from "../../src/session/domain/import.ts";
import { sessionIdOf } from "../../src/session/domain/identity.ts";
import { searchCommand } from "../../src/session/commands/search.ts";
import type { CommandRunContext, LoadedProject } from "../../src/core/session-module.ts";
import type { EvidenceLocator } from "../../src/session/projection/query.ts";
import {
  initProject,
  makeTestEnv,
  writeClaudeSession,
  writeCodexSession,
  type TestEnv,
} from "../helpers.ts";

interface SearchJson {
  mode: string;
  totalMatches: number;
  matches: {
    sessionId: string;
    eventSeq: number;
    eventKind: string;
    role: string | null;
    timestamp: string | null;
    excerpt?: string;
    operation?: string;
    sourcePath?: string;
    locator: EvidenceLocator;
  }[];
  parameters: Record<string, unknown>;
}

let env: TestEnv;
let project: LoadedProject;
let ctx: CommandRunContext;

// Relevance fixtures: the strong match goes to the lexically LATER Session
// ID, so ranking must beat (session_id, seq) ordering for it to surface.
const relevanceA = "relevance-aaaa";
const relevanceB = "relevance-bbbb";
const recA = sessionIdOf({ harnessId: "claude-code", sourceSessionId: relevanceA });
const recB = sessionIdOf({ harnessId: "claude-code", sourceSessionId: relevanceB });
const [strongSession, weakSession, strongSessionId, weakSessionId] =
  recA < recB ? [relevanceB, relevanceA, recB, recA] : [relevanceA, relevanceB, recA, recB];

function claudeUserLine(sessionId: string, cwd: string, ts: string, text: unknown): unknown {
  return {
    type: "user",
    uuid: `${sessionId}-${ts}`,
    sessionId,
    cwd,
    timestamp: ts,
    message: { role: "user", content: text },
  };
}

async function run(args: (string | undefined)[], options: Record<string, unknown> = {}) {
  const outcome = await searchCommand.run(ctx, args, options);
  return { human: outcome.human, json: outcome.json as SearchJson };
}

beforeAll(async () => {
  env = await makeTestEnv();
  project = await initProject(env);
  ctx = { project, env: env.env, jsonMode: false, inputDisabled: true };
  const cwd = env.worktree;

  // Chinese prose, identifier fragments, a multi-line tool result, a tool
  // output travelling in a user-role envelope, and a system event.
  await writeClaudeSession(env.claudeHome, {
    sessionId: "search-main",
    cwd,
    extraLines: [
      claudeUserLine("search-main", cwd, "2026-07-15T10:05:00Z", "我们需要重建投影缓存 然后重试"),
      claudeUserLine(
        "search-main",
        cwd,
        "2026-07-15T10:06:00Z",
        "call ensureProjection before reading",
      ),
      {
        type: "user",
        uuid: "search-main-ml",
        sessionId: "search-main",
        cwd,
        timestamp: "2026-07-15T10:07:00Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tml",
              content:
                "Script completed with MULTITOKEN embedded\nWall time 0.1 seconds\n\n" +
                "Output: a very long trailing section that keeps going well past the bounded " +
                "excerpt width so the renderer has to truncate it with an ellipsis somewhere",
            },
          ],
        },
      },
      {
        type: "user",
        uuid: "search-main-env",
        sessionId: "search-main",
        cwd,
        timestamp: "2026-07-15T10:08:00Z",
        message: {
          role: "user",
          content: [
            { type: "tool_result", tool_use_id: "tp", content: "TRANSPORTPROBE finished cleanly" },
          ],
        },
      },
      {
        type: "system",
        uuid: "search-main-sys",
        sessionId: "search-main",
        cwd,
        timestamp: "2026-07-15T10:09:00Z",
        message: { role: "system", content: "SYSPROBE notice from the harness" },
      },
    ],
  });

  // A twin produced by resume: its source records a continuation parent.
  await writeClaudeSession(env.claudeHome, {
    sessionId: "search-child",
    cwd,
    parentSessionId: "search-main",
    userText: "continuation probe CONTTOKEN",
  });

  // Weak match is NEWEST (recency would rank it first); strong match has
  // the higher term frequency (relevance must rank it first).
  await writeClaudeSession(env.claudeHome, {
    sessionId: weakSession,
    cwd,
    extraLines: [
      claudeUserLine(
        weakSession,
        cwd,
        "2026-07-15T12:00:00Z",
        "relevancetoken zz appears once in a long sentence about many other unrelated things",
      ),
    ],
  });
  await writeClaudeSession(env.claudeHome, {
    sessionId: strongSession,
    cwd,
    extraLines: [
      claudeUserLine(
        strongSession,
        cwd,
        "2026-07-15T11:00:00Z",
        "relevancetoken zz relevancetoken relevancetoken",
      ),
    ],
  });

  // A chatty Session for the per-Session cap, plus one quiet neighbor.
  await writeClaudeSession(env.claudeHome, {
    sessionId: "search-chatty",
    cwd,
    extraLines: [1, 2, 3, 4, 5].map((n) =>
      claudeUserLine(
        "search-chatty",
        cwd,
        `2026-07-15T13:00:0${n}Z`,
        n === 5
          ? "captoken repetition number 5 captoken captoken captoken"
          : `captoken repetition number ${n}`,
      ),
    ),
  });
  await writeClaudeSession(env.claudeHome, {
    sessionId: "search-quiet",
    cwd,
    extraLines: [claudeUserLine("search-quiet", cwd, "2026-07-15T14:00:00Z", "captoken once")],
  });
  await writeClaudeSession(env.claudeHome, {
    sessionId: "search-short-cap",
    cwd,
    extraLines: [1, 2, 3, 4].map((n) =>
      claudeUserLine("search-short-cap", cwd, `2026-07-15T15:00:0${n}Z`, `短 match number ${n}`),
    ),
  });

  // Word-boundary fixtures: one standalone occurrence, one embedded-only
  // line (camelCase and underscores), one CJK-bounded occurrence, and the
  // same shapes for a short (scan-path) term.
  await writeClaudeSession(env.claudeHome, {
    sessionId: "search-word",
    cwd,
    extraLines: [
      claudeUserLine(
        "search-word",
        cwd,
        "2026-07-15T16:00:00Z",
        "wbtok stands beside wbtokenized text",
      ),
      claudeUserLine(
        "search-word",
        cwd,
        "2026-07-15T16:01:00Z",
        "sourceWbtokMessages and pre_wbtok_post drift",
      ),
      claudeUserLine("search-word", cwd, "2026-07-15T16:02:00Z", "重建wbtok索引"),
      claudeUserLine("search-word", cwd, "2026-07-15T16:03:00Z", "short qx stands alone"),
      claudeUserLine("search-word", cwd, "2026-07-15T16:04:00Z", "embedded aqxb only"),
    ],
  });

  // Word-mode relevance: the noisy line carries one whole-word occurrence
  // plus many embedded ones (bm25 scores every substring, so it wins the
  // plain ranking); the clean line carries three whole-word occurrences
  // and must outrank it under --word.
  await writeClaudeSession(env.claudeHome, {
    sessionId: "search-word-noise",
    cwd,
    extraLines: [
      claudeUserLine(
        "search-word-noise",
        cwd,
        "2026-07-15T16:05:00Z",
        "wrbase wrbased wrbased wrbased wrbased wrbased wrbased wrbased",
      ),
    ],
  });
  await writeClaudeSession(env.claudeHome, {
    sessionId: "search-word-clean",
    cwd,
    extraLines: [
      claudeUserLine("search-word-clean", cwd, "2026-07-15T16:06:00Z", "wrbase wrbase wrbase"),
    ],
  });

  // Codex: built-in shell attested as "shell", patching as "apply_patch".
  await writeCodexSession(env.codexHome, {
    sessionId: "11111111-2222-3333-4444-555555555555",
    cwd,
    extraLines: [
      {
        timestamp: "2026-07-15T09:10:00Z",
        type: "event_msg",
        payload: { type: "exec_command_begin", command: "bun shellprobe --suite full" },
      },
      {
        timestamp: "2026-07-15T09:10:01Z",
        type: "event_msg",
        payload: { type: "patch_apply_begin", call_id: "p1" },
      },
    ],
  });

  await runImport(project, env.env, { harness: null, dryRun: false, onlyCandidateIds: null });
});
afterAll(async () => {
  await env.cleanup();
});

describe("glia search retrieval", () => {
  test("a two-character Chinese query finds text on the scan path", async () => {
    const { json } = await run(["投影"]);
    expect(json.totalMatches).toBe(1);
    expect(json.matches[0]!.excerpt).toContain("«投影»");
    expect(json.matches[0]!.excerpt).toContain("重建«投影»缓存");
  });

  test("an identifier-fragment query finds camelCase text on the index path", async () => {
    const { json } = await run(["Projection"]);
    expect(json.totalMatches).toBe(1);
    expect(json.matches[0]!.excerpt).toContain("ensure«Projection»");
  });

  test("every term must match as a literal substring (AND)", async () => {
    const both = await run(["ensureProjection reading"]);
    expect(both.json.totalMatches).toBe(1);
    const none = await run(["ensureProjection 投影"]);
    expect(none.json.totalMatches).toBe(0);
  });

  test("a mixed index+short query keeps relevance ranking", async () => {
    const { json } = await run(["relevancetoken zz"], { limit: "1" });
    expect(json.totalMatches).toBe(2);
    expect(json.matches).toHaveLength(1);
    expect(json.matches[0]!.sessionId).toBe(strongSessionId);
  });

  test("an all-short-terms query orders by recency instead", async () => {
    const { json } = await run(["zz"], { limit: "1" });
    expect(json.totalMatches).toBe(2);
    expect(json.matches[0]!.sessionId).toBe(weakSessionId);
  });

  test("relevance in a lexically late Session survives a small --limit", async () => {
    const { human } = await run(["relevancetoken"], { limit: "1" });
    expect(human).toContain(strongSessionId);
    expect(human).not.toContain(weakSessionId);
    expect(human).toContain("1 of 2 matches shown (raise --limit to see more).");
  });
});

describe("glia search output", () => {
  test("a multi-line source match renders as one bounded line", async () => {
    const { json, human } = await run(["MULTITOKEN"]);
    const excerpt = json.matches[0]!.excerpt!;
    expect(excerpt).not.toContain("\n");
    expect(excerpt).toContain("«MULTITOKEN»");
    expect(excerpt).toContain("embedded Wall time 0.1 seconds Output:");
    expect(excerpt.endsWith("…")).toBeTrue();
    expect(excerpt.length).toBeLessThanOrEqual(124);
    // The JSON excerpt is byte-identical to what the human output shows.
    expect(human).toContain(excerpt);
  });

  test("matches group under one Session header with harness and time range", async () => {
    const { human, json } = await run(["captoken"], { perSession: "2" });
    const chattyId = json.matches[0]!.sessionId;
    expect(human.split(chattyId)).toHaveLength(2); // header once, never per line
    expect(human).toContain("claude-code");
    expect(human).toContain("2026-07-15");
    expect(human).toContain("source/transcript.jsonl:line:");
  });

  test("a continuation parent is annotated on the Session header", async () => {
    const { human } = await run(["CONTTOKEN"]);
    expect(human).toContain("(continues search-main)");
  });

  test("speaker labels use the filter vocabulary", async () => {
    const user = await run(["relevancetoken"], { limit: "1" });
    expect(user.human).toMatch(/#\d+\s+user\s/);
    const toolresult = await run(["TRANSPORTPROBE"]);
    expect(toolresult.human).toMatch(/#\d+\s+toolresult\s/);
  });

  test("the per-Session cap keeps other Sessions on the first page", async () => {
    const { human, json } = await run(["captoken"]);
    expect(json.totalMatches).toBe(6);
    expect(json.matches).toHaveLength(4); // 3 capped + 1 quiet
    expect(human).toContain("… 2 more matches in this Session (raise --per-session to see them).");
    expect(human).toContain("«captoken» repetition number 5 «captoken» «captoken» «captoken»");
    expect(human).toContain("«captoken» once");
    expect(human).toContain("4 of 6 matches shown.");
    const raised = await run(["captoken"], { perSession: "5" });
    expect(raised.json.matches).toHaveLength(6);
    expect(raised.human).toContain("6 matches.");
  });

  test("the scan-path per-Session cap keeps the newest matches, then displays source order", async () => {
    const { json } = await run(["短"], { perSession: "3" });
    expect(json.totalMatches).toBe(4);
    expect(json.matches.map((match) => match.excerpt)).toEqual([
      "«短» match number 2",
      "«短» match number 3",
      "«短» match number 4",
    ]);
  });

  test("reaching --limit reports the true total in text and JSON", async () => {
    const { human, json } = await run(["captoken"], { limit: "2", perSession: "5" });
    expect(json.totalMatches).toBe(6);
    expect(json.matches).toHaveLength(2);
    expect(human).toContain("2 of 6 matches shown (raise --limit to see more).");
  });

  test("the JSON document echoes filter, perSession, and carries role/timestamp", async () => {
    const { json } = await run(["relevancetoken"], { filter: ["user"], perSession: "2" });
    expect(json.parameters["filter"]).toEqual(["user"]);
    expect(json.parameters["perSession"]).toBe(2);
    expect(json.matches[0]!.role).toBe("user");
    expect(json.matches[0]!.timestamp).toMatch(/^2026-07-15T/);
  });
});

describe("glia search --word", () => {
  test("--word keeps only word-bounded matches on the index path", async () => {
    const plain = await run(["wbtok"]);
    expect(plain.json.totalMatches).toBe(3);
    const { json } = await run(["wbtok"], { word: true });
    expect(json.totalMatches).toBe(2);
    expect(json.parameters["word"]).toBe(true);
    const excerpts = json.matches.map((m) => m.excerpt!).sort();
    // The excerpt marks only the word-bounded occurrence, and CJK
    // neighbors bound a Latin term.
    expect(excerpts).toEqual(["«wbtok» stands beside wbtokenized text", "重建«wbtok»索引"]);
  });

  test("--word applies to short terms on the scan path", async () => {
    const plain = await run(["qx"]);
    expect(plain.json.totalMatches).toBe(2);
    const { json } = await run(["qx"], { word: true });
    expect(json.totalMatches).toBe(1);
    expect(json.matches[0]!.excerpt).toBe("short «qx» stands alone");
  });

  test("a CJK term keeps substring matching under --word", async () => {
    const { json } = await run(["投影"], { word: true });
    expect(json.totalMatches).toBe(1);
    expect(json.matches[0]!.excerpt).toContain("重建«投影»缓存");
  });

  test("--word relevance ranks by word-bounded occurrences, not raw bm25", async () => {
    // Plain relevance rewards the substring noise --word exists to suppress…
    const plain = await run(["wrbase"], { limit: "1" });
    expect(plain.json.matches[0]!.excerpt).toContain("«wrbase»d");
    // …word mode re-ranks from word-bounded occurrences, so the line with
    // three whole words beats the one whole word among eight embedded hits.
    const { json } = await run(["wrbase"], { word: true, limit: "1" });
    expect(json.totalMatches).toBe(2);
    expect(json.matches[0]!.excerpt).toBe("«wrbase» «wrbase» «wrbase»");
  });

  test("--word without a text query is a USAGE error", async () => {
    await expect(run([], { file: "tests/auth.test.ts", word: true })).rejects.toMatchObject({
      code: "USAGE",
      message: expect.stringContaining("--word requires a text query"),
    });
  });
});

describe("glia search --filter", () => {
  test("speaker slices select only messages with that speaker", async () => {
    const asUser = await run(["TRANSPORTPROBE"], { filter: ["user"] });
    expect(asUser.json.totalMatches).toBe(0); // user-role envelope, but a tool output
    const asAgent = await run(["TRANSPORTPROBE"], { filter: ["agent"] });
    expect(asAgent.json.totalMatches).toBe(0);
    const asToolResult = await run(["TRANSPORTPROBE"], { filter: ["toolresult"] });
    expect(asToolResult.json.totalMatches).toBe(1);
    const userMessages = await run(["relevancetoken"], { filter: ["user"] });
    expect(userMessages.json.totalMatches).toBe(2);
    const agentMessages = await run(["relevancetoken"], { filter: ["agent"] });
    expect(agentMessages.json.totalMatches).toBe(0);
  });

  test("toolcall:<name> matches case-insensitively, any of several attested names", async () => {
    // The event attests both Read and Bash; either name selects it.
    const viaBash = await run(["docs/plan.md"], { filter: ["toolcall:BASH"] });
    expect(viaBash.json.totalMatches).toBeGreaterThan(0);
    const viaRead = await run(["docs/plan.md"], { filter: ["toolcall:read"] });
    expect(viaRead.json.matches).toEqual(viaBash.json.matches);
    expect(viaBash.json.matches.every((m) => m.eventKind === "tool_call")).toBeTrue();
  });

  test("tool names are harness-native with no cross-harness aliasing", async () => {
    const shell = await run(["shellprobe"], { filter: ["toolcall:shell"] });
    expect(shell.json.totalMatches).toBe(1);
    const aliased = await run(["shellprobe"], { filter: ["toolcall:Bash"] });
    expect(aliased.json.totalMatches).toBe(0);
    const patch = await run(["apply_patch"], { filter: ["toolcall:apply_patch"] });
    expect(patch.json.matches.every((m) => m.eventKind === "tool_call")).toBeTrue();
    expect(patch.json.totalMatches).toBe(1);
  });

  test("repeated values union and the union intersects other filters", async () => {
    const union = await run(["relevancetoken"], { filter: ["user", "toolresult"] });
    expect(union.json.totalMatches).toBe(2);
    const intersected = await run(["relevancetoken"], {
      filter: ["user", "toolresult"],
      harness: "codex",
    });
    expect(intersected.json.totalMatches).toBe(0);
    const since = await run(["captoken"], { filter: ["user"], since: "2026-07-15T14:00:00Z" });
    expect(since.json.totalMatches).toBe(1);
  });

  test("raw normalized kinds stay usable as filter values", async () => {
    const system = await run(["SYSPROBE"], { filter: ["system"] });
    expect(system.json.totalMatches).toBe(1);
    const asMessage = await run(["SYSPROBE"], { filter: ["message"] });
    expect(asMessage.json.totalMatches).toBe(0);
  });

  test("--filter cannot run alone and unknown values are USAGE errors", async () => {
    await expect(run([], { filter: ["user"] })).rejects.toMatchObject({ code: "USAGE" });
    await expect(run(["captoken"], { filter: ["speaker"] })).rejects.toMatchObject({
      code: "USAGE",
      message: expect.stringContaining("toolcall:<name>"),
    });
    await expect(run(["captoken"], { filter: ["toolcall:"] })).rejects.toMatchObject({
      code: "USAGE",
    });
    await expect(run(["captoken"], { perSession: "0" })).rejects.toMatchObject({ code: "USAGE" });
  });
});

describe("glia search --file listing", () => {
  test("file-touch output groups, caps, and filters mechanically", async () => {
    const all = await run([undefined], { file: "tests/auth.test.ts" });
    expect(all.json.mode).toBe("file_touches");
    expect(all.json.totalMatches).toBeGreaterThan(0);
    expect(all.json.matches[0]!.sourcePath).toContain("tests/auth.test.ts");

    // The Read touch hangs off a tool_call event; the write off a tool_result.
    const calls = await run([undefined], { file: "tests/auth.test.ts", filter: ["toolcall"] });
    expect(calls.json.matches.every((m) => m.operation === "read")).toBeTrue();
    const results = await run([undefined], { file: "tests/auth.test.ts", filter: ["toolresult"] });
    expect(results.json.matches.every((m) => m.operation === "modified")).toBeTrue();
    expect(calls.json.totalMatches + results.json.totalMatches).toBe(all.json.totalMatches);
  });
});
