import type { LoadedProject } from "../../core/session-module.ts";
import { isSessionConflicted } from "./conflict.ts";
import type { DiscoveryResult } from "./discover.ts";
import { readDiscoveryState, type DiscoveryState } from "./discovery-state.ts";

const RETENTION_WARNING_DAYS = 14;
const DAY_MS = 24 * 60 * 60 * 1000;

export type SessionAdvisory =
  | { kind: "importable"; count: number }
  | { kind: "pending"; count: number }
  | {
      kind: "withheld";
      count: number;
      oldestFirstFlaggedAt: string;
      retentionWarning: boolean;
    };

function firstFlaggedAt(state: DiscoveryState, candidateId: string): string | null {
  const evaluation = state.evaluations[candidateId];
  return evaluation?.firstFlaggedAt ?? evaluation?.evaluatedAt ?? null;
}

export function withheldAdvisoryFromState(
  state: DiscoveryState,
  now = new Date(),
): Extract<SessionAdvisory, { kind: "withheld" }> | null {
  const times = Object.keys(state.evaluations)
    .map((candidateId) => firstFlaggedAt(state, candidateId))
    .filter((value): value is string => value !== null)
    .sort();
  if (times.length === 0) return null;
  const oldestFirstFlaggedAt = times[0]!;
  return {
    kind: "withheld",
    count: times.length,
    oldestFirstFlaggedAt,
    retentionWarning: ageDays(oldestFirstFlaggedAt, now) >= RETENTION_WARNING_DAYS,
  };
}

export async function storedWithheldAdvisory(
  project: LoadedProject,
  now = new Date(),
): Promise<Extract<SessionAdvisory, { kind: "withheld" }> | null> {
  return withheldAdvisoryFromState(await readDiscoveryState(project.paths.discoveryFile), now);
}

/** Full-discovery counts used by zero-result search and status. */
export async function advisoriesForDiscovery(
  project: LoadedProject,
  discovery: DiscoveryResult,
  now = new Date(),
): Promise<SessionAdvisory[]> {
  let importable = 0;
  let pending = 0;
  for (const entry of discovery.candidates) {
    if (entry.classification.kind === "pending") pending += 1;
    if (
      entry.classification.kind === "associated" &&
      !(await isSessionConflicted(project.paths.storeDir, entry.candidate.candidateId))
    ) {
      importable += 1;
    }
  }
  const advisories: SessionAdvisory[] = [];
  if (importable > 0) advisories.push({ kind: "importable", count: importable });
  if (pending > 0) advisories.push({ kind: "pending", count: pending });
  const withheld = await storedWithheldAdvisory(project, now);
  if (withheld !== null) advisories.push(withheld);
  return advisories;
}

export function ageDays(timestamp: string, now = new Date()): number {
  const at = Date.parse(timestamp);
  return Number.isFinite(at) ? Math.max(0, Math.floor((now.getTime() - at) / DAY_MS)) : 0;
}

export function renderWithheldBanner(
  advisory: Extract<SessionAdvisory, { kind: "withheld" }>,
  now = new Date(),
): string {
  const days = ageDays(advisory.oldestFirstFlaggedAt, now);
  const age = days === 0 ? "less than a day" : `${days} day(s)`;
  return (
    `Warning: ${advisory.count} withheld Session Candidate(s); oldest withheld for ${age}.` +
    (advisory.retentionWarning ? " Harness retention may delete the source." : "")
  );
}

export function renderDiscoveryAdvisories(
  advisories: readonly SessionAdvisory[],
  now = new Date(),
): string[] {
  const lines: string[] = [];
  for (const advisory of advisories) {
    if (advisory.kind === "importable") {
      lines.push(
        `${advisory.count} Session Candidate(s) are importable; ask before running import.`,
      );
    } else if (advisory.kind === "pending") {
      lines.push(`${advisory.count} Session Candidate(s) are pending Project association.`);
    } else {
      lines.push(renderWithheldBanner(advisory, now));
    }
  }
  return lines;
}

export const retentionWarningDays = RETENTION_WARNING_DAYS;
