import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { runStoreRemoteSet } from "../../src/core/commands/store-remote.ts";
import { readDeclaration, writeDeclaration } from "../../src/core/config/glia-json.ts";
import { loadProject } from "../../src/core/project/load.ts";
import { ProjectStore } from "../../src/core/store/store.ts";
import { runSync } from "../../src/core/store/sync.ts";
import { sessionModule } from "../../src/session/module.ts";
import { makeBareRemote, makeSecondWorktree, makeTestEnv, type TestEnv } from "../helpers.ts";

let env: TestEnv;
beforeEach(async () => {
  env = await makeTestEnv();
});
afterEach(async () => {
  await env.cleanup();
});

describe("lazy Project identity", () => {
  test("first use creates only machine-local state", async () => {
    const project = await loadProject(env.worktree, env.home);
    expect(project.declaration.projectId).toStartWith("prj_");
    expect(await Bun.file(join(env.worktree, "glia.json")).exists()).toBeFalse();
    expect(await new ProjectStore(project.paths.storeDir).exists()).toBeTrue();
  });

  test("store remote set materializes glia.json with the existing identity", async () => {
    const project = await loadProject(env.worktree, env.home);
    const remote = await makeBareRemote(env);
    await runStoreRemoteSet(
      { project, env: env.env, jsonMode: false, inputDisabled: true },
      remote,
      { dryRun: false, yes: true },
    );
    expect((await readDeclaration(env.worktree))?.projectId).toBe(project.declaration.projectId);
  });

  test("an authored declaration is adopted and first sync bootstraps its Store", async () => {
    const source = await loadProject(env.worktree, env.home);
    const remote = await makeBareRemote(env);
    source.declaration.store.remote = remote;
    await writeDeclaration(env.worktree, source.declaration);
    await runSync(source, env.env, [sessionModule]);

    const checkout = await makeSecondWorktree(env, "fresh-checkout");
    await writeDeclaration(checkout, source.declaration);
    const secondHome = join(env.root, "second-home");
    const adopted = await loadProject(checkout, secondHome, { allowMissingStore: true });
    expect(adopted.declaration.projectId).toBe(source.declaration.projectId);
    expect(await new ProjectStore(adopted.paths.storeDir).exists()).toBeFalse();
    await runSync(adopted, { GLIA_HOME: secondHome }, [sessionModule]);
    expect(await new ProjectStore(adopted.paths.storeDir).exists()).toBeTrue();
  });
});
