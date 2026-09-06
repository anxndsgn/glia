import { resolve } from "node:path";
import { git } from "../store/git.ts";
import { GliaError } from "../output/errors.ts";
import { BindingIndex, normalizeBoundPath, type PathMapping } from "./bindings.ts";
import { worktreeTopLevelOrNull } from "./resolve.ts";

export interface ProjectScope {
  root: string;
  /** Local repository identity; separate clones never share it. */
  key: string;
  roots: string[];
  git: boolean;
}

/** Git worktrees share a common Git directory. Ordinary folders use their canonical path. */
export async function projectScope(cwd: string): Promise<ProjectScope> {
  const top = await worktreeTopLevelOrNull(cwd);
  if (top === null) {
    const root = normalizeBoundPath(cwd);
    return { root, key: root, roots: [root], git: false };
  }
  const root = normalizeBoundPath(top);
  const common = await git(["rev-parse", "--git-common-dir"], root);
  if (common.exitCode !== 0) throw new GliaError("GIT_FAILED", common.stderr);
  const key = normalizeBoundPath(resolve(root, common.stdout.trim()));
  const listing = await git(["worktree", "list", "--porcelain", "-z"], root);
  if (listing.exitCode !== 0) throw new GliaError("GIT_FAILED", listing.stderr);
  const roots = listing.stdout
    .split("\0")
    .filter((s) => s.startsWith("worktree "))
    .map((s) => normalizeBoundPath(s.slice(9)));
  return { root, key, roots: roots.length > 0 ? roots : [root], git: true };
}

/** Explicit ownership of this root wins; otherwise inherit a sibling worktree's Project. */
export async function scopeMapping(scope: ProjectScope, home: string): Promise<PathMapping | null> {
  const index = new BindingIndex(home);
  const direct = await index.mapWorktree(scope.root);
  if (direct !== null) return direct;
  if (!scope.git) return await index.mapPath(scope.root);
  const owners = new Set<string>();
  for (const root of scope.roots) {
    const owner = await index.mapWorktree(root);
    if (owner !== null) owners.add(owner.projectId);
  }
  if (owners.size > 1) {
    throw new GliaError(
      "BINDING_CONFLICT",
      "sibling worktrees belong to different Projects; bind this worktree explicitly",
      { worktree: scope.root, projectIds: [...owners] },
      ["glia project list"],
    );
  }
  const projectId = [...owners][0];
  return projectId === undefined ? await index.mapOrdinaryAncestor(scope.root) : { projectId };
}
