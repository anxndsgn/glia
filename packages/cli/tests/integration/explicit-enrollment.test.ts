import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { createDeclaration, writeDeclaration } from "../../src/core/config/glia-json.ts";
import { runStoreRemoteSet } from "../../src/core/commands/store-remote.ts";
import { installHookConfig } from "../../src/core/hooks/config.ts";
import { loadProject, loadProjectForRead } from "../../src/core/project/load.ts";
import { projectPaths } from "../../src/core/project/paths.ts";
import type { CommandRunContext } from "../../src/core/session-module.ts";
import { listCommand } from "../../src/session/commands/list.ts";
import { confirmFirstImport } from "../../src/session/commands/import.ts";
import { claudeCodeAdapter } from "../../src/session/adapters/claude-code/adapter.ts";
import { mutateDiscoveryState } from "../../src/session/domain/discovery-state.ts";
import { FAKE_KEY, makeTestEnv, writeClaudeSession, type TestEnv } from "../helpers.ts";

let env: TestEnv;

beforeEach(async () => {
  env = await makeTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

function context(project: Awaited<ReturnType<typeof loadProjectForRead>>): CommandRunContext {
  return {
    project,
    env: env.env,
    jsonMode: false,
    inputDisabled: false,
  };
}

describe("explicit Project enrollment", () => {
  test("synthesized reads are concurrent, projection-empty, and reject writes", async () => {
    const project = await loadProjectForRead(env.worktree, env.home);
    expect(project.enrollment.kind).toBe("unenrolled");

    const [first, second] = await Promise.all([
      listCommand.run(context(project), [], {}),
      listCommand.run(context(project), [], {}),
    ]);
    expect(first.json).toMatchObject({ totalSessions: 0, sessions: [] });
    expect(second.json).toMatchObject({ totalSessions: 0, sessions: [] });
    await expect(mutateDiscoveryState(project, env.env, () => true)).rejects.toMatchObject({
      code: "INTERNAL",
    });
    await expect(
      runStoreRemoteSet(context(project), "/tmp/never-written.git", {
        dryRun: false,
        yes: true,
      }),
    ).rejects.toMatchObject({ code: "INTERNAL" });
    expect(await Bun.file(join(env.worktree, "glia.json")).exists()).toBeFalse();
    expect(await Bun.file(join(env.home, "projects")).exists()).toBeFalse();
  });

  test("an enrolled Project without its declared remote Store stays distinct from unenrolled", async () => {
    const declaration = createDeclaration("prj_remote_only");
    declaration.store.remote = "file:///tmp/glia-missing-remote.git";
    await writeDeclaration(env.worktree, declaration);
    await loadProject(env.worktree, env.home, { allowMissingStore: true });

    await expect(loadProjectForRead(env.worktree, env.home)).rejects.toMatchObject({
      code: "STORE_NOT_REALIZED",
      details: { projectId: "prj_remote_only", nextSteps: ["glia sync"] },
    });
  });

  test("a committed declaration stays unenrolled locally and is adopted on enrollment", async () => {
    const declaration = createDeclaration("prj_shared_declaration");
    declaration.store.remote = "file:///tmp/glia-shared-store.git";
    await writeDeclaration(env.worktree, declaration);

    const read = await loadProjectForRead(env.worktree, env.home);
    expect(read.enrollment.kind).toBe("unenrolled");
    expect(read.declaration.store.remote).toBe(declaration.store.remote);
    expect(read.declaration.projectId).not.toBe(declaration.projectId);

    const enrolled = await loadProject(env.worktree, env.home, { allowMissingStore: true });
    expect(enrolled.declaration.projectId).toBe("prj_shared_declaration");
    expect(
      await Bun.file(projectPaths(env.home, "prj_shared_declaration").bindingsFile).exists(),
    ).toBeTrue();
  });

  test("first-import consent states Store, import, withholding, and installed-hook effects", async () => {
    await mkdir(env.claudeHome, { recursive: true });
    await installHookConfig("claude-code", env.env, "/opt/glia/bin/glia");
    await writeClaudeSession(env.claudeHome, {
      sessionId: "enrollment-secret",
      cwd: env.worktree,
      extraLines: [
        {
          type: "user",
          sessionId: "enrollment-secret",
          cwd: env.worktree,
          message: { role: "user", content: `credential ${FAKE_KEY}` },
        },
      ],
    });
    await writeClaudeSession(env.claudeHome, {
      sessionId: "enrollment-pending",
      cwd: join(env.root, "missing-worktree"),
    });
    const project = await loadProjectForRead(env.worktree, env.home);
    let prompt = "";
    await expect(
      confirmFirstImport(context(project), {}, async (message) => {
        prompt = message;
        return false;
      }),
    ).rejects.toMatchObject({ code: "CANCELLED" });

    expect(prompt).toContain(`Store: create a Git-backed Store under ${env.home}/projects`);
    expect(prompt).toContain("Sessions: import 0 Session(s) now from 2 discovered Candidate(s)");
    expect(prompt).toContain("Secret review: withhold 1 Candidate(s)");
    expect(prompt).toContain("Association: 1 Candidate(s) need a Project decision first");
    expect(prompt).toContain("SessionEnd: capture future Sessions automatically");
    expect(await Bun.file(join(env.home, "projects")).exists()).toBeFalse();
  });

  test("first-import consent discloses Harness discovery failures before enrollment", async () => {
    await mkdir(join(env.claudeHome, "projects"), { recursive: true });
    const originalDiscover = claudeCodeAdapter.discover;
    claudeCodeAdapter.discover = async function* () {
      throw new Error("synthetic discovery failure");
    };
    try {
      const project = await loadProjectForRead(env.worktree, env.home);
      let prompt = "";
      await expect(
        confirmFirstImport(context(project), {}, async (message) => {
          prompt = message;
          return false;
        }),
      ).rejects.toMatchObject({ code: "CANCELLED" });

      expect(prompt).toContain("Harness discovery failures: 1 Harness(es)");
      expect(prompt).toContain("claude-code: synthetic discovery failure");
      expect(await Bun.file(join(env.home, "projects")).exists()).toBeFalse();
    } finally {
      claudeCodeAdapter.discover = originalDiscover;
    }
  });
});
