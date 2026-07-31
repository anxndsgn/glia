import { createDeclaration, readDeclaration } from "../config/glia-json.ts";
import { GliaError } from "../output/errors.ts";
import { ProjectStore } from "../store/store.ts";
import type { LoadedProject } from "../session-module.ts";
import { mapPathToProject } from "./bindings.ts";
import { createReplicaIdentity, readReplicaIdentity } from "./identity.ts";
import { projectPaths } from "./paths.ts";
import { realizeProject } from "./realize.ts";
import { resolveWorktreeTopLevel } from "./resolve.ts";

export interface LoadProjectOptions {
  /** Sync uses this to adopt a declared remote before a local Store exists. */
  allowMissingStore?: boolean;
}

/**
 * Resolves or creates the machine-local Project identity for a worktree.
 * The declaration remains virtual until `glia store remote set` writes it.
 */
export async function loadProject(
  cwd: string,
  home: string,
  options: LoadProjectOptions = {},
): Promise<LoadedProject> {
  const worktree = await resolveWorktreeTopLevel(cwd);
  const authored = await readDeclaration(worktree);
  const mapped = authored === null ? await mapPathToProject(home, worktree) : null;
  const projectId = authored?.projectId ?? mapped?.projectId ?? `prj_${Bun.randomUUIDv7()}`;
  const declaration = authored ?? createDeclaration(projectId);
  const identity = (await readReplicaIdentity(home)) ?? (await createReplicaIdentity(home));
  const paths = projectPaths(home, projectId);

  await realizeProject(worktree, paths, projectId, declaration.store.remote ?? null, {
    allowMissingStore: options.allowMissingStore === true,
  });

  if (options.allowMissingStore !== true && !(await new ProjectStore(paths.storeDir).exists())) {
    throw new GliaError(
      "STORE_NOT_REALIZED",
      `project ${projectId} declares a remote but has no local Store; run \`glia sync\` first`,
      { projectId, nextSteps: ["glia sync"] },
    );
  }

  return { home, worktree, declaration, paths, replicaId: identity.replicaId };
}
