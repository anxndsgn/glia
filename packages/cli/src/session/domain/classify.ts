import { BindingIndex } from "../../core/project/bindings.ts";
import type { LoadedProject } from "../../core/session-module.ts";
import type { SessionCandidate } from "../adapters/types.ts";
import type { DiscoveryState } from "./discovery-state.ts";
import { isTombstoned, ledgerEventsFor } from "./deletion.ts";

export type CandidateClass =
  | { kind: "associated"; via: "binding" | "explicit" }
  | { kind: "out_of_scope"; mappedProjectId: string | null }
  | { kind: "pending" }
  | { kind: "ignored" }
  | { kind: "tombstoned"; deletedAt: string; deletedBy: string; epoch: number };

export interface ClassifiedCandidate {
  candidate: SessionCandidate;
  classification: CandidateClass;
}

/**
 * Association rules:
 * - a live exact-worktree Binding wins over a stale explicit decision;
 * - otherwise an explicit machine-local decision wins;
 * - a tombstoned Source Identity — a Deletion Ledger entry and no live
 *   Session — is never accepted automatically again, and `tombstoned`
 *   takes precedence over `flagged` when both apply;
 * - an Opening Path under this Project's Bindings is associated (inferred);
 * - a resolvable Opening Path outside the bound roots is out of scope and
 *   skipped without requiring input or creating an ignore decision;
 * - a missing or unresolvable Opening Path is pending and requires an
 *   explicit decision;
 * - a Session is never split or assigned to multiple Projects.
 */
export async function classifyCandidate(
  project: LoadedProject,
  state: DiscoveryState,
  candidate: SessionCandidate,
  bindings: BindingIndex = new BindingIndex(project.home),
): Promise<CandidateClass> {
  if (state.ignored.includes(candidate.candidateId)) return { kind: "ignored" };

  if (await isTombstoned(project.paths.storeDir, candidate.candidateId)) {
    const events = await ledgerEventsFor(project.paths.storeDir, candidate.candidateId);
    const last = events[events.length - 1]!;
    return {
      kind: "tombstoned",
      deletedAt: last.deletedAt,
      deletedBy: last.replicaId,
      epoch: last.epoch,
    };
  }

  const explicit = state.associations[candidate.candidateId];
  if (candidate.openingPath !== null) {
    const resolution = await bindings.resolveOpeningPath(candidate.openingPath);
    if (resolution.mapping !== null) {
      if (resolution.mapping.projectId !== project.declaration.projectId) {
        return { kind: "out_of_scope", mappedProjectId: resolution.mapping.projectId };
      }
      return {
        kind: "associated",
        via: explicit?.projectId === project.declaration.projectId ? "explicit" : "binding",
      };
    }
    if (!resolution.resolved && explicit === undefined) return { kind: "pending" };
  }

  if (explicit) {
    return explicit.projectId === project.declaration.projectId
      ? { kind: "associated", via: "explicit" }
      : { kind: "out_of_scope", mappedProjectId: explicit.projectId };
  }
  if (candidate.openingPath === null) return { kind: "pending" };
  return { kind: "out_of_scope", mappedProjectId: null };
}
