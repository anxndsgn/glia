import { expect, test } from "bun:test";
import { rename } from "node:fs/promises";
import { claudeCodeAdapter } from "../../src/session/adapters/claude-code/adapter.ts";
import { codexAdapter } from "../../src/session/adapters/codex/adapter.ts";
import { sessionIdOf } from "../../src/session/domain/identity.ts";
import { runImport } from "../../src/session/domain/import.ts";
import { initProject, makeTestEnv, writeClaudeSession, writeCodexSession } from "../helpers.ts";

test("import refreshes each source without rescanning unrelated Sessions", async () => {
  const env = await makeTestEnv();
  const discover = claudeCodeAdapter.discover;
  try {
    const project = await initProject(env);
    for (let index = 0; index < 4; index++) {
      await writeClaudeSession(env.claudeHome, {
        sessionId: `refresh-${index}`,
        cwd: env.worktree,
      });
    }
    let discoveryCalls = 0;
    let parsedTranscripts = 0;
    claudeCodeAdapter.discover = async function* (context) {
      discoveryCalls += 1;
      for await (const candidate of discover(context)) {
        parsedTranscripts += 1;
        yield candidate;
      }
    };
    const report = await runImport(project, env.env, {
      harness: "claude-code",
      dryRun: false,
      onlyCandidateIds: null,
    });
    expect(report.sourceErrors).toEqual([]);
    expect(report.accepted).toHaveLength(4);
    expect(discoveryCalls).toBe(1);
    expect(parsedTranscripts).toBe(4);
  } finally {
    claudeCodeAdapter.discover = discover;
    await env.cleanup();
  }
});

for (const adapter of [claudeCodeAdapter, codexAdapter]) {
  for (const replaceOriginal of [false, true]) {
    test(`${adapter.harnessId} rediscovers a moved source${replaceOriginal ? " whose old path changed identity" : ""}`, async () => {
      const env = await makeTestEnv();
      const capture = adapter.capture;
      try {
        const project = await initProject(env);
        const sourceSessionId = "11111111-2222-3333-4444-555555555555";
        const spec = { sessionId: sourceSessionId, cwd: env.worktree };
        const path =
          adapter === claudeCodeAdapter
            ? await writeClaudeSession(env.claudeHome, spec)
            : await writeCodexSession(env.codexHome, spec);
        adapter.capture = async (candidate, staging) => {
          const captured = await capture(candidate, staging);
          await rename(path, path.replace(/\.jsonl$/, "-moved.jsonl"));
          if (replaceOriginal) {
            const replacement = { ...spec, sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" };
            const other =
              adapter === claudeCodeAdapter
                ? await writeClaudeSession(env.claudeHome, replacement)
                : await writeCodexSession(env.codexHome, replacement);
            await rename(other, path);
          }
          return captured;
        };
        const report = await runImport(project, env.env, {
          harness: adapter.harnessId,
          dryRun: false,
          onlyCandidateIds: null,
        });
        expect(report.sourceErrors).toEqual([]);
        expect(report.accepted.map((entry) => entry.sessionId)).toEqual([
          sessionIdOf({ harnessId: adapter.harnessId, sourceSessionId }),
        ]);
      } finally {
        adapter.capture = capture;
        await env.cleanup();
      }
    });
  }
}
