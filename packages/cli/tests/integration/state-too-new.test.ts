import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { readBindings } from "../../src/core/project/bindings.ts";
import { readReplicaIdentity } from "../../src/core/project/identity.ts";
import { identityFile } from "../../src/core/project/paths.ts";
import { readDeclaration, writeDeclaration } from "../../src/core/config/glia-json.ts";
import { readSyncState } from "../../src/core/store/sync-state.ts";
import { readDeletionPending } from "../../src/core/store/deletion.ts";
import { parseLedgerFile } from "../../src/session/domain/deletion.ts";
import { readDiscoveryState } from "../../src/session/domain/discovery-state.ts";
import { ensureProjection, readCurrentPointer } from "../../src/session/projection/publish.ts";
import { PROJECTION_VERSION } from "../../src/session/projection/schema.ts";
import { runImport } from "../../src/session/domain/import.ts";
import { sessionIdOf } from "../../src/session/domain/identity.ts";
import { sessionDir } from "../../src/session/storage/store-layout.ts";
import type { LoadedProject } from "../../src/core/session-module.ts";
import { initProject, makeTestEnv, writeClaudeSession, type TestEnv } from "../helpers.ts";

let env: TestEnv;
let project: LoadedProject;

beforeAll(async () => {
  env = await makeTestEnv();
  project = await initProject(env);
});

afterAll(async () => {
  await env.cleanup();
});

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(join(path, ".."), { recursive: true });
  await Bun.write(path, JSON.stringify(value, null, 2) + "\n");
}

describe("STATE_TOO_NEW: state written by a newer Glia names the binary, not the file", () => {
  test("Project Bindings", async () => {
    const file = join(env.root, "too-new-bindings.json");
    await writeJson(file, { schemaVersion: 99, projectId: "prj_x", roots: [], aliases: [] });
    await expect(readBindings(file)).rejects.toMatchObject({
      code: "STATE_TOO_NEW",
      details: { stateKind: "Project Bindings", path: file, foundVersion: 99, supportedVersion: 1 },
    });
  });

  test("Replica identity", async () => {
    const home = join(env.root, "too-new-home");
    await writeJson(identityFile(home), { schemaVersion: 2, replicaId: "rpl_x" });
    await expect(readReplicaIdentity(home)).rejects.toMatchObject({ code: "STATE_TOO_NEW" });
  });

  test("glia.json declaration: too-new is STATE_TOO_NEW, in-range invalid stays invalid", async () => {
    const worktree = join(env.root, "too-new-worktree");
    await mkdir(worktree, { recursive: true });
    await Bun.write(
      join(worktree, "glia.json"),
      JSON.stringify({ schemaVersion: 2, projectId: "prj_x", store: {}, contexts: {} }) + "\n",
    );
    await expect(readDeclaration(worktree)).rejects.toMatchObject({ code: "STATE_TOO_NEW" });

    await Bun.write(
      join(worktree, "glia.json"),
      JSON.stringify({ schemaVersion: 1, projectId: "", store: {}, contexts: {} }) + "\n",
    );
    await expect(readDeclaration(worktree)).rejects.toMatchObject({ code: "INVALID_DECLARATION" });
  });

  test("sync state", async () => {
    const file = join(env.root, "too-new-sync.json");
    await writeJson(file, { schemaVersion: 9, lastSyncAt: "x", outcome: "pushed", head: "h" });
    await expect(readSyncState(file)).rejects.toMatchObject({ code: "STATE_TOO_NEW" });
  });

  test("deletion propagation state", async () => {
    const file = join(env.root, "too-new-pending.json");
    await writeJson(file, { schemaVersion: 3, baseHead: null, events: [] });
    await expect(readDeletionPending(file)).rejects.toMatchObject({ code: "STATE_TOO_NEW" });
  });

  test("Deletion Ledger", () => {
    const content = JSON.stringify({
      schemaVersion: 2,
      sessionId: "ses_x",
      sourceIdentity: { harnessId: "codex", sourceSessionId: "s" },
      events: [],
    });
    expect(() => parseLedgerFile("session/deletions/ses_x.json", content)).toThrow(
      /newer than this Glia supports/,
    );
  });

  test("discovery state", async () => {
    const file = join(env.root, "too-new-discovery.json");
    await writeJson(file, { schemaVersion: 7, ignored: [], associations: {}, evaluations: {} });
    await expect(readDiscoveryState(file)).rejects.toMatchObject({ code: "STATE_TOO_NEW" });
  });

  test("the message carries the versions and the upgrade remedy", async () => {
    const file = join(env.root, "too-new-message.json");
    await writeJson(file, { schemaVersion: 42, projectId: "prj_x", roots: [], aliases: [] });
    await expect(readBindings(file)).rejects.toThrow(
      /schemaVersion 42, newer than this Glia supports \(1\); upgrade or rebuild/,
    );
  });
});

describe("the projection is exempt: version skew rebuilds transparently", () => {
  test("a pointer persisted under a newer projection version rebuilds, never STATE_TOO_NEW", async () => {
    const first = await ensureProjection(project, env.env);
    expect(first.stale).toBeFalse();
    const pointerFile = project.paths.currentProjectionFile;
    const pointer = JSON.parse(await Bun.file(pointerFile).text()) as Record<string, unknown>;
    pointer["projectionVersion"] = PROJECTION_VERSION + 1;
    await Bun.write(pointerFile, JSON.stringify(pointer) + "\n");

    const again = await ensureProjection(project, env.env);
    expect(again.stale).toBeFalse();
    const rewritten = await readCurrentPointer(pointerFile);
    expect(rewritten?.projectionVersion).toBe(PROJECTION_VERSION);
  });

  test("a failed rebuild over a version-skewed fallback rethrows the real error", async () => {
    // A fallback projection is only servable when its schema matches this
    // binary's query code; otherwise version-specific SQL would fail on
    // it and mask the durable-state error that broke the rebuild.
    await writeClaudeSession(env.claudeHome, { sessionId: "fallback-probe", cwd: env.worktree });
    await runImport(project, env.env, { harness: null, dryRun: false, onlyCandidateIds: null });

    // The rebuild trips over Session metadata written by a newer Glia…
    const sessionId = sessionIdOf({ harnessId: "claude-code", sourceSessionId: "fallback-probe" });
    const metaFile = join(sessionDir(project.paths.storeDir, sessionId), "session.json");
    const meta = JSON.parse(await Bun.file(metaFile).text()) as Record<string, unknown>;
    meta["schemaVersion"] = 99;
    await Bun.write(metaFile, JSON.stringify(meta, null, 2) + "\n");

    // …while the only fallback on disk was built by an older binary.
    const pointerFile = project.paths.currentProjectionFile;
    const pointer = JSON.parse(await Bun.file(pointerFile).text()) as Record<string, unknown>;
    pointer["projectionVersion"] = PROJECTION_VERSION - 1;
    await Bun.write(pointerFile, JSON.stringify(pointer) + "\n");

    await expect(ensureProjection(project, env.env)).rejects.toMatchObject({
      code: "STATE_TOO_NEW",
    });
  });
});

// The write side keeps its declared versions in step with what readers
// support; writeDeclaration round-trips under the same reader.
test("current writers produce state their own readers accept", async () => {
  const worktree = join(env.root, "roundtrip-worktree");
  await mkdir(worktree, { recursive: true });
  await writeDeclaration(worktree, {
    schemaVersion: 1,
    projectId: "prj_roundtrip",
    store: {},
    secretDetection: { enabled: true },
  });
  const declaration = await readDeclaration(worktree);
  expect(declaration?.projectId).toBe("prj_roundtrip");
});
