import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { runImport } from "../../src/session/domain/import.ts";
import { discoverCandidates } from "../../src/session/domain/discover.ts";
import {
  listSessionIds,
  readSessionMeta,
  readStoredBundle,
} from "../../src/session/storage/store-layout.ts";
import { ProjectStore } from "../../src/core/store/store.ts";
import { WriterLease } from "../../src/core/store/lease.ts";
import { GliaError } from "../../src/core/output/errors.ts";
import type { LoadedProject } from "../../src/core/session-module.ts";
import { claudeCodeAdapter } from "../../src/session/adapters/claude-code/adapter.ts";
import { sessionIdOf } from "../../src/session/domain/identity.ts";
import {
  initProject,
  makeSecondWorktree,
  makeTestEnv,
  writeClaudeSession,
  writeClaudeSubagent,
  writeCodexSession,
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

describe("glia import", () => {
  test("accepts current-project sessions from both harnesses in one commit", async () => {
    await writeClaudeSession(env.claudeHome, { sessionId: "aaaa-1", cwd: env.worktree });
    await writeCodexSession(env.codexHome, {
      sessionId: "11111111-2222-3333-4444-555555555555",
      cwd: env.worktree,
    });

    const report = await importAll();
    expect(report.accepted).toHaveLength(2);
    expect(report.storeCommit).not.toBeNull();
    expect(report.projectionFresh).toBeTrue();
    expect(await listSessionIds(project.paths.storeDir)).toHaveLength(2);
  });

  test("repeat import is a byte-identical no-op", async () => {
    await writeClaudeSession(env.claudeHome, { sessionId: "aaaa-1", cwd: env.worktree });
    const first = await importAll();
    const head = first.storeCommit;
    const again = await importAll();
    expect(again.accepted).toHaveLength(0);
    expect(again.unchanged).toBe(1);
    expect(again.storeCommit).toBe(head);
  });

  test("append, rewrite, and truncation each advance the same session to a new revision", async () => {
    const path = await writeClaudeSession(env.claudeHome, {
      sessionId: "aaaa-1",
      cwd: env.worktree,
    });
    const r1 = await importAll();
    const sessionId = r1.accepted[0]!.sessionId;
    const revisions = [r1.accepted[0]!.revision];

    const original = await Bun.file(path).text();
    await Bun.write(
      path,
      original +
        JSON.stringify({
          type: "user",
          sessionId: "aaaa-1",
          cwd: env.worktree,
          message: { role: "user", content: "appended" },
        }) +
        "\n",
    );
    const r2 = await importAll();
    expect(r2.accepted[0]!.sessionId).toBe(sessionId);
    revisions.push(r2.accepted[0]!.revision);

    // Truncation back to a prefix that still carries the opening path.
    const firstLineOnly = original.split("\n")[0]! + "\n";
    await Bun.write(path, firstLineOnly);
    const r3 = await importAll();
    expect(r3.accepted[0]!.sessionId).toBe(sessionId);
    revisions.push(r3.accepted[0]!.revision);

    await Bun.write(
      path,
      JSON.stringify({
        type: "user",
        sessionId: "aaaa-1",
        cwd: env.worktree,
        message: { role: "user", content: "rewritten" },
      }) + "\n",
    );
    const r4 = await importAll();
    expect(r4.accepted[0]!.sessionId).toBe(sessionId);
    revisions.push(r4.accepted[0]!.revision);

    expect(new Set(revisions).size).toBe(4);
    expect(await listSessionIds(project.paths.storeDir)).toEqual([sessionId]);
  });

  test("a subagent transcript appearing after accept advances the same session", async () => {
    const spec = { sessionId: "aaaa-1", cwd: env.worktree };
    await writeClaudeSession(env.claudeHome, spec);
    const first = await importAll();
    const sessionId = first.accepted[0]!.sessionId;

    // The subagent transcript Claude Code writes once the parent spawns one.
    const projectDir = join(env.claudeHome, "projects", env.worktree.replaceAll("/", "-"));
    await writeClaudeSubagent(projectDir, spec, { agentId: "alpha" });

    const again = await importAll();
    expect(again.accepted).toHaveLength(1);
    expect(again.accepted[0]!.sessionId).toBe(sessionId);
    // A new Revision of the same Session, not a second Session.
    expect(again.accepted[0]!.revision).not.toBe(first.accepted[0]!.revision);
    expect(await listSessionIds(project.paths.storeDir)).toEqual([sessionId]);

    const bundle = await readStoredBundle(project.paths.storeDir, sessionId);
    expect(bundle.manifest.files.map((f) => f.path)).toEqual([
      "source/subagents/agent-alpha.jsonl",
      "source/transcript.jsonl",
    ]);
  });

  test("source disappearance never deletes or archives the session", async () => {
    const path = await writeClaudeSession(env.claudeHome, {
      sessionId: "aaaa-1",
      cwd: env.worktree,
    });
    const first = await importAll();
    const sessionId = first.accepted[0]!.sessionId;
    await rm(path);
    const again = await importAll();
    expect(again.accepted).toHaveLength(0);
    expect(await readSessionMeta(project.paths.storeDir, sessionId)).not.toBeNull();
  });

  test("association uses only the opening path; out-of-scope sessions are skipped without input", async () => {
    const elsewhere = await makeSecondWorktree(env, "unrelated");
    await writeClaudeSession(env.claudeHome, {
      sessionId: "outside-1",
      cwd: elsewhere,
      // The session edits a file inside our project, which must not matter.
      writtenFilePath: `${env.worktree}/src/index.ts`,
    });
    const report = await importAll();
    expect(report.accepted).toHaveLength(0);
    expect(report.outOfScope).toBe(1);
    expect(report.pending).toHaveLength(0);
  });

  test("sessions with no resolvable opening path stay pending and never block the import", async () => {
    await writeClaudeSession(env.claudeHome, { sessionId: "good-1", cwd: env.worktree });
    await writeCodexSession(env.codexHome, {
      sessionId: "99999999-2222-3333-4444-555555555555",
      cwd: null,
    });
    const report = await importAll();
    expect(report.accepted).toHaveLength(1);
    expect(report.pending).toHaveLength(1);
    // Accepted work is committed even though a pending candidate remains.
    expect(report.storeCommit).not.toBeNull();
  });

  test("dry-run classifies without staging, committing, or taking the writer lease", async () => {
    await writeClaudeSession(env.claudeHome, { sessionId: "aaaa-1", cwd: env.worktree });
    const store = new ProjectStore(project.paths.storeDir);
    const headBefore = await store.head();

    // Hold the lease for the whole dry run: if the dry run needed it, it would fail.
    const lease = await WriterLease.acquire(project.paths.writerLockFile, 1_000);
    try {
      const report = await runImport(
        project,
        { ...env.env, GLIA_LEASE_TIMEOUT_MS: "50" },
        { harness: null, dryRun: true, onlyCandidateIds: null },
      );
      expect(report.wouldAccept).toHaveLength(1);
      expect(report.accepted).toHaveLength(0);
    } finally {
      lease.release();
    }
    expect(await store.head()).toBe(headBefore);
    expect(await listSessionIds(project.paths.storeDir)).toHaveLength(0);
    await expect(readdir(project.paths.stagingRoot)).rejects.toThrow();
  });

  test("candidate ids are stable across discovery runs", async () => {
    await writeClaudeSession(env.claudeHome, { sessionId: "aaaa-1", cwd: env.worktree });
    const first = await discoverCandidates(project, env.env, null);
    const second = await discoverCandidates(project, env.env, null);
    expect(first.candidates[0]!.candidate.candidateId).toBe(
      second.candidates[0]!.candidate.candidateId,
    );
  });

  test("a concurrent writer produces PROJECT_BUSY within the bounded wait", async () => {
    await writeClaudeSession(env.claudeHome, { sessionId: "aaaa-1", cwd: env.worktree });
    const lease = await WriterLease.acquire(project.paths.writerLockFile, 1_000);
    try {
      const busyEnv = { ...env.env, GLIA_LEASE_TIMEOUT_MS: "80" };
      await expect(
        runImport(project, busyEnv, { harness: null, dryRun: false, onlyCandidateIds: null }),
      ).rejects.toThrow(expect.objectContaining({ code: "PROJECT_BUSY" }) as Error);
    } finally {
      lease.release();
    }
  });

  test("a recaptured Candidate projection failure is contained and later Candidates continue", async () => {
    const failingPath = await writeClaudeSession(env.claudeHome, {
      sessionId: "aaaa-failing",
      cwd: env.worktree,
    });
    await writeClaudeSession(env.claudeHome, {
      sessionId: "bbbb-good",
      cwd: env.worktree,
    });
    const failingSessionId = sessionIdOf({
      harnessId: "claude-code",
      sourceSessionId: "aaaa-failing",
    });
    const originalProject = claudeCodeAdapter.project;
    let initialAnalyses = 0;
    let failRecapturedProjection = false;
    claudeCodeAdapter.project = async function* (bundle) {
      if (failRecapturedProjection && bundle.sessionId === failingSessionId) {
        throw new Error("synthetic recaptured projection failure");
      }
      initialAnalyses += 1;
      yield* originalProject.call(claudeCodeAdapter, bundle);
    };

    const lease = await WriterLease.acquire(project.paths.writerLockFile, 1_000);
    let leaseHeld = true;
    try {
      const importing = importAll();
      while (initialAnalyses < 2) await Bun.sleep(10);
      await Bun.write(
        failingPath,
        (await Bun.file(failingPath).text()) +
          JSON.stringify({
            type: "user",
            uuid: "changed-under-capture",
            sessionId: "aaaa-failing",
            cwd: env.worktree,
            timestamp: "2026-07-15T12:00:00Z",
            message: { role: "user", content: "changed under capture" },
          }) +
          "\n",
      );
      failRecapturedProjection = true;
      lease.release();
      leaseHeld = false;

      const report = await importing;
      expect(report.sourceErrors).toEqual([
        {
          candidateId: failingSessionId,
          message: "Error: synthetic recaptured projection failure",
        },
      ]);
      expect(report.accepted).toHaveLength(1);
      expect(report.accepted[0]!.sourceSessionId).toBe("bbbb-good");
    } finally {
      claudeCodeAdapter.project = originalProject;
      if (leaseHeld) lease.release();
    }
  });

  test("a resumed session with a new source id becomes a distinct session with traceable continuation", async () => {
    await writeCodexSession(env.codexHome, {
      sessionId: "11111111-2222-3333-4444-555555555555",
      cwd: env.worktree,
    });
    await writeCodexSession(env.codexHome, {
      sessionId: "22222222-2222-3333-4444-555555555555",
      cwd: env.worktree,
      resumedFrom: "11111111-2222-3333-4444-555555555555",
    });
    const report = await importAll();
    expect(report.accepted).toHaveLength(2);
    const ids = await listSessionIds(project.paths.storeDir);
    expect(ids).toHaveLength(2);
    const metas = await Promise.all(ids.map((id) => readSessionMeta(project.paths.storeDir, id)));
    const child = metas.find((m) => m?.continuation !== null);
    expect(child?.continuation?.parentSessionId).toBe("11111111-2222-3333-4444-555555555555");
  });

  test("crashed-operation residue is recovered in its own commit, never absorbed by the import commit", async () => {
    await writeClaudeSession(env.claudeHome, { sessionId: "aaaa-1", cwd: env.worktree });
    // Simulate a crashed earlier operation: stray bytes in the Store worktree.
    const residuePath = `${project.paths.storeDir}/session/sessions/ses_orphan/bundle/partial.jsonl`;
    await Bun.write(residuePath, "half-written residue\n");

    const report = await importAll();
    expect(report.accepted).toHaveLength(1);
    expect(report.recoveryCommit).not.toBeNull();
    expect(report.storeCommit).not.toBe(report.recoveryCommit);

    const { gitOrThrow } = await import("../../src/core/store/git.ts");
    const recoveryShow = await gitOrThrow(
      ["show", "--name-only", "--format=%s", report.recoveryCommit!],
      project.paths.storeDir,
    );
    expect(recoveryShow).toContain("glia: recover uncommitted working-tree residue");
    expect(recoveryShow).toContain("session/sessions/ses_orphan/bundle/partial.jsonl");

    const importShow = await gitOrThrow(
      ["show", "--name-only", "--format=%s", report.storeCommit!],
      project.paths.storeDir,
    );
    expect(importShow).not.toContain("ses_orphan");
    // The residue bytes stay traceable, not discarded.
    expect(await Bun.file(residuePath).text()).toBe("half-written residue\n");
  });

  test("a clean store worktree needs no recovery commit", async () => {
    await writeClaudeSession(env.claudeHome, { sessionId: "aaaa-1", cwd: env.worktree });
    const report = await importAll();
    expect(report.recoveryCommit).toBeNull();
  });

  test("adapter failure is isolated and reported as a partial result", async () => {
    await writeClaudeSession(env.claudeHome, { sessionId: "aaaa-1", cwd: env.worktree });
    // A file where the codex sessions directory should be poisons that adapter.
    await Bun.write(`${env.codexHome}/sessions`, "not a directory");
    const report = await importAll();
    expect(report.accepted).toHaveLength(1);
  });
});

describe("glia accept", () => {
  test("explicit association accepts a pending candidate and records the mode", async () => {
    await writeCodexSession(env.codexHome, {
      sessionId: "99999999-2222-3333-4444-555555555555",
      cwd: null,
    });
    const before = await importAll();
    expect(before.pending).toHaveLength(1);
    const candidateId = before.pending[0]!["candidateId"] as string;

    const { acceptCommand } = await import("../../src/session/commands/accept.ts");
    const outcome = await acceptCommand.run(
      { project, env: env.env, jsonMode: true, inputDisabled: true },
      [candidateId],
      {},
    );
    expect((outcome.json as { accepted: unknown[] }).accepted).toHaveLength(1);
    const meta = await readSessionMeta(project.paths.storeDir, candidateId);
    expect(meta?.association.mode).toBe("explicit");
  });

  test("accepts several pending candidates in one batch", async () => {
    await writeCodexSession(env.codexHome, {
      sessionId: "88888888-2222-3333-4444-555555555555",
      cwd: null,
    });
    await writeCodexSession(env.codexHome, {
      sessionId: "77777777-2222-3333-4444-555555555555",
      cwd: null,
    });
    const before = await importAll();
    expect(before.pending).toHaveLength(2);
    const ids = before.pending.map((p) => p["candidateId"] as string);

    const { acceptCommand } = await import("../../src/session/commands/accept.ts");
    const outcome = await acceptCommand.run(
      { project, env: env.env, jsonMode: true, inputDisabled: true },
      ids,
      {},
    );
    const json = outcome.json as { accepted: { sessionId: string }[] };
    expect(json.accepted.map((a) => a.sessionId).sort()).toEqual([...ids].sort());
    for (const id of ids) {
      const meta = await readSessionMeta(project.paths.storeDir, id);
      expect(meta?.association.mode).toBe("explicit");
    }
  });

  test("usage rules: no ids without --interactive; --interactive excludes ids and --yes", async () => {
    const ctx = { project, env: env.env, jsonMode: false, inputDisabled: false };
    const { acceptCommand } = await import("../../src/session/commands/accept.ts");
    await expect(acceptCommand.run(ctx, [], {})).rejects.toMatchObject({ code: "USAGE" });
    await expect(
      acceptCommand.run(ctx, [], { interactive: true, yes: true }),
    ).rejects.toMatchObject({ code: "USAGE" });
    await expect(acceptCommand.run(ctx, ["some-id"], { interactive: true })).rejects.toMatchObject({
      code: "USAGE",
    });
  });

  test("--interactive without a terminal is INPUT_REQUIRED before any Store mutation", async () => {
    const { acceptCommand } = await import("../../src/session/commands/accept.ts");
    await expect(
      acceptCommand.run({ project, env: env.env, jsonMode: true, inputDisabled: true }, [], {
        interactive: true,
      }),
    ).rejects.toMatchObject({ code: "INPUT_REQUIRED" });
  });

  test("an opening path mapped to another project cannot be overridden", async () => {
    const otherWorktree = await makeSecondWorktree(env, "other-project");
    await initProject(env, otherWorktree);
    await writeClaudeSession(env.claudeHome, { sessionId: "theirs-1", cwd: otherWorktree });

    const discovery = await discoverCandidates(project, env.env, null);
    const theirs = discovery.candidates.find(
      (c) => c.candidate.identity.sourceSessionId === "theirs-1",
    )!;
    expect(theirs.classification.kind).toBe("out_of_scope");

    const { acceptCommand } = await import("../../src/session/commands/accept.ts");
    await expect(
      acceptCommand.run(
        { project, env: env.env, jsonMode: true, inputDisabled: true },
        [theirs.candidate.candidateId],
        {},
      ),
    ).rejects.toThrow(GliaError);
  });
});
