import { dirname } from "node:path";
import { mkdir } from "node:fs/promises";
import { requireSupportedSchemaVersion } from "../../core/state/schema-version.ts";
import type { PersistedEvaluation } from "./secret-detection.ts";

export const DISCOVERY_STATE_SCHEMA_VERSION = 1;

/**
 * Machine-local discovery state. Ignore decisions, explicit
 * associations, and secret-detection evaluations never become shared
 * Project scope. Evaluations hold only masked data.
 */
export interface DiscoveryState {
  schemaVersion: number;
  ignored: string[];
  associations: Record<string, { projectId: string; decidedAt: string }>;
  /** Flagged Candidates' evaluations, keyed by Candidate ID. */
  evaluations: Record<string, PersistedEvaluation>;
}

export function emptyDiscoveryState(): DiscoveryState {
  return {
    schemaVersion: DISCOVERY_STATE_SCHEMA_VERSION,
    ignored: [],
    associations: {},
    evaluations: {},
  };
}

/**
 * The write side of the association rules `classify.ts` reads. An explicit
 * association must supersede an earlier ignore decision — classification
 * answers `ignored` before it looks at associations, so leaving the
 * Candidate in `ignored` would silently discard the decision.
 *
 * A batch of decisions taken together shares one `decidedAt`.
 */
export function associateCandidate(
  state: DiscoveryState,
  candidateId: string,
  projectId: string,
  decidedAt: string = new Date().toISOString(),
): void {
  state.ignored = state.ignored.filter((id) => id !== candidateId);
  state.associations[candidateId] = { projectId, decidedAt };
}

/**
 * Records a machine-local ignore decision. Any persisted evaluation drops
 * with it: the Candidate is no longer awaiting a secret-detection verdict.
 */
export function ignoreCandidate(state: DiscoveryState, candidateId: string): void {
  if (!state.ignored.includes(candidateId)) state.ignored.push(candidateId);
  delete state.evaluations[candidateId];
}

export async function readDiscoveryState(discoveryFile: string): Promise<DiscoveryState> {
  const file = Bun.file(discoveryFile);
  if (!(await file.exists())) return emptyDiscoveryState();
  const raw = JSON.parse(await file.text()) as Partial<DiscoveryState>;
  requireSupportedSchemaVersion(
    "discovery state",
    discoveryFile,
    raw.schemaVersion,
    DISCOVERY_STATE_SCHEMA_VERSION,
  );
  return {
    schemaVersion: DISCOVERY_STATE_SCHEMA_VERSION,
    ignored: Array.isArray(raw.ignored) ? raw.ignored.map(String) : [],
    associations:
      typeof raw.associations === "object" && raw.associations !== null ? raw.associations : {},
    evaluations:
      typeof raw.evaluations === "object" && raw.evaluations !== null ? raw.evaluations : {},
  };
}

export async function writeDiscoveryState(
  discoveryFile: string,
  state: DiscoveryState,
): Promise<void> {
  await mkdir(dirname(discoveryFile), { recursive: true });
  await Bun.write(discoveryFile, JSON.stringify(state, null, 2) + "\n");
}
