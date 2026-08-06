import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cp, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import {
  runProjectAdopt,
  runProjectBind,
  runProjectList,
  type MachineCommandContext,
} from "../../src/core/commands/project.ts";
import { createDeclaration, writeDeclaration } from "../../src/core/config/glia-json.ts";
import { normalizeBoundPath, readBindings } from "../../src/core/project/bindings.ts";
import { loadProject } from "../../src/core/project/load.ts";
import { projectPaths } from "../../src/core/project/paths.ts";
import { deletionMarkerBytes, readLocalStoreMarker } from "../../src/core/store/marker.ts";
import { ProjectStore } from "../../src/core/store/store.ts";
import { runSync } from "../../src/core/store/sync.ts";
import type { LoadedProject } from "../../src/core/session-module.ts";
import { runDelete } from "../../src/session/domain/delete.ts";
import {
  candidatesFromSideDir,
  readSessionConflict,
  writeConflictLayout,
} from "../../src/session/domain/conflict.ts";
import { ledgerEventsFor, readLocalLedgerEvents } from "../../src/session/domain/deletion.ts";
import { discoverCandidates } from "../../src/session/domain/discover.ts";
import {
  associateCandidate,
  readDiscoveryState,
  writeDiscoveryState,
} from "../../src/session/domain/discovery-state.ts";
import { runImport } from "../../src/session/domain/import.ts";
import { readWithheldLosses } from "../../src/session/domain/withheld-loss.ts";
import { resolveSessionConflict } from "../../src/session/domain/resolve.ts";
import { sessionDir } from "../../src/session/storage/store-layout.ts";
import { sessionModule } from "../../src/session/module.ts";
import {
  FAKE_KEY,
  makeBareRemote,
  makeSecondWorktree,
  makeTestEnv,
  setDeclaredRemote,
  writeClaudeSession,
  type TestEnv,
} from "../helpers.ts";

let env: TestEnv;
beforeEach(async () => {
  env = await makeTestEnv();
});
afterEach(async () => {
  await env.cleanup();
});

const DECLARED_ID = "prj_declared_by_the_other_machine";

function machineContext(overrides: Partial<MachineCommandContext> = {}): MachineCommandContext {
  return {
    requirement: "machine",
    cwd: env.worktree,
    home: env.home,
    env: env.env,
    jsonMode: false,
    inputDisabled: true,
    ...overrides,
  };
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Imports every discovered Candidate into `project`. */
async function importAll(project: LoadedProject): Promise<string[]> {
  const report = await runImport(project, env.env, {
    harness: null,
    dryRun: false,
    onlyCandidateIds: null,
  });
  return report.accepted.map((accepted) => accepted.sessionId);
}

/**
 * The machine that minted its own Project before pulling a glia.json that
 * declares another one: `worktree` is bound to A and declares B.
 */
async function makeMismatchedWorktree(
  worktree = env.worktree,
  declaredId = DECLARED_ID,
): Promise<LoadedProject> {
  const local = await loadProject(worktree, env.home);
  await writeDeclaration(worktree, createDeclaration(declaredId));
  return local;
}

async function sessionBytes(storeDir: string, sessionId: string): Promise<Record<string, string>> {
  const root = sessionDir(storeDir, sessionId);
  const files: Record<string, string> = {};
  const walk = async (dir: string, prefix: string): Promise<void> => {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) =>
      a.name.localeCompare(b.name),
    )) {
      const child = join(dir, entry.name);
      const name = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(child, name);
      else files[name] = await Bun.file(child).text();
    }
  };
  await walk(root, "");
  return files;
}

describe("glia project adopt", () => {
  test("rebinds the worktree and replays every Session into the declared Project", async () => {
    const local = await makeLocalProjectWithSession();
    const before = await sessionBytes(local.project.paths.storeDir, local.sessionId);

    const result = await runProjectAdopt(machineContext(), undefined);

    expect(result.json).toMatchObject({
      path: env.worktree,
      fromProjectId: local.project.declaration.projectId,
      toProjectId: DECLARED_ID,
      merged: 1,
      skipped: 0,
      conflicts: 0,
      changed: true,
    });
    const declared = projectPaths(env.home, DECLARED_ID);
    expect((await readBindings(declared.bindingsFile))?.roots).toEqual([env.worktree]);
    expect((await readBindings(local.project.paths.bindingsFile))?.roots).toEqual([]);
    expect(await sessionBytes(declared.storeDir, local.sessionId)).toEqual(before);
    expect(before[`session.json`]).toContain("secretDetectionOverride");
    expect(result.human).toContain("glia sync");
  });

  test("emits one JSON document naming both sides and a pure-binding path nulls the from side", async () => {
    const local = await makeLocalProjectWithSession();
    const merged = (await runProjectAdopt(machineContext({ jsonMode: true }), undefined))
      .json as Record<string, unknown>;
    expect(merged).toMatchObject({
      path: env.worktree,
      fromProjectId: local.project.declaration.projectId,
      toProjectId: DECLARED_ID,
      merged: 1,
      skipped: 0,
      conflicts: 0,
      ledgerMigrated: 0,
      fromStoreDir: local.project.paths.storeDir,
      deletedOldProject: false,
      nextSteps: ["glia sync"],
    });
    expect(await pathExists(local.project.paths.projectDir)).toBeTrue();

    const unbound = await makeSecondWorktree(env, "never-enrolled");
    await writeDeclaration(unbound, createDeclaration("prj_pure_binding"));
    const pure = (
      await runProjectAdopt(machineContext({ jsonMode: true, cwd: unbound }), undefined)
    ).json as Record<string, unknown>;
    expect(pure).toMatchObject({
      path: unbound,
      fromProjectId: null,
      toProjectId: "prj_pure_binding",
      merged: 0,
      skipped: 0,
      conflicts: 0,
      ledgerMigrated: 0,
      fromStoreDir: null,
      fromProjectDir: null,
      deletedOldProject: null,
      changed: true,
    });
    expect(
      (await readBindings(projectPaths(env.home, "prj_pure_binding").bindingsFile))?.roots,
    ).toEqual([unbound]);
  });

  test("a later sync merges the adopted Store with an unrelated remote history", async () => {
    const remote = await makeBareRemote(env);
    const other = await makeOtherMachine(remote, "cc-other-machine");
    const local = await makeLocalProjectWithSession(env.worktree, "cc-this-machine");
    await setDeclaredRemote(env.worktree, remote);

    await runProjectAdopt(machineContext(), undefined);
    const adopted = await loadProject(env.worktree, env.home, { allowMissingStore: true });
    const report = await runSync(adopted, env.env, [sessionModule]);

    expect(report.conflicted).toEqual([]);
    expect(report.classification).toBe("diverged");
    const ids = (await readdir(join(adopted.paths.storeDir, "session", "sessions"))).sort();
    expect(ids).toEqual([local.sessionId, other.sessionId].sort());
  });

  test("an empty old Project adopts cleanly and a consistent worktree is a successful no-op", async () => {
    const empty = await makeMismatchedWorktree();
    const first = await runProjectAdopt(machineContext(), undefined);
    expect(first.json).toMatchObject({
      fromProjectId: empty.declaration.projectId,
      merged: 0,
      skipped: 0,
      conflicts: 0,
      changed: true,
    });

    const repeated = await runProjectAdopt(machineContext(), undefined);
    expect(repeated.json).toMatchObject({
      fromProjectId: null,
      toProjectId: DECLARED_ID,
      merged: 0,
      changed: false,
    });
    expect(repeated.human).toContain("Nothing to do");

    const consistent = await makeSecondWorktree(env, "already-consistent");
    const self = await loadProject(consistent, env.home);
    await writeDeclaration(consistent, self.declaration);
    const noop = await runProjectAdopt(machineContext({ cwd: consistent }), undefined);
    expect(noop.json).toMatchObject({
      fromProjectId: null,
      toProjectId: self.declaration.projectId,
      merged: 0,
      changed: false,
    });
  });

  test("a rerun after an interrupted merge completes the remaining Sessions", async () => {
    const local = await makeLocalProjectWithSessions(["cc-partial-a", "cc-partial-b"]);
    // Model the interruption: the first Session already landed in the
    // declared Project's Store, but the rebinding never happened.
    const declared = projectPaths(env.home, DECLARED_ID);
    await new ProjectStore(declared.storeDir).init(DECLARED_ID);
    await cp(
      sessionDir(local.project.paths.storeDir, local.sessionIds[0]!),
      sessionDir(declared.storeDir, local.sessionIds[0]!),
      { recursive: true },
    );
    await new ProjectStore(declared.storeDir).commitAll("test: partial adopt");

    const result = await runProjectAdopt(machineContext(), undefined);
    expect(result.json).toMatchObject({ merged: 1, skipped: 1, conflicts: 0 });
    const ids = (await readdir(join(declared.storeDir, "session", "sessions"))).sort();
    expect(ids).toEqual([...local.sessionIds].sort());
  });

  test("an identical Revision digest is skipped even when its acceptance bytes differ", async () => {
    const local = await makeLocalProjectWithSessions(["cc-same-digest"]);
    const sessionId = local.sessionIds[0]!;
    const staged = await stageCopy(
      local.project.paths.storeDir,
      sessionId,
      join(env.root, "same-digest"),
      null,
    );
    const metaFile = join(staged, "session.json");
    const meta = JSON.parse(await Bun.file(metaFile).text()) as {
      currentRevision: { acceptedAt: string };
    };
    meta.currentRevision.acceptedAt = "2020-01-01T00:00:00.000Z";
    await Bun.write(metaFile, JSON.stringify(meta, null, 2) + "\n");
    const declaredStore = await seedDeclaredStore(sessionId, staged);

    const result = await runProjectAdopt(machineContext(), undefined);

    expect(result.json).toMatchObject({ merged: 0, skipped: 1, conflicts: 0 });
    const kept = JSON.parse(
      await Bun.file(join(sessionDir(declaredStore, sessionId), "session.json")).text(),
    ) as { currentRevision: { acceptedAt: string } };
    expect(kept.currentRevision.acceptedAt).toBe("2020-01-01T00:00:00.000Z");
  });

  test("a differing Revision freezes a Session Conflict that glia resolve settles", async () => {
    const local = await makeLocalProjectWithSessions(["cc-diverged"]);
    const sessionId = local.sessionIds[0]!;
    const staged = await stageCopy(
      local.project.paths.storeDir,
      sessionId,
      join(env.root, "diverged"),
      "d".repeat(64),
    );
    const declaredStore = await seedDeclaredStore(sessionId, staged);

    const result = await runProjectAdopt(machineContext(), undefined);
    expect(result.json).toMatchObject({ merged: 0, skipped: 0, conflicts: 1 });
    const conflict = await readSessionConflict(declaredStore, sessionId);
    expect(conflict?.candidates).toHaveLength(2);

    const adopted = await loadProject(env.worktree, env.home);
    const resolved = await resolveSessionConflict(adopted, env.env, sessionId, "d".repeat(64));
    expect(resolved.revision).toBe("d".repeat(64));
    expect(await readSessionConflict(declaredStore, sessionId)).toBeNull();
  });

  test("a Session already frozen in the old Project migrates whole and unions with the target", async () => {
    const local = await makeLocalProjectWithSessions(["cc-prefrozen"]);
    const sessionId = local.sessionIds[0]!;
    const storeDir = local.project.paths.storeDir;
    const left = await stageCopy(storeDir, sessionId, join(env.root, "left"), null);
    const right = await stageCopy(storeDir, sessionId, join(env.root, "right"), "b".repeat(64));
    const third = await stageCopy(storeDir, sessionId, join(env.root, "third"), "c".repeat(64));
    await writeConflictLayout(storeDir, sessionId, [
      ...(await candidatesFromSideDir(left)),
      ...(await candidatesFromSideDir(right)),
    ]);
    await new ProjectStore(storeDir).commitAll("test: freeze a conflict in the old Project");
    const declaredStore = await seedDeclaredStore(sessionId, third);

    const result = await runProjectAdopt(machineContext(), undefined);

    expect(result.json).toMatchObject({ merged: 0, skipped: 0, conflicts: 1 });
    const conflict = await readSessionConflict(declaredStore, sessionId);
    expect(conflict?.candidates.map((candidate) => candidate.digest).sort()).toEqual(
      ["b".repeat(64), "c".repeat(64), local.digests[sessionId]!].sort(),
    );
  });

  test("tombstones migrate into fresh epoch slots and keep blocking re-import", async () => {
    const local = await makeLocalProjectWithSessions(["cc-doomed"]);
    const sessionId = local.sessionIds[0]!;
    await runDelete(local.project, env.env, sessionId);
    // The declared Project already rewrote its own history five times.
    const declared = projectPaths(env.home, DECLARED_ID);
    const declaredStore = new ProjectStore(declared.storeDir);
    await declaredStore.init(DECLARED_ID);
    await Bun.write(join(declared.storeDir, "store.json"), deletionMarkerBytes(DECLARED_ID, 5));
    await declaredStore.commitAll("test: advance the declared Store epoch");

    const result = await runProjectAdopt(machineContext(), undefined);

    expect(result.json).toMatchObject({ merged: 0, skipped: 0, conflicts: 0, ledgerMigrated: 1 });
    const events = await ledgerEventsFor(declared.storeDir, sessionId);
    expect(events.map((event) => event.epoch)).toEqual([6]);
    expect((await readLocalStoreMarker(declared.storeDir))?.epoch).toBe(6);
    expect(await readLocalLedgerEvents(declared.storeDir)).toHaveLength(1);

    // The Harness source is still there; it must not come back to life.
    const adopted = await loadProject(env.worktree, env.home);
    const report = await runImport(adopted, env.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: null,
    });
    expect(report.accepted).toHaveLength(0);
    expect(report.tombstoned.map((entry) => entry["candidateId"])).toEqual([sessionId]);
  });

  test("Candidate associations follow the adopting Project and withheld evaluations become loss records", async () => {
    const detached = join(env.root, "removed-checkout");
    await writeClaudeSession(env.claudeHome, { sessionId: "cc-detached", cwd: detached });
    await writeClaudeSession(env.claudeHome, {
      sessionId: "cc-withheld",
      cwd: env.worktree,
      userText: `the key is ${FAKE_KEY}`,
    });
    const project = await loadProject(env.worktree, env.home);
    const withheldReport = await runImport(project, env.env, {
      harness: null,
      dryRun: false,
      onlyCandidateIds: null,
    });
    expect(withheldReport.flagged).toHaveLength(1);
    const pending = withheldReport.pending[0]!["candidateId"] as string;
    const state = await readDiscoveryState(project.paths.discoveryFile);
    expect(Object.keys(state.evaluations)).toHaveLength(1);
    associateCandidate(state, pending, project.declaration.projectId);
    await writeDiscoveryState(project.paths.discoveryFile, state);
    await writeDeclaration(env.worktree, createDeclaration(DECLARED_ID));

    const result = await runProjectAdopt(machineContext(), undefined);

    expect(result.json).toMatchObject({ associationsRewritten: 1, withheldDropped: 1 });
    const declared = projectPaths(env.home, DECLARED_ID);
    const adoptedState = await readDiscoveryState(declared.discoveryFile);
    expect(adoptedState.associations[pending]?.projectId).toBe(DECLARED_ID);
    expect(adoptedState.evaluations).toEqual({});
    const losses = await readWithheldLosses(declared.withheldLossFile);
    expect(losses.map((loss) => loss.candidateId)).toEqual(Object.keys(state.evaluations));
    expect((await readDiscoveryState(project.paths.discoveryFile)).evaluations).toEqual({});

    const adopted = await loadProject(env.worktree, env.home);
    const discovery = await discoverCandidates(adopted, env.env, null);
    const entry = discovery.candidates.find((c) => c.candidate.candidateId === pending);
    expect(entry?.classification).toEqual({ kind: "associated", via: "explicit" });
  });

  test("previews the consequences, and cancelling leaves every Binding and Store untouched", async () => {
    const local = await makeLocalProjectWithSessions(["cc-preview"]);
    const headBefore = await new ProjectStore(local.project.paths.storeDir).head();
    let preview = "";

    await expect(
      runProjectAdopt(machineContext({ inputDisabled: false }), undefined, {
        confirm: async (message) => {
          preview = message;
          return false;
        },
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });

    expect(preview).toContain(local.project.declaration.projectId);
    expect(preview).toContain(DECLARED_ID);
    expect(preview).toContain("Merge 1 Session(s)");
    expect(preview).toContain("destroys its Store Git history");
    expect(preview).toContain("glia sync");
    expect((await readBindings(local.project.paths.bindingsFile))?.roots).toEqual([env.worktree]);
    expect(await new ProjectStore(local.project.paths.storeDir).head()).toBe(headBefore);
    expect(await pathExists(projectPaths(env.home, DECLARED_ID).projectDir)).toBeFalse();
  });

  test("the delete question defaults to no, and an accepted delete removes the old Project", async () => {
    const local = await makeLocalProjectWithSessions(["cc-deletable"]);
    let deleteQuestion = "";
    const kept = await runProjectAdopt(machineContext({ inputDisabled: false }), undefined, {
      confirm: async () => true,
      confirmDelete: async (message) => {
        deleteQuestion = message;
        return false;
      },
    });
    expect(deleteQuestion).toContain(local.project.declaration.projectId);
    expect(deleteQuestion).toContain("destroys");
    expect(kept.json).toMatchObject({ merged: 1, deletedOldProject: false });
    expect(await pathExists(local.project.paths.projectDir)).toBeTrue();
    const listed = (await runProjectList(machineContext())).json as {
      projects: { projectId: string }[];
    };
    expect(listed.projects.map((entry) => entry.projectId)).toContain(
      local.project.declaration.projectId,
    );

    const removed = await runProjectAdopt(machineContext({ inputDisabled: false }), undefined, {
      confirm: async () => true,
      confirmDelete: async () => true,
    });
    // The rebinding already happened, so the rerun has nothing left to merge.
    expect(removed.json).toMatchObject({ fromProjectId: null, deletedOldProject: null });
    expect(await pathExists(local.project.paths.projectDir)).toBeTrue();
  });

  test("--delete-old removes the old Project once the merge lands", async () => {
    const local = await makeLocalProjectWithSessions(["cc-flagged-delete"]);
    const result = await runProjectAdopt(machineContext(), undefined, { deleteOld: true });

    expect(result.json).toMatchObject({ merged: 1, deletedOldProject: true });
    expect(await pathExists(local.project.paths.projectDir)).toBeFalse();
    const listed = (await runProjectList(machineContext())).json as {
      projects: { projectId: string }[];
    };
    expect(listed.projects.map((entry) => entry.projectId)).toEqual([DECLARED_ID]);
  });

  test("an old Project with other bindings survives, is never offered for deletion, and refuses the flag", async () => {
    const local = await makeLocalProjectWithSessions(["cc-multi-checkout"]);
    const second = await makeSecondWorktree(env, "second-checkout");
    await runProjectBind(machineContext(), local.project.declaration.projectId, second, false);

    await expect(
      runProjectAdopt(machineContext(), undefined, { deleteOld: true }),
    ).rejects.toMatchObject({
      code: "USAGE",
      details: {
        projectId: local.project.declaration.projectId,
        remainingBindings: [normalizeBoundPath(second)],
      },
    });
    expect(await pathExists(local.project.paths.projectDir)).toBeTrue();

    let preview = "";
    let askedToDelete = false;
    const result = await runProjectAdopt(machineContext({ inputDisabled: false }), undefined, {
      confirm: async (message) => {
        preview = message;
        return true;
      },
      confirmDelete: async () => {
        askedToDelete = true;
        return true;
      },
    });

    expect(preview).toContain(normalizeBoundPath(second));
    expect(askedToDelete).toBeFalse();
    expect(result.json).toMatchObject({
      merged: 1,
      deletedOldProject: false,
      remainingBindings: [normalizeBoundPath(second)],
    });
    expect((await readBindings(local.project.paths.bindingsFile))?.roots).toEqual([
      normalizeBoundPath(second),
    ]);
    expect(await pathExists(local.project.paths.projectDir)).toBeTrue();
  });

  test("a declaration mismatch points at adopt from every entry point", async () => {
    const local = await makeMismatchedWorktree();
    await expect(loadProject(env.worktree, env.home)).rejects.toMatchObject({
      code: "BINDING_CONFLICT",
      nextSteps: [
        `glia project adopt ${env.worktree}`,
        "glia project list",
        `glia project forget ${env.worktree}`,
      ],
    });
    await expect(
      runProjectBind(machineContext(), local.declaration.projectId, env.worktree, false),
    ).rejects.toMatchObject({
      code: "BINDING_CONFLICT",
      nextSteps: [`glia project adopt ${env.worktree}`, "glia project list"],
    });
  });

  test("refuses a worktree with no declaration and reports a stable code", async () => {
    await loadProject(env.worktree, env.home);
    await expect(runProjectAdopt(machineContext(), undefined)).rejects.toMatchObject({
      code: "NO_DECLARATION",
      nextSteps: ["glia project list", "glia import"],
    });
  });
});

/**
 * Copies one stored Session aside, optionally restamping its Revision, so
 * a test can present the declared Project with a differing side.
 */
async function stageCopy(
  storeDir: string,
  sessionId: string,
  dest: string,
  digest: string | null,
): Promise<string> {
  await rm(dest, { recursive: true, force: true });
  await cp(sessionDir(storeDir, sessionId), dest, { recursive: true });
  if (digest !== null) {
    const metaFile = join(dest, "session.json");
    const meta = JSON.parse(await Bun.file(metaFile).text()) as {
      currentRevision: { digest: string };
    };
    meta.currentRevision.digest = digest;
    await Bun.write(metaFile, JSON.stringify(meta, null, 2) + "\n");
  }
  return dest;
}

/** Gives the declared Project a local Store already holding `sourceDir`. */
async function seedDeclaredStore(sessionId: string, sourceDir: string): Promise<string> {
  const declared = projectPaths(env.home, DECLARED_ID);
  await new ProjectStore(declared.storeDir).init(DECLARED_ID);
  const target = sessionDir(declared.storeDir, sessionId);
  await rm(target, { recursive: true, force: true });
  await cp(sourceDir, target, { recursive: true });
  await new ProjectStore(declared.storeDir).commitAll("test: seed the declared Store");
  return declared.storeDir;
}

/** A second machine (its own GLIA_HOME) that already published to `remote`. */
async function makeOtherMachine(remote: string, sessionId: string): Promise<{ sessionId: string }> {
  const worktree = await makeSecondWorktree(env, "other-machine");
  const home = join(env.root, "glia-home-other");
  const claudeHome = join(env.root, "claude-home-other");
  const otherEnv = { ...env.env, GLIA_HOME: home, CLAUDE_CONFIG_DIR: claudeHome };
  const declaration = createDeclaration(DECLARED_ID);
  declaration.store = { remote };
  await writeDeclaration(worktree, declaration);
  await writeClaudeSession(claudeHome, { sessionId, cwd: worktree });
  const project = await loadProject(worktree, home, { allowMissingStore: true });
  await runSync(project, otherEnv, [sessionModule]);
  const accepted = await runImport(project, otherEnv, {
    harness: null,
    dryRun: false,
    onlyCandidateIds: null,
  });
  await runSync(project, otherEnv, [sessionModule]);
  return { sessionId: accepted.accepted[0]!.sessionId };
}

/** A worktree bound to a freshly minted Project holding several Sessions. */
async function makeLocalProjectWithSessions(
  sourceSessionIds: string[],
  worktree = env.worktree,
): Promise<{ project: LoadedProject; sessionIds: string[]; digests: Record<string, string> }> {
  for (const sessionId of sourceSessionIds) {
    await writeClaudeSession(env.claudeHome, { sessionId, cwd: worktree });
  }
  const project = await loadProject(worktree, env.home);
  const report = await runImport(project, env.env, {
    harness: null,
    dryRun: false,
    onlyCandidateIds: null,
  });
  if (report.accepted.length !== sourceSessionIds.length) {
    throw new Error(`fixture import accepted ${report.accepted.length} Sessions`);
  }
  await writeDeclaration(worktree, createDeclaration(DECLARED_ID));
  return {
    project,
    sessionIds: report.accepted.map((accepted) => accepted.sessionId),
    digests: Object.fromEntries(
      report.accepted.map((accepted) => [accepted.sessionId, accepted.revision]),
    ),
  };
}

/** A worktree bound to a freshly minted Project holding one imported Session. */
async function makeLocalProjectWithSession(
  worktree = env.worktree,
  sessionId = "cc-adopt-1",
): Promise<{ project: LoadedProject; sessionId: string }> {
  await writeClaudeSession(env.claudeHome, {
    sessionId,
    cwd: worktree,
    userText: `rotate the token ${["sk-ant", "api03-FAKEFAKEFAKEFAKE"].join("-")}`,
  });
  const project = await loadProject(worktree, env.home);
  await runImport(project, env.env, { harness: null, dryRun: false, onlyCandidateIds: null });
  const discovery = await discoverCandidates(project, env.env, null);
  const candidateId = discovery.candidates[0]!.candidate.candidateId;
  const accepted = await runImport(project, env.env, {
    harness: null,
    dryRun: false,
    onlyCandidateIds: [candidateId],
    overrideFlagged: true,
  });
  if (accepted.accepted.length !== 1) {
    throw new Error(`fixture import accepted ${accepted.accepted.length} Sessions`);
  }
  await writeDeclaration(worktree, createDeclaration(DECLARED_ID));
  return { project, sessionId: accepted.accepted[0]!.sessionId };
}
