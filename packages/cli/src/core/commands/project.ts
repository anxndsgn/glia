import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseDeclaration, readDeclaration } from "../config/glia-json.ts";
import { GliaError } from "../output/errors.ts";
import { confirmProceed } from "../output/confirm.ts";
import type { CommandOutcome } from "../output/result.ts";
import { shellQuote } from "../output/shell.ts";
import {
  normalizeBoundPath,
  readBindings,
  writeBindings,
  type Bindings,
} from "../project/bindings.ts";
import { bindingsLockFile, projectPaths } from "../project/paths.ts";
import { resolveWorktreeTopLevel } from "../project/resolve.ts";
import { WriterLease, writerLeaseTimeoutMs } from "../store/lease.ts";
import { ProjectStore } from "../store/store.ts";
import { git } from "../store/git.ts";
import { countSessionsAtHead } from "../../session/storage/store-layout.ts";

export interface MachineCommandContext {
  requirement: "machine";
  cwd: string;
  home: string;
  env: Record<string, string | undefined>;
  jsonMode: boolean;
  inputDisabled: boolean;
}

interface PathStatus {
  path: string;
  missing: boolean;
}

interface ProjectInventoryEntry {
  projectId: string;
  roots: PathStatus[];
  aliases: PathStatus[];
  captureState: "capturing" | "history_only";
  storeState: "available" | "not_yet_synced";
  sessionCount: number | null;
}

interface UnreadableProjectInventoryEntry {
  projectId: string;
  unreadable: { code: string; message: string };
}

async function pathStatus(path: string): Promise<PathStatus> {
  try {
    await stat(path);
    return { path, missing: false };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { path, missing: true };
    throw error;
  }
}

async function isGenuinelyMissingPath(path: string): Promise<boolean> {
  try {
    await stat(path);
    return false;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return true;
    // ENOTDIR means the target or one of its ancestors is an existing
    // non-directory, so it cannot represent a removed checkout path.
    if (code === "ENOTDIR") return false;
    throw error;
  }
}

async function projectIds(home: string): Promise<string[]> {
  try {
    return (await readdir(join(home, "projects"), { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function runProjectList(ctx: MachineCommandContext): Promise<CommandOutcome> {
  const projects: (ProjectInventoryEntry | UnreadableProjectInventoryEntry)[] = [];
  for (const projectId of await projectIds(ctx.home)) {
    const paths = projectPaths(ctx.home, projectId);
    try {
      const bindings = await readBindings(paths.bindingsFile);
      if (bindings === null) throw new Error(`Bindings file is missing at ${paths.bindingsFile}`);
      const store = new ProjectStore(paths.storeDir);
      const storeExists = await store.exists();
      projects.push({
        projectId,
        roots: await Promise.all(bindings.roots.map(pathStatus)),
        aliases: await Promise.all(bindings.aliases.map(pathStatus)),
        captureState: bindings.roots.length > 0 ? "capturing" : "history_only",
        storeState: storeExists ? "available" : "not_yet_synced",
        sessionCount: storeExists ? await countSessionsAtHead(paths.storeDir) : null,
      });
    } catch (error) {
      const gliaError = error instanceof GliaError ? error : null;
      projects.push({
        projectId,
        unreadable: {
          code: gliaError?.code ?? "INTERNAL",
          message: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  const lines = projects.map((entry) => {
    if ("unreadable" in entry) {
      return `project ${entry.projectId}\n  unreadable: ${entry.unreadable.message}`;
    }
    const roots =
      entry.roots.length === 0
        ? "(none — claims history but captures nothing)"
        : entry.roots.map((root) => `${root.path}${root.missing ? " (missing)" : ""}`).join(", ");
    const aliases =
      entry.aliases.length === 0
        ? "(none)"
        : entry.aliases
            .map((alias) => `${alias.path}${alias.missing ? " (missing)" : ""}`)
            .join(", ");
    const sessions =
      entry.sessionCount === null ? "unknown (Store not yet synced)" : String(entry.sessionCount);
    return `project ${entry.projectId}\n  roots: ${roots}\n  aliases: ${aliases}\n  Sessions: ${sessions}`;
  });
  return {
    json: { projects },
    human: lines.length === 0 ? "No Projects are bound on this machine." : lines.join("\n"),
  };
}

interface BoundPathMatch {
  projectId: string;
  bindings: Bindings;
  kind: "root" | "alias";
}

async function exactPathMatches(home: string, path: string): Promise<BoundPathMatch[]> {
  const normalized = normalizeBoundPath(path);
  const matches: BoundPathMatch[] = [];
  for (const projectId of await projectIds(home)) {
    const bindings = await readBindings(projectPaths(home, projectId).bindingsFile);
    if (bindings === null) continue;
    for (const [kind, paths] of [
      ["root", bindings.roots],
      ["alias", bindings.aliases],
    ] as const) {
      const storedPath = paths.find((candidate) => normalizeBoundPath(candidate) === normalized);
      if (storedPath !== undefined) matches.push({ projectId, bindings, kind });
    }
  }
  return matches;
}

async function hasCommittedDeclaration(path: string, projectId: string): Promise<boolean> {
  try {
    const active = await readDeclaration(path);
    if (active?.projectId !== projectId) return false;
    const result = await git(["show", "HEAD:glia.json"], path);
    if (result.exitCode !== 0) return false;
    const committed = parseDeclaration(JSON.parse(result.stdout), "HEAD:glia.json");
    return committed.projectId === projectId;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return false;
    if (error instanceof GliaError || error instanceof SyntaxError) return false;
    throw error;
  }
}

async function acquireBindingsLease(
  ctx: MachineCommandContext,
  retryCommand: string,
): Promise<WriterLease> {
  try {
    return await WriterLease.acquire(bindingsLockFile(ctx.home), writerLeaseTimeoutMs(ctx.env));
  } catch (error) {
    if (error instanceof GliaError && error.code === "PROJECT_BUSY") {
      throw new GliaError(error.code, error.message, {
        ...error.details,
        nextSteps: [retryCommand],
      });
    }
    throw error;
  }
}

interface ForgetInspection {
  match: BoundPathMatch;
  storeDir: string;
  sessionCount: number | null;
  rootless: boolean;
  hasDeclaration: boolean;
  reclaimCommand: string;
  previewLines: string[];
}

async function inspectForget(
  ctx: MachineCommandContext,
  normalized: string,
): Promise<ForgetInspection> {
  const matches = await exactPathMatches(ctx.home, normalized);
  if (matches.length === 0) {
    throw new GliaError("PATH_NOT_BOUND", `path ${normalized} is not bound to any Project`, {
      path: normalized,
      nextSteps: ["glia project list"],
    });
  }
  const match = matches[0]!;
  const paths = projectPaths(ctx.home, match.projectId);
  const store = new ProjectStore(paths.storeDir);
  const sessionCount = (await store.exists()) ? await countSessionsAtHead(paths.storeDir) : null;
  const remainingRoots = match.bindings.roots.filter(
    (candidate) => normalizeBoundPath(candidate) !== normalized,
  );
  const rootless = match.kind === "root" && remainingRoots.length === 0;
  const hasDeclaration = await hasCommittedDeclaration(normalized, match.projectId);
  const reclaimCommand = `glia project bind ${shellQuote(match.projectId)} ${shellQuote(normalized)}`;
  const previewLines = [
    `Unbind ${normalized} from project ${match.projectId}.`,
    `The Store remains at ${paths.storeDir} with ${sessionCount === null ? "an unknown number of" : sessionCount} Session(s).`,
  ];
  if (rootless) {
    previewLines.push(
      `This leaves the Project with no roots. Re-claim it with \`${reclaimCommand}\`.`,
    );
  }
  if (!hasDeclaration) {
    previewLines.push(
      `No committed glia.json declaration for this Project was found there; running \`glia import\` at this path again creates a new Project unless you first run \`${reclaimCommand}\`.`,
    );
  }
  return {
    match,
    storeDir: paths.storeDir,
    sessionCount,
    rootless,
    hasDeclaration,
    reclaimCommand,
    previewLines,
  };
}

function sameForgetPreview(left: ForgetInspection, right: ForgetInspection): boolean {
  return (
    left.match.projectId === right.match.projectId &&
    left.match.kind === right.match.kind &&
    left.sessionCount === right.sessionCount &&
    left.rootless === right.rootless &&
    left.hasDeclaration === right.hasDeclaration
  );
}

export interface ProjectForgetOptions {
  confirm?: (message: string) => Promise<boolean>;
}

export async function runProjectForget(
  ctx: MachineCommandContext,
  path: string,
  options: ProjectForgetOptions = {},
): Promise<CommandOutcome> {
  const normalized = normalizeBoundPath(path);
  const retryCommand = `glia project forget ${shellQuote(normalized)}`;
  let preview: ForgetInspection | null = null;
  if (!ctx.inputDisabled) {
    preview = await inspectForget(ctx, normalized);
    const confirm = options.confirm ?? confirmProceed;
    if (!(await confirm(`${preview.previewLines.join("\n")}\n\nContinue?`))) {
      throw new GliaError("CANCELLED", "project forget cancelled; Bindings are unchanged");
    }
  }

  const lease = await acquireBindingsLease(ctx, retryCommand);
  try {
    const current = await inspectForget(ctx, normalized);
    if (preview !== null && !sameForgetPreview(preview, current)) {
      throw new GliaError(
        "BINDING_CHANGED",
        `the Binding or Store changed while confirmation was open; review the current state and try again`,
        { path: normalized, nextSteps: [retryCommand] },
      );
    }
    current.match.bindings.roots = current.match.bindings.roots.filter(
      (candidate) => normalizeBoundPath(candidate) !== normalized,
    );
    current.match.bindings.aliases = current.match.bindings.aliases.filter(
      (candidate) => normalizeBoundPath(candidate) !== normalized,
    );
    await writeBindings(
      projectPaths(ctx.home, current.match.projectId).bindingsFile,
      current.match.bindings,
    );
    return {
      json: {
        projectId: current.match.projectId,
        path: normalized,
        removedFrom: current.match.kind,
        sessionCount: current.sessionCount,
        rootless: current.rootless,
        storeDir: current.storeDir,
        reclaimCommand: current.rootless ? current.reclaimCommand : null,
      },
      human: `${current.previewLines.join("\n")}\nBinding removed; no Store data was changed.`,
    };
  } finally {
    lease.release();
  }
}

export async function runProjectBind(
  ctx: MachineCommandContext,
  projectId: string,
  path: string | undefined,
  alias: boolean,
): Promise<CommandOutcome> {
  const candidate = path ?? ctx.cwd;
  let targetPath: string;
  try {
    targetPath = normalizeBoundPath(await resolveWorktreeTopLevel(candidate));
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const mayBeHistoricalAlias =
      alias &&
      path !== undefined &&
      (code === "ENOENT" || code === "ENOTDIR") &&
      (await isGenuinelyMissingPath(candidate));
    if (!mayBeHistoricalAlias) {
      if (code === "ENOENT" || code === "ENOTDIR") {
        throw new GliaError(
          "NOT_A_GIT_WORKTREE",
          `binding root ${normalizeBoundPath(candidate)} is not an existing Git worktree`,
          { path: normalizeBoundPath(candidate) },
        );
      }
      throw error;
    }
    targetPath = normalizeBoundPath(candidate);
  }
  const retryCommand = `glia project bind ${shellQuote(projectId)} ${shellQuote(targetPath)}${alias ? " --alias" : ""}`;
  const lease = await acquireBindingsLease(ctx, retryCommand);
  try {
    const paths = projectPaths(ctx.home, projectId);
    const bindings = await readBindings(paths.bindingsFile);
    if (bindings === null) {
      throw new GliaError(
        "PROJECT_NOT_FOUND",
        `project ${projectId} does not exist on this machine`,
        {
          projectId,
          nextSteps: ["glia project list"],
        },
      );
    }
    const declaration = await readDeclaration(targetPath);
    if (declaration !== null && declaration.projectId !== projectId) {
      throw new GliaError(
        "BINDING_CONFLICT",
        `path ${targetPath} declares project ${declaration.projectId} in glia.json and cannot be bound to ${projectId}`,
        {
          path: targetPath,
          projectId,
          declaredProjectId: declaration.projectId,
          nextSteps: ["glia project list"],
        },
      );
    }
    const matches = await exactPathMatches(ctx.home, targetPath);
    const owner = matches.find((match) => match.projectId !== projectId);
    if (owner !== undefined) {
      throw new GliaError(
        "BINDING_CONFLICT",
        `path ${targetPath} is already claimed by project ${owner.projectId}`,
        {
          path: targetPath,
          projectId,
          currentOwner: owner.projectId,
          currentKind: owner.kind,
          nextSteps: [`glia project forget ${shellQuote(targetPath)}`],
        },
      );
    }

    const matchingRoots = bindings.roots.filter(
      (candidate) => normalizeBoundPath(candidate) === targetPath,
    );
    const matchingAliases = bindings.aliases.filter(
      (candidate) => normalizeBoundPath(candidate) === targetPath,
    );
    const previousKind =
      matchingRoots.length > 0 ? "root" : matchingAliases.length > 0 ? "alias" : null;
    bindings.roots = bindings.roots.filter(
      (candidate) => normalizeBoundPath(candidate) !== targetPath,
    );
    bindings.aliases = bindings.aliases.filter(
      (candidate) => normalizeBoundPath(candidate) !== targetPath,
    );
    (alias ? bindings.aliases : bindings.roots).push(targetPath);
    const changed = alias
      ? matchingAliases.length !== 1 || matchingRoots.length !== 0
      : matchingRoots.length !== 1 || matchingAliases.length !== 0;
    if (changed) await writeBindings(paths.bindingsFile, bindings);
    return {
      json: {
        projectId,
        path: targetPath,
        kind: alias ? "alias" : "root",
        previousKind,
        changed,
      },
      human: changed
        ? `${alias ? "Aliased" : "Bound"} ${targetPath} to project ${projectId}.`
        : `${targetPath} is already ${alias ? "an alias" : "a root"} of project ${projectId}. Nothing to do.`,
    };
  } finally {
    lease.release();
  }
}

export interface MachineCommandDefinition {
  name: "list" | "forget" | "bind";
  description: string;
  requirement: "machine";
}

export const projectCommandDefinitions: readonly MachineCommandDefinition[] = [
  { name: "list", description: "list every machine-local Project Binding", requirement: "machine" },
  {
    name: "forget",
    description: "unbind a root or alias without deleting its Store",
    requirement: "machine",
  },
  {
    name: "bind",
    description: "bind a root or historical alias to an existing Project",
    requirement: "machine",
  },
];
