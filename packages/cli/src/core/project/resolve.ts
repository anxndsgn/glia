import { git } from "../store/git.ts";
import { GliaError } from "../output/errors.ts";

/**
 * Resolves the current code worktree top level. Fails outside a non-bare
 * Git working tree and never mutates the code repository.
 */
export async function resolveWorktreeTopLevel(cwd: string): Promise<string> {
  const result = await git(["rev-parse", "--show-toplevel"], cwd);
  if (result.exitCode !== 0 || result.stdout.trim().length === 0) {
    throw new GliaError("NOT_A_GIT_WORKTREE", "glia must run inside a non-bare Git working tree", {
      cwd,
    });
  }
  return result.stdout.trim();
}

/** {@link resolveWorktreeTopLevel}, with "not a worktree" as null. */
export async function worktreeTopLevelOrNull(cwd: string): Promise<string | null> {
  try {
    return await resolveWorktreeTopLevel(cwd);
  } catch {
    return null;
  }
}
