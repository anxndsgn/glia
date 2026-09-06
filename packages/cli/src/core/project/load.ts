import { sep } from "node:path";
import { projectScope, scopeMapping } from "./scope.ts";
import { createDeclaration, readDeclaration } from "../config/glia-json.ts";
import { GliaError } from "../output/errors.ts";
import { shellQuote } from "../output/shell.ts";
import { WriterLease, writerLeaseTimeoutMs } from "../store/lease.ts";
import { ProjectStore } from "../store/store.ts";
import type { LoadedProject } from "../session-module.ts";
import {
  BindingIndex,
  bindingsBindWorktree,
  bindingsRootWorktree,
  readBindings,
} from "./bindings.ts";
import { createReplicaIdentity, readReplicaIdentity } from "./identity.ts";
import { bindingsLockFile, projectPaths } from "./paths.ts";
import { realizeProject } from "./realize.ts";
import { retireReadCache } from "./read-cache.ts";

export interface LoadProjectOptions {
  /** `sync` and `store remote set` use this to proceed against a declared remote before a local Store exists. */
  allowMissingStore?: boolean;
}

/**
 * The recovery path leads with `project adopt`: it accepts the
 * declaration, merges the locally bound Project's Sessions into the
 * declared one, and is the only command that resolves this state. This
 * error stays cheap — the Session-level detail belongs to adopt's own
 * preview, which reads a consistent state under the Bindings lease.
 */
function declarationMismatchError(worktree: string, declared: string, owner: string): GliaError {
  return new GliaError(
    "BINDING_CONFLICT",
    `worktree ${worktree} is already bound to project ${owner}, but glia.json declares ${declared}`,
    { worktree, projectId: declared, currentOwner: owner },
    [
      `glia project adopt ${shellQuote(worktree)}`,
      "glia project list",
      `glia project forget ${shellQuote(worktree)}`,
    ],
  );
}

function storeNotRealizedError(projectId: string): GliaError {
  return new GliaError(
    "STORE_NOT_REALIZED",
    `project ${projectId} declares a remote but has no local Store; run \`glia sync\` first`,
    { projectId },
    ["glia sync"],
  );
}

function refuseAliasOnlyWorktree(worktree: string, projectId: string): never {
  throw new GliaError(
    "ALIAS_ONLY_WORKTREE",
    `worktree ${worktree} is a historical alias of project ${projectId}; bind it as a root before running Project commands here`,
    { worktree, projectId },
    [`glia project bind ${shellQuote(projectId)} ${shellQuote(worktree)}`],
  );
}

/** A sibling worktree or ordinary subdirectory inherits the bound Project's declaration.
 * Conflicting declarations need an explicit local choice rather than an arbitrary remote. */
async function boundDeclaration(home: string, projectId: string) {
  const bindings = await readBindings(projectPaths(home, projectId).bindingsFile);
  let selected: Awaited<ReturnType<typeof readDeclaration>> = null;
  for (const root of bindings?.roots ?? []) {
    const declaration = await readDeclaration(root);
    if (declaration?.projectId !== projectId) continue;
    if (selected !== null && JSON.stringify(selected) !== JSON.stringify(declaration)) {
      throw new GliaError(
        "BINDING_CONFLICT",
        "bound roots have different declarations; add an explicit glia.json declaration in this directory",
        { projectId },
        ["glia project list"],
      );
    }
    selected = declaration;
  }
  return selected ?? createDeclaration(projectId);
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
  const scope = await projectScope(cwd);
  const worktree = scope.root;
  // First use chooses a Project ID and creates its machine-local Binding.
  // Keep that whole realization transaction under the same machine-global
  // lease used by import ownership decisions: concurrent first use must not
  // create two Projects for one exact worktree, and a timed-out waiter must
  // not leave an orphan Project or Store behind.
  const lease = await WriterLease.acquire(bindingsLockFile(home), writerLeaseTimeoutMs());
  try {
    const authored = await readDeclaration(worktree);
    // Filesystem ownership wins over a declaration when deciding whether a
    // historical alias may be realized. Otherwise a declaration naming a
    // different Project could silently create a second claim for this path.
    const mapped = await scopeMapping(scope, home);
    if (mapped !== null) {
      const bindings = await readBindings(projectPaths(home, mapped.projectId).bindingsFile);
      if (
        bindings !== null &&
        bindingsBindWorktree(bindings, worktree) &&
        !bindingsRootWorktree(bindings, worktree)
      ) {
        refuseAliasOnlyWorktree(worktree, mapped.projectId);
      }
      if (authored !== null && authored.projectId !== mapped.projectId) {
        throw declarationMismatchError(worktree, authored.projectId, mapped.projectId);
      }
    }
    const projectId = authored?.projectId ?? mapped?.projectId ?? `prj_${Bun.randomUUIDv7()}`;
    const declaration = authored ?? (await boundDeclaration(home, projectId));
    const identity = (await readReplicaIdentity(home)) ?? (await createReplicaIdentity(home));
    const paths = projectPaths(home, projectId);

    await realizeProject(worktree, paths, projectId, declaration.store.remote ?? null);
    await retireReadCache(home, readProjectId(scope.key));

    if (options.allowMissingStore !== true && !(await new ProjectStore(paths.storeDir).exists())) {
      throw storeNotRealizedError(projectId);
    }

    return {
      home,
      worktree,
      declaration,
      paths,
      replicaId: identity.replicaId,
      enrollment: { kind: "enrolled" },
    };
  } finally {
    lease.release();
  }
}

const SYNTHESIZED_REPLICA_ID = "__glia_read_only__";

function readProjectId(scopeKey: string): string {
  return `prj_read_${new Bun.CryptoHasher("sha256").update(scopeKey).digest("hex").slice(0, 32)}`;
}

/**
 * Resolves an enrolled Project for reads, or synthesizes a read-only Project
 * whose paths are deliberately unrelated to any declared Project identity.
 */
export async function loadProjectForRead(cwd: string, home: string): Promise<LoadedProject> {
  const scope = await projectScope(cwd);
  const worktree = scope.root;
  const authored = await readDeclaration(worktree);
  const mapped = await scopeMapping(scope, home);

  if (mapped !== null) {
    if (authored !== null && authored.projectId !== mapped.projectId) {
      throw declarationMismatchError(worktree, authored.projectId, mapped.projectId);
    }
    const paths = projectPaths(home, mapped.projectId);
    const identity = await readReplicaIdentity(home);
    return {
      home,
      worktree,
      declaration: authored ?? (await boundDeclaration(home, mapped.projectId)),
      paths,
      replicaId: identity?.replicaId ?? SYNTHESIZED_REPLICA_ID,
      enrollment: { kind: "enrolled" },
    };
  }

  const synthesizedProjectId = readProjectId(scope.key);
  const declaration = authored ?? createDeclaration(synthesizedProjectId);
  return {
    home,
    worktree,
    declaration: { ...declaration, projectId: synthesizedProjectId },
    paths: projectPaths(home, synthesizedProjectId),
    replicaId: SYNTHESIZED_REPLICA_ID,
    enrollment: {
      kind: "unenrolled",
      bindingOverlay: { worktree, projectId: synthesizedProjectId },
    },
  };
}

/**
 * Resolves an already-bound Project without creating an identity, Project,
 * Store, state directory, or Binding. Hook mode uses this as its opt-in guard.
 */
export async function loadExistingProject(
  cwd: string,
  home: string,
): Promise<LoadedProject | null> {
  const scope = await projectScope(cwd);
  const worktree = scope.root;
  const authored = await readDeclaration(worktree);
  const mapped = await scopeMapping(scope, home);
  if (mapped !== null && authored !== null && authored.projectId !== mapped.projectId) return null;
  const projectId = authored?.projectId ?? mapped?.projectId ?? null;
  if (projectId === null) return null;

  const paths = projectPaths(home, projectId);
  const bindings = await readBindings(paths.bindingsFile);
  if (bindings === null) return null;
  if (bindingsBindWorktree(bindings, worktree) && !bindingsRootWorktree(bindings, worktree))
    return null;
  const admitted = scope.git
    ? scope.roots.some((root) => bindingsRootWorktree(bindings, root))
    : bindings.roots.some((root) => worktree === root || worktree.startsWith(root + sep));
  if (!admitted) {
    const ordinaryOwner = await new BindingIndex(home).mapOrdinaryAncestor(worktree, true);
    if (ordinaryOwner?.projectId !== projectId) return null;
  }

  const identity = await readReplicaIdentity(home);
  if (identity === null) return null;
  return {
    home,
    worktree,
    declaration: authored ?? (await boundDeclaration(home, projectId)),
    paths,
    replicaId: identity.replicaId,
    enrollment: { kind: "enrolled" },
  };
}
