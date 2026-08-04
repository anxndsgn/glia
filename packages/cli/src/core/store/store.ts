import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { git, gitOrThrow } from "./git.ts";
import { STORE_MARKER_FILE, storeMarkerBytes } from "./marker.ts";

export const COMMIT_IDENTITY = ["-c", "user.name=glia", "-c", "user.email=glia@local"];

/** The same fixed identity, for Git plumbing that reads the environment. */
export const COMMIT_IDENTITY_ENV = {
  GIT_AUTHOR_NAME: "glia",
  GIT_AUTHOR_EMAIL: "glia@local",
  GIT_COMMITTER_NAME: "glia",
  GIT_COMMITTER_EMAIL: "glia@local",
};

/**
 * The authoritative Git-backed Store Replica. Git is an internal mechanism;
 * the working-tree layout is private implementation detail.
 */
export class ProjectStore {
  constructor(readonly dir: string) {}

  async exists(): Promise<boolean> {
    return await Bun.file(join(this.dir, ".git", "HEAD")).exists();
  }

  /** Store creation writes the identity and format marker from day one. */
  async init(projectId: string): Promise<void> {
    if (await this.exists()) return;
    await mkdir(this.dir, { recursive: true });
    await gitOrThrow(["init", "--initial-branch=main"], this.dir);
    await Bun.write(join(this.dir, STORE_MARKER_FILE), storeMarkerBytes(projectId));
    await gitOrThrow(["add", "-A"], this.dir);
    await gitOrThrow(
      [...COMMIT_IDENTITY, "commit", "--no-gpg-sign", "-m", "glia: initialize store"],
      this.dir,
    );
  }

  async head(): Promise<string> {
    return (await gitOrThrow(["rev-parse", "HEAD"], this.dir)).trim();
  }

  /** Stages everything and commits when the tree changed; returns the resulting head either way. */
  async commitAll(message: string): Promise<string> {
    await gitOrThrow(["add", "-A"], this.dir);
    const status = await gitOrThrow(["status", "--porcelain"], this.dir);
    if (status.trim().length > 0) {
      await gitOrThrow([...COMMIT_IDENTITY, "commit", "--no-gpg-sign", "-m", message], this.dir);
    }
    return await this.head();
  }

  async isClean(): Promise<boolean> {
    const result = await git(["status", "--porcelain"], this.dir);
    return result.exitCode === 0 && result.stdout.trim().length === 0;
  }

  /**
   * Commits working-tree residue left by a crashed operation as its own
   * clearly marked recovery commit, so a writer's commit never silently
   * absorbs changes it did not make. The caller owns the writer lease.
   * Returns the recovery head, or null when the tree was already clean.
   */
  async commitRecoveryIfDirty(details: Record<string, unknown> = {}): Promise<string | null> {
    if (await this.isClean()) return null;
    const trailer = JSON.stringify({ op: "store.recover", ...details });
    return await this.commitAll(
      `glia: recover uncommitted working-tree residue\n\nglia-op: ${trailer}`,
    );
  }
}
