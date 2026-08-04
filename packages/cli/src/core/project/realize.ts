import { mkdir } from "node:fs/promises";
import type { ProjectPaths } from "./paths.ts";
import { emptyBindings, normalizeBoundPath, readBindings, writeBindings } from "./bindings.ts";
import { ProjectStore } from "../store/store.ts";

export async function realizeProject(
  worktree: string,
  paths: ProjectPaths,
  projectId: string,
  declaredRemote: string | null,
): Promise<void> {
  await mkdir(paths.stateDir, { recursive: true });
  await mkdir(paths.cacheDir, { recursive: true });

  // A declared remote is never contacted implicitly: only sync may
  // populate the Store, so commands that do not pass `allowMissingStore`
  // receive a typed refusal from loadProject after local realization.
  const store = new ProjectStore(paths.storeDir);
  if (!(await store.exists()) && declaredRemote === null) {
    await store.init(projectId);
  }

  // loadProject holds the machine-global Binding lease across realization.
  const bindings = (await readBindings(paths.bindingsFile)) ?? emptyBindings(projectId);
  const root = normalizeBoundPath(worktree);
  if (!bindings.roots.includes(root)) bindings.roots.push(root);
  await writeBindings(paths.bindingsFile, bindings);
}
