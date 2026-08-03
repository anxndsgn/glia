import { dirname, join, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { projectPaths } from "./paths.ts";
import { resolveWorktreeTopLevel } from "./resolve.ts";
import { requireSupportedSchemaVersion } from "../state/schema-version.ts";
import { GliaError } from "../output/errors.ts";

export const BINDINGS_SCHEMA_VERSION = 1;

export interface Bindings {
  schemaVersion: number;
  projectId: string;
  /** Absolute checkout or worktree roots currently bound to the Project. */
  roots: string[];
  /** Former checkout paths explicitly aliased to the Project. */
  aliases: string[];
}

export function emptyBindings(projectId: string): Bindings {
  return { schemaVersion: BINDINGS_SCHEMA_VERSION, projectId, roots: [], aliases: [] };
}

export async function readBindings(bindingsFile: string): Promise<Bindings | null> {
  const file = Bun.file(bindingsFile);
  if (!(await file.exists())) return null;
  const raw = JSON.parse(await file.text()) as Record<string, unknown>;
  requireSupportedSchemaVersion(
    "Project Bindings",
    bindingsFile,
    raw["schemaVersion"],
    BINDINGS_SCHEMA_VERSION,
  );
  return {
    schemaVersion: BINDINGS_SCHEMA_VERSION,
    projectId: String(raw["projectId"] ?? ""),
    roots: Array.isArray(raw["roots"]) ? (raw["roots"] as string[]).map(String) : [],
    aliases: Array.isArray(raw["aliases"]) ? (raw["aliases"] as string[]).map(String) : [],
  };
}

export async function writeBindings(bindingsFile: string, bindings: Bindings): Promise<void> {
  await mkdir(dirname(bindingsFile), { recursive: true });
  await Bun.write(bindingsFile, JSON.stringify(bindings, null, 2) + "\n");
}

export function normalizeBoundPath(path: string): string {
  let resolved = resolve(path);
  try {
    // Symlinked variants (e.g. /var vs /private/var on macOS) must map to
    // one Binding. Former checkout paths may no longer exist; fall back to
    // the lexical form so aliases still match.
    resolved = realpathSync(resolved);
  } catch {
    // Keep the lexical resolution.
  }
  return resolved.length > 1 && resolved.endsWith(sep) ? resolved.slice(0, -1) : resolved;
}

function isWithin(root: string, path: string): boolean {
  return path === root || path.startsWith(root + sep);
}

export function bindingsContain(bindings: Bindings, path: string): boolean {
  return bindingMatchLength(bindings, path) !== null;
}

/** Length of the most-specific bound root/alias containing this path. */
export function bindingMatchLength(bindings: Bindings, path: string): number | null {
  const candidate = normalizeBoundPath(path);
  const matches = [...bindings.roots, ...bindings.aliases]
    .map(normalizeBoundPath)
    .filter((root) => isWithin(root, candidate));
  return matches.length === 0 ? null : Math.max(...matches.map((root) => root.length));
}

/** Exact worktree admission, distinct from Opening Path containment. */
export function bindingsBindWorktree(bindings: Bindings, worktree: string): boolean {
  const candidate = normalizeBoundPath(worktree);
  return [...bindings.roots, ...bindings.aliases].some(
    (path) => normalizeBoundPath(path) === candidate,
  );
}

export interface PathMapping {
  projectId: string;
}

export interface OpeningPathResolution {
  /** False when the path vanished before any exact historical Binding proved ownership. */
  resolved: boolean;
  mapping: PathMapping | null;
}

/**
 * One machine-local Binding scan, reused across a batch of lookups.
 *
 * Reading the Bindings under GLIA_HOME is O(Projects) file I/O, so a caller
 * mapping many Opening Paths — discovery classifying every candidate —
 * shares one index rather than rescanning per path. Bindings are read on
 * demand and memoized by file. The most-specific root wins, so an explicitly
 * bound nested worktree cannot also be claimed by its bound parent.
 */
export class BindingIndex {
  readonly #home: string;
  readonly #byFile = new Map<string, Bindings | null>();
  #projectIds: string[] | null = null;

  constructor(home: string) {
    this.#home = home;
  }

  /** The Bindings at `bindingsFile`, read once per index. */
  async read(bindingsFile: string): Promise<Bindings | null> {
    const cached = this.#byFile.get(bindingsFile);
    if (cached !== undefined) return cached;
    const bindings = await readBindings(bindingsFile);
    this.#byFile.set(bindingsFile, bindings);
    return bindings;
  }

  async #ids(): Promise<string[]> {
    if (this.#projectIds === null) {
      try {
        this.#projectIds = (await readdir(join(this.#home, "projects"))).sort();
      } catch {
        this.#projectIds = [];
      }
    }
    return this.#projectIds;
  }

  /**
   * Maps an Opening Path through every machine-local Binding under
   * GLIA_HOME. Returns the owning Project when a Binding claims the path.
   */
  async mapPath(openingPath: string): Promise<PathMapping | null> {
    let best: { projectId: string; length: number } | null = null;
    for (const projectId of await this.#ids()) {
      const bindings = await this.read(projectPaths(this.#home, projectId).bindingsFile);
      if (bindings) {
        const length = bindingMatchLength(bindings, openingPath);
        if (
          length !== null &&
          (best === null ||
            length > best.length ||
            (length === best.length && projectId < best.projectId))
        ) {
          best = { projectId, length };
        }
      }
    }
    return best === null ? null : { projectId: best.projectId };
  }

  /**
   * Maps the exact Git worktree containing an Opening Path. Containment alone
   * is insufficient: an independent, unbound repository nested below a bound
   * root has not opted in and must not be inherited by its parent Project.
   */
  async resolveOpeningPath(openingPath: string): Promise<OpeningPathResolution> {
    let probe = openingPath;
    let missing = false;
    for (;;) {
      try {
        // Current filesystem truth wins over stale historical Bindings. If a
        // deleted child path is later reused as an ordinary parent directory,
        // Git resolves the parent worktree and the old child Binding cannot
        // capture new Sessions at that path.
        const worktree = await resolveWorktreeTopLevel(probe);
        if (missing) return { resolved: false, mapping: null };
        return { resolved: true, mapping: await this.mapWorktree(worktree) };
      } catch (error) {
        if (error instanceof GliaError && error.code === "NOT_A_GIT_WORKTREE") {
          return { resolved: !missing, mapping: null };
        }
        const code = (error as NodeJS.ErrnoException).code;
        if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      }

      missing = true;
      // The probed path is absent. A formerly bound child worktree may have
      // disappeared in full, so its exact lexical Binding outranks whichever
      // surviving parent Git would resolve after the next climb.
      const exact = await this.mapWorktree(probe);
      if (exact !== null) return { resolved: true, mapping: exact };
      const parent = dirname(probe);
      if (parent === probe) return { resolved: false, mapping: null };
      probe = parent;
    }
  }

  async mapOpeningPath(openingPath: string): Promise<PathMapping | null> {
    return (await this.resolveOpeningPath(openingPath)).mapping;
  }

  /** Finds the Binding whose root/alias is exactly this Git worktree. */
  async mapWorktree(worktree: string): Promise<PathMapping | null> {
    for (const projectId of await this.#ids()) {
      const bindings = await this.read(projectPaths(this.#home, projectId).bindingsFile);
      if (bindings && bindingsBindWorktree(bindings, worktree)) return { projectId };
    }
    return null;
  }
}

/** One-shot {@link BindingIndex.mapPath} for a single Opening Path. */
export async function mapPathToProject(
  home: string,
  openingPath: string,
): Promise<PathMapping | null> {
  return await new BindingIndex(home).mapPath(openingPath);
}

export async function mapWorktreeToProject(
  home: string,
  worktree: string,
): Promise<PathMapping | null> {
  return await new BindingIndex(home).mapWorktree(worktree);
}
