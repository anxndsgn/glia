import type { GliaDeclaration } from "./config/glia-json.ts";
import type { CommandOutcome } from "./output/result.ts";
import type { ProjectPaths } from "./project/paths.ts";

export interface LoadedProject {
  home: string;
  worktree: string;
  declaration: GliaDeclaration;
  paths: ProjectPaths;
  replicaId: string;
}

export interface ModuleContext {
  project: LoadedProject;
  env: Record<string, string | undefined>;
}

export interface CommandRunContext extends ModuleContext {
  jsonMode: boolean;
  /** True when --no-input was given or stdio is not a TTY. */
  inputDisabled: boolean;
  /** True when stdout may carry ANSI styling. */
  colors?: boolean;
}

export interface CommandOptionDefinition {
  flags: string;
  description: string;
  repeatable?: boolean;
}

export interface CommandDefinition {
  /** Root command name, e.g. `import` → `glia import`. */
  name: string;
  description: string;
  arguments?: { name: string; description: string }[];
  options?: CommandOptionDefinition[];
  run(
    ctx: CommandRunContext,
    args: (string | undefined)[],
    options: Record<string, unknown>,
  ): Promise<CommandOutcome>;
}

export interface ModuleStatus {
  detail: Record<string, unknown>;
}

export interface StoreConflictSide {
  head: string;
  materialize(destDir: string): Promise<void>;
}

export interface StoreUnitConflict {
  unitDir: string;
  local: StoreConflictSide;
  remote: StoreConflictSide;
}

export interface StoreUnitMerge {
  unitDir: string;
  local: StoreConflictSide;
  remote: StoreConflictSide;
}

export interface StoreDeletionEvent {
  unitId: string;
  sourceIdentity: Record<string, string>;
  replicaId: string;
  deletedAt: string;
  epoch: number;
}

export interface StoreDeletionHook {
  ledgerDir: string;
  parseLedgerFile(path: string, content: string): StoreDeletionEvent[];
  serializeLedgerFile(events: StoreDeletionEvent[]): { path: string; content: string };
  mergeLedgerEvents(a: StoreDeletionEvent[], b: StoreDeletionEvent[]): StoreDeletionEvent[];
  purgePathsFor(event: StoreDeletionEvent): string[];
  preserveUnit(
    project: LoadedProject,
    commit: string,
    event: StoreDeletionEvent,
    destDir: string,
  ): Promise<void>;
  onDeletionApplied(project: LoadedProject, events: StoreDeletionEvent[]): Promise<void>;
}

/** The built-in Session vertical and the Store-integrity hooks core uses. */
/**
 * Reported by any command whose write succeeded but whose
 * `rebuildProjection` did not: the operation stands, the projection is
 * stale, and the next query rebuilds it. One wording for every surface.
 */
export const PROJECTION_DEFERRED_NOTE =
  "Projection rebuild deferred; the next query will rebuild it.";

export interface SessionModule<TConfig = unknown> {
  readonly id: string;
  readonly description: string;
  readonly commands: readonly CommandDefinition[];
  parseConfig(input: unknown): TConfig;
  inspect(context: ModuleContext, config: TConfig): Promise<ModuleStatus>;
  storeUnitFor?(path: string): string | null;
  onStoreUnitConflict?(project: LoadedProject, conflict: StoreUnitConflict): Promise<void>;
  mergeStoreUnitFor?(unitDir: string): boolean;
  mergeStoreUnit?(project: LoadedProject, merge: StoreUnitMerge): Promise<void>;
  rebuildProjection?(project: LoadedProject, storeCommit: string): Promise<void>;
  deletion?: StoreDeletionHook;
}
