import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { join } from "node:path";
import { rm } from "node:fs/promises";
import type { CommandOutcome } from "../../src/core/output/result.ts";
import type { CommandRunContext, LoadedProject } from "../../src/core/session-module.ts";
import { sessionModule } from "../../src/session/module.ts";
const sessionModules = [sessionModule];
import { runStatus } from "../../src/core/commands/status.ts";
import { loadProject } from "../../src/core/project/load.ts";
import { git, gitOrThrow } from "../../src/core/store/git.ts";
import { ProjectStore } from "../../src/core/store/store.ts";
import { runSync } from "../../src/core/store/sync.ts";
import { archiveCommand, unarchiveCommand } from "../../src/session/commands/archive.ts";
import { candidatesCommand } from "../../src/session/commands/candidates.ts";
import { exportCommand } from "../../src/session/commands/export.ts";
import { listCommand } from "../../src/session/commands/list.ts";
import { searchCommand } from "../../src/session/commands/search.ts";
import { showCommand } from "../../src/session/commands/show.ts";
import { viewCommand } from "../../src/session/commands/view.ts";
import {
  ARCHIVE_SCHEMA_VERSION,
  archiveMarkerPath,
  archiveStateFor,
  mergeArchiveMarker,
  readArchiveMarker,
  transitionSessionArchive,
  type ArchiveMarker,
} from "../../src/session/domain/archive.ts";
import { runDelete } from "../../src/session/domain/delete.ts";
import { isTombstoned } from "../../src/session/domain/deletion.ts";
import { sessionIdOf } from "../../src/session/domain/identity.ts";
import { runImport } from "../../src/session/domain/import.ts";
import { ensureProjection } from "../../src/session/projection/publish.ts";
import { listSessions, openProjection } from "../../src/session/projection/query.ts";
import { readSessionMeta } from "../../src/session/storage/store-layout.ts";
import {
  initAt,
  initProject,
  makeBareRemote,
  makeSecondReplica,
  makeTestEnv,
  setDeclaredRemote,
  writeClaudeSession,
  type TestEnv,
} from "../helpers.ts";

setDefaultTimeout(60_000);

let env: TestEnv;
let project: LoadedProject;
let ctx: CommandRunContext;
const sourceSessionId = "archive-main";
const sessionId = sessionIdOf({ harnessId: "claude-code", sourceSessionId });

beforeEach(async () => {
  env = await makeTestEnv();
  project = await initProject(env);
  ctx = { project, env: env.env, jsonMode: false, inputDisabled: true };
  await writeClaudeSession(env.claudeHome, {
    sessionId: sourceSessionId,
    cwd: env.worktree,
    userText: "unique archive needle",
  });
  await importInto(project, env.env);
});

afterEach(async () => {
  await env.cleanup();
});

type Env = Record<string, string | undefined>;

const importInto = (
  target: LoadedProject,
  targetEnv: Env,
  onlyCandidateIds: string[] | null = null,
  acceptTombstoned = false,
) =>
  runImport(target, targetEnv, {
    harness: null,
    dryRun: false,
    onlyCandidateIds,
    acceptTombstoned,
  });

function outcomeJson<T>(outcome: CommandOutcome): T {
  return outcome.json as T;
}

async function headOf(target = project): Promise<string> {
  return await new ProjectStore(target.paths.storeDir).head();
}

async function writeMarker(
  target: LoadedProject,
  marker: ArchiveMarker,
  message: string,
): Promise<string> {
  const path = join(target.paths.storeDir, archiveMarkerPath(marker.sessionId));
  await Bun.write(path, JSON.stringify(marker, null, 2) + "\n");
  return await new ProjectStore(target.paths.storeDir).commitAll(message);
}

describe("Session Archive", () => {
  test("collection filtering, direct addressing, preview, no-op, status, and rebuild follow the contract", async () => {
    const markerFile = join(project.paths.storeDir, archiveMarkerPath(sessionId));
    const initialHead = await headOf();

    const dry = await archiveCommand.run(ctx, [sessionId], { dryRun: true });
    expect(outcomeJson<{ applied: boolean }>(dry).applied).toBeFalse();
    expect(dry.human).toContain("does not remove evidence");
    expect(await headOf()).toBe(initialHead);
    expect(await Bun.file(markerFile).exists()).toBeFalse();

    await expect(archiveCommand.run(ctx, [sessionId], {})).rejects.toMatchObject({
      code: "INPUT_REQUIRED",
    });
    expect(await headOf()).toBe(initialHead);
    expect(await Bun.file(markerFile).exists()).toBeFalse();

    const archived = await archiveCommand.run(ctx, [sessionId], { yes: true });
    expect(outcomeJson<{ applied: boolean; nextState: string }>(archived)).toMatchObject({
      applied: true,
      nextState: "archived",
    });
    expect(archived.human).toContain("no space was reclaimed");
    expect((await readArchiveMarker(project.paths.storeDir, sessionId))?.state).toBe("archived");

    const listed = await listCommand.run(ctx, [], {});
    expect(outcomeJson<{ totalSessions: number }>(listed).totalSessions).toBe(0);
    const included = await listCommand.run(ctx, [], { includeArchived: true });
    expect(included.human).toContain("[archived]");
    expect(
      outcomeJson<{ sessions: { archiveState: string }[] }>(included).sessions[0],
    ).toMatchObject({ sessionId, archiveState: "archived" });

    const search = await searchCommand.run(ctx, ["archive needle"], {});
    expect(outcomeJson<{ totalMatches: number }>(search).totalMatches).toBe(0);
    const includedSearch = await searchCommand.run(ctx, ["archive needle"], {
      includeArchived: true,
    });
    expect(includedSearch.human).toContain("[archived]");
    expect(
      outcomeJson<{ matches: { sessionId: string; archiveState: string }[] }>(includedSearch)
        .matches[0],
    ).toMatchObject({ sessionId, archiveState: "archived" });

    const shown = await showCommand.run(ctx, [sessionId], {});
    expect(shown.human).toContain("archive state: archived");
    expect(outcomeJson<{ session: { archiveState: string } }>(shown).session.archiveState).toBe(
      "archived",
    );

    const candidates = await candidatesCommand.run(ctx, [], { status: ["associated"] });
    expect(candidates.human).toContain("[archived]");
    expect(
      outcomeJson<{ candidates: { candidateId: string; archiveState: string }[] }>(
        candidates,
      ).candidates.find((candidate) => candidate.candidateId === sessionId),
    ).toMatchObject({ archiveState: "archived" });

    const viewed = await viewCommand.run(ctx, [sessionId], {});
    expect(viewed.human).toContain("[archived]");
    expect(outcomeJson<{ session: { archiveState: string } }>(viewed).session.archiveState).toBe(
      "archived",
    );

    const output = join(env.root, "archived-export");
    const exported = await exportCommand.run(ctx, [sessionId], { output });
    expect(exported.human).toContain("archive state archived");
    expect(outcomeJson<{ archiveState: string }>(exported).archiveState).toBe("archived");
    expect(
      (
        JSON.parse(await Bun.file(join(output, "session.json")).text()) as {
          archiveState: string;
        }
      ).archiveState,
    ).toBe("archived");

    const status = await runStatus(project, sessionModules, env.env);
    expect(status.human).toContain("archived=1");
    expect(outcomeJson<{ session: { archived: number } }>(status).session.archived).toBe(1);

    const beforeNoop = await headOf();
    const noop = await archiveCommand.run(ctx, [sessionId], { yes: true });
    expect(outcomeJson<{ applied: boolean }>(noop).applied).toBeFalse();
    expect(noop.human).toContain("Nothing to do");
    expect(await headOf()).toBe(beforeNoop);

    await rm(project.paths.sessionCacheDir, { recursive: true, force: true });
    const rebuilt = await ensureProjection(project, env.env);
    const db = openProjection(rebuilt.dbPath);
    try {
      expect(listSessions(db)).toEqual([]);
      expect(listSessions(db, true)[0]?.archiveState).toBe("archived");
    } finally {
      db.close();
    }

    await unarchiveCommand.run(ctx, [sessionId], { yes: true });
    const marker = await readArchiveMarker(project.paths.storeDir, sessionId);
    expect(marker?.state).toBe("active");
    expect(await Bun.file(markerFile).exists()).toBeTrue();
    const restored = await listCommand.run(ctx, [], {});
    expect(outcomeJson<{ totalSessions: number }>(restored).totalSessions).toBe(1);

    const beforeUnarchiveNoop = await headOf();
    const unarchiveNoop = await unarchiveCommand.run(ctx, [sessionId], { yes: true });
    expect(outcomeJson<{ applied: boolean }>(unarchiveNoop).applied).toBeFalse();
    expect(await headOf()).toBe(beforeUnarchiveNoop);
  });

  test("transitions change only marker metadata; a new Revision is accepted and stays hidden", async () => {
    const storeDir = project.paths.storeDir;
    const beforeHead = await headOf();
    const sessionTreeBefore = (
      await gitOrThrow(["rev-parse", `HEAD:session/sessions/${sessionId}`], storeDir)
    ).trim();
    const digestBefore = (await readSessionMeta(storeDir, sessionId))!.currentRevision.digest;

    const report = await transitionSessionArchive(project, env.env, sessionId, "archived");
    expect(report.applied).toBeTrue();
    const changed = (
      await gitOrThrow(
        ["diff-tree", "--no-commit-id", "--name-only", "-r", report.storeCommit],
        storeDir,
      )
    )
      .trim()
      .split("\n");
    expect(changed).toEqual([archiveMarkerPath(sessionId)]);
    expect(
      (await gitOrThrow(["rev-parse", `HEAD:session/sessions/${sessionId}`], storeDir)).trim(),
    ).toBe(sessionTreeBefore);
    expect(
      (
        await gitOrThrow(["rev-parse", `${beforeHead}:session/sessions/${sessionId}`], storeDir)
      ).trim(),
    ).toBe(sessionTreeBefore);
    expect((await readSessionMeta(storeDir, sessionId))!.currentRevision.digest).toBe(digestBefore);

    await writeClaudeSession(env.claudeHome, {
      sessionId: sourceSessionId,
      cwd: env.worktree,
      userText: "unique archive needle with a newly accepted revision",
    });
    const imported = await importInto(project, env.env);
    expect(imported.accepted).toHaveLength(1);
    expect(imported.accepted[0]!.revision).not.toBe(digestBefore);
    expect(await archiveStateFor(storeDir, sessionId)).toBe("archived");

    const handle = await ensureProjection(project, env.env);
    const db = openProjection(handle.dbPath);
    try {
      expect(listSessions(db)).toEqual([]);
      expect(listSessions(db, true)[0]?.revisionDigest).toBe(imported.accepted[0]!.revision);
    } finally {
      db.close();
    }
  });

  test("deletion purges the marker and history; explicit re-admission returns active", async () => {
    await transitionSessionArchive(project, env.env, sessionId, "archived");
    const markerPath = archiveMarkerPath(sessionId);
    expect(await Bun.file(join(project.paths.storeDir, markerPath)).exists()).toBeTrue();

    await runDelete(project, env.env, sessionId);
    expect(await Bun.file(join(project.paths.storeDir, markerPath)).exists()).toBeFalse();
    expect(await isTombstoned(project.paths.storeDir, sessionId)).toBeTrue();
    await expect(archiveCommand.run(ctx, [sessionId], { yes: true })).rejects.toMatchObject({
      code: "SESSION_DELETED",
    });
    const historyProbe = await git(
      ["log", "-S", sessionId, "--", markerPath],
      project.paths.storeDir,
    );
    expect(historyProbe.stdout.trim()).toBe("");

    const admitted = await importInto(project, env.env, [sessionId], true);
    expect(admitted.accepted).toHaveLength(1);
    expect(await archiveStateFor(project.paths.storeDir, sessionId)).toBe("active");
  });

  test("unknown IDs are NOT_FOUND and newer marker state is STATE_TOO_NEW", async () => {
    await expect(archiveCommand.run(ctx, ["ses_unknown"], { yes: true })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });

    await transitionSessionArchive(project, env.env, sessionId, "archived");
    const marker = (await readArchiveMarker(project.paths.storeDir, sessionId))!;
    await Bun.write(
      join(project.paths.storeDir, archiveMarkerPath(sessionId)),
      JSON.stringify({ ...marker, schemaVersion: ARCHIVE_SCHEMA_VERSION + 1 }) + "\n",
    );
    await expect(archiveStateFor(project.paths.storeDir, sessionId)).rejects.toMatchObject({
      code: "STATE_TOO_NEW",
      details: {
        stateKind: "Session archive marker",
        foundVersion: ARCHIVE_SCHEMA_VERSION + 1,
        supportedVersion: ARCHIVE_SCHEMA_VERSION,
      },
    });
  });

  test("shared archive state synchronizes and restores default filtering on another Replica", async () => {
    const remote = await makeBareRemote(env);
    await setDeclaredRemote(env.worktree, remote);
    project = await loadProject(env.worktree, env.home);
    await runSync(project, env.env, sessionModules);

    const replicaB = await makeSecondReplica(env, "archive-b");
    const projectB = await initAt(replicaB.worktree, replicaB.home);
    await transitionSessionArchive(project, env.env, sessionId, "archived");
    await runSync(project, env.env, sessionModules);
    const received = await runSync(projectB, replicaB.env, sessionModules);
    expect(received.conflicted).toEqual([]);
    expect(await archiveStateFor(projectB.paths.storeDir, sessionId)).toBe("archived");

    const handle = await ensureProjection(projectB, replicaB.env);
    const db = openProjection(handle.dbPath);
    try {
      expect(listSessions(db)).toEqual([]);
      expect(listSessions(db, true)[0]?.sessionId).toBe(sessionId);
    } finally {
      db.close();
    }
  });

  test("divergent markers merge by timestamp then Replica ID without a Session Conflict", async () => {
    const remote = await makeBareRemote(env);
    await setDeclaredRemote(env.worktree, remote);
    project = await loadProject(env.worktree, env.home);
    await transitionSessionArchive(project, env.env, sessionId, "archived");
    await runSync(project, env.env, sessionModules);

    const replicaB = await makeSecondReplica(env, "archive-merge-b");
    const projectB = await initAt(replicaB.worktree, replicaB.home);
    const tiedAt = "2026-07-20T00:00:00.000Z";
    const aWins = project.replicaId.localeCompare(projectB.replicaId) > 0;
    const markerA: ArchiveMarker = {
      schemaVersion: ARCHIVE_SCHEMA_VERSION,
      sessionId,
      state: aWins ? "active" : "archived",
      transitionedAt: tiedAt,
      replicaId: project.replicaId,
    };
    const markerB: ArchiveMarker = {
      schemaVersion: ARCHIVE_SCHEMA_VERSION,
      sessionId,
      state: aWins ? "archived" : "active",
      transitionedAt: tiedAt,
      replicaId: projectB.replicaId,
    };
    await writeMarker(project, markerA, "test: transition A");
    await writeMarker(projectB, markerB, "test: transition B");
    await runSync(project, env.env, sessionModules);
    const merged = await runSync(projectB, replicaB.env, sessionModules);

    expect(merged.classification).toBe("diverged");
    expect(merged.conflicted).toEqual([]);
    expect(merged.merged).toBeGreaterThanOrEqual(1);
    const expected = mergeArchiveMarker(markerA, markerB);
    expect(await readArchiveMarker(projectB.paths.storeDir, sessionId)).toEqual(expected);

    const firstParent = await gitOrThrow(
      ["show", `HEAD^1:${archiveMarkerPath(sessionId)}`],
      projectB.paths.storeDir,
    );
    const secondParent = await gitOrThrow(
      ["show", `HEAD^2:${archiveMarkerPath(sessionId)}`],
      projectB.paths.storeDir,
    );
    expect([firstParent, secondParent].join("\n")).toContain(markerA.replicaId);
    expect([firstParent, secondParent].join("\n")).toContain(markerB.replicaId);
  });

  test("a concurrent Revision advance and archive transition merge independently", async () => {
    const remote = await makeBareRemote(env);
    await setDeclaredRemote(env.worktree, remote);
    project = await loadProject(env.worktree, env.home);
    await runSync(project, env.env, sessionModules);

    const replicaB = await makeSecondReplica(env, "archive-revision-b");
    const projectB = await initAt(replicaB.worktree, replicaB.home);

    await writeClaudeSession(env.claudeHome, {
      sessionId: sourceSessionId,
      cwd: env.worktree,
      userText: "Revision advanced on A while B archives",
    });
    const advanced = await importInto(project, env.env);
    await runSync(project, env.env, sessionModules);

    await transitionSessionArchive(projectB, replicaB.env, sessionId, "archived");
    const merged = await runSync(projectB, replicaB.env, sessionModules);
    expect(merged.conflicted).toEqual([]);
    expect(await archiveStateFor(projectB.paths.storeDir, sessionId)).toBe("archived");
    expect(
      (await readSessionMeta(projectB.paths.storeDir, sessionId))!.currentRevision.digest,
    ).toBe(advanced.accepted[0]!.revision);
  });
});
