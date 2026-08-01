import type { CommandDefinition } from "../../core/session-module.ts";
import type { CommandOutcome } from "../../core/output/result.ts";
import { GliaError } from "../../core/output/errors.ts";
import { byRecency, positiveIntOrNull } from "./shared.ts";
import { discoverCandidates, candidateSummary } from "../domain/discover.ts";
import { readDiscoveryState } from "../domain/discovery-state.ts";
import type { ClassifiedCandidate } from "../domain/classify.ts";
import type { PersistedEvaluation } from "../domain/secret-detection.ts";
import { listArchiveMarkers } from "../domain/archive.ts";
import { renderSuspectedHits } from "./render-secret-hits.ts";
import {
  candidateDisplayLabel,
  candidateSubagentNote,
  shortSessionTime,
} from "./candidate-display.ts";
import { truncate } from "../../core/output/terminal.ts";

const DEFAULT_LIMIT = 50;
/** Display cap for the label column in human rows. */
const LABEL_WIDTH = 60;

/** The `--status` vocabulary, spelled exactly as the `--json` document spells it. */
const STATUS_VOCABULARY = [
  "associated",
  "out_of_scope",
  "pending",
  "ignored",
  "tombstoned",
  "flagged",
] as const;
type StatusFilter = (typeof STATUS_VOCABULARY)[number];

type DetectionReport =
  | { status: "not_evaluated" }
  | {
      status: "flagged";
      rulesetVersion: number;
      bundleDigest: string;
      evaluatedAt: string;
      suspectedSecrets: PersistedEvaluation["hits"];
      unscanned: PersistedEvaluation["unscanned"];
    };

export const candidatesCommand: CommandDefinition = {
  name: "candidates",
  description: "discover and classify every current Session Candidate without mutating the Store",
  options: [
    {
      flags: "--status <class>",
      description: `show only candidates of a classification (${STATUS_VOCABULARY.join(", ")}); repeatable, values union`,
      repeatable: true,
    },
    {
      flags: "--limit <n>",
      description: `maximum candidate entries (default ${DEFAULT_LIMIT}; the true total is always stated)`,
    },
    { flags: "--all", description: "remove the entry bound (mutually exclusive with --limit)" },
  ],
  async run(ctx, _args, options): Promise<CommandOutcome> {
    const statuses = parseStatusFilters(options["status"]);
    const limitOption = positiveIntOrNull(options["limit"], "--limit");
    const all = options["all"] === true;
    if (all && limitOption !== null) {
      throw new GliaError("USAGE", "--all and --limit are mutually exclusive");
    }
    const limit = limitOption ?? DEFAULT_LIMIT;

    const discovery = await discoverCandidates(ctx.project, ctx.env, null);
    const state = await readDiscoveryState(ctx.project.paths.discoveryFile);
    const archiveStates = new Map(
      (await listArchiveMarkers(ctx.project.paths.storeDir)).map((marker) => [
        marker.sessionId,
        marker.state,
      ]),
    );
    // Detection evaluates only captured bytes; here only the persisted
    // evaluation of the last evaluating import can speak. Anything else
    // is honestly not_evaluated — candidates never captures.
    const detectionFor = (candidateId: string): DetectionReport => {
      const evaluation = state.evaluations[candidateId];
      if (!evaluation) return { status: "not_evaluated" };
      return {
        status: "flagged",
        rulesetVersion: evaluation.rulesetVersion,
        bundleDigest: evaluation.bundleDigest,
        evaluatedAt: evaluation.evaluatedAt,
        suspectedSecrets: evaluation.hits,
        unscanned: evaluation.unscanned,
      };
    };
    const isFlagged = (entry: ClassifiedCandidate): boolean =>
      entry.classification.kind === "associated" &&
      state.evaluations[entry.candidate.candidateId] !== undefined;

    // The tally is the stable global summary: one count per classification
    // plus `flagged`, the non-additive subset of associated candidates
    // carrying secret flags.
    const counts = {
      associated: 0,
      out_of_scope: 0,
      pending: 0,
      ignored: 0,
      flagged: 0,
      tombstoned: 0,
    };
    for (const entry of discovery.candidates) {
      counts[entry.classification.kind] += 1;
      if (isFlagged(entry)) counts.flagged += 1;
    }

    // Actionable-first, deterministic entry order: the default cap
    // truncates stale noise, never pending work.
    const classRank = (entry: ClassifiedCandidate): number => {
      switch (entry.classification.kind) {
        case "pending":
          return 0;
        case "associated":
          return isFlagged(entry) ? 1 : 2;
        case "out_of_scope":
          return 3;
        case "ignored":
          return 4;
        case "tombstoned":
          return 5;
      }
    };
    const matchesStatus = (entry: ClassifiedCandidate): boolean => {
      if (statuses.length === 0) return true;
      return statuses.some((status) =>
        status === "flagged" ? isFlagged(entry) : entry.classification.kind === status,
      );
    };
    const selected = discovery.candidates.filter(matchesStatus).sort((a, b) => {
      const byClass = classRank(a) - classRank(b);
      return byClass !== 0 ? byClass : byRecency(a, b);
    });
    const shown = all ? selected : selected.slice(0, limit);

    const candidates = shown.map(({ candidate, classification }) => ({
      ...candidateSummary(candidate),
      classification,
      archiveState: archiveStates.get(candidate.candidateId) ?? "active",
      secretDetection: detectionFor(candidate.candidateId),
    }));

    const flaggedIds: string[] = [];
    const lines: string[] = [
      `${discovery.candidates.length} candidate(s): ${counts.associated} associated (${counts.flagged} flagged), ` +
        `${counts.out_of_scope} out of scope, ${counts.pending} pending, ${counts.ignored} ignored, ` +
        `${counts.tombstoned} tombstoned.`,
    ];
    const explicitStatuses = statuses.length > 0;
    // The default form expands only actionable entries; an explicit
    // --status selection lists what it asked for.
    const visible = shown.filter(
      (entry) =>
        explicitStatuses ||
        entry.classification.kind === "pending" ||
        entry.classification.kind === "tombstoned" ||
        isFlagged(entry),
    );
    const statusOf = (entry: ClassifiedCandidate): string =>
      isFlagged(entry) ? "flagged" : entry.classification.kind;
    const statusWidth = Math.max(0, ...visible.map((entry) => statusOf(entry).length));
    for (const entry of visible) {
      const { candidate, classification } = entry;
      const archiveNote =
        archiveStates.get(candidate.candidateId) === "archived" ? " [archived]" : "";
      lines.push(
        `${statusOf(entry).padEnd(statusWidth)}  ${shortSessionTime(candidate.sessionTime)}  ` +
          `${truncate(candidateDisplayLabel(candidate), LABEL_WIDTH)}  ` +
          `${candidate.candidateId}${archiveNote}${candidateSubagentNote(candidate)}`,
      );
      if (classification.kind === "tombstoned") {
        lines.push(
          `  deleted ${classification.deletedAt} by replica ${classification.deletedBy} (epoch ${classification.epoch})`,
        );
        continue;
      }
      const evaluation = state.evaluations[candidate.candidateId];
      if (classification.kind === "associated" && evaluation !== undefined) {
        flaggedIds.push(candidate.candidateId);
        for (const line of renderSuspectedHits(evaluation.hits, evaluation.unscanned)) {
          lines.push(`  ${line}`);
        }
      }
    }
    if (shown.length < selected.length) {
      lines.push(
        `entries capped at ${shown.length} of ${selected.length} under the active filter (--all removes the bound).`,
      );
    }
    if (counts.pending > 0)
      lines.push("Associate a pending candidate with `glia accept <candidate-id>`.");
    if (counts.tombstoned > 0)
      lines.push(
        "Re-admit a tombstoned candidate explicitly with `glia accept <candidate-id>`; the override is persisted.",
      );
    if (counts.flagged > 0) {
      const target = flaggedIds.length === 1 ? flaggedIds[0]! : "<candidate-id>";
      lines.push(
        `Accept a flagged candidate explicitly with \`glia accept ${target}\`; the override is persisted.`,
      );
    }
    for (const failure of discovery.adapterFailures) {
      lines.push(`warning: ${failure.harnessId} discovery failed: ${failure.message}`);
    }
    return {
      json: {
        counts,
        totalCandidates: selected.length,
        candidates,
        parameters: { status: statuses, limit: all ? null : limit, all },
        unavailableHarnesses: discovery.unavailableHarnesses,
        adapterFailures: discovery.adapterFailures,
      },
      human: lines.join("\n"),
    };
  },
};

function parseStatusFilters(raw: unknown): StatusFilter[] {
  if (raw === undefined) return [];
  const values = Array.isArray(raw) ? raw.map(String) : [String(raw)];
  for (const value of values) {
    if (!(STATUS_VOCABULARY as readonly string[]).includes(value)) {
      throw new GliaError(
        "USAGE",
        `--status accepts ${STATUS_VOCABULARY.join(", ")}; got: ${value}`,
      );
    }
  }
  return values as StatusFilter[];
}
