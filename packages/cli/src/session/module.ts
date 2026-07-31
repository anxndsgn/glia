import { join } from "node:path";
import { rm } from "node:fs/promises";
import type {
  SessionModule,
  LoadedProject,
  ModuleContext,
  ModuleStatus,
  StoreUnitConflict,
} from "../core/session-module.ts";
import { ProjectStore } from "../core/store/store.ts";
import { listSessionIds } from "./storage/store-layout.ts";
import {
  buildAndPublishLocked,
  pointerIsCurrent,
  readCurrentPointer,
} from "./projection/publish.ts";
import { discoverCandidates } from "./domain/discover.ts";
import {
  candidatesFromSideDir,
  listConflictedSessionIds,
  writeConflictLayout,
} from "./domain/conflict.ts";
import { importCommand } from "./commands/import.ts";
import { candidatesCommand } from "./commands/candidates.ts";
import { acceptCommand } from "./commands/accept.ts";
import { listCommand } from "./commands/list.ts";
import { showCommand } from "./commands/show.ts";
import { searchCommand } from "./commands/search.ts";
import { viewCommand } from "./commands/view.ts";
import { exportCommand } from "./commands/export.ts";
import { conflictsCommand } from "./commands/conflicts.ts";
import { resolveCommand } from "./commands/resolve.ts";
import { deleteCommand } from "./commands/delete.ts";
import { tombstonesCommand } from "./commands/tombstones.ts";
import { archiveCommand, unarchiveCommand } from "./commands/archive.ts";
import {
  SESSION_LEDGER_DIR,
  collapseLocalState,
  mergeLedgerEvents,
  parseLedgerFile,
  preserveSessionUnit,
  purgePathsFor,
  readLocalLedgerEvents,
  serializeLedgerFile,
} from "./domain/deletion.ts";
import { countArchivedSessions, mergeArchiveUnit, SESSION_ARCHIVE_DIR } from "./domain/archive.ts";

const SESSIONS_PREFIX = "session/sessions/";

export interface SessionConfig {
  /** The secret-detection gate; enabled unless the declaration turns it off. */
  secretDetectionEnabled: boolean;
}

export const sessionModule: SessionModule<SessionConfig> = {
  id: "session",
  description: "complete agent Sessions preserved as historical evidence",
  commands: [
    importCommand,
    candidatesCommand,
    acceptCommand,
    listCommand,
    showCommand,
    searchCommand,
    viewCommand,
    exportCommand,
    conflictsCommand,
    resolveCommand,
    deleteCommand,
    tombstonesCommand,
    archiveCommand,
    unarchiveCommand,
  ],

  parseConfig(input: unknown): SessionConfig {
    const secretDetection =
      typeof input === "object" && input !== null
        ? (input as Record<string, unknown>)["secretDetection"]
        : undefined;
    return {
      secretDetectionEnabled:
        (secretDetection as { enabled?: boolean } | undefined)?.enabled !== false,
    };
  },

  /** A Revision is one atomic whole: the Session directory is the divergence unit. */
  storeUnitFor(path: string): string | null {
    if (path === SESSION_ARCHIVE_DIR || path.startsWith(`${SESSION_ARCHIVE_DIR}/`)) {
      return SESSION_ARCHIVE_DIR;
    }
    if (!path.startsWith(SESSIONS_PREFIX)) return null;
    const sessionId = path.slice(SESSIONS_PREFIX.length).split("/")[0];
    if (!sessionId || sessionId.length === 0) return null;
    return `${SESSIONS_PREFIX}${sessionId}`;
  },

  mergeStoreUnitFor(unitDir: string): boolean {
    return unitDir === SESSION_ARCHIVE_DIR;
  },

  async mergeStoreUnit(project, merge): Promise<void> {
    await mergeArchiveUnit(project, merge);
  },

  async onStoreUnitConflict(project: LoadedProject, conflict: StoreUnitConflict): Promise<void> {
    const sessionId = conflict.unitDir.slice(SESSIONS_PREFIX.length);
    const staging = join(project.paths.stagingRoot, `conflict-${process.pid}-${sessionId}`);
    await rm(staging, { recursive: true, force: true });
    try {
      const localDir = join(staging, "local");
      const remoteDir = join(staging, "remote");
      await conflict.local.materialize(localDir);
      await conflict.remote.materialize(remoteDir);
      const candidates = [
        ...(await candidatesFromSideDir(localDir)),
        ...(await candidatesFromSideDir(remoteDir)),
      ];
      await writeConflictLayout(project.paths.storeDir, sessionId, candidates);
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  },

  async rebuildProjection(project: LoadedProject, storeCommit: string): Promise<void> {
    await buildAndPublishLocked(project, storeCommit);
  },

  /**
   * The deletion Store-integrity hook: ledger format and merge rule,
   * event-to-purge-path mapping, export-shaped bystander preservation,
   * and machine-local collapse. Core invokes it regardless of enablement,
   * so a disabled Session module never blocks deletion propagation.
   */
  deletion: {
    ledgerDir: SESSION_LEDGER_DIR,
    parseLedgerFile,
    serializeLedgerFile,
    mergeLedgerEvents,
    purgePathsFor,
    preserveUnit: preserveSessionUnit,
    onDeletionApplied: collapseLocalState,
  },

  async inspect(context: ModuleContext, config: SessionConfig): Promise<ModuleStatus> {
    const { project } = context;
    const sessionIds = await listSessionIds(project.paths.storeDir);
    const conflictedIds = await listConflictedSessionIds(project.paths.storeDir);
    const tombstoneEvents = await readLocalLedgerEvents(project.paths.storeDir);
    const archived = await countArchivedSessions(project.paths.storeDir);
    const pointer = await readCurrentPointer(project.paths.currentProjectionFile);
    const store = new ProjectStore(project.paths.storeDir);
    const head = (await store.exists()) ? await store.head() : null;

    let pendingCandidates = 0;
    let ignoredCandidates = 0;
    const discovery = await discoverCandidates(project, context.env, null);
    for (const { classification } of discovery.candidates) {
      if (classification.kind === "pending") pendingCandidates += 1;
      if (classification.kind === "ignored") ignoredCandidates += 1;
    }
    return {
      detail: {
        secretDetection: config.secretDetectionEnabled ? "enabled" : "disabled",
        sessions: sessionIds.length,
        archived,
        conflicts: conflictedIds.length,
        tombstoneEvents: tombstoneEvents.length,
        pendingCandidates,
        ignoredCandidates,
        projection:
          pointer === null
            ? { state: "absent" }
            : {
                state: head !== null && pointerIsCurrent(pointer, head) ? "fresh" : "stale",
                storeCommit: pointer.storeCommit,
              },
      },
    };
  },
};
