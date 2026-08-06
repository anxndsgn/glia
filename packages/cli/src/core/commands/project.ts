import { mkdir, readdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { parseDeclaration, readDeclaration, type GliaDeclaration } from "../config/glia-json.ts";
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
import { createReplicaIdentity, readReplicaIdentity } from "../project/identity.ts";
import { bindingsLockFile, projectPaths, type ProjectPaths } from "../project/paths.ts";
import { realizeProject } from "../project/realize.ts";
import { resolveWorktreeTopLevel } from "../project/resolve.ts";
import type { LoadedProject } from "../session-module.ts";
import { WriterLease, writerLeaseTimeoutMs } from "../store/lease.ts";
import { ProjectStore } from "../store/store.ts";
import { git } from "../store/git.ts";
import {
  adoptSessionsFrom,
  emptyAdoptMergeReport,
  type AdoptMergeReport,
} from "../../session/domain/adopt.ts";
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
      throw new GliaError(error.code, error.message, error.details, [retryCommand]);
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
  /** Set when glia.json there names a different Project, which no `bind` can re-claim. */
  declaredProjectId: string | null;
  reclaimCommand: string;
  adoptCommand: string;
  previewLines: string[];
}

/** The declared Project ID at `path`, or null when unreadable or absent. */
async function declaredProjectIdAt(path: string): Promise<string | null> {
  try {
    return (await readDeclaration(path))?.projectId ?? null;
  } catch {
    return null;
  }
}

async function inspectForget(
  ctx: MachineCommandContext,
  normalized: string,
): Promise<ForgetInspection> {
  const matches = await exactPathMatches(ctx.home, normalized);
  if (matches.length === 0) {
    throw new GliaError(
      "PATH_NOT_BOUND",
      `path ${normalized} is not bound to any Project`,
      { path: normalized },
      ["glia project list"],
    );
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
  const declared = await declaredProjectIdAt(normalized);
  const declaredProjectId = declared !== null && declared !== match.projectId ? declared : null;
  const reclaimCommand = `glia project bind ${shellQuote(match.projectId)} ${shellQuote(normalized)}`;
  const adoptCommand = `glia project adopt ${shellQuote(normalized)}`;
  const previewLines = [
    `Unbind ${normalized} from project ${match.projectId}.`,
    `The Store remains at ${paths.storeDir} with ${sessionCount === null ? "an unknown number of" : sessionCount} Session(s).`,
  ];
  if (rootless) {
    previewLines.push("This leaves the Project with no roots.");
  }
  if (declaredProjectId !== null) {
    // `bind` would fail there with BINDING_CONFLICT every time, so the
    // recovery path is adopting the declaration, never re-claiming.
    previewLines.push(
      `glia.json there declares project ${declaredProjectId}, so \`glia project bind\` cannot re-claim this path; adopt the declaration with \`${adoptCommand}\` instead.`,
    );
  } else {
    if (rootless) previewLines.push(`Re-claim it with \`${reclaimCommand}\`.`);
    if (!hasDeclaration) {
      previewLines.push(
        `No committed glia.json declaration for this Project was found there; running \`glia import\` at this path again creates a new Project unless you first run \`${reclaimCommand}\`.`,
      );
    }
  }
  return {
    match,
    storeDir: paths.storeDir,
    sessionCount,
    rootless,
    hasDeclaration,
    declaredProjectId,
    reclaimCommand,
    adoptCommand,
    previewLines,
  };
}

function sameForgetPreview(left: ForgetInspection, right: ForgetInspection): boolean {
  return (
    left.match.projectId === right.match.projectId &&
    left.match.kind === right.match.kind &&
    left.sessionCount === right.sessionCount &&
    left.rootless === right.rootless &&
    left.hasDeclaration === right.hasDeclaration &&
    left.declaredProjectId === right.declaredProjectId
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
        { path: normalized },
        [retryCommand],
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
        declaredProjectId: current.declaredProjectId,
        reclaimCommand:
          current.rootless && current.declaredProjectId === null ? current.reclaimCommand : null,
        adoptCommand: current.declaredProjectId === null ? null : current.adoptCommand,
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
        { projectId },
        ["glia project list"],
      );
    }
    const declaration = await readDeclaration(targetPath);
    if (declaration !== null && declaration.projectId !== projectId) {
      throw new GliaError(
        "BINDING_CONFLICT",
        `path ${targetPath} declares project ${declaration.projectId} in glia.json and cannot be bound to ${projectId}`,
        { path: targetPath, projectId, declaredProjectId: declaration.projectId },
        [`glia project adopt ${shellQuote(targetPath)}`, "glia project list"],
      );
    }
    const matches = await exactPathMatches(ctx.home, targetPath);
    const owner = matches.find((match) => match.projectId !== projectId);
    if (owner !== undefined) {
      throw new GliaError(
        "BINDING_CONFLICT",
        `path ${targetPath} is already claimed by project ${owner.projectId}`,
        { path: targetPath, projectId, currentOwner: owner.projectId, currentKind: owner.kind },
        [`glia project forget ${shellQuote(targetPath)}`],
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

export interface ProjectAdoptOptions {
  /** Injected for tests; the preview gate ahead of any mutation. */
  confirm?: (message: string) => Promise<boolean>;
  /** Injected for tests; the post-merge question about deleting the old Project. */
  confirmDelete?: (message: string) => Promise<boolean>;
  deleteOld?: boolean;
}

interface AdoptSubject {
  worktree: string;
  declaration: GliaDeclaration;
  toProjectId: string;
  from: BoundPathMatch | null;
  fromPaths: ProjectPaths | null;
  fromSessionCount: number | null;
  /** The old Project's other roots and aliases, which adopt never touches. */
  remainingBindings: string[];
  alreadyRoot: boolean;
}

async function inspectAdopt(ctx: MachineCommandContext, worktree: string): Promise<AdoptSubject> {
  const declaration = await readDeclaration(worktree);
  if (declaration === null) {
    throw new GliaError(
      "NO_DECLARATION",
      `worktree ${worktree} has no glia.json declaration to adopt`,
      { worktree },
      ["glia project list", "glia import"],
    );
  }
  const toProjectId = declaration.projectId;
  const matches = await exactPathMatches(ctx.home, worktree);
  const from = matches.find((match) => match.projectId !== toProjectId) ?? null;
  const fromPaths = from === null ? null : projectPaths(ctx.home, from.projectId);
  return {
    worktree,
    declaration,
    toProjectId,
    from,
    fromPaths,
    fromSessionCount:
      fromPaths !== null && (await new ProjectStore(fromPaths.storeDir).exists())
        ? await countSessionsAtHead(fromPaths.storeDir)
        : null,
    remainingBindings:
      from === null
        ? []
        : [
            ...new Set(
              [...from.bindings.roots, ...from.bindings.aliases]
                .map(normalizeBoundPath)
                .filter((candidate) => candidate !== worktree),
            ),
          ].sort(),
    alreadyRoot: matches.some((match) => match.projectId === toProjectId && match.kind === "root"),
  };
}

function sameAdoptSubject(left: AdoptSubject, right: AdoptSubject): boolean {
  return (
    left.toProjectId === right.toProjectId &&
    (left.from?.projectId ?? null) === (right.from?.projectId ?? null) &&
    (left.from?.kind ?? null) === (right.from?.kind ?? null) &&
    left.fromSessionCount === right.fromSessionCount &&
    left.remainingBindings.join("\0") === right.remainingBindings.join("\0") &&
    left.alreadyRoot === right.alreadyRoot
  );
}

/**
 * Refuses an impossible deletion before anything is written, so the flag
 * never half-applies a merge it cannot finish as asked.
 */
function refuseImpossibleDeletion(subject: AdoptSubject, retryCommand: string): void {
  if (subject.from === null) {
    throw new GliaError(
      "USAGE",
      `${subject.worktree} has no other Project to delete: it is already the declared project ${subject.toProjectId}`,
      { worktree: subject.worktree, projectId: subject.toProjectId },
      [retryCommand],
    );
  }
  if (subject.remainingBindings.length > 0) {
    throw new GliaError(
      "USAGE",
      `project ${subject.from.projectId} still has ${subject.remainingBindings.length} other Binding(s) and cannot be deleted: ${subject.remainingBindings.join(", ")}`,
      { projectId: subject.from.projectId, remainingBindings: subject.remainingBindings },
      [
        retryCommand,
        ...subject.remainingBindings.map(
          (remaining) => `glia project adopt ${shellQuote(remaining)}`,
        ),
      ],
    );
  }
}

function adoptPreviewLines(subject: AdoptSubject): string[] {
  const declaredRemote = subject.declaration.store.remote ?? null;
  const lines = [
    `Adopt the glia.json declaration at ${subject.worktree}: bind it as a root of project ${subject.toProjectId}.`,
  ];
  if (subject.from !== null && subject.fromPaths !== null) {
    lines.push(
      `Unbind ${subject.worktree} from project ${subject.from.projectId} (${subject.from.kind}).`,
      `Merge ${subject.fromSessionCount === null ? "an unknown number of" : subject.fromSessionCount} Session(s), deletion tombstones, archive markers, and Candidate associations from ${subject.fromPaths.storeDir} into project ${subject.toProjectId}.`,
    );
    if (subject.remainingBindings.length > 0) {
      lines.push(
        `Project ${subject.from.projectId} keeps ${subject.remainingBindings.length} other Binding(s): ${subject.remainingBindings.join(", ")}. It stays alive and cannot be deleted; adopt each of those separately. Candidate ownership moves to ${subject.toProjectId}.`,
      );
    } else {
      lines.push(
        `Project ${subject.from.projectId} is kept at ${subject.fromPaths.projectDir} unless you choose to delete it afterwards. Deleting it destroys its Store Git history, including earlier Revisions this merge does not carry over.`,
      );
    }
  }
  lines.push(
    declaredRemote !== null
      ? `Nothing is sent over the network. Run \`glia sync\` afterwards to merge with ${declaredRemote}.`
      : "Nothing is sent over the network. No remote is declared, so nothing syncs until `glia store remote set <url>`.",
  );
  return lines;
}

/**
 * Accepts the glia.json declaration at a worktree: rebinds the worktree to
 * the declared Project and merges the previously bound Project's Sessions,
 * tombstones, archive markers, and machine-local associations into it. One
 * direction only — adopt never writes glia.json — purely local, and
 * idempotent.
 *
 * Both prompts run before any lease is taken, and the state the user
 * approved is re-inspected under the leases (BINDING_CHANGED on drift),
 * following forget's confirm-then-reverify pattern. The leases are taken
 * in the writer-then-Bindings direction import uses — Store writer leases
 * in Project-ID order first, the machine-global Bindings lease last — so
 * adopt can never form an ABBA cycle with a concurrent capture. The merge
 * runs before the rebinding, so an interruption leaves the declaration
 * mismatch in place, which is exactly what a rerun needs to find.
 */
export async function runProjectAdopt(
  ctx: MachineCommandContext,
  path: string | undefined,
  options: ProjectAdoptOptions = {},
): Promise<CommandOutcome> {
  const worktree = normalizeBoundPath(await resolveWorktreeTopLevel(path ?? ctx.cwd));
  const retryCommand = `glia project adopt ${shellQuote(worktree)}`;

  const first = await inspectAdopt(ctx, worktree);
  if (options.deleteOld === true) refuseImpossibleDeletion(first, retryCommand);

  let deleting = options.deleteOld === true;
  let approved: AdoptSubject | null = null;
  if (!ctx.inputDisabled) {
    approved = first;
    const confirm = options.confirm ?? confirmProceed;
    if (!(await confirm(`${adoptPreviewLines(first).join("\n")}\n\nContinue?`))) {
      throw new GliaError(
        "CANCELLED",
        "project adopt cancelled; Bindings and Stores are unchanged",
      );
    }
    if (
      !deleting &&
      first.from !== null &&
      first.fromPaths !== null &&
      first.remainingBindings.length === 0
    ) {
      const confirmDelete = options.confirmDelete ?? confirmProceed;
      deleting = await confirmDelete(
        `Delete project ${first.from.projectId} and its Store at ${first.fromPaths.projectDir} after the merge completes? Its Sessions will be in project ${first.toProjectId}, but deleting destroys the old Store's Git history, including earlier Revisions.`,
      );
    }
  }

  const toPaths = projectPaths(ctx.home, first.toProjectId);
  const lockTargets = [{ id: first.toProjectId, file: toPaths.writerLockFile }];
  if (first.from !== null && first.fromPaths !== null) {
    lockTargets.push({ id: first.from.projectId, file: first.fromPaths.writerLockFile });
  }
  lockTargets.sort((a, b) => a.id.localeCompare(b.id));

  const writerLeases: WriterLease[] = [];
  try {
    for (const target of lockTargets) {
      writerLeases.push(await acquireStoreLease(target.file, ctx, retryCommand));
    }
    const lease = await acquireBindingsLease(ctx, retryCommand);
    try {
      const current = await inspectAdopt(ctx, worktree);
      // A Project-ID drift means the writer leases cover the wrong Stores;
      // any drift after an interactive preview executes beyond what the
      // user approved. Both re-run cleanly.
      const idsMatch =
        current.toProjectId === first.toProjectId &&
        (current.from?.projectId ?? null) === (first.from?.projectId ?? null);
      if (!idsMatch || (approved !== null && !sameAdoptSubject(approved, current))) {
        throw new GliaError(
          "BINDING_CHANGED",
          `the Binding or Store changed while confirmation was open; review the current state and try again`,
          { path: worktree },
          [retryCommand],
        );
      }
      if (deleting) refuseImpossibleDeletion(current, retryCommand);

      const report = await adoptInto(ctx, current, toPaths);

      // Rebinding is last: an interrupted merge leaves the declaration
      // mismatch in place, which is exactly what a rerun needs to find.
      if (current.from !== null && current.fromPaths !== null) {
        current.from.bindings.roots = current.from.bindings.roots.filter(
          (candidate) => normalizeBoundPath(candidate) !== worktree,
        );
        current.from.bindings.aliases = current.from.bindings.aliases.filter(
          (candidate) => normalizeBoundPath(candidate) !== worktree,
        );
        await writeBindings(current.fromPaths.bindingsFile, current.from.bindings);
      }
      const toBindings = await readBindings(toPaths.bindingsFile);
      if (
        toBindings !== null &&
        toBindings.aliases.some((candidate) => normalizeBoundPath(candidate) === worktree)
      ) {
        // A historical alias of the declared Project is promoted: adopt
        // always leaves the worktree admitting capture.
        toBindings.aliases = toBindings.aliases.filter(
          (candidate) => normalizeBoundPath(candidate) !== worktree,
        );
        await writeBindings(toPaths.bindingsFile, toBindings);
      }
      await realizeProject(
        worktree,
        toPaths,
        current.toProjectId,
        current.declaration.store.remote ?? null,
      );

      let deletedOldProject: boolean | null = current.from === null ? null : false;
      if (
        deleting &&
        current.from !== null &&
        current.fromPaths !== null &&
        current.remainingBindings.length === 0
      ) {
        // The old Store's writer lease is still held here, so no writer
        // commits into the directory while it is removed. A hook that
        // resolved the old Project before this command started can still
        // recreate a partial directory afterwards; that residue shows up
        // as an unreadable entry in `project list` and is safe to remove.
        await rm(current.fromPaths.projectDir, { recursive: true, force: true });
        deletedOldProject = true;
      }

      const declaredRemote = current.declaration.store.remote ?? null;
      const changed = current.from !== null || !current.alreadyRoot;
      return {
        json: {
          path: worktree,
          fromProjectId: current.from?.projectId ?? null,
          toProjectId: current.toProjectId,
          changed,
          merged: report.merged,
          skipped: report.skipped,
          conflicts: report.conflicts,
          ledgerMigrated: report.ledgerMigrated,
          archiveMigrated: report.archiveMigrated,
          associationsRewritten: report.associationsRewritten,
          ignoredMigrated: report.ignoredMigrated,
          withheldDropped: report.withheldDropped,
          fromStoreDir: current.fromPaths?.storeDir ?? null,
          fromProjectDir: current.fromPaths?.projectDir ?? null,
          remainingBindings: current.remainingBindings,
          deletedOldProject,
          storeCommit: report.storeCommit,
          projectionFresh: report.projectionFresh,
          nextSteps: [
            ...(report.conflicts > 0 ? ["glia conflicts"] : []),
            ...(declaredRemote !== null ? ["glia sync"] : []),
          ],
        },
        human: adoptHumanLines(current, report, changed, deletedOldProject).join("\n"),
      };
    } finally {
      lease.release();
    }
  } finally {
    for (const writerLease of writerLeases.reverse()) writerLease.release();
  }
}

function adoptHumanLines(
  subject: AdoptSubject,
  report: AdoptMergeReport,
  changed: boolean,
  deletedOldProject: boolean | null,
): string[] {
  const lines: string[] = [];
  if (!changed && subject.from === null) {
    lines.push(
      `${subject.worktree} is already a root of the declared project ${subject.toProjectId}. Nothing to do.`,
    );
  } else {
    lines.push(`Bound ${subject.worktree} as a root of project ${subject.toProjectId}.`);
  }
  if (subject.from !== null && subject.fromPaths !== null) {
    lines.push(
      `Merged ${report.merged} Session(s) from project ${subject.from.projectId} (${report.skipped} already present, ${report.conflicts} frozen as Session Conflicts, ${report.ledgerMigrated} deletion tombstone(s) and ${report.archiveMigrated} archive marker(s) migrated).`,
    );
    if (
      report.associationsRewritten > 0 ||
      report.ignoredMigrated > 0 ||
      report.withheldDropped > 0
    ) {
      lines.push(
        `Rewrote ${report.associationsRewritten} Candidate association(s), carried over ${report.ignoredMigrated} ignore decision(s), and recorded ${report.withheldDropped} dropped withheld evaluation(s) in the loss record.`,
      );
    }
    if (report.conflicts > 0) {
      lines.push(
        "Inspect the conflicts with `glia conflicts` and pick a Revision with `glia resolve`.",
      );
    }
    lines.push(
      deletedOldProject === true
        ? `Deleted project ${subject.from.projectId} at ${subject.fromPaths.projectDir}.`
        : `Project ${subject.from.projectId} is kept at ${subject.fromPaths.projectDir}${subject.remainingBindings.length > 0 ? ` with ${subject.remainingBindings.length} other Binding(s)` : ""}.`,
    );
  }
  lines.push(
    subject.declaration.store.remote != null
      ? "Run `glia sync` to merge with the declared remote."
      : "No remote is declared; share this Store later with `glia store remote set <url>`.",
  );
  return lines;
}

/**
 * Realizes the declared Project's Store and runs the merge. The caller
 * already holds both Stores' writer leases and the Bindings lease.
 */
async function adoptInto(
  ctx: MachineCommandContext,
  subject: AdoptSubject,
  toPaths: ProjectPaths,
): Promise<AdoptMergeReport> {
  if (subject.from === null || subject.fromPaths === null) return emptyAdoptMergeReport();

  await mkdir(toPaths.stateDir, { recursive: true });
  await mkdir(toPaths.cacheDir, { recursive: true });
  // A declared remote is never contacted here: the local Store is created
  // marker-only when absent, and `glia sync` merges the unrelated
  // histories afterwards.
  await new ProjectStore(toPaths.storeDir).init(subject.declaration.projectId);

  const identity = (await readReplicaIdentity(ctx.home)) ?? (await createReplicaIdentity(ctx.home));
  const target: LoadedProject = {
    home: ctx.home,
    worktree: subject.worktree,
    declaration: subject.declaration,
    paths: toPaths,
    replicaId: identity.replicaId,
    enrollment: { kind: "enrolled" },
  };
  return await adoptSessionsFrom(target, subject.fromPaths, subject.from.projectId);
}

async function acquireStoreLease(
  lockFile: string,
  ctx: MachineCommandContext,
  retryCommand: string,
): Promise<WriterLease> {
  try {
    return await WriterLease.acquire(lockFile, writerLeaseTimeoutMs(ctx.env));
  } catch (error) {
    if (error instanceof GliaError && error.code === "PROJECT_BUSY") {
      throw new GliaError(error.code, error.message, error.details, [retryCommand]);
    }
    throw error;
  }
}

export interface MachineCommandDefinition {
  name: "list" | "forget" | "bind" | "adopt";
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
  {
    name: "adopt",
    description: "accept this worktree's glia.json declaration and merge the locally bound Project",
    requirement: "machine",
  },
];
