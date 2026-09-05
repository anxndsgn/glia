import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { cp } from "node:fs/promises";
import { runSync, REMOTE_TRACKING_REF, type SyncOptions } from "../../src/core/store/sync.ts";
import { sessionModule } from "../../src/session/module.ts";
const sessionModules = [sessionModule];
import { runImport } from "../../src/session/domain/import.ts";
import { resolveSessionConflict } from "../../src/session/domain/resolve.ts";
import {
  isSessionConflicted,
  listConflictedSessionIds,
  readSessionConflict,
} from "../../src/session/domain/conflict.ts";
import { listSessionIds, readSessionMeta } from "../../src/session/storage/store-layout.ts";
import { ensureProjection } from "../../src/session/projection/publish.ts";
import { listSessions, openProjection } from "../../src/session/projection/query.ts";
import { exportCommand } from "../../src/session/commands/export.ts";
import { runStoreRemoteSet } from "../../src/core/commands/store-remote.ts";
import { readDeclaration, writeDeclaration } from "../../src/core/config/glia-json.ts";
import { loadProject } from "../../src/core/project/load.ts";
import { projectPaths } from "../../src/core/project/paths.ts";
import { git, gitOrThrow } from "../../src/core/store/git.ts";
import { readLocalStoreMarker, storeMarkerBytes } from "../../src/core/store/marker.ts";
import { COMMIT_IDENTITY, ProjectStore } from "../../src/core/store/store.ts";
import type { LoadedProject } from "../../src/core/session-module.ts";
import { GliaError } from "../../src/core/output/errors.ts";
import { readArchiveMarker, transitionSessionArchive } from "../../src/session/domain/archive.ts";
import {
  initAt,
  initProject,
  makeBareRemote,
  makeSecondReplica,
  makeSecondWorktree,
  makeTestEnv,
  setDeclaredRemote,
  writeClaudeSession,
  type TestEnv,
} from "../helpers.ts";

setDefaultTimeout(60_000);

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
const sync = (project: LoadedProject, env: Env, options?: SyncOptions) =>
  runSync(project, env, sessionModules, options);

/** Machine A: initialized project with a declared bare remote. */
async function machineA(withSession = true): Promise<LoadedProject> {
  const project = await initProject(envA);
  if (withSession) {
    await writeClaudeSession(envA.claudeHome, { sessionId: "aaaa-1", cwd: envA.worktree });
    await importInto(project, envA.env);
  }
  const remote = await makeBareRemote(envA);
  await setDeclaredRemote(envA.worktree, remote);
  return await loadProject(envA.worktree, envA.home);
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

describe("glia sync", () => {
  for (const defaultBranch of ["other", "missing"]) {
    test(`bootstrap checks out main when the remote HEAD names ${defaultBranch}`, async () => {
      const projectA = await machineA();
      const reportA = await sync(projectA, envA.env);
      const remoteDir = Bun.fileURLToPath(projectA.declaration.store.remote!);
      if (defaultBranch === "other") {
        await gitOrThrow(["branch", "other", "main"], remoteDir);
      }
      await gitOrThrow(["symbolic-ref", "HEAD", `refs/heads/${defaultBranch}`], remoteDir);

      const b = await makeSecondReplica(envA, "b");
      const projectB = await initAt(b.worktree, b.home);
      expect((await gitOrThrow(["branch", "--show-current"], projectB.paths.storeDir)).trim()).toBe(
        "main",
      );
      expect(await headOf(projectB)).toBe(reportA.head);
      await writeClaudeSession(b.claudeHome, { sessionId: "bootstrap-b", cwd: b.worktree });
      await importInto(projectB, b.env);
      const reportB = await sync(projectB, b.env);
      expect(reportB.pushed).toBe(1);
      await sync(projectA, envA.env);
      expect(await listSessionIds(projectA.paths.storeDir)).toHaveLength(2);
    });
  }

  test("bootstrap refuses remote history that has no main branch", async () => {
    const projectA = await machineA();
    await sync(projectA, envA.env);
    const remoteDir = Bun.fileURLToPath(projectA.declaration.store.remote!);
    await gitOrThrow(["branch", "-m", "main", "other"], remoteDir);
    const b = await makeSecondReplica(envA, "b");
    await expect(initAt(b.worktree, b.home)).rejects.toThrow(
      expect.objectContaining({ code: "STORE_MISMATCH" }) as Error,
    );
    expect(
      await new ProjectStore(
        projectPaths(b.home, projectA.declaration.projectId).storeDir,
      ).exists(),
    ).toBeFalse();
    expect((await gitOrThrow(["branch", "--list", "main"], remoteDir)).trim()).toBe("");
  });

  test("clean-machine recovery: machine B bootstraps through init and queries byte-identical sessions", async () => {
    const projectA = await machineA();
    const reportA = await sync(projectA, envA.env);
    expect(reportA.classification).toBe("local_ahead");
    expect(reportA.pushed).toBe(1);
    expect(reportA.conflicted).toHaveLength(0);

    const b = await makeSecondReplica(envA, "b");
    const projectB = await initAt(b.worktree, b.home);

    const ids = await listSessionIds(projectB.paths.storeDir);
    expect(ids).toHaveLength(1);
    expect(await headOf(projectB)).toBe(reportA.head);
    expect(await Bun.file(transcriptPath(projectB, ids[0]!)).text()).toBe(
      await Bun.file(transcriptPath(projectA, ids[0]!)).text(),
    );

    const handle = await ensureProjection(projectB, b.env);
    const db = openProjection(handle.dbPath);
    try {
      expect(listSessions(db)).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("two replicas importing different sessions converge with no interaction and identical heads", async () => {
    const projectA = await machineA();
    await sync(projectA, envA.env);

    const b = await makeSecondReplica(envA, "b");
    const projectB = await initAt(b.worktree, b.home);
    await writeClaudeSession(b.claudeHome, { sessionId: "bbbb-1", cwd: b.worktree });
    await importInto(projectB, b.env);

    const reportB = await sync(projectB, b.env);
    expect(reportB.classification).toBe("local_ahead");
    expect(reportB.pushed).toBe(1);
    expect(reportB.pulled).toBe(0);
    expect(reportB.conflicted).toHaveLength(0);

    const reportA2 = await sync(projectA, envA.env);
    expect(reportA2.classification).toBe("fast_forward");
    expect(reportA2.pulled).toBe(1);
    expect(reportA2.pushed).toBe(0);

    expect(await headOf(projectA)).toBe(await headOf(projectB));
    expect(await listSessionIds(projectA.paths.storeDir)).toHaveLength(2);
    expect(await listSessionIds(projectB.paths.storeDir)).toHaveLength(2);

    // Idempotence: repeating sync after convergence changes nothing on either side.
    const again = await sync(projectA, envA.env);
    expect(again.classification).toBe("up_to_date");
    expect(again.pulled + again.pushed + again.merged).toBe(0);
    expect(again.head).toBe(reportA2.head);
    expect((await sync(projectB, b.env)).classification).toBe("up_to_date");
  });

  test("a same-session divergence freezes exactly that session; resolve propagates and import accepts newest bytes", async () => {
    // Both machines share the session and one extra session that must stay available.
    const projectA = await initProject(envA);
    await writeClaudeSession(envA.claudeHome, { sessionId: "keep-1", cwd: envA.worktree });
    await writeClaudeSession(envA.claudeHome, {
      sessionId: "conf-1",
      cwd: envA.worktree,
      userText: "variant one",
    });
    await importInto(projectA, envA.env);
    const remote = await makeBareRemote(envA);
    await setDeclaredRemote(envA.worktree, remote);
    const projectA2 = await loadProject(envA.worktree, envA.home);
    await sync(projectA2, envA.env);

    const b = await makeSecondReplica(envA, "b");
    const projectB = await initAt(b.worktree, b.home);

    // The same source Session grows differently on each machine.
    await writeClaudeSession(envA.claudeHome, {
      sessionId: "conf-1",
      cwd: envA.worktree,
      userText: "variant one grown on machine A",
    });
    await importInto(projectA2, envA.env);
    await sync(projectA2, envA.env);

    await writeClaudeSession(b.claudeHome, {
      sessionId: "conf-1",
      cwd: b.worktree,
      userText: "variant grown differently on machine B",
    });
    const importB = await importInto(projectB, b.env);
    expect(importB.accepted).toHaveLength(1);
    const sessionId = importB.accepted[0]!.sessionId;
    const digestB = importB.accepted[0]!.revision;
    const digestA = (await readSessionMeta(projectA2.paths.storeDir, sessionId))!.currentRevision
      .digest;
    expect(digestA).not.toBe(digestB);

    const reportB = await sync(projectB, b.env);
    expect(reportB.classification).toBe("diverged");
    expect(reportB.conflicted).toEqual([`session/sessions/${sessionId}`]);

    // The conflict freezes only that session.
    expect(await isSessionConflicted(projectB.paths.storeDir, sessionId)).toBeTrue();
    const doc = (await readSessionConflict(projectB.paths.storeDir, sessionId))!;
    expect(doc.candidates).toHaveLength(2);
    expect(doc.candidates.map((c) => c.digest).sort()).toEqual([digestA, digestB].sort());

    // Archive metadata is disjoint from the frozen evidence unit. Both
    // transitions succeed without changing or resolving the conflict.
    await transitionSessionArchive(projectB, b.env, sessionId, "archived");
    expect(await isSessionConflicted(projectB.paths.storeDir, sessionId)).toBeTrue();
    await transitionSessionArchive(projectB, b.env, sessionId, "active");
    expect(await isSessionConflicted(projectB.paths.storeDir, sessionId)).toBeTrue();
    expect((await readArchiveMarker(projectB.paths.storeDir, sessionId))?.state).toBe("active");

    const ctxB = { project: projectB, env: b.env, jsonMode: true, inputDisabled: true };
    await expect(
      exportCommand.run(ctxB, [sessionId], { output: join(envA.root, "out-conflicted") }),
    ).rejects.toThrow(expect.objectContaining({ code: "SESSION_CONFLICT" }) as Error);

    // Every other session stays available.
    const handle = await ensureProjection(projectB, b.env);
    const db = openProjection(handle.dbPath);
    try {
      const rows = listSessions(db);
      expect(rows).toHaveLength(1);
      expect(rows[0]!.sessionId).not.toBe(sessionId);
    } finally {
      db.close();
    }

    // The merged store pushed; machine A reads the same conflict.
    const reportA = await sync(projectA2, envA.env);
    expect(reportA.classification).toBe("fast_forward");
    expect(await isSessionConflicted(projectA2.paths.storeDir, sessionId)).toBeTrue();

    // A conflicted session's candidate is skipped by import, blocking nothing.
    const importDuringConflict = await importInto(projectB, b.env);
    expect(importDuringConflict.conflicted).toHaveLength(1);
    expect(importDuringConflict.accepted).toHaveLength(0);

    // Offline pick-one resolution on B, to machine A's candidate.
    const resolved = await resolveSessionConflict(projectB, b.env, sessionId, digestA);
    expect(resolved.revision).toBe(digestA);
    expect(await isSessionConflicted(projectB.paths.storeDir, sessionId)).toBeFalse();
    expect(
      (await readSessionMeta(projectB.paths.storeDir, sessionId))!.currentRevision.digest,
    ).toBe(digestA);
    expect((await readArchiveMarker(projectB.paths.storeDir, sessionId))?.state).toBe("active");

    // The unselected candidate remains traceable in Store history.
    const parentConflict = await git(
      ["show", `${resolved.storeCommit}~1:session/sessions/${sessionId}/conflict/conflict.json`],
      projectB.paths.storeDir,
    );
    expect(parentConflict.exitCode).toBe(0);
    expect(parentConflict.stdout).toContain(digestB);

    // The next import accepts the newest source bytes.
    const importAfterResolve = await importInto(projectB, b.env);
    expect(importAfterResolve.accepted).toHaveLength(1);
    expect(importAfterResolve.accepted[0]!.revision).toBe(digestB);

    // Resolution propagates through the next sync.
    await sync(projectB, b.env);
    const reportA2 = await sync(projectA2, envA.env);
    expect(reportA2.classification).toBe("fast_forward");
    expect(await isSessionConflicted(projectA2.paths.storeDir, sessionId)).toBeFalse();
    expect(
      (await readSessionMeta(projectA2.paths.storeDir, sessionId))!.currentRevision.digest,
    ).toBe(digestB);
    expect(await headOf(projectA2)).toBe(await headOf(projectB));
  });

  test("STORE_MISMATCH refuses before any local mutation, on sync and on bootstrap", async () => {
    const projectA = await machineA();
    await sync(projectA, envA.env);
    const remote = projectA.declaration.store.remote!;

    // A different project mistypes the same remote.
    const otherWorktree = await makeSecondWorktree(envA, "other-project");
    await initAt(otherWorktree, envA.home);
    await setDeclaredRemote(otherWorktree, remote);
    const other = await loadProject(otherWorktree, envA.home);
    const store = new ProjectStore(other.paths.storeDir);
    const headBefore = await store.head();

    await expect(sync(other, envA.env)).rejects.toThrow(
      expect.objectContaining({ code: "STORE_MISMATCH" }) as Error,
    );
    expect(await store.head()).toBe(headBefore);
    expect(await store.isClean()).toBeTrue();
    const tracking = await git(
      ["rev-parse", "--verify", "--quiet", REMOTE_TRACKING_REF],
      other.paths.storeDir,
    );
    expect(tracking.exitCode).not.toBe(0);

    // Bootstrap validates identity before adopting the clone.
    const cloneWorktree = await makeSecondWorktree(envA, "other-clone");
    await cp(join(otherWorktree, "glia.json"), join(cloneWorktree, "glia.json"));
    const homeC = join(envA.root, "glia-home-c");
    await expect(initAt(cloneWorktree, homeC)).rejects.toThrow(
      expect.objectContaining({ code: "STORE_MISMATCH" }) as Error,
    );
    const otherId = (await readDeclaration(otherWorktree))!.projectId;
    expect(await Bun.file(join(projectPaths(homeC, otherId).projectDir)).exists()).toBeFalse();
    expect(await Bun.file(join(homeC, "identity.json")).exists()).toBeTrue();
  });

  test("REMOTE_REWRITTEN refuses rewritten remote history with zero local mutation", async () => {
    const projectA = await machineA();
    await sync(projectA, envA.env);
    const remote = projectA.declaration.store.remote!;

    const rewriter = join(envA.root, "rewriter");
    await gitOrThrow(["clone", remote, rewriter], envA.root);
    await gitOrThrow([...COMMIT_IDENTITY, "commit", "--amend", "-m", "rewritten"], rewriter);
    await gitOrThrow(["push", "--force", "origin", "main"], rewriter);

    const store = new ProjectStore(projectA.paths.storeDir);
    const headBefore = await store.head();
    const trackingBefore = (
      await gitOrThrow(["rev-parse", REMOTE_TRACKING_REF], projectA.paths.storeDir)
    ).trim();

    await expect(sync(projectA, envA.env)).rejects.toThrow(
      expect.objectContaining({ code: "REMOTE_REWRITTEN" }) as Error,
    );
    expect(await store.head()).toBe(headBefore);
    expect(await store.isClean()).toBeTrue();
    expect(
      (await gitOrThrow(["rev-parse", REMOTE_TRACKING_REF], projectA.paths.storeDir)).trim(),
    ).toBe(trackingBefore);
  });

  // A newer store marker met over sync is covered by deletion.test.ts
  // ("an older Glia meeting a newer store format…"), which also pins its
  // precedence over REMOTE_REWRITTEN; per-state-file STATE_TOO_NEW readers
  // are covered in state-too-new.test.ts.

  test("an unversioned existing store is backfilled by the migration as its own commit", async () => {
    const project = await initProject(envA);
    const store = new ProjectStore(project.paths.storeDir);
    // Simulate a Store created before the marker existed.
    await gitOrThrow(["rm", "-q", "store.json"], project.paths.storeDir);
    await store.commitAll("legacy: no marker");
    expect(await readLocalStoreMarker(project.paths.storeDir)).toBeNull();

    await writeClaudeSession(envA.claudeHome, { sessionId: "aaaa-1", cwd: envA.worktree });
    const report = await importInto(project, envA.env);
    expect(report.accepted).toHaveLength(1);

    expect(await Bun.file(join(project.paths.storeDir, "store.json")).text()).toBe(
      storeMarkerBytes(project.declaration.projectId),
    );
    const log = await gitOrThrow(["log", "--format=%s"], project.paths.storeDir);
    expect(log).toContain("glia: mark store format (storeFormatVersion 1)");
  });

  test("sync without a declared remote fails fast with next-step guidance", async () => {
    const project = await initProject(envA);
    const headBefore = await headOf(project);
    try {
      await sync(project, envA.env);
      expect.unreachable();
    } catch (err) {
      expect((err as GliaError).code).toBe("NO_STORE_REMOTE");
      expect((err as GliaError).message).toContain("glia store remote set");
    }
    expect(await headOf(project)).toBe(headBefore);
  });

  test("a push race retries within its bound and reports cleanly when exhausted", async () => {
    const projectA = await machineA();
    await sync(projectA, envA.env);
    const remote = projectA.declaration.store.remote!;

    const racer = join(envA.root, "racer");
    await gitOrThrow(["clone", remote, racer], envA.root);
    const advanceRemote = async () => {
      await gitOrThrow(["fetch", "origin", "main"], racer);
      await gitOrThrow(["reset", "--hard", "FETCH_HEAD"], racer);
      await gitOrThrow([...COMMIT_IDENTITY, "commit", "--allow-empty", "-m", "race"], racer);
      await gitOrThrow(["push", "origin", "main"], racer);
    };

    // One race resolves within the bound.
    await writeClaudeSession(envA.claudeHome, { sessionId: "race-1", cwd: envA.worktree });
    await importInto(projectA, envA.env);
    const report = await sync(projectA, envA.env, {
      beforePush: async (attempt) => {
        if (attempt === 1) await advanceRemote();
      },
    });
    expect(report.attempts).toBe(2);

    // A remote that advances during every window exhausts the bound.
    await writeClaudeSession(envA.claudeHome, { sessionId: "race-2", cwd: envA.worktree });
    await importInto(projectA, envA.env);
    await expect(
      sync(projectA, envA.env, { beforePush: async () => await advanceRemote() }),
    ).rejects.toThrow(expect.objectContaining({ code: "SYNC_RETRY_EXHAUSTED" }) as Error);

    // Sync is idempotent: re-running it is the complete remedy.
    const remedy = await sync(projectA, envA.env);
    expect(remedy.attempts).toBe(1);
  });

  test("the whole store synchronizes with the session module disabled, still capturing conflicts", async () => {
    const projectA = await initProject(envA);
    await writeClaudeSession(envA.claudeHome, {
      sessionId: "conf-1",
      cwd: envA.worktree,
      userText: "variant one",
    });
    await importInto(projectA, envA.env);
    const remote = await makeBareRemote(envA);
    await setDeclaredRemote(envA.worktree, remote);
    const projectA2 = await loadProject(envA.worktree, envA.home);
    await sync(projectA2, envA.env);

    const b = await makeSecondReplica(envA, "b");
    let projectB = await initAt(b.worktree, b.home);
    await writeClaudeSession(b.claudeHome, {
      sessionId: "conf-1",
      cwd: b.worktree,
      userText: "variant two",
    });
    await importInto(projectB, b.env);

    await writeClaudeSession(envA.claudeHome, {
      sessionId: "conf-1",
      cwd: envA.worktree,
      userText: "variant one grown",
    });
    await importInto(projectA2, envA.env);
    await sync(projectA2, envA.env);

    // Disable the session module on B before its sync.
    const declaration = (await readDeclaration(b.worktree))!;
    declaration.unknownKeys = {
      ...declaration.unknownKeys,
      contexts: { session: { enabled: false } },
    };
    await writeDeclaration(b.worktree, declaration);
    projectB = await loadProject(b.worktree, b.home);

    const report = await sync(projectB, b.env);
    expect(report.conflicted).toHaveLength(1);
    expect(await listConflictedSessionIds(projectB.paths.storeDir)).toHaveLength(1);
    expect(await headOf(projectB)).toBe(report.head);
  });

  test("two stores with no common ancestor but matching identity converge as an ordinary diverged merge", async () => {
    const projectA = await initProject(envA);
    await writeClaudeSession(envA.claudeHome, { sessionId: "aaaa-1", cwd: envA.worktree });
    await importInto(projectA, envA.env);

    // Machine C attached while the project was still local-only.
    const c = await makeSecondReplica(envA, "c");
    const projectC = await initAt(c.worktree, c.home);
    await writeClaudeSession(c.claudeHome, { sessionId: "cccc-1", cwd: c.worktree });
    await importInto(projectC, c.env);

    const remote = await makeBareRemote(envA);
    await setDeclaredRemote(envA.worktree, remote);
    const projectA2 = await loadProject(envA.worktree, envA.home);
    await sync(projectA2, envA.env);

    await setDeclaredRemote(c.worktree, remote);
    const projectC2 = await loadProject(c.worktree, c.home);
    const report = await sync(projectC2, c.env);
    expect(report.classification).toBe("diverged");
    expect(report.conflicted).toHaveLength(0);
    expect(report.pulled).toBe(1);
    expect(report.pushed).toBe(1);

    await sync(projectA2, envA.env);
    expect(await headOf(projectA2)).toBe(await headOf(projectC2));
    expect(await listSessionIds(projectA2.paths.storeDir)).toHaveLength(2);
    expect(await listSessionIds(projectC2.paths.storeDir)).toHaveLength(2);
  });

  test("a dirty store working tree is preserved as a recovery commit and the sync completes", async () => {
    const projectA = await machineA();
    await sync(projectA, envA.env);

    const residue = join(projectA.paths.storeDir, "session", "sessions", "ses_orphan", "partial");
    await Bun.write(residue, "half-written residue\n");

    const report = await sync(projectA, envA.env);
    expect(report.recoveryCommit).not.toBeNull();
    const store = new ProjectStore(projectA.paths.storeDir);
    expect(await store.isClean()).toBeTrue();
    const shown = await gitOrThrow(
      ["show", `${report.recoveryCommit!}:session/sessions/ses_orphan/partial`],
      projectA.paths.storeDir,
    );
    expect(shown).toBe("half-written residue\n");
  });

  test("a same-digest conflict resolves deterministically to the earlier acceptance time", async () => {
    // Two replicas over one checkout and one harness home: identical bytes
    // accepted independently, differing only in acceptance metadata.
    const projectA = await initProject(envA);
    const remote = await makeBareRemote(envA);
    await setDeclaredRemote(envA.worktree, remote);
    const projectA2 = await loadProject(envA.worktree, envA.home);
    await sync(projectA2, envA.env);

    const homeB = join(envA.root, "glia-home-b");
    const envB: Env = { ...envA.env, GLIA_HOME: homeB };
    const projectB = await initAt(envA.worktree, homeB);

    await writeClaudeSession(envA.claudeHome, { sessionId: "same-1", cwd: envA.worktree });
    const importA = await importInto(projectA2, envA.env);
    await Bun.sleep(15);
    const importB = await importInto(projectB, envB);
    const sessionId = importA.accepted[0]!.sessionId;
    const digest = importA.accepted[0]!.revision;
    expect(importB.accepted[0]!.revision).toBe(digest);

    await sync(projectA2, envA.env);
    const report = await sync(projectB, envB);
    expect(report.conflicted).toEqual([`session/sessions/${sessionId}`]);

    const doc = (await readSessionConflict(projectB.paths.storeDir, sessionId))!;
    expect(doc.candidates).toHaveLength(2);
    expect(new Set(doc.candidates.map((c) => c.digest)).size).toBe(1);
    const earliest = [...doc.candidates.map((c) => c.acceptedAt)].sort()[0]!;

    const resolved = await resolveSessionConflict(projectB, envB, sessionId, digest);
    expect(resolved.acceptedAt).toBe(earliest);
    expect(
      (await readSessionMeta(projectB.paths.storeDir, sessionId))!.currentRevision.acceptedAt,
    ).toBe(earliest);

    // The unselected metadata remains traceable in Store history.
    const parent = await git(
      ["show", `${resolved.storeCommit}~1:session/sessions/${sessionId}/conflict/conflict.json`],
      projectB.paths.storeDir,
    );
    expect(parent.exitCode).toBe(0);
  });

  test("a credential-bearing URL is rejected offline before touching the declaration", async () => {
    const project = await initProject(envA);
    const before = await Bun.file(join(envA.worktree, "glia.json")).text();
    const ctx = { project, env: envA.env, jsonMode: true, inputDisabled: true };

    await expect(
      runStoreRemoteSet(ctx, ["https", "://user:secret@example.com/store.git"].join(""), {
        dryRun: false,
        yes: true,
      }),
    ).rejects.toThrow(expect.objectContaining({ code: "USAGE" }) as Error);
    expect(await Bun.file(join(envA.worktree, "glia.json")).text()).toBe(before);

    // Without --yes in a non-interactive run, INPUT_REQUIRED precedes any write.
    await expect(
      runStoreRemoteSet(ctx, "/tmp/somewhere.git", { dryRun: false, yes: false }),
    ).rejects.toThrow(expect.objectContaining({ code: "INPUT_REQUIRED" }) as Error);
    expect(await Bun.file(join(envA.worktree, "glia.json")).text()).toBe(before);

    const applied = await runStoreRemoteSet(ctx, "/tmp/somewhere.git", {
      dryRun: false,
      yes: true,
    });
    expect((applied.json as { applied: boolean }).applied).toBeTrue();
    expect((await readDeclaration(envA.worktree))!.store.remote).toBe("/tmp/somewhere.git");
  });

  test("a failed bootstrap clone leaves zero local state and a retry succeeds cleanly", async () => {
    const projectA = await machineA();
    await sync(projectA, envA.env);
    const goodRemote = projectA.declaration.store.remote!;

    const b = await makeSecondReplica(envA, "b");
    await setDeclaredRemote(b.worktree, Bun.pathToFileURL(join(envA.root, "missing.git")).href);
    await expect(initAt(b.worktree, b.home)).rejects.toThrow(
      expect.objectContaining({ code: "GIT_FAILED" }) as Error,
    );
    const projectId = (await readDeclaration(b.worktree))!.projectId;
    expect(await Bun.file(projectPaths(b.home, projectId).projectDir).exists()).toBeFalse();
    expect(await Bun.file(join(b.home, "identity.json")).exists()).toBeTrue();

    await setDeclaredRemote(b.worktree, goodRemote);
    const projectB = await initAt(b.worktree, b.home);
    expect(await listSessionIds(projectB.paths.storeDir)).toHaveLength(1);
  });

  test("bootstrapping from a reachable but empty remote adopts the clone and the first sync pushes", async () => {
    await initProject(envA);
    // A brand-new bare remote, never pushed to.
    const remote = await makeBareRemote(envA, "empty-remote");
    const b = await makeSecondReplica(envA, "b");
    await setDeclaredRemote(b.worktree, remote);
    const projectB = await initAt(b.worktree, b.home);

    expect(await readLocalStoreMarker(projectB.paths.storeDir)).not.toBeNull();
    const report = await sync(projectB, b.env);
    expect(report.classification).toBe("up_to_date");
    const lsRemote = await gitOrThrow(
      ["ls-remote", remote, "refs/heads/main"],
      projectB.paths.storeDir,
    );
    expect(lsRemote.trim().length).toBeGreaterThan(0);
  });
});
