import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { LoadedProject } from "../../src/core/session-module.ts";
import { runStatus } from "../../src/core/commands/status.ts";
import {
  hookLogMaxBytes,
  readHookLiveness,
  readHookRunReport,
  recordHookRun,
  touchHookLiveness,
} from "../../src/core/hooks/run-state.ts";
import { WriterLease } from "../../src/core/store/lease.ts";
import { ProjectStore } from "../../src/core/store/store.ts";
import { runHookInvocation, spawnDetachedHook } from "../../src/session/commands/hook-import.ts";
import { searchCommand } from "../../src/session/commands/search.ts";
import {
  decorateSessionOutcome,
  runWithSessionAdvisory,
} from "../../src/session/commands/advisory-output.ts";
import { archiveCommand } from "../../src/session/commands/archive.ts";
import { acceptCommand } from "../../src/session/commands/accept.ts";
import { runDelete } from "../../src/session/domain/delete.ts";
import { runImport } from "../../src/session/domain/import.ts";
import {
  associateCandidate,
  ignoreCandidate,
  readDiscoveryState,
  writeDiscoveryState,
} from "../../src/session/domain/discovery-state.ts";
import { readWithheldLosses } from "../../src/session/domain/withheld-loss.ts";
import { sessionIdOf } from "../../src/session/domain/identity.ts";
import { listSessionIds } from "../../src/session/storage/store-layout.ts";
import { sessionModule } from "../../src/session/module.ts";
import {
  FAKE_KEY,
  initProject,
  makeSecondWorktree,
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

function foregroundEnv(overrides: Record<string, string | undefined> = {}) {
  return { ...env.env, GLIA_HOOK_FOREGROUND: "1", ...overrides };
}

function pauseNextProjectWriterAcquire(): {
  reached: Promise<void>;
  resume: () => void;
  restore: () => void;
} {
  const acquire = WriterLease.acquire;
  let reachedResolve!: () => void;
  let resumeResolve!: () => void;
  const reached = new Promise<void>((resolve) => {
    reachedResolve = resolve;
  });
  const resumed = new Promise<void>((resolve) => {
    resumeResolve = resolve;
  });
  let intercepted = false;
  WriterLease.acquire = async (lockFile, timeoutMs) => {
    if (!intercepted && lockFile === project.paths.writerLockFile) {
      intercepted = true;
      reachedResolve();
      await resumed;
    }
    return await acquire(lockFile, timeoutMs);
  };
  return {
    reached,
    resume: resumeResolve,
    restore: () => {
      WriterLease.acquire = acquire;
    },
  };
}

describe("hook-mode import", () => {
  test("imports a bound Project from a subdirectory and records both liveness scopes", async () => {
    await writeClaudeSession(env.claudeHome, { sessionId: "hook-bound", cwd: env.worktree });
    const subdir = join(env.worktree, "packages", "app");
    await mkdir(subdir, { recursive: true });

    await runHookInvocation({ cwd: subdir, env: foregroundEnv(), jsonMode: false });

    expect(await listSessionIds(project.paths.storeDir)).toEqual([
      sessionIdOf({ harnessId: "claude-code", sourceSessionId: "hook-bound" }),
    ]);
    expect((await readHookLiveness(env.home))?.lastRunAt).toBeString();
    const report = await readHookRunReport(project);
    expect(report?.outcome).toBe("success");
    expect((report?.summary["accepted"] as unknown[]).length).toBe(1);

    const search = await searchCommand.run(
      { project, env: env.env, jsonMode: true, inputDisabled: true },
      ["flaky auth"],
      {},
    );
    expect((search.json as { totalMatches: number }).totalMatches).toBeGreaterThan(0);
  });

  test("an unbound worktree creates nothing beyond the machine liveness stamp", async () => {
    const unbound = await makeSecondWorktree(env, "unbound-hook");
    const projectsBefore = await readdir(join(env.home, "projects"));

    await runHookInvocation({ cwd: unbound, env: foregroundEnv(), jsonMode: false });

    expect(await readdir(join(env.home, "projects"))).toEqual(projectsBefore);
    expect((await readHookLiveness(env.home))?.lastRunAt).toBeString();
  });

  test("an unbound nested Git worktree never flows into its bound parent", async () => {
    const nested = join(env.worktree, "vendor", "independent");
    await mkdir(nested, { recursive: true });
    const git = Bun.spawn(["git", "init", "-q", "--initial-branch=main", nested]);
    expect(await git.exited).toBe(0);
    await writeClaudeSession(env.claudeHome, { sessionId: "nested-unbound", cwd: nested });
    const projectsBefore = await readdir(join(env.home, "projects"));

    // A full parent sweep must respect the exact Git worktree opt-in boundary,
    // even though the nested path is lexically below the parent's Binding.
    await runHookInvocation({ cwd: env.worktree, env: foregroundEnv(), jsonMode: false });
    const parentReport = await readHookRunReport(project);
    expect((parentReport?.summary["accepted"] as unknown[]).length).toBe(0);
    expect(parentReport?.summary["outOfScope"]).toBe(1);
    expect(await listSessionIds(project.paths.storeDir)).toEqual([]);

    await runHookInvocation({ cwd: nested, env: foregroundEnv(), jsonMode: false });
    expect(await readdir(join(env.home, "projects"))).toEqual(projectsBefore);

    const childProject = await initProject(env, nested);
    const childReport = await runImport(childProject, env.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: null,
    });
    expect(childReport.accepted).toHaveLength(1);
    expect(await listSessionIds(project.paths.storeDir)).toEqual([]);
    expect(await listSessionIds(childProject.paths.storeDir)).toHaveLength(1);
  });

  test("a vanished historical cwd does not hide other Harness candidates", async () => {
    const removed = join(env.worktree, "packages", "removed-app");
    await mkdir(removed, { recursive: true });
    await writeClaudeSession(env.claudeHome, { sessionId: "removed-cwd", cwd: removed });
    await writeClaudeSession(env.claudeHome, { sessionId: "live-cwd", cwd: env.worktree });
    await rm(removed, { recursive: true, force: true });

    const report = await runImport(project, env.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: null,
    });

    expect(report.adapterFailures).toEqual([]);
    expect(report.accepted).toHaveLength(1);
    expect(report.pending).toHaveLength(1);
    expect(await listSessionIds(project.paths.storeDir)).toHaveLength(1);
  });

  test("a vanished leaf stays pending until explicitly associated", async () => {
    const nested = join(env.worktree, "vendor", "surviving-independent");
    const removedLeaf = join(nested, "packages", "removed-app");
    await mkdir(removedLeaf, { recursive: true });
    const git = Bun.spawn(["git", "init", "-q", "--initial-branch=main", nested]);
    expect(await git.exited).toBe(0);
    await writeClaudeSession(env.claudeHome, {
      sessionId: "nested-removed-leaf",
      cwd: removedLeaf,
    });
    await rm(removedLeaf, { recursive: true, force: true });

    const parentReport = await runImport(project, env.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: null,
    });
    expect(parentReport.accepted).toEqual([]);
    expect(parentReport.pending).toHaveLength(1);

    const childProject = await initProject(env, nested);
    const childReport = await runImport(childProject, env.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: null,
    });
    expect(childReport.accepted).toEqual([]);
    expect(childReport.pending).toHaveLength(1);

    const candidateId = sessionIdOf({
      harnessId: "claude-code",
      sourceSessionId: "nested-removed-leaf",
    });
    const accepted = await acceptCommand.run(
      { project: childProject, env: env.env, jsonMode: true, inputDisabled: true },
      [candidateId],
      { yes: true },
    );
    expect((accepted.json as { accepted: unknown[] }).accepted).toHaveLength(1);
    expect(await listSessionIds(project.paths.storeDir)).toEqual([]);
    expect(await listSessionIds(childProject.paths.storeDir)).toHaveLength(1);
  });

  test("a vanished never-bound nested repository stays pending in its parent", async () => {
    const nested = join(env.worktree, "vendor", "vanished-never-bound");
    const openingPath = join(nested, "packages", "app");
    await mkdir(openingPath, { recursive: true });
    const git = Bun.spawn(["git", "init", "-q", "--initial-branch=main", nested]);
    expect(await git.exited).toBe(0);
    await writeClaudeSession(env.claudeHome, {
      sessionId: "vanished-never-bound",
      cwd: openingPath,
    });
    await rm(nested, { recursive: true, force: true });

    const report = await runImport(project, env.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: null,
    });

    expect(report.accepted).toEqual([]);
    expect(report.pending).toHaveLength(1);
    expect(await listSessionIds(project.paths.storeDir)).toEqual([]);
  });

  test("a vanished bound child root remains owned by its child Project", async () => {
    const nested = join(env.worktree, "vendor", "former-child");
    const openingPath = join(nested, "packages", "app");
    await mkdir(openingPath, { recursive: true });
    const git = Bun.spawn(["git", "init", "-q", "--initial-branch=main", nested]);
    expect(await git.exited).toBe(0);
    const childProject = await initProject(env, nested);
    await writeClaudeSession(env.claudeHome, {
      sessionId: "vanished-bound-child",
      cwd: openingPath,
    });
    await rm(nested, { recursive: true, force: true });

    const parentReport = await runImport(project, env.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: null,
    });
    const childReport = await runImport(childProject, env.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: null,
    });

    expect(parentReport.accepted).toEqual([]);
    expect(parentReport.outOfScope).toBe(1);
    expect(childReport.accepted).toHaveLength(1);
    expect(await listSessionIds(project.paths.storeDir)).toEqual([]);
    expect(await listSessionIds(childProject.paths.storeDir)).toHaveLength(1);
  });

  test("a reused former child path follows its current parent worktree", async () => {
    const nested = join(env.worktree, "vendor", "reused-child-path");
    await mkdir(nested, { recursive: true });
    const git = Bun.spawn(["git", "init", "-q", "--initial-branch=main", nested]);
    expect(await git.exited).toBe(0);
    const childProject = await initProject(env, nested);
    await rm(nested, { recursive: true, force: true });
    await mkdir(nested, { recursive: true });
    await writeClaudeSession(env.claudeHome, {
      sessionId: "reused-child-path",
      cwd: nested,
    });

    const parentReport = await runImport(project, env.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: null,
    });
    const childReport = await runImport(childProject, env.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: null,
    });

    expect(parentReport.accepted).toHaveLength(1);
    expect(childReport.accepted).toEqual([]);
    expect(childReport.outOfScope).toBe(1);
    expect(await listSessionIds(project.paths.storeDir)).toHaveLength(1);
    expect(await listSessionIds(childProject.paths.storeDir)).toEqual([]);
  });

  test("accept refuses an ignored Candidate after a child Project takes ownership", async () => {
    const nested = join(env.worktree, "vendor", "ignored-child");
    await mkdir(nested, { recursive: true });
    const sourceSessionId = "ignored-before-child-binding";
    await writeClaudeSession(env.claudeHome, { sessionId: sourceSessionId, cwd: nested });
    const candidateId = sessionIdOf({ harnessId: "claude-code", sourceSessionId });
    const ignored = await readDiscoveryState(project.paths.discoveryFile);
    ignoreCandidate(ignored, candidateId);
    await writeDiscoveryState(project.paths.discoveryFile, ignored);

    const git = Bun.spawn(["git", "init", "-q", "--initial-branch=main", nested]);
    expect(await git.exited).toBe(0);
    const childProject = await initProject(env, nested);

    await expect(
      acceptCommand.run(
        { project, env: env.env, jsonMode: true, inputDisabled: true },
        [candidateId],
        { yes: true },
      ),
    ).rejects.toMatchObject({ code: "ASSOCIATION_CONFLICT" });
    const childReport = await runImport(childProject, env.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: null,
    });
    expect(childReport.accepted).toHaveLength(1);
    expect(await listSessionIds(project.paths.storeDir)).toEqual([]);
    expect(await listSessionIds(childProject.paths.storeDir)).toHaveLength(1);
  });

  test("a live child Binding overrides a stale parent association at lease time", async () => {
    const nested = join(env.worktree, "vendor", "associated-before-child");
    await mkdir(nested, { recursive: true });
    const sourceSessionId = "associated-before-child-binding";
    await writeClaudeSession(env.claudeHome, { sessionId: sourceSessionId, cwd: nested });
    const candidateId = sessionIdOf({ harnessId: "claude-code", sourceSessionId });
    const associated = await readDiscoveryState(project.paths.discoveryFile);
    associateCandidate(associated, candidateId, project.declaration.projectId);
    await writeDiscoveryState(project.paths.discoveryFile, associated);

    const git = Bun.spawn(["git", "init", "-q", "--initial-branch=main", nested]);
    expect(await git.exited).toBe(0);
    const childProject = await initProject(env, nested);
    const parentReport = await runImport(project, env.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: null,
    });
    const childReport = await runImport(childProject, env.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: null,
    });

    expect(parentReport.accepted).toEqual([]);
    expect(parentReport.outOfScope).toBe(1);
    expect(childReport.accepted).toHaveLength(1);
    expect(await listSessionIds(project.paths.storeDir)).toEqual([]);
    expect(await listSessionIds(childProject.paths.storeDir)).toHaveLength(1);
  });

  test("a bound nested worktree is owned only by its most-specific Project", async () => {
    const nested = join(env.worktree, "vendor", "owned-child");
    await mkdir(nested, { recursive: true });
    const git = Bun.spawn(["git", "init", "-q", "--initial-branch=main", nested]);
    expect(await git.exited).toBe(0);
    const childProject = await initProject(env, nested);
    await writeClaudeSession(env.claudeHome, { sessionId: "nested-owned", cwd: nested });

    const parentReport = await runImport(project, env.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: null,
    });
    const childReport = await runImport(childProject, env.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: null,
    });

    expect(parentReport.accepted).toHaveLength(0);
    expect(parentReport.outOfScope).toBe(1);
    expect(await listSessionIds(project.paths.storeDir)).toEqual([]);
    expect(childReport.accepted).toHaveLength(1);
    expect(await listSessionIds(childProject.paths.storeDir)).toHaveLength(1);
  });

  test("lease-time Binding refresh keeps a newly bound child out of its parent", async () => {
    const nested = join(env.worktree, "vendor", "concurrent-child");
    await mkdir(nested, { recursive: true });
    const git = Bun.spawn(["git", "init", "-q", "--initial-branch=main", nested]);
    expect(await git.exited).toBe(0);
    await writeClaudeSession(env.claudeHome, { sessionId: "concurrent-owned", cwd: nested });

    const lease = await WriterLease.acquire(project.paths.writerLockFile, 1_000);
    const parentImport = runImport(
      project,
      { ...env.env, GLIA_LEASE_TIMEOUT_MS: "2000" },
      { harness: null, dryRun: false, onlyCandidateIds: null },
    );
    let childProject!: LoadedProject;
    try {
      await Bun.sleep(50);
      childProject = await initProject(env, nested);
    } finally {
      lease.release();
    }

    const parentReport = await parentImport;
    const childReport = await runImport(childProject, env.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: null,
    });
    expect(parentReport.accepted).toHaveLength(0);
    expect(parentReport.outOfScope).toBe(1);
    expect(await listSessionIds(project.paths.storeDir)).toEqual([]);
    expect(childReport.accepted).toHaveLength(1);
  });

  test("lease-time Binding refresh keeps flagged debt only in a newly bound child", async () => {
    const nested = join(env.worktree, "vendor", "concurrent-flagged-child");
    await mkdir(nested, { recursive: true });
    const git = Bun.spawn(["git", "init", "-q", "--initial-branch=main", nested]);
    expect(await git.exited).toBe(0);
    const sessionId = "concurrent-flagged-owned";
    await writeClaudeSession(env.claudeHome, {
      sessionId,
      cwd: nested,
      userText: `credential ${FAKE_KEY}`,
    });
    const candidateId = sessionIdOf({ harnessId: "claude-code", sourceSessionId: sessionId });

    const lease = await WriterLease.acquire(project.paths.writerLockFile, 1_000);
    const parentImport = runImport(
      project,
      { ...env.env, GLIA_LEASE_TIMEOUT_MS: "2000" },
      { harness: null, dryRun: false, onlyCandidateIds: null },
    );
    let childProject!: LoadedProject;
    try {
      await Bun.sleep(50);
      childProject = await initProject(env, nested);
    } finally {
      lease.release();
    }

    const parentReport = await parentImport;
    const childReport = await runImport(childProject, env.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: null,
    });
    expect(parentReport.flagged).toEqual([]);
    expect(parentReport.outOfScope).toBe(1);
    expect(
      (await readDiscoveryState(project.paths.discoveryFile)).evaluations[candidateId],
    ).toBeUndefined();
    expect(parentReport.prunedWithheld).toEqual([]);
    expect(await readWithheldLosses(project.paths.withheldLossFile)).toEqual([]);
    expect(childReport.flagged).toHaveLength(1);
    expect(
      (await readDiscoveryState(childProject.paths.discoveryFile)).evaluations[candidateId],
    ).toBeDefined();
  });

  test("an ignore committed before a waiting import wins over clean acceptance", async () => {
    const sessionId = "ignored-before-accept";
    await writeClaudeSession(env.claudeHome, { sessionId, cwd: env.worktree });
    const candidateId = sessionIdOf({ harnessId: "claude-code", sourceSessionId: sessionId });

    const lease = await WriterLease.acquire(project.paths.writerLockFile, 1_000);
    const importing = runImport(
      project,
      { ...env.env, GLIA_LEASE_TIMEOUT_MS: "2000" },
      { harness: null, dryRun: false, onlyCandidateIds: null },
    );
    try {
      await Bun.sleep(50);
      const state = await readDiscoveryState(project.paths.discoveryFile);
      ignoreCandidate(state, candidateId);
      await writeDiscoveryState(project.paths.discoveryFile, state);
    } finally {
      lease.release();
    }
    const report = await importing;

    expect(report.accepted).toEqual([]);
    expect(report.ignored).toBe(1);
    expect(await listSessionIds(project.paths.storeDir)).toEqual([]);
  });

  test("a waiting import recaptures when another operation clears its staging", async () => {
    await writeClaudeSession(env.claudeHome, {
      sessionId: "staging-cleared-before-accept",
      cwd: env.worktree,
    });
    const lease = await WriterLease.acquire(project.paths.writerLockFile, 1_000);
    const importing = runImport(
      project,
      { ...env.env, GLIA_LEASE_TIMEOUT_MS: "2000" },
      { harness: null, dryRun: false, onlyCandidateIds: null },
    );
    try {
      await Bun.sleep(50);
      await rm(project.paths.stagingRoot, { recursive: true, force: true });
    } finally {
      lease.release();
    }
    const report = await importing;

    expect(report.sourceErrors).toEqual([]);
    expect(report.accepted).toHaveLength(1);
    expect(await listSessionIds(project.paths.storeDir)).toHaveLength(1);
  });

  test("outside a worktree is a quiet guard no-op", async () => {
    const outside = join(env.root, "outside");
    await mkdir(outside, { recursive: true });

    await runHookInvocation({ cwd: outside, env: foregroundEnv(), jsonMode: false });

    expect((await readHookLiveness(env.home))?.lastRunAt).toBeString();
    expect(await readHookRunReport(project)).toBeNull();
  });

  test("lease contention returns quietly, records busy, and leaves Store head unchanged", async () => {
    await writeClaudeSession(env.claudeHome, { sessionId: "hook-busy", cwd: env.worktree });
    const head = await new ProjectStore(project.paths.storeDir).head();
    const lease = await WriterLease.acquire(project.paths.writerLockFile, 1_000);
    try {
      await runHookInvocation({
        cwd: env.worktree,
        env: foregroundEnv({ GLIA_LEASE_TIMEOUT_MS: "30" }),
        jsonMode: false,
      });
    } finally {
      lease.release();
    }

    expect(await new ProjectStore(project.paths.storeDir).head()).toBe(head);
    expect((await readHookRunReport(project))?.outcome).toBe("busy");
  });

  test("global Binding contention waits only once and leaves the Store untouched", async () => {
    await writeClaudeSession(env.claudeHome, {
      sessionId: "hook-global-busy",
      cwd: env.worktree,
    });
    const head = await new ProjectStore(project.paths.storeDir).head();
    const lease = await WriterLease.acquire(project.paths.bindingsLockFile, 1_000);
    const acquire = WriterLease.acquire;
    let globalAttempts = 0;
    WriterLease.acquire = async (lockFile, timeoutMs) => {
      if (lockFile === project.paths.bindingsLockFile) globalAttempts += 1;
      return await acquire(lockFile, timeoutMs);
    };
    try {
      await runHookInvocation({
        cwd: env.worktree,
        env: foregroundEnv({ GLIA_LEASE_TIMEOUT_MS: "30" }),
        jsonMode: false,
      });
    } finally {
      WriterLease.acquire = acquire;
      lease.release();
    }

    expect(globalAttempts).toBe(1);
    expect(await new ProjectStore(project.paths.storeDir).head()).toBe(head);
    expect((await readHookRunReport(project))?.outcome).toBe("busy");
  });

  test("overlapping unchanged triggers do not create a second Store commit", async () => {
    await writeClaudeSession(env.claudeHome, { sessionId: "hook-repeat", cwd: env.worktree });
    await runHookInvocation({ cwd: env.worktree, env: foregroundEnv(), jsonMode: false });
    const first = await new ProjectStore(project.paths.storeDir).head();
    await runHookInvocation({ cwd: env.worktree, env: foregroundEnv(), jsonMode: false });
    expect(await new ProjectStore(project.paths.storeDir).head()).toBe(first);
  });

  test("an asynchronous detached-spawn failure is swallowed", async () => {
    spawnDetachedHook(env.worktree, env.env, [join(env.root, "missing-glia")]);
    await Bun.sleep(25);
    expect(true).toBeTrue();
  });

  test("a diagnostic report failure cannot reclassify a successful import", async () => {
    await writeClaudeSession(env.claudeHome, {
      sessionId: "report-write-failure",
      cwd: env.worktree,
    });
    const recordedOutcomes: string[] = [];

    await runHookInvocation({
      cwd: env.worktree,
      env: foregroundEnv(),
      jsonMode: false,
      recordRun: async (_loaded, report) => {
        recordedOutcomes.push(report.outcome);
        throw new Error("diagnostic disk unavailable");
      },
    });

    expect(recordedOutcomes).toEqual(["success"]);
    expect(await listSessionIds(project.paths.storeDir)).toHaveLength(1);
  });
});

describe("withheld freshness state", () => {
  test("continuous re-evaluation preserves firstFlaggedAt, then full discovery records source loss", async () => {
    const source = await writeClaudeSession(env.claudeHome, {
      sessionId: "hook-secret",
      cwd: env.worktree,
      extraLines: [
        {
          type: "user",
          sessionId: "hook-secret",
          cwd: env.worktree,
          message: { role: "user", content: `credential ${FAKE_KEY}` },
        },
      ],
    });
    const candidateId = sessionIdOf({
      harnessId: "claude-code",
      sourceSessionId: "hook-secret",
    });

    const first = await runImport(project, env.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: null,
    });
    expect(first.flagged).toHaveLength(1);
    const firstFlaggedAt = (await readDiscoveryState(project.paths.discoveryFile)).evaluations[
      candidateId
    ]!.firstFlaggedAt;

    await Bun.sleep(5);
    await runImport(project, env.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: null,
    });
    expect(
      (await readDiscoveryState(project.paths.discoveryFile)).evaluations[candidateId]!
        .firstFlaggedAt,
    ).toBe(firstFlaggedAt);

    await rm(source);
    const pruned = await runImport(project, env.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: null,
    });
    expect(pruned.prunedWithheld.map((record) => record.candidateId)).toEqual([candidateId]);
    expect(
      (await readDiscoveryState(project.paths.discoveryFile)).evaluations[candidateId],
    ).toBeUndefined();
    const losses = await readWithheldLosses(project.paths.withheldLossFile);
    expect(losses.at(-1)).toMatchObject({ candidateId, firstFlaggedAt });
  });

  test("a narrowed import never prunes another Harness's missing evaluation", async () => {
    const source = await writeClaudeSession(env.claudeHome, {
      sessionId: "narrow-secret",
      cwd: env.worktree,
      extraLines: [
        {
          type: "user",
          sessionId: "narrow-secret",
          cwd: env.worktree,
          message: { role: "user", content: `credential ${FAKE_KEY}` },
        },
      ],
    });
    const candidateId = sessionIdOf({
      harnessId: "claude-code",
      sourceSessionId: "narrow-secret",
    });
    await runImport(project, env.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: null,
    });
    await rm(source);

    await runImport(project, env.env, {
      harness: "codex",
      dryRun: false,
      onlyCandidateIds: null,
    });

    expect(
      (await readDiscoveryState(project.paths.discoveryFile)).evaluations[candidateId],
    ).toBeDefined();
    expect(await readWithheldLosses(project.paths.withheldLossFile)).toEqual([]);
  });

  test("an unavailable Harness exempts its withheld evaluations from pruning", async () => {
    const candidateId = sessionIdOf({ harnessId: "codex", sourceSessionId: "offline-codex" });
    const state = await readDiscoveryState(project.paths.discoveryFile);
    state.evaluations[candidateId] = {
      identity: { harnessId: "codex", sourceSessionId: "offline-codex" },
      bundleDigest: "sha256:offline",
      rulesetVersion: 1,
      evaluatedAt: "2026-08-01T00:00:00Z",
      firstFlaggedAt: "2026-08-01T00:00:00Z",
      hits: [],
      unscanned: [],
    };
    await writeDiscoveryState(project.paths.discoveryFile, state);

    const report = await runImport(project, env.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: null,
    });

    expect(report.unavailableHarnesses.map((entry) => entry.harnessId)).toContain("codex");
    expect(
      (await readDiscoveryState(project.paths.discoveryFile)).evaluations[candidateId],
    ).toBeDefined();
    expect(await readWithheldLosses(project.paths.withheldLossFile)).toEqual([]);
  });

  test("a full import never prunes an evaluation added after its discovery snapshot", async () => {
    const source = await writeClaudeSession(env.claudeHome, {
      sessionId: "prune-race-old",
      cwd: env.worktree,
      extraLines: [
        {
          type: "user",
          sessionId: "prune-race-old",
          cwd: env.worktree,
          message: { role: "user", content: `credential ${FAKE_KEY}` },
        },
      ],
    });
    await runImport(project, env.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: null,
    });
    await rm(source);
    const oldId = sessionIdOf({ harnessId: "claude-code", sourceSessionId: "prune-race-old" });
    const newId = sessionIdOf({ harnessId: "claude-code", sourceSessionId: "prune-race-new" });

    const lease = await WriterLease.acquire(project.paths.writerLockFile, 1_000);
    const importing = runImport(
      project,
      { ...env.env, GLIA_LEASE_TIMEOUT_MS: "2000" },
      { harness: null, dryRun: false, onlyCandidateIds: null },
    );
    try {
      await Bun.sleep(50);
      const concurrent = await readDiscoveryState(project.paths.discoveryFile);
      concurrent.evaluations[newId] = {
        ...concurrent.evaluations[oldId]!,
        identity: { harnessId: "claude-code", sourceSessionId: "prune-race-new" },
      };
      await writeDiscoveryState(project.paths.discoveryFile, concurrent);
    } finally {
      lease.release();
    }
    const report = await importing;
    const final = await readDiscoveryState(project.paths.discoveryFile);
    expect(report.prunedWithheld.map((record) => record.candidateId)).toEqual([oldId]);
    expect(final.evaluations[oldId]).toBeUndefined();
    expect(final.evaluations[newId]).toBeDefined();
  });

  test("an accepted digest clears crash-residue evaluation without recording source loss", async () => {
    const source = await writeClaudeSession(env.claudeHome, {
      sessionId: "accepted-evaluation-residue",
      cwd: env.worktree,
      userText: `credential ${FAKE_KEY}`,
    });
    const candidateId = sessionIdOf({
      harnessId: "claude-code",
      sourceSessionId: "accepted-evaluation-residue",
    });
    await runImport(project, env.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: null,
    });
    const staleEvaluation = structuredClone(
      (await readDiscoveryState(project.paths.discoveryFile)).evaluations[candidateId]!,
    );
    const accepted = await runImport(project, env.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: [candidateId],
      overrideFlagged: true,
    });
    expect(accepted.accepted).toHaveLength(1);

    const crashResidue = await readDiscoveryState(project.paths.discoveryFile);
    crashResidue.evaluations[candidateId] = staleEvaluation;
    await writeDiscoveryState(project.paths.discoveryFile, crashResidue);
    await rm(source);

    const recovered = await runImport(project, env.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: null,
    });
    expect(recovered.prunedWithheld).toEqual([]);
    expect(
      (await readDiscoveryState(project.paths.discoveryFile)).evaluations[candidateId],
    ).toBeUndefined();
    expect(await readWithheldLosses(project.paths.withheldLossFile)).toEqual([]);
  });

  test("a full discovery clears source-present tombstone residue without recording loss", async () => {
    const sessionId = "tombstone-evaluation-residue";
    await writeClaudeSession(env.claudeHome, {
      sessionId,
      cwd: env.worktree,
      userText: `credential ${FAKE_KEY}`,
    });
    const candidateId = sessionIdOf({ harnessId: "claude-code", sourceSessionId: sessionId });
    await runImport(project, env.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: null,
    });
    const staleEvaluation = structuredClone(
      (await readDiscoveryState(project.paths.discoveryFile)).evaluations[candidateId]!,
    );
    await runImport(project, env.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: [candidateId],
      overrideFlagged: true,
    });
    await runDelete(project, env.env, candidateId);

    // Model a crash after the tombstone commit but before local discovery
    // residue was collapsed. The Harness source intentionally remains.
    const residue = await readDiscoveryState(project.paths.discoveryFile);
    residue.evaluations[candidateId] = staleEvaluation;
    await writeDiscoveryState(project.paths.discoveryFile, residue);
    const recovered = await runImport(project, env.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: null,
    });

    expect(recovered.prunedWithheld).toEqual([]);
    expect(recovered.tombstoned).toHaveLength(1);
    expect(
      (await readDiscoveryState(project.paths.discoveryFile)).evaluations[candidateId],
    ).toBeUndefined();
    expect(await readWithheldLosses(project.paths.withheldLossFile)).toEqual([]);
  });

  test("a full discovery clears flagged debt after a nested Project takes ownership", async () => {
    const nested = join(env.worktree, "vendor", "later-flagged-child");
    await mkdir(nested, { recursive: true });
    const sessionId = "later-flagged-owned";
    await writeClaudeSession(env.claudeHome, {
      sessionId,
      cwd: nested,
      userText: `credential ${FAKE_KEY}`,
    });
    const candidateId = sessionIdOf({ harnessId: "claude-code", sourceSessionId: sessionId });
    await runImport(project, env.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: null,
    });
    expect(
      (await readDiscoveryState(project.paths.discoveryFile)).evaluations[candidateId],
    ).toBeDefined();

    // The directory becomes an independent worktree only after the parent's
    // masked observation. Masked debt follows current Binding ownership; it
    // is not a durable cross-Project assignment like accepted evidence.
    const git = Bun.spawn(["git", "init", "-q", "--initial-branch=main", nested]);
    expect(await git.exited).toBe(0);
    const childProject = await initProject(env, nested);
    const parentSweep = await runImport(project, env.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: null,
    });
    const childSweep = await runImport(childProject, env.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: null,
    });

    expect(parentSweep.outOfScope).toBe(1);
    expect(parentSweep.prunedWithheld).toEqual([]);
    expect(
      (await readDiscoveryState(project.paths.discoveryFile)).evaluations[candidateId],
    ).toBeUndefined();
    expect(await readWithheldLosses(project.paths.withheldLossFile)).toEqual([]);
    expect(childSweep.flagged).toHaveLength(1);
  });

  test("an explicit evaluation clear wins over an older hook re-evaluation", async () => {
    await writeClaudeSession(env.claudeHome, {
      sessionId: "accept-race",
      cwd: env.worktree,
      extraLines: [
        {
          type: "user",
          sessionId: "accept-race",
          cwd: env.worktree,
          message: { role: "user", content: `credential ${FAKE_KEY}` },
        },
      ],
    });
    await runImport(project, env.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: null,
    });
    const candidateId = sessionIdOf({
      harnessId: "claude-code",
      sourceSessionId: "accept-race",
    });

    const lease = await WriterLease.acquire(project.paths.writerLockFile, 1_000);
    const importing = runImport(
      project,
      { ...env.env, GLIA_LEASE_TIMEOUT_MS: "2000" },
      { harness: null, dryRun: false, onlyCandidateIds: null },
    );
    try {
      await Bun.sleep(50);
      const accepted = await readDiscoveryState(project.paths.discoveryFile);
      delete accepted.evaluations[candidateId];
      await writeDiscoveryState(project.paths.discoveryFile, accepted);
    } finally {
      lease.release();
    }
    await importing;

    expect(
      (await readDiscoveryState(project.paths.discoveryFile)).evaluations[candidateId],
    ).toBeUndefined();
  });

  test("a first-time flagged evaluation cannot overwrite a concurrent ignore", async () => {
    await writeClaudeSession(env.claudeHome, {
      sessionId: "ignore-race",
      cwd: env.worktree,
      extraLines: [
        {
          type: "user",
          sessionId: "ignore-race",
          cwd: env.worktree,
          message: { role: "user", content: `credential ${FAKE_KEY}` },
        },
      ],
    });
    const candidateId = sessionIdOf({
      harnessId: "claude-code",
      sourceSessionId: "ignore-race",
    });

    const lease = await WriterLease.acquire(project.paths.writerLockFile, 1_000);
    const importing = runImport(
      project,
      { ...env.env, GLIA_LEASE_TIMEOUT_MS: "2000" },
      { harness: null, dryRun: false, onlyCandidateIds: null },
    );
    try {
      await Bun.sleep(50);
      const ignored = await readDiscoveryState(project.paths.discoveryFile);
      ignoreCandidate(ignored, candidateId);
      await writeDiscoveryState(project.paths.discoveryFile, ignored);
    } finally {
      lease.release();
    }
    await importing;

    const final = await readDiscoveryState(project.paths.discoveryFile);
    expect(final.ignored).toContain(candidateId);
    expect(final.evaluations[candidateId]).toBeUndefined();
  });

  test("a flagged capture that changes while waiting is re-evaluated before persistence", async () => {
    await writeClaudeSession(env.claudeHome, {
      sessionId: "stale-flag",
      cwd: env.worktree,
      userText: `first bytes ${FAKE_KEY}`,
    });
    const candidateId = sessionIdOf({
      harnessId: "claude-code",
      sourceSessionId: "stale-flag",
    });

    const lease = await WriterLease.acquire(project.paths.writerLockFile, 1_000);
    const importing = runImport(
      project,
      { ...env.env, GLIA_LEASE_TIMEOUT_MS: "2000" },
      { harness: null, dryRun: false, onlyCandidateIds: null },
    );
    try {
      await Bun.sleep(50);
      await writeClaudeSession(env.claudeHome, {
        sessionId: "stale-flag",
        cwd: env.worktree,
        userText: `newer bytes ${FAKE_KEY}`,
      });
    } finally {
      lease.release();
    }
    const report = await importing;
    const first = (await readDiscoveryState(project.paths.discoveryFile)).evaluations[candidateId];
    expect(report.flagged).toHaveLength(1);
    expect(first).toBeDefined();
    await runImport(project, env.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: null,
    });
    const second = (await readDiscoveryState(project.paths.discoveryFile)).evaluations[candidateId];
    expect(second?.bundleDigest).toBe(first?.bundleDigest);
    expect(second?.firstFlaggedAt).toBe(first?.firstFlaggedAt);
  });

  test("a newly discovered subagent is included in the persisted flagged evaluation", async () => {
    const spec = {
      sessionId: "late-flagged-subagent",
      cwd: env.worktree,
      userText: `credential ${FAKE_KEY}`,
    };
    await writeClaudeSession(env.claudeHome, spec);
    const candidateId = sessionIdOf({
      harnessId: "claude-code",
      sourceSessionId: spec.sessionId,
    });

    const lease = await WriterLease.acquire(project.paths.writerLockFile, 1_000);
    const importing = runImport(
      project,
      { ...env.env, GLIA_LEASE_TIMEOUT_MS: "2000" },
      { harness: null, dryRun: false, onlyCandidateIds: null },
    );
    try {
      await Bun.sleep(50);
      await writeClaudeSession(env.claudeHome, {
        ...spec,
        subagents: [{ agentId: "late", spawnPrompt: "inspect retry helpers" }],
      });
    } finally {
      lease.release();
    }
    const report = await importing;
    const first = (await readDiscoveryState(project.paths.discoveryFile)).evaluations[candidateId];
    expect(report.flagged).toHaveLength(1);
    expect(first).toBeDefined();
    await runImport(project, env.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: null,
    });
    const second = (await readDiscoveryState(project.paths.discoveryFile)).evaluations[candidateId];
    expect(second?.bundleDigest).toBe(first?.bundleDigest);
  });

  test("a changed transcript cannot hide a later missing subagent artifact", async () => {
    const sessionId = "changed-and-missing";
    const source = await writeClaudeSession(env.claudeHome, {
      sessionId,
      cwd: env.worktree,
      userText: `credential ${FAKE_KEY}`,
      subagents: [{ agentId: "removed", spawnPrompt: "inspect retry helpers" }],
    });
    const candidateId = sessionIdOf({ harnessId: "claude-code", sourceSessionId: sessionId });
    const subagent = join(dirname(source), sessionId, "subagents", "agent-removed.jsonl");

    const lease = await WriterLease.acquire(project.paths.writerLockFile, 1_000);
    const importing = runImport(
      project,
      { ...env.env, GLIA_LEASE_TIMEOUT_MS: "2000" },
      { harness: null, dryRun: false, onlyCandidateIds: null },
    );
    try {
      await Bun.sleep(50);
      await Bun.write(
        source,
        `${await readFile(source, "utf8")}${JSON.stringify({ type: "progress", sessionId })}\n`,
      );
      await rm(subagent);
    } finally {
      lease.release();
    }
    const report = await importing;

    expect(report.prunedWithheld.map((record) => record.candidateId)).toEqual([candidateId]);
    expect(
      (await readDiscoveryState(project.paths.discoveryFile)).evaluations[candidateId],
    ).toBeUndefined();
  });

  test("a clean capture includes a subagent created while waiting for the lease", async () => {
    const spec = { sessionId: "late-clean-subagent", cwd: env.worktree };
    await writeClaudeSession(env.claudeHome, spec);

    const lease = await WriterLease.acquire(project.paths.writerLockFile, 1_000);
    const importing = runImport(
      project,
      { ...env.env, GLIA_LEASE_TIMEOUT_MS: "2000" },
      { harness: null, dryRun: false, onlyCandidateIds: null },
    );
    try {
      await Bun.sleep(50);
      await writeClaudeSession(env.claudeHome, {
        ...spec,
        subagents: [{ agentId: "late", spawnPrompt: "inspect retry helpers" }],
      });
    } finally {
      lease.release();
    }
    const first = await importing;
    const second = await runImport(project, env.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: null,
    });

    expect(first.accepted).toHaveLength(1);
    expect(second.accepted).toHaveLength(0);
    expect(second.unchanged).toBe(1);
  });

  test("a flagged source lost while waiting for the lease leaves durable loss evidence", async () => {
    const source = await writeClaudeSession(env.claudeHome, {
      sessionId: "lost-before-evaluation",
      cwd: env.worktree,
      userText: `soon missing ${FAKE_KEY}`,
    });
    const candidateId = sessionIdOf({
      harnessId: "claude-code",
      sourceSessionId: "lost-before-evaluation",
    });

    const lease = await WriterLease.acquire(project.paths.writerLockFile, 1_000);
    const importing = runImport(
      project,
      { ...env.env, GLIA_LEASE_TIMEOUT_MS: "2000" },
      { harness: null, dryRun: false, onlyCandidateIds: null },
    );
    try {
      await Bun.sleep(50);
      await rm(source);
    } finally {
      lease.release();
    }
    const report = await importing;

    expect(
      (await readDiscoveryState(project.paths.discoveryFile)).evaluations[candidateId],
    ).toBeUndefined();
    expect(report.prunedWithheld.map((record) => record.candidateId)).toEqual([candidateId]);
    expect(
      (await readWithheldLosses(project.paths.withheldLossFile)).map(
        (record) => record.candidateId,
      ),
    ).toEqual([candidateId]);
  });

  test("a vanished Opening Path preserves a current flagged evaluation", async () => {
    const cwd = join(env.worktree, "vanishing-flagged-cwd");
    await mkdir(cwd, { recursive: true });
    await writeClaudeSession(env.claudeHome, {
      sessionId: "flagged-after-cwd-vanished",
      cwd,
      userText: `still present ${FAKE_KEY}`,
    });
    const candidateId = sessionIdOf({
      harnessId: "claude-code",
      sourceSessionId: "flagged-after-cwd-vanished",
    });

    const pause = pauseNextProjectWriterAcquire();
    const importing = runImport(
      project,
      { ...env.env, GLIA_LEASE_TIMEOUT_MS: "2000" },
      { harness: null, dryRun: false, onlyCandidateIds: null },
    );
    try {
      await pause.reached;
      await rm(cwd, { recursive: true, force: true });
    } finally {
      pause.resume();
      pause.restore();
    }
    const report = await importing;

    expect(report.flagged).toHaveLength(1);
    expect(report.outOfScope).toBe(0);
    expect(report.prunedWithheld).toEqual([]);
    expect(
      (await readDiscoveryState(project.paths.discoveryFile)).evaluations[candidateId],
    ).toBeDefined();
  });

  test("a vanished Opening Path cannot hide flagged source loss", async () => {
    const cwd = join(env.worktree, "vanishing-lost-cwd");
    await mkdir(cwd, { recursive: true });
    const source = await writeClaudeSession(env.claudeHome, {
      sessionId: "flagged-lost-after-cwd-vanished",
      cwd,
      userText: `soon missing ${FAKE_KEY}`,
    });
    const candidateId = sessionIdOf({
      harnessId: "claude-code",
      sourceSessionId: "flagged-lost-after-cwd-vanished",
    });

    const pause = pauseNextProjectWriterAcquire();
    const importing = runImport(
      project,
      { ...env.env, GLIA_LEASE_TIMEOUT_MS: "2000" },
      { harness: null, dryRun: false, onlyCandidateIds: null },
    );
    try {
      await pause.reached;
      await rm(cwd, { recursive: true, force: true });
      await rm(source);
    } finally {
      pause.resume();
      pause.restore();
    }
    const report = await importing;

    expect(report.flagged).toHaveLength(0);
    expect(report.outOfScope).toBe(0);
    expect(report.prunedWithheld.map((record) => record.candidateId)).toEqual([candidateId]);
    expect(
      (await readDiscoveryState(project.paths.discoveryFile)).evaluations[candidateId],
    ).toBeUndefined();
    expect(
      (await readWithheldLosses(project.paths.withheldLossFile)).map(
        (record) => record.candidateId,
      ),
    ).toEqual([candidateId]);
  });

  test("a failed clean recapture preserves old masked evidence until a full loss sweep", async () => {
    const sessionId = "clean-then-lost";
    const source = await writeClaudeSession(env.claudeHome, {
      sessionId,
      cwd: env.worktree,
      userText: `credential ${FAKE_KEY}`,
    });
    const candidateId = sessionIdOf({ harnessId: "claude-code", sourceSessionId: sessionId });
    await runImport(project, env.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: null,
    });
    const before = structuredClone(
      (await readDiscoveryState(project.paths.discoveryFile)).evaluations[candidateId]!,
    );
    await writeClaudeSession(env.claudeHome, {
      sessionId,
      cwd: env.worktree,
      userText: "the credential has been removed",
    });

    const lease = await WriterLease.acquire(project.paths.writerLockFile, 1_000);
    const importing = runImport(
      project,
      { ...env.env, GLIA_LEASE_TIMEOUT_MS: "2000" },
      { harness: null, dryRun: false, onlyCandidateIds: null },
    );
    try {
      await Bun.sleep(50);
      await rm(source);
    } finally {
      lease.release();
    }
    const failed = await importing;
    expect(failed.accepted).toEqual([]);
    expect(failed.sourceErrors).toHaveLength(1);
    expect(
      (await readDiscoveryState(project.paths.discoveryFile)).evaluations[candidateId],
    ).toEqual(before);
    expect(await readWithheldLosses(project.paths.withheldLossFile)).toEqual([]);

    const swept = await runImport(project, env.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: null,
    });
    expect(swept.prunedWithheld.map((record) => record.candidateId)).toEqual([candidateId]);
    expect(
      (await readDiscoveryState(project.paths.discoveryFile)).evaluations[candidateId],
    ).toBeUndefined();
  });

  test("a narrowed run preserves an existing evaluation when its captured source disappears", async () => {
    const source = await writeClaudeSession(env.claudeHome, {
      sessionId: "narrow-lost-after-capture",
      cwd: env.worktree,
      userText: `soon missing ${FAKE_KEY}`,
    });
    await runImport(project, env.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: null,
    });
    const candidateId = sessionIdOf({
      harnessId: "claude-code",
      sourceSessionId: "narrow-lost-after-capture",
    });
    const before = (await readDiscoveryState(project.paths.discoveryFile)).evaluations[candidateId];

    const lease = await WriterLease.acquire(project.paths.writerLockFile, 1_000);
    const importing = runImport(
      project,
      { ...env.env, GLIA_LEASE_TIMEOUT_MS: "2000" },
      { harness: "claude-code", dryRun: false, onlyCandidateIds: null },
    );
    try {
      await Bun.sleep(50);
      await rm(source);
    } finally {
      lease.release();
    }
    const report = await importing;

    expect(
      (await readDiscoveryState(project.paths.discoveryFile)).evaluations[candidateId],
    ).toEqual(before);
    expect(report.prunedWithheld).toEqual([]);
    expect(await readWithheldLosses(project.paths.withheldLossFile)).toEqual([]);
  });
});

describe("zero-result freshness advisories", () => {
  test("discovers importable and pending Candidates only when a search has no results", async () => {
    await writeClaudeSession(env.claudeHome, { sessionId: "not-imported", cwd: env.worktree });
    const outcome = await searchCommand.run(
      { project, env: env.env, jsonMode: true, inputDisabled: true },
      ["definitely absent"],
      {},
    );
    const json = outcome.json as {
      totalMatches: number;
      advisories: { kind: string; count: number }[];
    };
    expect(json.totalMatches).toBe(0);
    expect(json.advisories).toContainEqual({ kind: "importable", count: 1 });
    expect(outcome.human).toContain("1 Session Candidate(s) are importable");
  });

  test("old withheld debt carries its stable age and generic retention warning", async () => {
    const source = await writeClaudeSession(env.claudeHome, {
      sessionId: "old-secret",
      cwd: env.worktree,
      extraLines: [
        {
          type: "user",
          sessionId: "old-secret",
          cwd: env.worktree,
          message: { role: "user", content: `credential ${FAKE_KEY}` },
        },
      ],
    });
    await runImport(project, env.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: null,
    });
    const candidateId = sessionIdOf({ harnessId: "claude-code", sourceSessionId: "old-secret" });
    const state = await readDiscoveryState(project.paths.discoveryFile);
    state.evaluations[candidateId]!.firstFlaggedAt = new Date(
      Date.now() - 15 * 24 * 60 * 60 * 1_000,
    ).toISOString();
    await writeDiscoveryState(project.paths.discoveryFile, state);
    await rm(source);

    // A narrowed search discovery is not an import and does not prune the debt.
    const outcome = await searchCommand.run(
      { project, env: env.env, jsonMode: true, inputDisabled: true },
      ["no match"],
      {},
    );
    const withheld = (
      outcome.json as {
        advisories: {
          kind: string;
          count: number;
          oldestFirstFlaggedAt?: string;
          retentionWarning?: boolean;
        }[];
      }
    ).advisories.find((entry) => entry.kind === "withheld")!;
    expect(withheld).toMatchObject({ count: 1, retentionWarning: true });
    expect(withheld.oldestFirstFlaggedAt).toBe(state.evaluations[candidateId]!.firstFlaggedAt);
    expect(outcome.human).toContain("Harness retention may delete the source");
  });

  test("interactive outcomes open with the persisted withheld banner and JSON facts", async () => {
    await writeClaudeSession(env.claudeHome, {
      sessionId: "banner-secret",
      cwd: env.worktree,
      extraLines: [
        {
          type: "user",
          sessionId: "banner-secret",
          cwd: env.worktree,
          message: { role: "user", content: `credential ${FAKE_KEY}` },
        },
      ],
    });
    await runImport(project, env.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: null,
    });

    const events: string[] = [];
    const decorated = await runWithSessionAdvisory(
      { project, env: env.env, jsonMode: false, inputDisabled: false },
      async () => {
        events.push("command started");
        return { json: { value: 1 }, human: "command body" };
      },
      (text) => events.push(text.trim()),
    );
    expect(events[0]?.startsWith("Warning: 1 withheld Session Candidate(s)")).toBeTrue();
    expect(events[1]).toBe("command started");
    expect(decorated.human).toBe("command body");
    expect(
      (decorated.json as { advisories: { kind: string; count: number }[] }).advisories,
    ).toEqual([expect.objectContaining({ kind: "withheld", count: 1 })]);
  });

  test("completed JSON advisories drop debt resolved by the command", async () => {
    await writeClaudeSession(env.claudeHome, {
      sessionId: "resolved-banner-secret",
      cwd: env.worktree,
      userText: `credential ${FAKE_KEY}`,
    });
    await runImport(project, env.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: null,
    });

    const events: string[] = [];
    const decorated = await runWithSessionAdvisory(
      { project, env: env.env, jsonMode: false, inputDisabled: false },
      async () => {
        const state = await readDiscoveryState(project.paths.discoveryFile);
        state.evaluations = {};
        await writeDiscoveryState(project.paths.discoveryFile, state);
        return { json: { resolved: true }, human: "resolved" };
      },
      (text) => events.push(text.trim()),
    );

    expect(events[0]?.startsWith("Warning: 1 withheld Session Candidate(s)")).toBeTrue();
    expect((decorated.json as { advisories?: unknown[] }).advisories).toBeUndefined();
  });

  test("an advisory read failure cannot turn a committed command into a false failure", async () => {
    await writeClaudeSession(env.claudeHome, { sessionId: "advisory-failure", cwd: env.worktree });
    const imported = await runImport(project, env.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: null,
    });
    const sessionId = imported.accepted[0]!.sessionId;
    await Bun.write(
      project.paths.discoveryFile,
      JSON.stringify({ schemaVersion: 2, ignored: [], associations: {}, evaluations: {} }),
    );

    const ctx = { project, env: env.env, jsonMode: true, inputDisabled: true };
    const committed = await archiveCommand.run(ctx, [sessionId], { yes: true });
    const decorated = await decorateSessionOutcome(ctx, committed);

    expect((decorated.json as { applied: boolean }).applied).toBeTrue();
  });
});

describe("status freshness visibility", () => {
  test("reports withheld debt, both hook scopes, and durable source loss", async () => {
    const storeHeadBefore = await new ProjectStore(project.paths.storeDir).head();
    const source = await writeClaudeSession(env.claudeHome, {
      sessionId: "status-secret",
      cwd: env.worktree,
      extraLines: [
        {
          type: "user",
          sessionId: "status-secret",
          cwd: env.worktree,
          message: { role: "user", content: `credential ${FAKE_KEY}` },
        },
      ],
    });
    await runHookInvocation({ cwd: env.worktree, env: foregroundEnv(), jsonMode: false });
    expect(await new ProjectStore(project.paths.storeDir).head()).toBe(storeHeadBefore);
    expect(await readdir(project.paths.stagingRoot).catch(() => [])).toEqual([]);
    expect((await readHookRunReport(project))?.summary["flagged"]).toHaveLength(1);

    const before = await runStatus(project, [sessionModule], env.env);
    const beforeSession = (before.json as { session: Record<string, unknown> }).session as {
      withheldCandidates: { count: number; oldestFirstFlaggedAt: string | null };
      hookLiveness: { machineLastRunAt: string | null; projectLastRunAt: string | null };
    };
    expect(beforeSession.withheldCandidates.count).toBe(1);
    expect(beforeSession.withheldCandidates.oldestFirstFlaggedAt).toBeString();
    expect(beforeSession.hookLiveness.machineLastRunAt).toBeString();
    expect(beforeSession.hookLiveness.projectLastRunAt).toBeString();
    expect(before.human).toContain("(success)");
    expect(before.human).toContain("hook last run (machine)");
    expect(before.human).toContain("withheld: 1 candidate(s)");

    await rm(source);
    await runHookInvocation({ cwd: env.worktree, env: foregroundEnv(), jsonMode: false });
    const after = await runStatus(project, [sessionModule], env.env);
    const afterSession = (after.json as { session: Record<string, unknown> }).session as {
      lostWithheldCandidates: { count: number; records: unknown[] };
    };
    expect(afterSession.lostWithheldCandidates.count).toBe(1);
    expect(afterSession.lostWithheldCandidates.records).toHaveLength(1);
    expect(after.human).toContain("withheld source loss: 1 candidate(s)");
  });
});

describe("hook run files", () => {
  test("the latest report remains readable while the history is size-capped", async () => {
    for (let index = 0; index < 80; index += 1) {
      await recordHookRun(project, {
        schemaVersion: 1,
        startedAt: `2026-08-03T00:00:${String(index).padStart(2, "0")}Z`,
        finishedAt: `2026-08-03T00:00:${String(index).padStart(2, "0")}Z`,
        outcome: "success",
        summary: { index, padding: "x".repeat(1_500) },
      });
    }
    expect((await stat(project.paths.hookLogFile)).size).toBeLessThanOrEqual(hookLogMaxBytes);
    expect((await readHookRunReport(project))?.summary["index"]).toBe(79);
  });

  test("concurrent recorders retain every bounded log entry", async () => {
    await Promise.all(
      Array.from({ length: 20 }, (_, index) =>
        recordHookRun(project, {
          schemaVersion: 1,
          startedAt: `2026-08-03T01:00:${String(index).padStart(2, "0")}Z`,
          finishedAt: `2026-08-03T01:00:${String(index).padStart(2, "0")}Z`,
          outcome: "success",
          summary: { index },
        }),
      ),
    );
    const records = (await readFile(project.paths.hookLogFile, "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { summary: { index: number } });
    expect(new Set(records.map((record) => record.summary.index)).size).toBe(20);
  });

  test("one oversized report leaves a valid non-empty capped log line", async () => {
    await recordHookRun(project, {
      schemaVersion: 1,
      startedAt: "2026-08-03T02:00:00Z",
      finishedAt: "2026-08-03T02:00:01Z",
      outcome: "success",
      summary: { padding: "x".repeat(hookLogMaxBytes * 2) },
    });
    const log = await readFile(project.paths.hookLogFile, "utf8");
    expect(Buffer.byteLength(log)).toBeLessThanOrEqual(hookLogMaxBytes);
    expect(log.trim().length).toBeGreaterThan(0);
    expect(() => JSON.parse(log.trim())).not.toThrow();
  });

  test("latest report and machine liveness timestamps never move backward", async () => {
    const newer: Parameters<typeof recordHookRun>[1] = {
      schemaVersion: 1,
      startedAt: "2026-08-03T04:00:00Z",
      finishedAt: "2026-08-03T04:00:02Z",
      outcome: "success",
      summary: { order: "newer" },
    };
    const older: Parameters<typeof recordHookRun>[1] = {
      schemaVersion: 1,
      startedAt: "2026-08-03T03:00:00Z",
      finishedAt: "2026-08-03T03:00:02Z",
      outcome: "busy",
      summary: { order: "older" },
    };
    await recordHookRun(project, newer);
    await recordHookRun(project, older);
    expect((await readHookRunReport(project))?.summary["order"]).toBe("newer");

    await touchHookLiveness(env.home, newer.finishedAt);
    await touchHookLiveness(env.home, older.finishedAt);
    expect((await readHookLiveness(env.home))?.lastRunAt).toBe(newer.finishedAt);
  });
});
