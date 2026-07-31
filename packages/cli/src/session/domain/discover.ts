import { BindingIndex } from "../../core/project/bindings.ts";
import type { LoadedProject } from "../../core/session-module.ts";
import type { HarnessId } from "../../core/harnesses/ids.ts";
import { sessionAdapters } from "../adapters/index.ts";
import type { SessionCandidate } from "../adapters/types.ts";
import { readDiscoveryState } from "./discovery-state.ts";
import { classifyCandidate, type ClassifiedCandidate } from "./classify.ts";

export interface AdapterFailure {
  harnessId: HarnessId;
  message: string;
}

export interface DiscoveryResult {
  candidates: ClassifiedCandidate[];
  unavailableHarnesses: { harnessId: HarnessId; reason: string | null }[];
  adapterFailures: AdapterFailure[];
}

/**
 * Read-only discovery across every eligible Harness. An unavailable or
 * empty Harness never fails the run; adapter failures are isolated and
 * reported as a partial result.
 */
export async function discoverCandidates(
  project: LoadedProject,
  env: Record<string, string | undefined>,
  harnessFilter: HarnessId | null,
): Promise<DiscoveryResult> {
  const state = await readDiscoveryState(project.paths.discoveryFile);
  // One Binding scan for the whole run: classification is per candidate,
  // but the Bindings it reads are the same for every one of them.
  const bindings = new BindingIndex(project.home);
  const result: DiscoveryResult = { candidates: [], unavailableHarnesses: [], adapterFailures: [] };

  for (const adapter of sessionAdapters) {
    if (harnessFilter !== null && adapter.harnessId !== harnessFilter) continue;
    try {
      const availability = await adapter.inspectAvailability({ env });
      if (!availability.available) {
        result.unavailableHarnesses.push({
          harnessId: adapter.harnessId,
          reason: availability.reason,
        });
        continue;
      }
      const seen = new Set<string>();
      for await (const candidate of adapter.discover({ env })) {
        if (seen.has(candidate.candidateId)) continue;
        seen.add(candidate.candidateId);
        const classification = await classifyCandidate(project, state, candidate, bindings);
        result.candidates.push({ candidate, classification });
      }
    } catch (err) {
      result.adapterFailures.push({
        harnessId: adapter.harnessId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  return result;
}

export function candidateSummary(c: SessionCandidate): Record<string, unknown> {
  return {
    candidateId: c.candidateId,
    harnessId: c.identity.harnessId,
    sourceSessionId: c.identity.sourceSessionId,
    openingPath: c.openingPath,
    continuation: c.continuation,
    sessionTime: c.sessionTime,
    label: c.label,
  };
}
