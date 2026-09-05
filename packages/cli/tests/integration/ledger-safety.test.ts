import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { runProjectAdopt } from "../../src/core/commands/project.ts";
import { createDeclaration, writeDeclaration } from "../../src/core/config/glia-json.ts";
import { readBindings } from "../../src/core/project/bindings.ts";
import { loadProject } from "../../src/core/project/load.ts";
import { ProjectStore } from "../../src/core/store/store.ts";
import {
  ledgerFilePath,
  readLocalLedgerEvents,
  SESSION_LEDGER_DIR,
} from "../../src/session/domain/deletion.ts";
import { makeTestEnv, type TestEnv } from "../helpers.ts";

let env: TestEnv;
beforeEach(async () => {
  env = await makeTestEnv();
});
afterEach(async () => {
  await env.cleanup();
});

describe("Deletion Ledger read failures", () => {
  test("an absent namespace is an empty ledger", async () => {
    expect(await readLocalLedgerEvents(join(env.root, "absent-store"))).toEqual([]);
  });

  test("a failed ledger read never returns an empty or partial history", async () => {
    const store = join(env.root, "store");
    // A directory at a ledger file path produces an actual I/O error on all test hosts.
    await mkdir(join(store, ledgerFilePath("unreadable")), { recursive: true });
    await expect(readLocalLedgerEvents(store)).rejects.toThrow();
  });

  test("a future ledger prevents adoption from deleting its original Project", async () => {
    const local = await loadProject(env.worktree, env.home);
    const store = new ProjectStore(local.paths.storeDir);
    const ledger = join(local.paths.storeDir, ledgerFilePath("future-session"));
    await mkdir(join(local.paths.storeDir, SESSION_LEDGER_DIR), { recursive: true });
    const content = JSON.stringify({ schemaVersion: 999 });
    await Bun.write(ledger, content);
    await store.commitAll("test: preserve a future Deletion Ledger");
    await expect(readLocalLedgerEvents(local.paths.storeDir)).rejects.toMatchObject({
      code: "STATE_TOO_NEW",
    });

    await writeDeclaration(env.worktree, createDeclaration("prj_declared_elsewhere"));
    const bindings = await readBindings(local.paths.bindingsFile);
    expect(bindings?.roots).toContain(env.worktree);
    await expect(
      runProjectAdopt(
        {
          requirement: "machine",
          cwd: env.worktree,
          home: env.home,
          env: env.env,
          jsonMode: false,
          inputDisabled: true,
        },
        undefined,
        { deleteOld: true },
      ),
    ).rejects.toMatchObject({ code: "STATE_TOO_NEW" });
    expect((await stat(local.paths.storeDir)).isDirectory()).toBe(true);
    expect(await Bun.file(ledger).text()).toBe(content);
    expect(await readBindings(local.paths.bindingsFile)).toEqual(bindings);
  });
});
