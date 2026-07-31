import { buildInfo } from "../build-info.ts";
import type { SessionModule, LoadedProject } from "../session-module.ts";
import type { CommandOutcome } from "../output/result.ts";
import { readBindings } from "../project/bindings.ts";
import { countPreservedItems, readDeletionPending } from "../store/deletion.ts";
import { readSyncState } from "../store/sync-state.ts";

/** `glia status` is read-only after Project resolution and never touches the network. */
export async function runStatus(
  project: LoadedProject,
  modules: readonly SessionModule[],
  env: Record<string, string | undefined>,
): Promise<CommandOutcome> {
  const bindings = await readBindings(project.paths.bindingsFile);
  const remote = project.declaration.store.remote ?? null;
  const syncState = await readSyncState(project.paths.syncStateFile);
  const pendingDeletion = remote
    ? await readDeletionPending(project.paths.deletionPendingFile)
    : null;
  const preservedItems = await countPreservedItems(project.paths.preservedDir);
  const unknownKeys = Object.keys(project.declaration.unknownKeys ?? {}).sort();
  const sessionModule = modules[0];
  const sessionStatus = sessionModule
    ? await sessionModule.inspect({ project, env }, sessionModule.parseConfig(project.declaration))
    : { detail: {} };
  const build = buildInfo();

  const lines = [
    `project ${project.declaration.projectId}`,
    `  worktree: ${project.worktree}`,
    `  glia: ${build.version} (${build.commit} ${build.builtAt})`,
    `  store: ${remote ? `remote ${remote}` : "local_only (no clean-machine recovery until a remote is configured)"}`,
  ];
  if (remote) {
    lines.push(
      syncState?.lastFetchAt ? `  last fetch: ${syncState.lastFetchAt}` : "  last fetch: never",
      syncState?.lastSyncAt
        ? `  last sync: ${syncState.lastSyncAt} (${syncState.outcome}, head ${syncState.head!.slice(0, 12)})`
        : "  last sync: never (run `glia sync`)",
    );
  }
  if (pendingDeletion && pendingDeletion.events.length > 0) {
    lines.push(
      `  deletion: ${pendingDeletion.events.length} event(s) applied locally, propagation pending (run \`glia sync\`)`,
    );
  }
  if (preservedItems > 0) {
    lines.push(
      `  preserved: ${preservedItems} bystander item(s) awaiting disposition in ${project.paths.preservedDir}`,
    );
  }
  if (unknownKeys.length > 0) {
    lines.push(`  glia.json: unrecognized top-level key(s) ${unknownKeys.join(", ")} (preserved)`);
  }
  lines.push(`  bound roots: ${bindings?.roots.join(", ") ?? "(none)"}`);
  const detailText = Object.entries(sessionStatus.detail)
    .map(
      ([key, value]) =>
        `${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`,
    )
    .join(" ");
  lines.push(`  session: ${detailText}`);

  return {
    json: {
      projectId: project.declaration.projectId,
      worktree: project.worktree,
      build,
      store: {
        mode: remote ? "remote" : "local_only",
        remote,
        lastFetchAt: syncState?.lastFetchAt ?? null,
        lastSyncAt: syncState?.lastSyncAt ?? null,
        lastSync: syncState?.lastSyncAt
          ? { at: syncState.lastSyncAt, outcome: syncState.outcome, head: syncState.head }
          : null,
        deletionPropagationPending:
          pendingDeletion && pendingDeletion.events.length > 0
            ? { events: pendingDeletion.events.length }
            : null,
        preservedItems,
      },
      unrecognizedKeys: unknownKeys,
      boundRoots: bindings?.roots ?? [],
      session: sessionStatus.detail,
    },
    human: lines.join("\n"),
  };
}
