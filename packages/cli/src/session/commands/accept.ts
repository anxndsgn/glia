import type { CommandDefinition, CommandRunContext } from "../../core/session-module.ts";
import type { CommandOutcome } from "../../core/output/result.ts";
import { confirmProceed } from "../../core/output/confirm.ts";
import { pickGrouped, type PickerItem } from "../../core/output/picker.ts";
import { GliaError } from "../../core/output/errors.ts";
import { BindingIndex } from "../../core/project/bindings.ts";
import { discoverCandidates } from "../domain/discover.ts";
import type { ClassifiedCandidate } from "../domain/classify.ts";
import {
  associateCandidate,
  mutateDiscoveryState,
  readDiscoveryState,
  type DiscoveryState,
} from "../domain/discovery-state.ts";
import { runImport } from "../domain/import.ts";
import { byRecency } from "./shared.ts";
import { previewCandidateFamilies, type FamilyHint } from "../domain/family-hint.ts";
import { familyHintText } from "./family-display.ts";
import { humanImportReport } from "./import.ts";
import { renderSuspectedHits } from "./render-secret-hits.ts";
import { candidateDisplayLabel, shortSessionTime } from "./candidate-display.ts";

export const acceptCommand: CommandDefinition = {
  name: "accept",
  description:
    "explicitly associate pending Candidates with this Project and accept them into the Store",
  arguments: [
    {
      name: "[candidate-id...]",
      description: "stable Candidate IDs reported by `session candidates`",
    },
  ],
  options: [
    {
      flags: "--yes",
      description: "accept required family or tombstone confirmations without prompting",
    },
    {
      flags: "--interactive",
      description: "pick pending and flagged Candidates from an arrow-key multi-select",
    },
  ],
  async run(ctx, args, options): Promise<CommandOutcome> {
    const explicitIds = args.filter((a): a is string => a !== undefined);
    const interactive = options["interactive"] === true;
    const yes = options["yes"] === true;
    if (interactive && yes) {
      throw new GliaError(
        "USAGE",
        "--yes only applies to the explicit-id form; confirmations stay per-candidate in --interactive",
      );
    }
    if (interactive && explicitIds.length > 0) {
      throw new GliaError(
        "USAGE",
        "--interactive selects its Candidates in the picker; give candidate ids or --interactive, not both",
      );
    }
    if (!interactive && explicitIds.length === 0) {
      throw new GliaError(
        "USAGE",
        "session accept requires at least one <candidate-id>, or --interactive to pick from a list",
      );
    }
    if (interactive && (ctx.jsonMode || ctx.inputDisabled)) {
      throw new GliaError(
        "INPUT_REQUIRED",
        "--interactive needs a terminal to render its picker; list candidates and accept them by id instead",
        {
          nextSteps: [
            "glia candidates --status pending --status flagged --json",
            "glia accept <candidate-id> ...",
          ],
        },
      );
    }

    const discovery = await discoverCandidates(ctx.project, ctx.env, null);
    const state = await readDiscoveryState(ctx.project.paths.discoveryFile);
    const isFlagged = (entry: ClassifiedCandidate): boolean =>
      entry.classification.kind === "associated" &&
      state.evaluations[entry.candidate.candidateId] !== undefined;

    const skippedLines: string[] = [];
    let targets: ClassifiedCandidate[];
    if (interactive) {
      const picked = await pickInteractive(discovery.candidates, state, isFlagged);
      if (picked.outcome !== null) return picked.outcome;
      targets = picked.targets;
    } else {
      targets = resolveExplicitTargets(discovery.candidates, explicitIds);
    }

    // Family analysis must precede every acceptance decision. It captures
    // only into transient machine-local staging and never mutates the
    // Store or discovery decisions; the accepted subset adopts the
    // preview's captured bytes below instead of capturing them again.
    const preview = await previewCandidateFamilies(
      ctx.project,
      targets.map((entry) => entry.candidate),
    );
    try {
      targets = await confirmTargets(ctx, targets, state, isFlagged, preview.hints, {
        interactive,
        yes,
        skippedLines,
      });
      if (targets.length === 0) {
        if (interactive) {
          const human = [...skippedLines, "nothing accepted."].join("\n");
          return { json: { accepted: [], skipped: skippedLines }, human };
        }
        throw new GliaError("CANCELLED", "acceptance cancelled; nothing was imported");
      }

      // Pending and previously ignored Candidates gain their explicit
      // association first, so the import classifies them as associated.
      const associating = targets.filter(
        (t) => t.classification.kind === "pending" || t.classification.kind === "ignored",
      );
      if (associating.length > 0) {
        const decidedAt = new Date().toISOString();
        await mutateDiscoveryState(ctx.project, ctx.env, async (latest) => {
          const bindings = new BindingIndex(ctx.project.home);
          for (const entry of associating) {
            const openingPath = entry.candidate.openingPath;
            const mapped = openingPath === null ? null : await bindings.mapOpeningPath(openingPath);
            if (mapped !== null && mapped.projectId !== ctx.project.declaration.projectId) {
              throw new GliaError(
                "ASSOCIATION_CONFLICT",
                `candidate ${entry.candidate.candidateId} is now owned by project ${mapped.projectId}`,
                {
                  candidateId: entry.candidate.candidateId,
                  mappedProjectId: mapped.projectId,
                },
              );
            }
            associateCandidate(
              latest,
              entry.candidate.candidateId,
              ctx.project.declaration.projectId,
              decidedAt,
            );
          }
          return true;
        });
      }

      const tombstonedIds = targets
        .filter((t) => t.classification.kind === "tombstoned")
        .map((t) => t.candidate.candidateId);
      const report = await runImport(ctx.project, ctx.env, {
        harness: null,
        dryRun: false,
        onlyCandidateIds: targets.map((t) => t.candidate.candidateId),
        acceptTombstoned: tombstonedIds.length > 0,
        overrideFlagged: true,
        precaptured: preview.precaptured,
      });
      const human = [...skippedLines, humanImportReport(report)].join("\n");
      return { json: { ...report, skipped: skippedLines }, human };
    } finally {
      await preview.dispose();
    }
  },
};

/** Resolve explicit ids to Candidates and reject association conflicts.
 * Consent facts are collected and confirmed only after every target resolves. */
function resolveExplicitTargets(
  candidates: ClassifiedCandidate[],
  ids: string[],
): ClassifiedCandidate[] {
  const targets: ClassifiedCandidate[] = [];
  for (const candidateId of ids) {
    const found = candidates.find((c) => c.candidate.candidateId === candidateId);
    if (!found) {
      throw new GliaError("NOT_FOUND", `no discoverable candidate ${candidateId}`, {
        candidateId,
      });
    }
    const { classification, candidate } = found;
    if (classification.kind === "out_of_scope") {
      if (classification.mappedProjectId !== null) {
        throw new GliaError(
          "ASSOCIATION_CONFLICT",
          `candidate ${candidateId} has an opening path already mapped to project ${classification.mappedProjectId}; an opening path mapped to another Project cannot be overridden for one candidate`,
          { candidateId, mappedProjectId: classification.mappedProjectId },
        );
      }
      throw new GliaError(
        "ASSOCIATION_CONFLICT",
        `candidate ${candidateId} has a resolvable opening path (${candidate.openingPath}) outside this Project's bound roots; it is out of scope for this Project`,
        { candidateId, openingPath: candidate.openingPath },
      );
    }
    targets.push(found);
  }
  return targets;
}

/**
 * Put family, deletion, and interactive secret facts in one per-Candidate
 * consent prompt. No discovery decision or Store byte changes before this
 * function returns the confirmed subset.
 */
async function confirmTargets(
  ctx: CommandRunContext,
  targets: ClassifiedCandidate[],
  state: DiscoveryState,
  isFlagged: (entry: ClassifiedCandidate) => boolean,
  familyHints: Map<string, FamilyHint>,
  options: {
    interactive: boolean;
    yes: boolean;
    skippedLines: string[];
  },
): Promise<ClassifiedCandidate[]> {
  const confirmed: ClassifiedCandidate[] = [];
  for (const entry of targets) {
    const { candidate, classification } = entry;
    const candidateId = candidate.candidateId;
    const hint = familyHints.get(candidateId) ?? null;
    const flagged = options.interactive && isFlagged(entry);
    const tombstoned = classification.kind === "tombstoned";
    const needsConfirmation = flagged || tombstoned || hint !== null;
    if (!needsConfirmation || options.yes) {
      confirmed.push(entry);
      continue;
    }
    if (ctx.jsonMode || ctx.inputDisabled) {
      // `flagged` cannot reach here: it needs --interactive, which already
      // refuses a non-terminal. Only family and tombstone facts remain.
      const reasons = [
        hint === null ? null : familyHintText(hint),
        tombstoned
          ? `was deleted at ${classification.deletedAt} by replica ${classification.deletedBy} (epoch ${classification.epoch})`
          : null,
      ].filter((reason): reason is string => reason !== null);
      throw new GliaError(
        "INPUT_REQUIRED",
        `candidate ${candidateId} ${reasons.join(" and ")}; acceptance needs confirmation — re-run with --yes to accept`,
        {
          candidateId,
          ...(hint === null ? {} : { familyHint: hint }),
          ...(tombstoned
            ? {
                deletedAt: classification.deletedAt,
                deletedBy: classification.deletedBy,
                epoch: classification.epoch,
              }
            : {}),
          nextSteps: [`glia accept ${candidateId} --yes`],
        },
      );
    }

    const sections: string[] = [];
    if (hint !== null) {
      sections.push(
        `${candidateDisplayLabel(candidate)} (${candidateId}) ${familyHintText(hint)}.`,
      );
    }
    if (tombstoned) {
      sections.push(
        `This Source Identity was deleted at ${classification.deletedAt} by replica ${classification.deletedBy} (epoch ${classification.epoch}).\n` +
          "Re-admitting it as a fresh Session sessions the override in the Session's metadata.",
      );
    }
    if (flagged) {
      const evaluation = state.evaluations[candidateId]!;
      const hits = renderSuspectedHits(evaluation.hits, evaluation.unscanned).join("\n");
      sections.push(
        `${candidateDisplayLabel(candidate)} (${candidateId}) is flagged:\n${hits}\n` +
          "Accepting sessions the override in the Session's metadata.",
      );
    }
    const proceeding = await confirmProceed(`${sections.join("\n\n")}\n\nAccept this Candidate?`);
    if (proceeding) {
      confirmed.push(entry);
    } else {
      const kind = tombstoned ? "tombstoned" : flagged ? "flagged" : "fork-family";
      options.skippedLines.push(`skipped ${kind} ${candidateId} (declined)`);
    }
  }
  return confirmed;
}

/** Run the arrow-key multi-select over pending and flagged Candidates.
 * Returns either the chosen Candidates or a terminal outcome (empty list). */
async function pickInteractive(
  candidates: ClassifiedCandidate[],
  state: DiscoveryState,
  isFlagged: (entry: ClassifiedCandidate) => boolean,
): Promise<{ targets: ClassifiedCandidate[]; outcome: CommandOutcome | null }> {
  const eligible = candidates
    .filter((entry) => entry.classification.kind === "pending" || isFlagged(entry))
    .sort(byRecency);
  if (eligible.length === 0) {
    const counts = { pending: 0, flagged: 0 };
    for (const entry of candidates) {
      if (entry.classification.kind === "pending") counts.pending += 1;
      if (isFlagged(entry)) counts.flagged += 1;
    }
    const human = `nothing to accept: ${counts.pending} pending, ${counts.flagged} flagged.`;
    return { targets: [], outcome: { json: { accepted: [], counts }, human } };
  }

  const items: PickerItem[] = eligible.map((entry) => {
    const flagged = isFlagged(entry);
    const evaluation = state.evaluations[entry.candidate.candidateId];
    const hitCount = evaluation ? evaluation.hits.length : 0;
    return {
      value: entry.candidate.candidateId,
      name:
        `${shortSessionTime(entry.candidate.sessionTime)}  ` +
        `${flagged ? "⚠ " : ""}${candidateDisplayLabel(entry.candidate)}`,
      description: flagged
        ? `flagged: ${hitCount} suspected secret(s) — accepting sessions the override · ` +
          `${entry.candidate.identity.harnessId} ${entry.candidate.identity.sourceSessionId}`
        : `${entry.candidate.identity.harnessId} ${entry.candidate.identity.sourceSessionId}`,
      group: "",
    };
  });
  const chosen = await pickGrouped(items, "Select Sessions to accept into the Store", {
    preserveOrder: true,
    nouns: { plural: "Sessions", singular: "Session", rootGroup: "the list" },
  });
  if (chosen === null) {
    throw new GliaError("CANCELLED", "acceptance cancelled; nothing imported");
  }
  const byId = new Map(eligible.map((entry) => [entry.candidate.candidateId, entry]));
  return {
    targets: chosen
      .map((id) => byId.get(id))
      .filter((entry): entry is ClassifiedCandidate => entry !== undefined),
    outcome: null,
  };
}
