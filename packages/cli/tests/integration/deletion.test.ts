import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { readdir } from "node:fs/promises";
import { runSync } from "../../src/core/store/sync.ts";
import { sessionModule } from "../../src/session/module.ts";
const sessionModules = [sessionModule];
import {
  DELETION_LIMITATION,
  buildLedgerCommit,
  countPreservedItems,
  readDeletionPending,
  rewriteHistoryPurging,
} from "../../src/core/store/deletion.ts";
import { runImport } from "../../src/session/domain/import.ts";
import { planDelete, runDelete } from "../../src/session/domain/delete.ts";
import {
  ledgerEventsFor,
  ledgerFilePath,
  readLocalLedgerEvents,
} from "../../src/session/domain/deletion.ts";
import { isSessionConflicted, readSessionConflict } from "../../src/session/domain/conflict.ts";
import { discoverCandidates } from "../../src/session/domain/discover.ts";
import { sessionIdOf } from "../../src/session/domain/identity.ts";
import { listSessionIds, readSessionMeta } from "../../src/session/storage/store-layout.ts";
import { ensureProjection } from "../../src/session/projection/publish.ts";
import { listSessions, openProjection } from "../../src/session/projection/query.ts";
import { deleteCommand } from "../../src/session/commands/delete.ts";
import { tombstonesCommand } from "../../src/session/commands/tombstones.ts";
import { showCommand } from "../../src/session/commands/show.ts";
import { acceptCommand } from "../../src/session/commands/accept.ts";
import { exportCommand } from "../../src/session/commands/export.ts";
import { runStatus } from "../../src/core/commands/status.ts";
import { readDeclaration, writeDeclaration } from "../../src/core/config/glia-json.ts";
import { loadProject } from "../../src/core/project/load.ts";
import { git, gitOrThrow } from "../../src/core/store/git.ts";
import { STORE_FORMAT_VERSION, readLocalStoreMarker } from "../../src/core/store/marker.ts";
import { WriterLease } from "../../src/core/store/lease.ts";
import { COMMIT_IDENTITY, ProjectStore } from "../../src/core/store/store.ts";
import type { CommandRunContext, LoadedProject } from "../../src/core/session-module.ts";
import {
  FAKE_KEY,
  initAt,
  initProject,
  makeBareRemote,
  makeSecondReplica,
  makeTestEnv,
  setDeclaredRemote,
  writeClaudeSession,
  writeCodexSession,
  type ReplicaEnv,
  type TestEnv,
} from "../helpers.ts";

setDefaultTimeout(120_000);

let envA: TestEnv;
beforeEach(async () => {
  envA = await makeTestEnv();
});
afterEach(async () => {
  await envA.cleanup();
});

type Env = Record<string, string | undefined>;

const importInto = (project: LoadedProject, env: Env) =>
  runImport(project, env, { harness: null, dryRun: false, onlyCandidateIds: null });
const sync = (project: LoadedProject, env: Env) => runSync(project, env, sessionModules);

const sessionIdOfSession = (sessionId: string) =>
  sessionIdOf({ harnessId: "claude-code", sourceSessionId: sessionId });

function ctxOf(
  project: LoadedProject,
  env: Env,
  overrides: Partial<CommandRunContext> = {},
): CommandRunContext {
  return { project, env, jsonMode: false, inputDisabled: true, ...overrides };
}

/** Machine A with sessions imported and a declared bare remote. */
async function machineA(
  sessionIds: string[],
): Promise<{ project: LoadedProject; remoteDir: string }> {
  let project = await initProject(envA);
  for (const sessionId of sessionIds) {
    await writeClaudeSession(envA.claudeHome, {
      sessionId,
      cwd: envA.worktree,
      userText: `unmistakable payload of ${sessionId}`,
    });
  }
  if (sessionIds.length > 0) await importInto(project, envA.env);
  const remote = await makeBareRemote(envA);
  await setDeclaredRemote(envA.worktree, remote);
  project = await loadProject(envA.worktree, envA.home);
  return { project, remoteDir: join(envA.root, "store-remote.git") };
}

async function replicaB(): Promise<{ b: ReplicaEnv; project: LoadedProject }> {
  const b = await makeSecondReplica(envA, "b");
  const project = await initAt(b.worktree, b.home);
  return { b, project };
}

function transcriptPath(project: LoadedProject, sessionId: string): string {
  return join(
    project.paths.storeDir,
    "session",
    "sessions",
    sessionId,
    "bundle",
    "source",
    "transcript.jsonl",
  );
}

async function headOf(project: LoadedProject): Promise<string> {
  return await new ProjectStore(project.paths.storeDir).head();
}

async function blobShaOf(storeDir: string, file: string): Promise<string> {
  return (await gitOrThrow(["hash-object", file], storeDir)).trim();
}

async function objectExists(storeDir: string, sha: string): Promise<boolean> {
  return (await git(["cat-file", "-e", sha], storeDir)).exitCode === 0;
}

/** True when `needle` appears anywhere in any commit reachable from any ref. */
async function historyContains(storeDir: string, needle: string): Promise<boolean> {
  const revs = (await gitOrThrow(["rev-list", "--all"], storeDir))
    .trim()
    .split("\n")
    .filter((l) => l.length > 0);
  for (const rev of revs) {
    const result = await git(["grep", "-q", needle, rev], storeDir);
    if (result.exitCode === 0) return true;
  }
  return false;
}

async function projectionSessionIds(project: LoadedProject, env: Env): Promise<string[]> {
  const handle = await ensureProjection(project, env);
  const db = openProjection(handle.dbPath);
  try {
    return listSessions(db).map((r) => r.sessionId);
  } finally {
    db.close();
  }
}

describe("session deletion (local operation)", () => {
  test("delete previews, requires confirmation, and purges payload from worktree, history, staging, caches, and projection", async () => {
    const { project } = await machineA(["del-1", "keep-1"]);
    const sessionId = sessionIdOfSession("del-1");
    const needle = "unmistakable payload of del-1";
    const blob = await blobShaOf(project.paths.storeDir, transcriptPath(project, sessionId));
    expect(await historyContains(project.paths.storeDir, needle)).toBeTrue();

    // --json without --yes is INPUT_REQUIRED before any mutation.
    const headBefore = await headOf(project);
    await expect(
      deleteCommand.run(ctxOf(project, envA.env, { jsonMode: true }), [sessionId], {}),
    ).rejects.toThrow(expect.objectContaining({ code: "INPUT_REQUIRED" }) as Error);
    expect(await headOf(project)).toBe(headBefore);

    const outcome = await deleteCommand.run(ctxOf(project, envA.env), [sessionId], { yes: true });
    const report = outcome.json as Record<string, unknown>;
    expect(report["epoch"]).toBe(1);
    // 14. Every deletion output states the limitation verbatim.
    expect(report["limitation"]).toBe(DELETION_LIMITATION);
    expect(outcome.human).toContain(DELETION_LIMITATION);

    // Payload gone: working tree, complete Git history, object database.
    expect(await Bun.file(transcriptPath(project, sessionId)).exists()).toBeFalse();
    expect(await historyContains(project.paths.storeDir, needle)).toBeFalse();
    expect(await objectExists(project.paths.storeDir, blob)).toBeFalse();
    // Staging and caches are clean; the projection no longer answers.
    expect(await Bun.file(project.paths.stagingRoot).exists()).toBeFalse();
    expect(await projectionSessionIds(project, envA.env)).toEqual([sessionIdOfSession("keep-1")]);
    // The bystander session's payload is untouched.
    expect(
      await historyContains(project.paths.storeDir, "unmistakable payload of keep-1"),
    ).toBeTrue();

    // 2. The ledger event carries exactly the five fields; no digests.
    const ledgerText = await Bun.file(
      join(project.paths.storeDir, ledgerFilePath(sessionId)),
    ).text();
    const ledger = JSON.parse(ledgerText) as Record<string, unknown>;
    expect(Object.keys(ledger).sort()).toEqual([
      "events",
      "schemaVersion",
      "sessionId",
      "sourceIdentity",
    ]);
    expect(Object.keys((ledger["sourceIdentity"] as object) ?? {}).sort()).toEqual([
      "harnessId",
      "sourceSessionId",
    ]);
    const events = ledger["events"] as Record<string, unknown>[];
    expect(events).toHaveLength(1);
    expect(Object.keys(events[0]!).sort()).toEqual(["deletedAt", "epoch", "replicaId"]);
    expect(ledgerText).not.toContain("digest");

    // 18. The first deletion bumps storeFormatVersion in the same commit.
    const marker = (await readLocalStoreMarker(project.paths.storeDir))!;
    expect(marker.storeFormatVersion).toBe(STORE_FORMAT_VERSION);
    expect(marker.epoch).toBe(1);
    const changed = await gitOrThrow(
      ["diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD"],
      project.paths.storeDir,
    );
    expect(changed).toContain("store.json");
    expect(changed).toContain(ledgerFilePath(sessionId));
  });

  test("deleting an already-deleted or unknown session is typed and epoch-stable; a concurrent writer gets PROJECT_BUSY", async () => {
    const { project } = await machineA(["del-2"]);
    const sessionId = sessionIdOfSession("del-2");
    await runDelete(project, envA.env, sessionId);

    await expect(runDelete(project, envA.env, sessionId)).rejects.toThrow(
      expect.objectContaining({ code: "SESSION_DELETED" }) as Error,
    );
    await expect(planDelete(project, "ses_00000000000000000000000000000000")).rejects.toThrow(
      expect.objectContaining({ code: "NOT_FOUND" }) as Error,
    );
    expect((await readLocalStoreMarker(project.paths.storeDir))!.epoch).toBe(1);

    // A concurrent writer holding the lease: PROJECT_BUSY.
    await writeClaudeSession(envA.claudeHome, { sessionId: "del-3", cwd: envA.worktree });
    await importInto(project, envA.env);
    const lease = await WriterLease.acquire(project.paths.writerLockFile, 1_000);
    try {
      await expect(
        runDelete(
          project,
          { ...envA.env, GLIA_LEASE_TIMEOUT_MS: "250" },
          sessionIdOfSession("del-3"),
        ),
      ).rejects.toThrow(expect.objectContaining({ code: "PROJECT_BUSY" }) as Error);
    } finally {
      lease.release();
    }
  });

  test("an interrupted deletion leaves the pre-deletion Store fully intact and a retry succeeds", async () => {
    const { project } = await machineA(["intr-1"]);
    const sessionId = sessionIdOfSession("intr-1");
    const store = new ProjectStore(project.paths.storeDir);
    const headBefore = await store.head();

    // An interruption is exactly: rewrite prepared aside, no reference switch.
    const rewrite = await rewriteHistoryPurging(project.paths.storeDir, headBefore, [
      `session/sessions/${sessionId}`,
    ]);
    await buildLedgerCommit(
      project.paths.storeDir,
      rewrite.newHead,
      project.declaration.projectId,
      1,
      [],
      "interrupted attempt",
    );
    expect(await store.head()).toBe(headBefore);
    expect(await store.isClean()).toBeTrue();
    expect(await Bun.file(transcriptPath(project, sessionId)).exists()).toBeTrue();

    const report = await runDelete(project, envA.env, sessionId);
    expect(report.epoch).toBe(1);
    expect(await Bun.file(transcriptPath(project, sessionId)).exists()).toBeFalse();
  });

  test("a Session frozen in Session Conflict is deletable; the preview names both candidates and the layout is purged", async () => {
    // Recipe from the sync suite: the same Session grows differently on two machines.
    const projectA1 = await initProject(envA);
    await writeClaudeSession(envA.claudeHome, {
      sessionId: "conf-1",
      cwd: envA.worktree,
      userText: "variant one",
    });
    await importInto(projectA1, envA.env);
    const remote = await makeBareRemote(envA);
    await setDeclaredRemote(envA.worktree, remote);
    const projectA = await loadProject(envA.worktree, envA.home);
    await sync(projectA, envA.env);

    const { b, project: projectB } = await replicaB();
    await writeClaudeSession(envA.claudeHome, {
      sessionId: "conf-1",
      cwd: envA.worktree,
      userText: "variant grown on machine A",
    });
    await importInto(projectA, envA.env);
    await sync(projectA, envA.env);
    await writeClaudeSession(b.claudeHome, {
      sessionId: "conf-1",
      cwd: b.worktree,
      userText: "variant grown differently on machine B",
    });
    await importInto(projectB, b.env);
    const reportB = await sync(projectB, b.env);
    const sessionId = sessionIdOfSession("conf-1");
    expect(reportB.conflicted).toEqual([`session/sessions/${sessionId}`]);
    expect(await isSessionConflicted(projectB.paths.storeDir, sessionId)).toBeTrue();

    const plan = await planDelete(projectB, sessionId);
    expect(plan.conflict).not.toBeNull();
    expect(plan.conflict!.candidates).toHaveLength(2);

    const report = await runDelete(projectB, b.env, sessionId);
    expect(report.deletedConflictCandidates).toBe(2);
    expect(await isSessionConflicted(projectB.paths.storeDir, sessionId)).toBeFalse();
    expect(await readSessionConflict(projectB.paths.storeDir, sessionId)).toBeNull();
    expect(await historyContains(projectB.paths.storeDir, "variant grown")).toBeFalse();

    // The deletion propagates; machine A verifies and both candidates die there too.
    const syncedB = await sync(projectB, b.env);
    expect(syncedB.deletion?.eventsPushed).toBe(1);
    const syncedA = await sync(projectA, envA.env);
    expect(syncedA.deletion?.eventsApplied).toBe(1);
    expect(await historyContains(projectA.paths.storeDir, "variant")).toBeFalse();
    expect(await headOf(projectA)).toBe(await headOf(projectB));
  });

  test("deletion on a local_only Project completes offline; a later first synchronization merges ledgers by union with the larger epoch", async () => {
    // Local-only machine A deletes with no remote declared.
    const project = await initProject(envA);
    await writeClaudeSession(envA.claudeHome, {
      sessionId: "solo-1",
      cwd: envA.worktree,
      userText: "unmistakable payload of solo-1",
    });
    await importInto(project, envA.env);
    const sessionId = sessionIdOfSession("solo-1");
    const report = await runDelete(project, envA.env, sessionId);
    expect(report.propagation).toBe("local_only");
    expect(await readDeletionPending(project.paths.deletionPendingFile)).toBeNull();
    const status = await runStatus(project, sessionModules, envA.env);
    expect(status.human).not.toContain("propagation pending");

    // A second machine deletes its own session against the same remote first.
    const remote = await makeBareRemote(envA);
    const { b, project: projectB } = await replicaB();
    await setDeclaredRemote(b.worktree, remote);
    const projectB2 = await loadProject(b.worktree, b.home);
    await writeClaudeSession(b.claudeHome, {
      sessionId: "solo-2",
      cwd: b.worktree,
      userText: "unmistakable payload of solo-2",
    });
    await importInto(projectB2, b.env);
    await runDelete(projectB2, b.env, sessionIdOfSession("solo-2"));
    await sync(projectB2, b.env);

    // A declares the remote later: the first synchronization unions the
    // disjoint ledgers, keeps equal epochs, and takes the larger epoch.
    await setDeclaredRemote(envA.worktree, remote);
    const projectA = await loadProject(envA.worktree, envA.home);
    const first = await sync(projectA, envA.env);
    expect(first.classification).toBe("diverged");
    const events = await readLocalLedgerEvents(projectA.paths.storeDir);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.epoch).sort()).toEqual([1, 1]);
    expect((await readLocalStoreMarker(projectA.paths.storeDir))!.epoch).toBe(1);

    const second = await sync(projectB2, b.env);
    expect(second.deletion?.eventsApplied).toBe(1);
    expect(await headOf(projectA)).toBe(await headOf(projectB2));
    expect(
      await historyContains(projectB2.paths.storeDir, "unmistakable payload of solo-1"),
    ).toBeFalse();
  });
});

describe("session deletion (propagation protocol)", () => {
  test("the rewrite is deterministic, the second replica retains nothing, heads converge, and transient payload is purged before success", async () => {
    const { project: projectA } = await machineA(["prop-1", "prop-2"]);
    await sync(projectA, envA.env);
    const { b, project: projectB } = await replicaB();
    const sessionId = sessionIdOfSession("prop-1");
    const needle = "unmistakable payload of prop-1";
    const headBefore = await headOf(projectA);
    const purge = [`session/sessions/${sessionId}`];
    const blobOnB = await blobShaOf(projectB.paths.storeDir, transcriptPath(projectB, sessionId));

    // 4. Byte-identical recomputation: both replicas' pure rewrites agree.
    const imageOnA = (await rewriteHistoryPurging(projectA.paths.storeDir, headBefore, purge))
      .newHead;
    const imageOnB = (await rewriteHistoryPurging(projectB.paths.storeDir, headBefore, purge))
      .newHead;
    expect(imageOnA).toBe(imageOnB);

    await runDelete(projectA, envA.env, sessionId);
    expect((await gitOrThrow(["rev-parse", "HEAD^"], projectA.paths.storeDir)).trim()).toBe(
      imageOnA,
    );
    // Propagation pending until the next sync; `glia status` reports it.
    const statusA = await runStatus(projectA, sessionModules, envA.env);
    expect(statusA.human).toContain("propagation pending");

    // 10. Pushing fetches the not-yet-rewritten remote (payload transiently
    // re-materializes) and purges it again before reporting success.
    const pushReport = await sync(projectA, envA.env);
    expect(pushReport.deletion?.eventsPushed).toBe(1);
    expect(await historyContains(projectA.paths.storeDir, needle)).toBeFalse();

    // 3. The receiving replica verifies, applies, and retains nothing.
    const reportB = await sync(projectB, b.env);
    expect(reportB.deletion?.eventsApplied).toBe(1);
    expect(reportB.deletion?.epochBefore).toBe(0);
    expect(reportB.deletion?.epochAfter).toBe(1);
    expect(await historyContains(projectB.paths.storeDir, needle)).toBeFalse();
    expect(await objectExists(projectB.paths.storeDir, blobOnB)).toBeFalse();
    expect(await headOf(projectA)).toBe(await headOf(projectB));
    expect(await projectionSessionIds(projectB, b.env)).toEqual([sessionIdOfSession("prop-2")]);

    // 26. Convergence is stable: repeating sync changes nothing anywhere.
    expect((await sync(projectA, envA.env)).classification).toBe("up_to_date");
    expect((await sync(projectB, b.env)).classification).toBe("up_to_date");
    expect((await readLocalStoreMarker(projectB.paths.storeDir))!.epoch).toBe(1);
  });

  test("an unexplained rewrite and a recomputation mismatch are both refused as REMOTE_REWRITTEN with zero local mutation and distinguishable details", async () => {
    const { project: projectA, remoteDir } = await machineA(["guard-1"]);
    await sync(projectA, envA.env);
    const { b, project: projectB } = await replicaB();

    // Unexplained: an unrelated history with no ledger events.
    const impostor = join(envA.root, "impostor");
    await gitOrThrow(["init", "-q", "--initial-branch=main", impostor], envA.root);
    await Bun.write(
      join(impostor, "store.json"),
      JSON.stringify(
        {
          storeFormatVersion: STORE_FORMAT_VERSION,
          projectId: projectA.declaration.projectId,
        },
        null,
        2,
      ) + "\n",
    );
    await gitOrThrow(["add", "-A"], impostor);
    await gitOrThrow([...COMMIT_IDENTITY, "commit", "--no-gpg-sign", "-m", "impostor"], impostor);
    const genuine = (await gitOrThrow(["ls-remote", remoteDir, "refs/heads/main"], envA.root))
      .split("\t")[0]!
      .trim();
    await gitOrThrow(["push", "--force", remoteDir, "main:refs/heads/main"], impostor);

    const headBefore = await headOf(projectB);
    let unexplained: unknown;
    await sync(projectB, b.env).catch((err: unknown) => (unexplained = err));
    expect(unexplained).toMatchObject({
      code: "REMOTE_REWRITTEN",
      details: { reason: "unexplained_rewrite" },
    });
    expect(await headOf(projectB)).toBe(headBefore);

    // Recomputation mismatch: same unrelated history, but now presenting
    // a Deletion Ledger event — the guard recomputes and the hashes differ.
    const sessionId = sessionIdOfSession("guard-1");
    await Bun.write(
      join(impostor, "store.json"),
      JSON.stringify(
        {
          storeFormatVersion: STORE_FORMAT_VERSION,
          projectId: projectA.declaration.projectId,
          epoch: 1,
        },
        null,
        2,
      ) + "\n",
    );
    await Bun.write(
      join(impostor, ledgerFilePath(sessionId)),
      JSON.stringify(
        {
          schemaVersion: 1,
          sessionId,
          sourceIdentity: { harnessId: "claude-code", sourceSessionId: "guard-1" },
          events: [{ replicaId: "impostor", deletedAt: "2026-07-18T00:00:00.000Z", epoch: 1 }],
        },
        null,
        2,
      ) + "\n",
    );
    await gitOrThrow(["add", "-A"], impostor);
    await gitOrThrow(
      [...COMMIT_IDENTITY, "commit", "--no-gpg-sign", "-m", "forged ledger"],
      impostor,
    );
    await gitOrThrow(["push", "--force", remoteDir, "main:refs/heads/main"], impostor);

    let mismatch: unknown;
    await sync(projectB, b.env).catch((err: unknown) => (mismatch = err));
    expect(mismatch).toMatchObject({
      code: "REMOTE_REWRITTEN",
      details: { reason: "recomputation_mismatch" },
    });
    expect(await headOf(projectB)).toBe(headBefore);
    expect(await Bun.file(transcriptPath(projectB, sessionId)).exists()).toBeTrue();

    // Restore the genuine remote head: the same replica then syncs cleanly.
    const restorer = join(envA.root, "restorer");
    await gitOrThrow(["clone", "-q", remoteDir, restorer], envA.root);
    await gitOrThrow(["update-ref", "refs/heads/main", genuine], restorer);
    await gitOrThrow(["push", "--force", remoteDir, "main:refs/heads/main"], restorer);
    expect((await sync(projectB, b.env)).classification).toBe("up_to_date");
  });

  test("a replica behind the rewrite base verifies by prefix image and receives never-synchronized commits as ordinary fresh content", async () => {
    const { project: projectA } = await machineA(["early-1"]);
    await sync(projectA, envA.env);
    const { b, project: projectB } = await replicaB(); // B stops here: behind the base.

    // A adds a session B never saw, syncs, then deletes it and syncs again.
    await writeClaudeSession(envA.claudeHome, {
      sessionId: "late-1",
      cwd: envA.worktree,
      userText: "unmistakable payload of late-1",
    });
    await importInto(projectA, envA.env);
    await sync(projectA, envA.env);
    await runDelete(projectA, envA.env, sessionIdOfSession("late-1"));
    await sync(projectA, envA.env);

    // B's shared prefix is untouched by the filter: plain fast-forward.
    const reportB = await sync(projectB, b.env);
    expect(reportB.classification).toBe("fast_forward");
    expect(reportB.deletion?.eventsApplied).toBe(1);
    expect(await headOf(projectB)).toBe(await headOf(projectA));
    expect(
      await historyContains(projectB.paths.storeDir, "unmistakable payload of late-1"),
    ).toBeFalse();
    expect(await listSessionIds(projectB.paths.storeDir)).toEqual([sessionIdOfSession("early-1")]);
  });

  test("a deletion pushed after the remote advanced re-derives automatically, and a remote update to the deleted session is stripped in deletion's favor", async () => {
    const { project: projectA } = await machineA(["adv-1", "adv-2"]);
    await sync(projectA, envA.env);
    const { b, project: projectB } = await replicaB();

    // B updates the doomed session and adds an unrelated one, then pushes.
    await writeClaudeSession(b.claudeHome, {
      sessionId: "adv-1",
      cwd: b.worktree,
      userText: "unmistakable update grown on machine B",
    });
    await writeClaudeSession(b.claudeHome, {
      sessionId: "adv-3",
      cwd: b.worktree,
      userText: "unmistakable payload of adv-3",
    });
    await importInto(projectB, b.env);
    await sync(projectB, b.env);

    // A deletes without fetching first; its push re-derives mechanically.
    const sessionId = sessionIdOfSession("adv-1");
    await runDelete(projectA, envA.env, sessionId);
    const push = await sync(projectA, envA.env);
    expect(push.deletion?.eventsPushed).toBe(1);
    // The remote's update to the deleted session was stripped; the
    // unrelated remote session arrived intact.
    expect(await historyContains(projectA.paths.storeDir, "unmistakable update grown")).toBeFalse();
    expect(await listSessionIds(projectA.paths.storeDir)).toEqual(
      [sessionIdOfSession("adv-2"), sessionIdOfSession("adv-3")].sort(),
    );

    const reportB = await sync(projectB, b.env);
    expect(reportB.deletion?.eventsApplied).toBe(1);
    expect(await historyContains(projectB.paths.storeDir, "unmistakable update grown")).toBeFalse();
    expect(await headOf(projectA)).toBe(await headOf(projectB));
    expect((await sync(projectA, envA.env)).classification).toBe("up_to_date");
  });

  test("two concurrent deletions of different sessions serialize through push retry with consecutive epochs and converge", async () => {
    const { project: projectA } = await machineA(["two-1", "two-2"]);
    await sync(projectA, envA.env);
    const { b, project: projectB } = await replicaB();

    await runDelete(projectA, envA.env, sessionIdOfSession("two-1"));
    await runDelete(projectB, b.env, sessionIdOfSession("two-2"));
    await sync(projectA, envA.env); // the winner
    const loser = await sync(projectB, b.env); // verifies, re-derives on top
    expect(loser.deletion?.eventsApplied).toBe(1);
    expect(loser.deletion?.eventsPushed).toBe(1);

    const events = await readLocalLedgerEvents(projectB.paths.storeDir);
    expect(events.map((e) => ({ id: e.unitId, epoch: e.epoch }))).toEqual([
      { id: sessionIdOfSession("two-1"), epoch: 1 },
      { id: sessionIdOfSession("two-2"), epoch: 2 },
    ]);
    expect((await readLocalStoreMarker(projectB.paths.storeDir))!.epoch).toBe(2);

    const reportA = await sync(projectA, envA.env);
    expect(reportA.deletion?.eventsApplied).toBe(1);
    expect(await headOf(projectA)).toBe(await headOf(projectB));
    expect(
      await historyContains(projectA.paths.storeDir, "unmistakable payload of two-"),
    ).toBeFalse();
    expect(
      await historyContains(projectB.paths.storeDir, "unmistakable payload of two-"),
    ).toBeFalse();
  });

  test("two independent deletions of the same session converge on one deterministically chosen ledger slot", async () => {
    const { project: projectA } = await machineA(["same-1", "same-keep"]);
    await sync(projectA, envA.env);
    const { b, project: projectB } = await replicaB();
    const sessionId = sessionIdOfSession("same-1");

    await runDelete(projectA, envA.env, sessionId);
    await runDelete(projectB, b.env, sessionId);
    await sync(projectA, envA.env);
    await sync(projectB, b.env);
    await sync(projectA, envA.env);

    expect(await headOf(projectA)).toBe(await headOf(projectB));
    const events = await ledgerEventsFor(projectA.paths.storeDir, sessionId);
    expect(events).toHaveLength(1);
    expect(events[0]!.epoch).toBe(1);
    // The winner is the earlier deletion timestamp: machine A deleted first.
    expect(events[0]!.replicaId).toBe(projectA.replicaId);
    expect((await readLocalStoreMarker(projectA.paths.storeDir))!.epoch).toBe(1);
    expect(
      await historyContains(projectB.paths.storeDir, "unmistakable payload of same-1"),
    ).toBeFalse();
  });

  test("bystander commits survive; unsynchronized changes to the deleted session are preserved export-shaped, reported, and never overwritten", async () => {
    const { project: projectA } = await machineA(["by-1", "by-2"]);
    await sync(projectA, envA.env);
    const { b, project: projectB } = await replicaB();

    // B grows the doomed session and imports a brand-new one — both unsynchronized.
    await writeClaudeSession(b.claudeHome, {
      sessionId: "by-1",
      cwd: b.worktree,
      userText: "unsynchronized local growth of by-1",
    });
    await writeClaudeSession(b.claudeHome, {
      sessionId: "by-3",
      cwd: b.worktree,
      userText: "unmistakable payload of by-3",
    });
    await importInto(projectB, b.env);

    await runDelete(projectA, envA.env, sessionIdOfSession("by-1"));
    await sync(projectA, envA.env);

    // Sync captures and completes: no human decision blocks it.
    const reportB = await sync(projectB, b.env);
    expect(reportB.deletion?.eventsApplied).toBe(1);
    expect(reportB.deletion?.preserved).toHaveLength(1);
    const preservedPath = reportB.deletion!.preserved[0]!.path;

    // The bystander session survived intact and reached the remote.
    expect(await listSessionIds(projectB.paths.storeDir)).toEqual(
      [sessionIdOfSession("by-2"), sessionIdOfSession("by-3")].sort(),
    );
    // The deleted session's unsynchronized bytes live on, export-shaped.
    expect(await Bun.file(join(preservedPath, "source", "transcript.jsonl")).text()).toContain(
      "unsynchronized local growth of by-1",
    );
    expect(await Bun.file(join(preservedPath, "preserved.json")).exists()).toBeTrue();
    // ...but are gone from the Store.
    expect(
      await historyContains(projectB.paths.storeDir, "unsynchronized local growth"),
    ).toBeFalse();

    // `glia status` shows the preserved item until the user disposes of it.
    const status = await runStatus(projectB, sessionModules, b.env);
    expect(status.human).toContain("preserved: 1 bystander item(s)");

    // 23. A second round preserves into its own layout.
    await writeClaudeSession(b.claudeHome, {
      sessionId: "by-2",
      cwd: b.worktree,
      userText: "second unsynchronized growth of by-2",
    });
    await importInto(projectB, b.env);
    await runDelete(projectA, envA.env, sessionIdOfSession("by-2"));
    await sync(projectA, envA.env);
    const round2 = await sync(projectB, b.env);
    expect(round2.deletion?.preserved).toHaveLength(1);
    expect(round2.deletion!.preserved[0]!.path).not.toBe(preservedPath);
    expect(await countPreservedItems(projectB.paths.preservedDir)).toBe(2);
    expect(await Bun.file(join(preservedPath, "source", "transcript.jsonl")).text()).toContain(
      "unsynchronized local growth of by-1",
    );
  });

  test("one sync carries several pending epochs together and the receiver applies them in epoch order", async () => {
    const { project: projectA } = await machineA(["multi-1", "multi-2", "multi-3"]);
    await sync(projectA, envA.env);
    const { b, project: projectB } = await replicaB();

    await runDelete(projectA, envA.env, sessionIdOfSession("multi-1"));
    await runDelete(projectA, envA.env, sessionIdOfSession("multi-2"));
    const pending = await readDeletionPending(projectA.paths.deletionPendingFile);
    expect(pending!.events.map((e) => e.event.epoch)).toEqual([1, 2]);

    const push = await sync(projectA, envA.env);
    expect(push.deletion?.eventsPushed).toBe(2);
    const reportB = await sync(projectB, b.env);
    expect(reportB.deletion?.eventsApplied).toBe(2);
    expect(reportB.deletion?.epochAfter).toBe(2);
    expect(await listSessionIds(projectB.paths.storeDir)).toEqual([sessionIdOfSession("multi-3")]);
    expect(await headOf(projectA)).toBe(await headOf(projectB));
  });

  test("a remote refusing non-fast-forward pushes yields REWRITE_PUSH_REFUSED, status reports pending, and a later permitted sync completes", async () => {
    const { project: projectA, remoteDir } = await machineA(["deny-1"]);
    await sync(projectA, envA.env);
    await gitOrThrow(["config", "receive.denyNonFastForwards", "true"], remoteDir);

    await runDelete(projectA, envA.env, sessionIdOfSession("deny-1"));
    let refused: unknown;
    await sync(projectA, envA.env).catch((err: unknown) => (refused = err));
    expect(refused).toMatchObject({ code: "REWRITE_PUSH_REFUSED" });

    // Locally deleted, propagation-pending; status says so.
    expect(await readDeletionPending(projectA.paths.deletionPendingFile)).not.toBeNull();
    const status = await runStatus(projectA, sessionModules, envA.env);
    expect(status.human).toContain("propagation pending");

    await gitOrThrow(["config", "receive.denyNonFastForwards", "false"], remoteDir);
    const completed = await sync(projectA, envA.env);
    expect(completed.deletion?.eventsPushed).toBe(1);
    expect(await readDeletionPending(projectA.paths.deletionPendingFile)).toBeNull();
  });

  test("a deletion rewrite arriving at a replica with the Session module disabled is still verified, applied, and purged", async () => {
    const { project: projectA } = await machineA(["dis-1", "dis-2"]);
    await sync(projectA, envA.env);
    const { b, project: projectB } = await replicaB();

    const declaration = (await readDeclaration(b.worktree))!;
    declaration.unknownKeys = {
      ...declaration.unknownKeys,
      contexts: { session: { enabled: false } },
    };
    await writeDeclaration(b.worktree, declaration);
    const disabledB = await loadProject(b.worktree, b.home);

    await runDelete(projectA, envA.env, sessionIdOfSession("dis-1"));
    await sync(projectA, envA.env);
    const reportB = await sync(disabledB, b.env);
    expect(reportB.deletion?.eventsApplied).toBe(1);
    expect(
      await historyContains(disabledB.paths.storeDir, "unmistakable payload of dis-1"),
    ).toBeFalse();
    expect(await listSessionIds(disabledB.paths.storeDir)).toEqual([sessionIdOfSession("dis-2")]);
    expect(await headOf(disabledB)).toBe(await headOf(projectA));
  });

  test("an older Glia meeting a newer store format is told to upgrade, never REMOTE_REWRITTEN; a deletion-free store keeps its prior format", async () => {
    const { project: projectA, remoteDir } = await machineA(["fmt-1"]);
    await sync(projectA, envA.env);
    // A deletion-free Store keeps the base format.
    expect((await readLocalStoreMarker(projectA.paths.storeDir))!.storeFormatVersion).toBe(
      STORE_FORMAT_VERSION,
    );

    // Simulate a future Glia: an unrelated rewritten history whose marker
    // is newer than this build understands. The polite upgrade prompt
    // must win over the rewrite guard.
    const future = join(envA.root, "future");
    await gitOrThrow(["init", "-q", "--initial-branch=main", future], envA.root);
    await Bun.write(
      join(future, "store.json"),
      JSON.stringify(
        {
          storeFormatVersion: STORE_FORMAT_VERSION + 1,
          projectId: projectA.declaration.projectId,
          epoch: 9,
        },
        null,
        2,
      ) + "\n",
    );
    await gitOrThrow(["add", "-A"], future);
    await gitOrThrow([...COMMIT_IDENTITY, "commit", "--no-gpg-sign", "-m", "future"], future);
    await gitOrThrow(["push", "--force", remoteDir, "main:refs/heads/main"], future);

    const headBefore = await headOf(projectA);
    await expect(sync(projectA, envA.env)).rejects.toThrow(
      expect.objectContaining({ code: "STATE_TOO_NEW" }) as Error,
    );
    expect(await headOf(projectA)).toBe(headBefore);
  });
});

describe("session deletion (lifecycle after deletion)", () => {
  test("a tombstoned identity is skipped on every replica, re-admits only explicitly with a persisted override, and show answers SESSION_DELETED", async () => {
    const { project: projectA } = await machineA(["life-1"]);
    await sync(projectA, envA.env);
    const { b, project: projectB } = await replicaB();
    // The same source Session exists on machine B's harness too.
    await writeClaudeSession(b.claudeHome, {
      sessionId: "life-1",
      cwd: b.worktree,
      userText: "unmistakable payload of life-1",
    });
    const sessionId = sessionIdOfSession("life-1");

    await runDelete(projectA, envA.env, sessionId);
    await sync(projectA, envA.env);
    await sync(projectB, b.env);

    // 13. Deleted is distinguishable from never-existed.
    await expect(showCommand.run(ctxOf(projectA, envA.env), [sessionId], {})).rejects.toThrow(
      expect.objectContaining({ code: "SESSION_DELETED" }) as Error,
    );
    await expect(
      showCommand.run(ctxOf(projectA, envA.env), ["ses_00000000000000000000000000000000"], {}),
    ).rejects.toThrow(expect.objectContaining({ code: "NOT_FOUND" }) as Error);
    // list/search/export treat the tombstoned identity as nonexistent.
    await expect(
      exportCommand.run(ctxOf(projectA, envA.env), [sessionId], {
        output: join(envA.root, "export-tomb"),
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "NOT_FOUND" }) as Error);

    // 12. Discovery still finds the source; import skips it without failing.
    for (const [project, env] of [
      [projectA, envA.env],
      [projectB, b.env],
    ] as const) {
      const report = await importInto(project, env);
      expect(report.accepted).toHaveLength(0);
      expect(report.tombstoned).toHaveLength(1);
      const discovery = await discoverCandidates(project, env, null);
      const classified = discovery.candidates.find((c) => c.candidate.candidateId === sessionId)!;
      expect(classified.classification.kind).toBe("tombstoned");
    }

    // `session tombstones` lists the ledger events.
    const tombstones = await tombstonesCommand.run(ctxOf(projectA, envA.env), [], {});
    expect((tombstones.json as { events: unknown[] }).events).toHaveLength(1);
    expect(tombstones.human).toContain(sessionId);

    // Explicit re-acceptance requires confirmation, then re-admits the
    // same Session ID with a fresh Revision chain and a persisted override.
    await expect(
      acceptCommand.run(ctxOf(projectA, envA.env, { jsonMode: true }), [sessionId], {}),
    ).rejects.toThrow(expect.objectContaining({ code: "INPUT_REQUIRED" }) as Error);
    const accepted = await acceptCommand.run(ctxOf(projectA, envA.env), [sessionId], { yes: true });
    expect((accepted.json as { accepted: { sessionId: string }[] }).accepted[0]!.sessionId).toBe(
      sessionId,
    );
    const meta = (await readSessionMeta(projectA.paths.storeDir, sessionId))!;
    expect(meta.tombstoneOverride).toMatchObject({ overriddenEpoch: 1 });
    // Fresh chain: exactly one metadata commit in the purged history.
    const chain = await gitOrThrow(
      ["rev-list", "--count", "HEAD", "--", `session/sessions/${sessionId}/session.json`],
      projectA.paths.storeDir,
    );
    expect(chain.trim()).toBe("1");
    // The ledger is append-only: re-acceptance removed nothing.
    expect(await ledgerEventsFor(projectA.paths.storeDir, sessionId)).toHaveLength(1);

    // Deleting the re-accepted Session appends a second ledger event.
    const second = await runDelete(projectA, envA.env, sessionId);
    expect(second.epoch).toBe(2);
    expect(await ledgerEventsFor(projectA.paths.storeDir, sessionId)).toHaveLength(2);
  });

  test("re-admitting an explicitly associated identity restores the association, so later source growth flows as ordinary Revisions", async () => {
    // A Codex session with no cwd has no resolvable Opening Path: only an
    // explicit association accepts it, and deletion collapses exactly that.
    const project = await initProject(envA);
    await writeCodexSession(envA.codexHome, {
      sessionId: "0199aaaa-0000-7000-8000-000000000001",
      cwd: null,
    });
    const sessionId = sessionIdOf({
      harnessId: "codex",
      sourceSessionId: "0199aaaa-0000-7000-8000-000000000001",
    });
    await acceptCommand.run(ctxOf(project, envA.env), [sessionId], {});
    expect(await readSessionMeta(project.paths.storeDir, sessionId)).not.toBeNull();

    await runDelete(project, envA.env, sessionId);
    const readmitted = await acceptCommand.run(ctxOf(project, envA.env), [sessionId], {
      yes: true,
    });
    expect((readmitted.json as { accepted: unknown[] }).accepted).toHaveLength(1);

    // The source grows; an ordinary import accepts the new Revision
    // instead of classifying the identity as pending again.
    await writeCodexSession(envA.codexHome, {
      sessionId: "0199aaaa-0000-7000-8000-000000000001",
      cwd: null,
      agentText: "grown after re-admission",
    });
    const growth = await importInto(project, envA.env);
    expect(growth.pending).toHaveLength(0);
    expect(growth.accepted.map((a) => a.sessionId)).toEqual([sessionId]);
  });

  test("deleting a parent session leaves the child's continuation intact and the chain resolves to SESSION_DELETED at the parent", async () => {
    const project0 = await initProject(envA);
    await writeClaudeSession(envA.claudeHome, {
      sessionId: "parent-1",
      cwd: envA.worktree,
      userText: "unmistakable payload of parent-1",
    });
    await writeClaudeSession(envA.claudeHome, {
      sessionId: "child-1",
      cwd: envA.worktree,
      parentSessionId: "parent-1",
      userText: "unmistakable payload of child-1",
    });
    await importInto(project0, envA.env);
    const parentId = sessionIdOfSession("parent-1");
    const childId = sessionIdOfSession("child-1");

    await runDelete(project0, envA.env, parentId);

    const child = await showCommand.run(ctxOf(project0, envA.env), [childId], {});
    const detail = (child.json as { session: { continuationParent: string | null } }).session;
    expect(detail.continuationParent).toBe("parent-1");
    await expect(showCommand.run(ctxOf(project0, envA.env), [parentId], {})).rejects.toThrow(
      expect.objectContaining({ code: "SESSION_DELETED" }) as Error,
    );
  });

  test("tombstoned takes precedence over flagged; explicit re-acceptance re-runs detection and sessions both overrides", async () => {
    const project = await initProject(envA);
    await writeClaudeSession(envA.claudeHome, {
      sessionId: "sec-1",
      cwd: envA.worktree,
      userText: `here is my key ${FAKE_KEY} please use it`,
    });
    const sessionId = sessionIdOfSession("sec-1");

    // Flagged first; accepted explicitly with the detection override.
    const first = await importInto(project, envA.env);
    expect(first.flagged).toHaveLength(1);
    await acceptCommand.run(ctxOf(project, envA.env), [sessionId], {});
    expect(
      (await readSessionMeta(project.paths.storeDir, sessionId))!.secretDetectionOverride,
    ).toBeDefined();

    await runDelete(project, envA.env, sessionId);
    expect(await historyContains(project.paths.storeDir, FAKE_KEY)).toBeFalse();

    // Both tombstoned and flag-worthy: classifies tombstoned.
    const discovery = await discoverCandidates(project, envA.env, null);
    const classified = discovery.candidates.find((c) => c.candidate.candidateId === sessionId)!;
    expect(classified.classification.kind).toBe("tombstoned");

    // Explicit re-acceptance re-runs detection and sessions both overrides.
    const accepted = await acceptCommand.run(ctxOf(project, envA.env), [sessionId], { yes: true });
    expect((accepted.json as { accepted: unknown[] }).accepted).toHaveLength(1);
    const meta = (await readSessionMeta(project.paths.storeDir, sessionId))!;
    expect(meta.tombstoneOverride).toMatchObject({ overriddenEpoch: 1 });
    expect(meta.secretDetectionOverride).toBeDefined();
  });
});
