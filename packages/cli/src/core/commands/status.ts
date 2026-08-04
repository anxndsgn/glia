import { buildInfo } from "../build-info.ts";
import { projectIsEnrolled, type SessionModule, type LoadedProject } from "../session-module.ts";
import type { CommandOutcome } from "../output/result.ts";
import { readBindings } from "../project/bindings.ts";
import { countPreservedItems, readDeletionPending } from "../store/deletion.ts";
import { readSyncState } from "../store/sync-state.ts";
import { ageDays } from "../../session/domain/advisories.ts";
import { HARNESS_IDS } from "../harnesses/ids.ts";
import { managedHookInstalled } from "../hooks/config.ts";

/** `glia status` is read-only after Project resolution and never touches the network. */
export async function runStatus(
  project: LoadedProject,
  modules: readonly SessionModule[],
  env: Record<string, string | undefined>,
): Promise<CommandOutcome> {
  const enrolled = projectIsEnrolled(project);
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
  const hookInstallation = Object.fromEntries(
    await Promise.all(
      HARNESS_IDS.map(async (harnessId) => [
        harnessId,
        await managedHookInstalled(harnessId, env).catch(() => false),
      ]),
    ),
  );

  const lines = [
    enrolled ? `project ${project.declaration.projectId}` : "repository (not enrolled)",
    `  worktree: ${project.worktree}`,
    `  glia: ${build.version} (${build.commit} ${build.builtAt})`,
    enrolled
      ? `  store: ${remote ? `remote ${remote}` : "local_only (no clean-machine recovery until a remote is configured)"}`
      : `  store declaration: ${remote ?? "none"}`,
    `  enrollment: ${enrolled ? "enrolled" : "not enrolled (run `glia import`)"}`,
    `  hooks installed: ${HARNESS_IDS.map((id) => `${id}=${hookInstallation[id] ? "yes" : "no"}`).join(" ")}`,
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
  lines.push(`  bound roots: ${enrolled ? (bindings?.roots.join(", ") ?? "(none)") : "(none)"}`);
  const detailText = Object.entries(sessionStatus.detail)
    .map(
      ([key, value]) =>
        `${key}=${typeof value === "object" ? JSON.stringify(value) : String(value)}`,
    )
    .join(" ");
  lines.push(`  session: ${detailText}`);
  const withheld = sessionStatus.detail["withheldCandidates"] as
    | { count?: number; oldestFirstFlaggedAt?: string | null; retentionWarning?: boolean }
    | undefined;
  if ((withheld?.count ?? 0) > 0) {
    const days = ageDays(withheld!.oldestFirstFlaggedAt!);
    const age = days === 0 ? "less than a day" : `${days} day(s)`;
    lines.push(
      `  withheld: ${withheld!.count} candidate(s), oldest withheld for ${age} (first flagged ${withheld!.oldestFirstFlaggedAt})` +
        (withheld!.retentionWarning ? "; Harness retention may delete the source" : ""),
    );
  }
  const lost = sessionStatus.detail["lostWithheldCandidates"] as { count?: number } | undefined;
  if ((lost?.count ?? 0) > 0) {
    lines.push(`  withheld source loss: ${lost!.count} candidate(s)`);
  }
  const hooks = sessionStatus.detail["hookLiveness"] as
    | {
        machineLastRunAt?: string | null;
        projectLastRunAt?: string | null;
        projectLastOutcome?: string | null;
      }
    | undefined;
  lines.push(
    `  hook last run (machine): ${hooks?.machineLastRunAt ?? "never"}`,
    `  hook last import (Project): ${hooks?.projectLastRunAt ?? "never"}` +
      (hooks?.projectLastOutcome ? ` (${hooks.projectLastOutcome})` : ""),
  );

  return {
    json: {
      projectId: enrolled ? project.declaration.projectId : null,
      enrolled,
      worktree: project.worktree,
      build,
      hookInstallation,
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
