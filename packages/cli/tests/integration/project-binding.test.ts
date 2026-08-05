import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import {
  runProjectBind,
  runProjectForget,
  runProjectList,
  type MachineCommandContext,
} from "../../src/core/commands/project.ts";
import {
  BindingIndex,
  emptyBindings,
  readBindings,
  writeBindings,
} from "../../src/core/project/bindings.ts";
import { loadExistingProject, loadProject } from "../../src/core/project/load.ts";
import { bindingsLockFile, projectPaths } from "../../src/core/project/paths.ts";
import { WriterLease } from "../../src/core/store/lease.ts";
import { ProjectStore } from "../../src/core/store/store.ts";
import { gitOrThrow } from "../../src/core/store/git.ts";
import { createDeclaration, writeDeclaration } from "../../src/core/config/glia-json.ts";
import { initProject, makeSecondWorktree, makeTestEnv, type TestEnv } from "../helpers.ts";

let env: TestEnv;
beforeEach(async () => {
  env = await makeTestEnv();
});
afterEach(async () => {
  await env.cleanup();
});

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

describe("Project Binding commands", () => {
  test("list is machine-scoped, empty, and side-effect free", async () => {
    const outside = join(env.root, "outside");
    await mkdir(outside);
    const result = await runProjectList(machineContext({ cwd: outside }));

    expect(result.json).toEqual({ projects: [] });
    expect(result.human).toContain("No Projects");
    expect(await pathExists(env.home)).toBeFalse();
  });

  test("list isolates unreadable Bindings and reports missing, rootless, and unsynced states", async () => {
    const project = await initProject(env);
    const missing = join(env.root, "deleted-checkout");
    await writeBindings(project.paths.bindingsFile, {
      schemaVersion: 1,
      projectId: project.declaration.projectId,
      roots: [missing],
      aliases: [env.worktree],
    });
    const inventorySession = join(project.paths.storeDir, "session", "sessions", "ses_inventory");
    await mkdir(inventorySession, {
      recursive: true,
    });
    await Bun.write(join(inventorySession, "session.json"), "{}\n");
    await new ProjectStore(project.paths.storeDir).commitAll("test: add inventory Session");
    const inFlightSession = join(project.paths.storeDir, "session", "sessions", "ses_in_flight");
    await mkdir(inFlightSession, { recursive: true });
    await Bun.write(join(inFlightSession, "session.json"), "{}\n");

    const historyOnlyId = "prj_history_only";
    await writeBindings(projectPaths(env.home, historyOnlyId).bindingsFile, {
      ...emptyBindings(historyOnlyId),
      aliases: [join(env.root, "old-checkout")],
    });
    const damagedId = "prj_damaged";
    const damaged = projectPaths(env.home, damagedId).bindingsFile;
    await mkdir(join(env.home, "projects", damagedId, "state"), { recursive: true });
    await Bun.write(damaged, '{"schemaVersion":999');

    const lockBefore = await stat(bindingsLockFile(env.home));
    const result = await runProjectList(machineContext());
    const projects = (result.json as { projects: Record<string, unknown>[] }).projects;
    expect(projects).toHaveLength(3);
    expect(
      projects.find((entry) => entry["projectId"] === project.declaration.projectId),
    ).toMatchObject({
      roots: [{ path: missing, missing: true }],
      aliases: [{ path: env.worktree, missing: false }],
      captureState: "capturing",
      storeState: "available",
      sessionCount: 1,
    });
    expect(projects.find((entry) => entry["projectId"] === historyOnlyId)).toMatchObject({
      roots: [],
      captureState: "history_only",
      storeState: "not_yet_synced",
      sessionCount: null,
    });
    expect(projects.find((entry) => entry["projectId"] === damagedId)).toMatchObject({
      unreadable: { code: "INTERNAL" },
    });
    const lockAfter = await stat(bindingsLockFile(env.home));
    expect({ size: lockAfter.size, mtimeMs: lockAfter.mtimeMs }).toEqual({
      size: lockBefore.size,
      mtimeMs: lockBefore.mtimeMs,
    });
  });

  test("bind is idempotent, moves paths between root and alias, and rejects conflicts", async () => {
    const first = await initProject(env);
    const otherWorktree = await makeSecondWorktree(env, "other-project");
    const other = await loadProject(otherWorktree, env.home);
    const reclaimed = await makeSecondWorktree(env, "reclaimed");
    const nestedPath = join(reclaimed, "src");
    await mkdir(nestedPath);

    await expect(
      runProjectBind(machineContext(), first.declaration.projectId, otherWorktree, false),
    ).rejects.toMatchObject({ code: "BINDING_CONFLICT" });
    await expect(
      runProjectBind(machineContext(), "prj_unknown", reclaimed, false),
    ).rejects.toMatchObject({ code: "PROJECT_NOT_FOUND" });

    const aliased = await runProjectBind(
      machineContext(),
      first.declaration.projectId,
      nestedPath,
      true,
    );
    expect(aliased.json).toMatchObject({ changed: true, kind: "alias", previousKind: null });
    const repeated = await runProjectBind(
      machineContext(),
      first.declaration.projectId,
      nestedPath,
      true,
    );
    expect(repeated.json).toMatchObject({ changed: false, kind: "alias" });

    await runProjectBind(machineContext(), first.declaration.projectId, nestedPath, false);
    let bindings = await readBindings(first.paths.bindingsFile);
    expect(bindings?.roots).toContain(reclaimed);
    expect(bindings?.aliases).not.toContain(reclaimed);

    await runProjectBind(machineContext(), first.declaration.projectId, nestedPath, true);
    bindings = await readBindings(first.paths.bindingsFile);
    expect(bindings?.roots).not.toContain(reclaimed);
    expect(bindings?.aliases).toContain(reclaimed);
    expect((await readBindings(other.paths.bindingsFile))?.roots).toContain(otherWorktree);
  });

  test("forget removes roots and aliases without changing the Store", async () => {
    const project = await loadProject(env.worktree, env.home);
    const store = new ProjectStore(project.paths.storeDir);
    const headBefore = await store.head();
    const linkedSpelling = join(env.root, "linked-checkout");
    await symlink(env.worktree, linkedSpelling);
    let preview = "";
    const result = await runProjectForget(
      machineContext({ inputDisabled: false }),
      linkedSpelling,
      {
        confirm: async (message) => {
          preview = message;
          const concurrentLease = await WriterLease.acquire(bindingsLockFile(env.home), 30);
          concurrentLease.release();
          return true;
        },
      },
    );

    expect(preview).toContain(`Unbind ${env.worktree}`);
    expect(preview).toContain(project.paths.storeDir);
    expect(preview).toContain("no roots");
    expect(preview).toContain(`glia project bind ${project.declaration.projectId}`);
    expect(preview).toContain("running `glia import`");
    expect(result.json).toMatchObject({ removedFrom: "root", rootless: true });
    expect((await readBindings(project.paths.bindingsFile))?.roots).toEqual([]);
    expect(await store.head()).toBe(headBefore);
    await expect(runProjectForget(machineContext(), env.worktree)).rejects.toMatchObject({
      code: "PATH_NOT_BOUND",
    });

    await runProjectBind(machineContext(), project.declaration.projectId, env.worktree, true);
    const aliasResult = await runProjectForget(machineContext(), env.worktree);
    expect(aliasResult.json).toMatchObject({ removedFrom: "alias", rootless: false });
    expect((await readBindings(project.paths.bindingsFile))?.aliases).toEqual([]);
  });

  test("aliases claim historical Sessions but do not admit hooks or lazy realization", async () => {
    const project = await loadProject(env.worktree, env.home);
    await runProjectBind(machineContext(), project.declaration.projectId, env.worktree, true);
    await mkdir(join(env.worktree, "src"));

    expect(await new BindingIndex(env.home).mapOpeningPath(join(env.worktree, "src"))).toEqual({
      projectId: project.declaration.projectId,
    });
    expect(await loadExistingProject(env.worktree, env.home)).toBeNull();
    await expect(loadProject(env.worktree, env.home)).rejects.toMatchObject({
      code: "ALIAS_ONLY_WORKTREE",
      details: { projectId: project.declaration.projectId },
    });
    const bindings = await readBindings(project.paths.bindingsFile);
    expect(bindings?.roots).toEqual([]);
    expect(bindings?.aliases).toEqual([env.worktree]);
  });

  test("a declaration cannot hide an alias owned by another Project", async () => {
    const declared = await loadProject(env.worktree, env.home);
    const aliasedWorktree = await makeSecondWorktree(env, "declared-over-alias");
    const historical = await loadProject(aliasedWorktree, env.home);
    await runProjectBind(machineContext(), historical.declaration.projectId, aliasedWorktree, true);
    await writeDeclaration(aliasedWorktree, createDeclaration(declared.declaration.projectId));

    await expect(loadProject(aliasedWorktree, env.home)).rejects.toMatchObject({
      code: "ALIAS_ONLY_WORKTREE",
      details: { projectId: historical.declaration.projectId },
    });
  });

  test("bind rejects mismatched declarations and existing non-Git alias targets", async () => {
    const project = await loadProject(env.worktree, env.home);
    const declaredWorktree = await makeSecondWorktree(env, "declared-unbound");
    await writeDeclaration(declaredWorktree, createDeclaration("prj_declared_elsewhere"));
    await expect(
      runProjectBind(machineContext(), project.declaration.projectId, declaredWorktree, false),
    ).rejects.toMatchObject({
      code: "BINDING_CONFLICT",
      details: { declaredProjectId: "prj_declared_elsewhere" },
    });

    const ordinaryDirectory = join(env.root, "ordinary-directory");
    await mkdir(ordinaryDirectory);
    await expect(
      runProjectBind(machineContext(), project.declaration.projectId, ordinaryDirectory, true),
    ).rejects.toMatchObject({ code: "NOT_A_GIT_WORKTREE" });

    const ordinaryFile = join(env.root, "ordinary-file");
    await Bun.write(ordinaryFile, "not a directory\n");
    await expect(
      runProjectBind(machineContext(), project.declaration.projectId, ordinaryFile, true),
    ).rejects.toMatchObject({ code: "NOT_A_GIT_WORKTREE" });
    await expect(
      runProjectBind(
        machineContext(),
        project.declaration.projectId,
        join(ordinaryFile, "retired-checkout"),
        true,
      ),
    ).rejects.toMatchObject({ code: "NOT_A_GIT_WORKTREE" });
    expect((await readBindings(project.paths.bindingsFile))?.aliases).toEqual([]);
  });

  test("forget warns for a declaration naming another Project and quotes recovery paths", async () => {
    const spacedWorktree = await makeSecondWorktree(env, "My Project");
    const project = await loadProject(spacedWorktree, env.home);
    await writeDeclaration(spacedWorktree, createDeclaration("prj_someone_else"));
    await gitOrThrow(["add", "glia.json"], spacedWorktree);
    await gitOrThrow(
      [
        "-c",
        "user.name=glia-test",
        "-c",
        "user.email=glia-test@local",
        "commit",
        "--no-gpg-sign",
        "-m",
        "test: add mismatched declaration",
      ],
      spacedWorktree,
    );
    let preview = "";
    const forgotten = await runProjectForget(
      machineContext({ inputDisabled: false }),
      spacedWorktree,
      {
        confirm: async (message) => {
          preview = message;
          return true;
        },
      },
    );

    expect(preview).toContain("No committed glia.json declaration for this Project");
    expect(preview).toContain(`'${spacedWorktree}'`);
    expect((forgotten.json as { reclaimCommand: string }).reclaimCommand).toContain(
      `'${spacedWorktree}'`,
    );
  });

  test("Binding mutations honor the machine-global lease timeout", async () => {
    const project = await loadProject(env.worktree, env.home);
    const lease = await WriterLease.acquire(bindingsLockFile(env.home), 1_000);
    try {
      await expect(
        runProjectForget(
          machineContext({ env: { ...env.env, GLIA_LEASE_TIMEOUT_MS: "30" } }),
          env.worktree,
        ),
      ).rejects.toMatchObject({
        code: "PROJECT_BUSY",
        nextSteps: [`glia project forget ${env.worktree}`],
      });
      expect((await readBindings(project.paths.bindingsFile))?.roots).toEqual([env.worktree]);
    } finally {
      lease.release();
    }
  });
});
