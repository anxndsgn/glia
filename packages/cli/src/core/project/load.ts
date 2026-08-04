import { createDeclaration, readDeclaration } from "../config/glia-json.ts";
import { GliaError } from "../output/errors.ts";
import { WriterLease, writerLeaseTimeoutMs } from "../store/lease.ts";
import { ProjectStore } from "../store/store.ts";
import type { LoadedProject } from "../session-module.ts";
import { bindingsBindWorktree, mapWorktreeToProject, readBindings } from "./bindings.ts";
import { createReplicaIdentity, readReplicaIdentity } from "./identity.ts";
import { bindingsLockFile, projectPaths } from "./paths.ts";
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
  // First use chooses a Project ID and creates its machine-local Binding.
  // Keep that whole realization transaction under the same machine-global
  // lease used by import ownership decisions: concurrent first use must not
  // create two Projects for one exact worktree, and a timed-out waiter must
  // not leave an orphan Project or Store behind.
  const lease = await WriterLease.acquire(bindingsLockFile(home), writerLeaseTimeoutMs());
  try {
    const authored = await readDeclaration(worktree);
    const mapped = authored === null ? await mapWorktreeToProject(home, worktree) : null;
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
  } finally {
    lease.release();
  }
}

/**
 * Resolves an already-bound Project without creating an identity, Project,
 * Store, state directory, or Binding. Hook mode uses this as its opt-in guard.
 */
export async function loadExistingProject(
  cwd: string,
  home: string,
): Promise<LoadedProject | null> {
  const worktree = await resolveWorktreeTopLevel(cwd);
  const authored = await readDeclaration(worktree);
  const mapped = authored === null ? await mapWorktreeToProject(home, worktree) : null;
  const projectId = authored?.projectId ?? mapped?.projectId ?? null;
  if (projectId === null) return null;

  const paths = projectPaths(home, projectId);
  const bindings = await readBindings(paths.bindingsFile);
  if (bindings === null || !bindingsBindWorktree(bindings, worktree)) return null;

  const identity = await readReplicaIdentity(home);
  if (identity === null) return null;
  return {
    home,
    worktree,
    declaration: authored ?? createDeclaration(projectId),
    paths,
    replicaId: identity.replicaId,
  };
}
