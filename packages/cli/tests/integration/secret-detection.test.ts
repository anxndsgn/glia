import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runImport } from "../../src/session/domain/import.ts";
import { readDiscoveryState } from "../../src/session/domain/discovery-state.ts";
import { candidatesCommand } from "../../src/session/commands/candidates.ts";
import {
  listSessionIds,
  readSessionMeta,
  readStoredBundle,
} from "../../src/session/storage/store-layout.ts";
import { readDeclaration, writeDeclaration } from "../../src/core/config/glia-json.ts";
import { loadProject } from "../../src/core/project/load.ts";
import type { CommandRunContext, LoadedProject } from "../../src/core/session-module.ts";
import {
  FAKE_KEY,
  initProject,
  makeTestEnv,
  writeClaudeSession,
  type TestEnv,
} from "../helpers.ts";

let env: TestEnv;
let project: LoadedProject;
beforeEach(async () => {
  env = await makeTestEnv();
  project = await initProject(env);
});
afterEach(async () => {
  await env.cleanup();
});

const importAll = () =>
  runImport(project, env.env, { harness: null, dryRun: false, onlyCandidateIds: null });
const acceptOnly = (candidateId: string) =>
  runImport(project, env.env, {
    harness: null,
    dryRun: false,
    onlyCandidateIds: [candidateId],
    overrideFlagged: true,
  });
const ctx = (): CommandRunContext => ({
  project,
  env: env.env,
  jsonMode: true,
  inputDisabled: true,
});

describe("secret detection at the acceptance boundary", () => {
  test("a seeded credential is flagged, withheld, and blocks no other candidate", async () => {
    await writeClaudeSession(env.claudeHome, { sessionId: "clean-1", cwd: env.worktree });
    await writeClaudeSession(env.claudeHome, {
      sessionId: "leaky-1",
      cwd: env.worktree,
      userText: `here is my key ${FAKE_KEY} please use it`,
    });

    const report = await importAll();
    expect(report.secretDetection.evaluated).toBeTrue();
    expect(report.accepted).toHaveLength(1);
    expect(report.flagged).toHaveLength(1);
    const flagged = report.flagged[0]!;
    const hits = flagged["suspectedSecrets"] as { ruleId: string; preview: string }[];
    expect(hits.map((h) => h.ruleId)).toContain("anthropic-api-key");
    expect(await listSessionIds(project.paths.storeDir)).toHaveLength(1);

    // The full matched value never appears in output or machine-local state.
    expect(JSON.stringify(report)).not.toContain(FAKE_KEY);
    const state = await readDiscoveryState(project.paths.discoveryFile);
    expect(Object.keys(state.evaluations)).toHaveLength(1);
    expect(JSON.stringify(state)).not.toContain(FAKE_KEY);
  });

  test("a credential seeded only in a subagent transcript still gates accept", async () => {
    await writeClaudeSession(env.claudeHome, {
      sessionId: "leaky-sub",
      cwd: env.worktree,
      subagents: [{ agentId: "alpha", spawnPrompt: `use the key ${FAKE_KEY} to authenticate` }],
    });

    const report = await importAll();
    expect(report.accepted).toHaveLength(0);
    expect(report.flagged).toHaveLength(1);
    const hits = report.flagged[0]!["suspectedSecrets"] as { ruleId: string; file: string }[];
    expect(hits.map((h) => h.ruleId)).toContain("anthropic-api-key");
    // The hit addresses the subagent file it was actually found in.
    expect(hits.map((h) => h.file)).toContain("source/subagents/agent-alpha.jsonl");
    expect(JSON.stringify(report)).not.toContain(FAKE_KEY);
  });

  test("session accept takes the exact flagged bytes and sessions the override", async () => {
    const sourcePath = await writeClaudeSession(env.claudeHome, {
      sessionId: "leaky-2",
      cwd: env.worktree,
      userText: `key ${FAKE_KEY}`,
    });
    const first = await importAll();
    const candidateId = String(first.flagged[0]!["candidateId"]);

    const accepted = await acceptOnly(candidateId);
    expect(accepted.accepted).toHaveLength(1);
    expect(accepted.accepted[0]!.flaggedRules).toContain("anthropic-api-key");

    const meta = await readSessionMeta(project.paths.storeDir, candidateId);
    expect(meta).not.toBeNull();
    expect(meta!.secretDetectionOverride).toBeDefined();
    expect(meta!.secretDetectionOverride!.ruleIds).toContain("anthropic-api-key");
    expect(meta!.secretDetectionOverride!.rulesetVersion).toBeGreaterThanOrEqual(1);
    expect(JSON.stringify(meta)).not.toContain(FAKE_KEY);

    // Exact source bytes, unmodified.
    const bundle = await readStoredBundle(project.paths.storeDir, candidateId);
    const storedTranscript = await Bun.file(
      join(bundle.dir, bundle.manifest.files[0]!.path),
    ).text();
    expect(storedTranscript).toBe(await Bun.file(sourcePath).text());

    // The persisted evaluation is cleared once accepted.
    const state = await readDiscoveryState(project.paths.discoveryFile);
    expect(Object.keys(state.evaluations)).toHaveLength(0);
  });

  test("candidates reports not_evaluated before an evaluating import and hits after", async () => {
    await writeClaudeSession(env.claudeHome, {
      sessionId: "leaky-3",
      cwd: env.worktree,
      userText: `key ${FAKE_KEY}`,
    });

    const before = await candidatesCommand.run(ctx(), [], {});
    const beforeJson = before.json as {
      counts: { flagged: number };
      candidates: { secretDetection: { status: string } }[];
    };
    expect(beforeJson.counts.flagged).toBe(0);
    expect(beforeJson.candidates[0]!.secretDetection.status).toBe("not_evaluated");

    await importAll();
    const after = await candidatesCommand.run(ctx(), [], {});
    const afterJson = after.json as {
      counts: { flagged: number };
      candidates: { secretDetection: { status: string } }[];
    };
    expect(afterJson.counts.flagged).toBe(1);
    expect(afterJson.candidates[0]!.secretDetection.status).toBe("flagged");
    expect(JSON.stringify(after.json)).not.toContain(FAKE_KEY);
    expect(after.human).toContain("flagged");
    expect(after.human).toMatch(
      /suspected anthropic-api-key in source\/transcript\.jsonl \(sk-ant-…\[[0-9a-f]{4}\]\) at line \d+/,
    );
    const candidateId = String((afterJson.candidates[0] as Record<string, unknown>)["candidateId"]);
    expect(after.human).toContain(`glia accept ${candidateId}`);
    expect(after.human).not.toContain(FAKE_KEY);
  });

  test("dry-run reports detection as not evaluated and captures nothing", async () => {
    await writeClaudeSession(env.claudeHome, {
      sessionId: "leaky-4",
      cwd: env.worktree,
      userText: `key ${FAKE_KEY}`,
    });
    const report = await runImport(project, env.env, {
      harness: null,
      dryRun: true,
      onlyCandidateIds: null,
    });
    expect(report.secretDetection.evaluated).toBeFalse();
    expect(report.flagged).toHaveLength(0);
    expect(report.wouldAccept).toHaveLength(1);
    const state = await readDiscoveryState(project.paths.discoveryFile);
    expect(Object.keys(state.evaluations)).toHaveLength(0);
  });

  test("changed source bytes are re-evaluated and rebind the evaluation digest", async () => {
    const path = await writeClaudeSession(env.claudeHome, {
      sessionId: "leaky-5",
      cwd: env.worktree,
      userText: `key ${FAKE_KEY}`,
    });
    await importAll();
    const first = (await readDiscoveryState(project.paths.discoveryFile)).evaluations;
    const candidateId = Object.keys(first)[0]!;

    await Bun.write(
      path,
      (await Bun.file(path).text()) +
        JSON.stringify({
          type: "user",
          sessionId: "leaky-5",
          cwd: env.worktree,
          message: { role: "user", content: "appended after the flag" },
        }) +
        "\n",
    );
    const second = await importAll();
    expect(second.flagged).toHaveLength(1);
    const after = (await readDiscoveryState(project.paths.discoveryFile)).evaluations;
    expect(after[candidateId]!.bundleDigest).not.toBe(first[candidateId]!.bundleDigest);
  });

  test("a newer flagged revision leaves the accepted Current Revision untouched", async () => {
    const path = await writeClaudeSession(env.claudeHome, {
      sessionId: "grows-1",
      cwd: env.worktree,
    });
    const clean = await importAll();
    expect(clean.accepted).toHaveLength(1);
    const sessionId = clean.accepted[0]!.sessionId;
    const acceptedDigest = clean.accepted[0]!.revision;

    await Bun.write(
      path,
      (await Bun.file(path).text()) +
        JSON.stringify({
          type: "user",
          sessionId: "grows-1",
          cwd: env.worktree,
          message: { role: "user", content: `oops ${FAKE_KEY}` },
        }) +
        "\n",
    );
    const report = await importAll();
    expect(report.accepted).toHaveLength(0);
    expect(report.flagged).toHaveLength(1);
    const meta = await readSessionMeta(project.paths.storeDir, sessionId);
    expect(meta!.currentRevision.digest).toBe(acceptedDigest);
  });

  test("disabling detection in the declaration restores unconditional acceptance", async () => {
    const declaration = await readDeclaration(env.worktree);
    declaration!.secretDetection = { enabled: false };
    await writeDeclaration(env.worktree, declaration!);
    project = await loadProject(env.worktree, env.home);

    await writeClaudeSession(env.claudeHome, {
      sessionId: "leaky-6",
      cwd: env.worktree,
      userText: `key ${FAKE_KEY}`,
    });
    const report = await importAll();
    expect(report.secretDetection.enabled).toBeFalse();
    expect(report.accepted).toHaveLength(1);
    expect(report.flagged).toHaveLength(0);
  });

  test("a flagged candidate whose next capture is clean auto-accepts and clears the evaluation", async () => {
    const path = await writeClaudeSession(env.claudeHome, {
      sessionId: "leaky-7",
      cwd: env.worktree,
      userText: `key ${FAKE_KEY}`,
    });
    await importAll();
    expect(
      Object.keys((await readDiscoveryState(project.paths.discoveryFile)).evaluations),
    ).toHaveLength(1);

    await writeClaudeSession(env.claudeHome, {
      sessionId: "leaky-7",
      cwd: env.worktree,
      userText: "the credential was removed from this rewrite",
    });
    void path;
    const report = await importAll();
    expect(report.accepted).toHaveLength(1);
    expect(report.flagged).toHaveLength(0);
    expect(
      Object.keys((await readDiscoveryState(project.paths.discoveryFile)).evaluations),
    ).toHaveLength(0);
  });
});
