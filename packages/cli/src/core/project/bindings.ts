import { join, resolve, sep } from "node:path";
import { realpathSync } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { dirname } from "node:path";
import { projectPaths } from "./paths.ts";
import { requireSupportedSchemaVersion } from "../state/schema-version.ts";

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
  const candidate = normalizeBoundPath(path);
  return (
    bindings.roots.some((root) => isWithin(normalizeBoundPath(root), candidate)) ||
    bindings.aliases.some((alias) => isWithin(normalizeBoundPath(alias), candidate))
  );
}

export interface PathMapping {
  projectId: string;
}

/**
 * One machine-local Binding scan, reused across a batch of lookups.
 *
 * Reading the Bindings under GLIA_HOME is O(Projects) file I/O, so a caller
 * mapping many Opening Paths — discovery classifying every candidate —
 * shares one index rather than rescanning per path. Bindings are read on
 * demand and memoized by file, preserving the first-match-wins order and
 * never reading a Project the lookups never reach.
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
        this.#projectIds = await readdir(join(this.#home, "projects"));
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
    for (const projectId of await this.#ids()) {
      const bindings = await this.read(projectPaths(this.#home, projectId).bindingsFile);
      if (bindings && bindingsContain(bindings, openingPath)) {
        return { projectId };
      }
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
