import { PROJECTION_DEFERRED_NOTE } from "../../core/session-module.ts";
import type { CommandDefinition, CommandRunContext } from "../../core/session-module.ts";
import type { CommandOutcome } from "../../core/output/result.ts";
import { GliaError } from "../../core/output/errors.ts";
import { confirmProceed } from "../../core/output/confirm.ts";
import { withProgress } from "../../core/output/progress.ts";
import { isHarnessId, type HarnessId } from "../../core/harnesses/ids.ts";
import { previewEnrollment, runImport, type ImportReport } from "../domain/import.ts";
import { discoverCandidates } from "../domain/discover.ts";
import {
  associateCandidate,
  ignoreCandidate,
  mutateDiscoveryState,
} from "../domain/discovery-state.ts";
import { previewCandidateFamilies, type FamilyHint } from "../domain/family-hint.ts";
import { familyHintText } from "./family-display.ts";
import type { SecretHit, UnscannedFile } from "../domain/secret-detection.ts";
import { renderSuspectedHits } from "./render-secret-hits.ts";
import { ageDays } from "../domain/advisories.ts";
import { HARNESS_IDS } from "../../core/harnesses/ids.ts";
import { managedHookInstalled } from "../../core/hooks/config.ts";

export function parseHarnessOption(value: unknown): HarnessId | null {
  if (value === undefined) return null;
  const harness = String(value);
  if (!isHarnessId(harness)) {
    throw new GliaError("USAGE", `unknown harness ${harness}; supported: codex, claude-code`);
  }
  return harness;
}

export async function confirmFirstImport(
  ctx: CommandRunContext,
  options: Record<string, unknown>,
  confirm: (message: string) => Promise<boolean> = confirmProceed,
): Promise<void> {
  const harness = parseHarnessOption(options["harness"]);
  const preview = await previewEnrollment(ctx.project, ctx.env, harness);
  const hooksInstalled = (
    await Promise.all(HARNESS_IDS.map((id) => managedHookInstalled(id, ctx.env).catch(() => false)))
  ).some(Boolean);
  const lines = [
    `Enroll repository ${ctx.project.worktree} with Glia?`,
    "",
    `  Store: create a Git-backed Store under ${ctx.project.home}/projects`,
    `  Sessions: import ${preview.wouldImport} Session(s) now from ${preview.discovered} discovered Candidate(s)`,
    `  Secret review: withhold ${preview.withheld} Candidate(s) pending explicit acceptance`,
  ];
  if (preview.pending > 0) {
    lines.push(`  Association: ${preview.pending} Candidate(s) need a Project decision first`);
  }
  if (hooksInstalled) {
    lines.push("  SessionEnd: capture future Sessions automatically for this repository");
  }
  if (preview.sourceErrors.length > 0) {
    lines.push(
      `  Source errors: ${preview.sourceErrors.length} Candidate(s) could not be previewed`,
    );
  }
  lines.push("", "Continue?");
  if (!(await confirm(lines.join("\n")))) {
    throw new GliaError("CANCELLED", "import cancelled; the repository remains unenrolled", {
      nextSteps: ["glia import"],
    });
  }
}

export const importCommand: CommandDefinition = {
  name: "import",
  projectAccess: (options) => (options["dryRun"] === true ? "read" : "write"),
  unenrolledRead: "empty",
  description:
    "discover Sessions, accept associated Candidates into the Store, and refresh the projection; " +
    "on a terminal, pending and flagged Candidates are resolved with prompts (skip with --no-input)",
  options: [
    {
      flags: "--hook",
      description: "run the silent SessionEnd automation path (installed by glia setup)",
    },
    { flags: "--harness <id>", description: "only inspect one harness (codex or claude-code)" },
    {
      flags: "--dry-run",
      description: "classify and report without capturing or writing anything",
    },
  ],
  async run(ctx, _args, options): Promise<CommandOutcome> {
    const hook = options["hook"] === true;
    if (hook && ctx.jsonMode) {
      throw new GliaError("USAGE", "--hook cannot be combined with --json");
    }
    if (hook && (options["harness"] !== undefined || options["dryRun"] === true)) {
      throw new GliaError("USAGE", "--hook cannot be combined with --harness or --dry-run");
    }
    const harness = parseHarnessOption(options["harness"]);
    const dryRun = options["dryRun"] === true;
    // Interactive resolution follows the terminal: --json, --no-input, and
    // piped stdio all disable it, so scripted imports never block on a prompt.
    const interactive = !hook && !ctx.inputDisabled && !dryRun;
    // Discovery walks every harness history and capture reads whole
    // bundles: on a large history this is seconds of silence otherwise.
    const importWork = () =>
      runImport(ctx.project, ctx.env, {
        harness,
        dryRun,
        onlyCandidateIds: null,
      });
    const report = hook
      ? await importWork()
      : await withProgress(
          ctx,
          dryRun ? "Discovering Sessions" : "Importing Sessions",
          (r) =>
            r.dryRun
              ? `Discovered ${r.wouldAccept.length} candidate(s) to accept`
              : `Accepted ${r.accepted.length} revision(s)`,
          importWork,
        );
    // Pending resolution runs first: a Candidate associated here is
    // re-imported with the secret gate intact, so its flagged bytes join
    // the flagged prompt below instead of being accepted silently.
    if (interactive && report.pending.length > 0) {
      await resolvePendingInteractively(ctx, harness, report);
    }
    if (interactive && report.flagged.length > 0) {
      await resolveFlaggedInteractively(ctx, report);
    }
    return { json: report, human: hook ? "" : humanImportReport(report) };
  },
};

/**
 * Folds a follow-up accept run into the main report. Counts the main run
 * already reported (pending, ignored, out of scope) are not re-added; the
 * callers instead prune the entries the follow-up resolved.
 */
function mergeFollowUpReport(report: ImportReport, second: ImportReport): void {
  report.accepted.push(...second.accepted);
  report.flagged.push(...second.flagged);
  report.conflicted.push(...second.conflicted);
  report.sourceErrors.push(...second.sourceErrors);
  report.unchanged += second.unchanged;
  if (second.storeCommit !== null) report.storeCommit = second.storeCommit;
  if (second.accepted.length > 0) report.projectionFresh = second.projectionFresh;
  if (report.recoveryCommit === null) report.recoveryCommit = second.recoveryCommit;
}

/**
 * Presents each flagged Candidate with its suspected-secret hits and asks
 * accept, skip, or ignore. Accepting re-runs the accept path, which sessions
 * the override in the Session's objective metadata.
 */
async function resolveFlaggedInteractively(
  ctx: CommandRunContext,
  report: ImportReport,
): Promise<void> {
  const { select, isCancel } = await import("@clack/prompts");
  const acceptIds: string[] = [];
  const ignoreIds: string[] = [];
  const resolvedIds = new Set<string>();
  for (const flagged of report.flagged) {
    const candidateId = String(flagged["candidateId"]);
    const hitLines = renderSuspectedHits(
      (flagged["suspectedSecrets"] ?? []) as SecretHit[],
      (flagged["unscanned"] ?? []) as UnscannedFile[],
    );
    // The Fork Family note renders before the decision prompt; it stays
    // advisory — accepting, skipping, or later deleting a twin is the
    // user's call.
    const familyHint = flagged["familyHint"] as FamilyHint | null;
    const familyNote =
      familyHint !== null && familyHint !== undefined ? `${familyHintText(familyHint)}\n` : "";
    const choice = await select({
      message:
        `${familyNote}Candidate ${candidateId} (${flagged["harnessId"]} ${flagged["sourceSessionId"]}) has suspected secrets:\n` +
        hitLines.map((line) => `  ${line}`).join("\n") +
        "\nAccept anyway?",
      options: [
        { value: "accept", label: "Accept anyway (sessions the override)" },
        { value: "skip", label: "Decide later (keep flagged)" },
        { value: "ignore", label: "Ignore on this machine" },
      ],
    });
    if (isCancel(choice)) throw new GliaError("CANCELLED", "import cancelled");
    if (choice === "accept") {
      acceptIds.push(candidateId);
      resolvedIds.add(candidateId);
    } else if (choice === "ignore") {
      ignoreIds.push(candidateId);
      resolvedIds.add(candidateId);
    }
  }
  if (ignoreIds.length > 0) {
    await mutateDiscoveryState(ctx.project, ctx.env, (state) => {
      for (const candidateId of ignoreIds) ignoreCandidate(state, candidateId);
      return true;
    });
  }
  if (acceptIds.length > 0) {
    const second = await withProgress(
      ctx,
      `Accepting ${acceptIds.length} withheld candidate(s)`,
      (r) => `Accepted ${r.accepted.length} revision(s)`,
      () =>
        runImport(ctx.project, ctx.env, {
          harness: null,
          dryRun: false,
          onlyCandidateIds: acceptIds,
          overrideFlagged: true,
        }),
    );
    mergeFollowUpReport(report, second);
  }
  report.flagged = report.flagged.filter((f) => !resolvedIds.has(String(f["candidateId"])));
}

/**
 * Presents each pending Candidate and asks associate, skip, or ignore.
 * Newly associated Candidates are accepted by a follow-up run that keeps
 * the secret-detection gate: their flagged bytes join `report.flagged`
 * for the flagged prompt instead of being accepted silently.
 */
async function resolvePendingInteractively(
  ctx: CommandRunContext,
  harness: HarnessId | null,
  report: ImportReport,
): Promise<void> {
  const { select, isCancel } = await import("@clack/prompts");
  // The main run's report carries only serializable summaries, so this
  // pass re-discovers to get the full Candidates the family-hint preview
  // captures from; it runs only when pending Candidates exist.
  const discovery = await discoverCandidates(ctx.project, ctx.env, harness);
  const pending = discovery.candidates.filter((c) => c.classification.kind === "pending");
  if (pending.length === 0) return;
  const preview = await previewCandidateFamilies(
    ctx.project,
    pending.map((entry) => entry.candidate),
  );
  try {
    const associateIds: string[] = [];
    const ignoreIds: string[] = [];
    const resolvedIds = new Set<string>();
    for (const { candidate } of pending) {
      const hint = preview.hints.get(candidate.candidateId);
      const familyNote = hint === undefined ? "" : `${familyHintText(hint)}\n`;
      const choice = await select({
        message:
          `${familyNote}Session ${candidate.identity.sourceSessionId} (${candidate.identity.harnessId}) has no resolvable opening path. ` +
          "Associate it with this project?",
        options: [
          { value: "associate", label: "Associate with this project" },
          { value: "skip", label: "Decide later (keep pending)" },
          { value: "ignore", label: "Ignore on this machine" },
        ],
      });
      if (isCancel(choice)) throw new GliaError("CANCELLED", "import cancelled");
      if (choice === "associate") {
        associateIds.push(candidate.candidateId);
        resolvedIds.add(candidate.candidateId);
      } else if (choice === "ignore") {
        ignoreIds.push(candidate.candidateId);
        resolvedIds.add(candidate.candidateId);
      }
    }
    if (associateIds.length > 0 || ignoreIds.length > 0) {
      const decidedAt = new Date().toISOString();
      await mutateDiscoveryState(ctx.project, ctx.env, (state) => {
        for (const candidateId of associateIds) {
          associateCandidate(state, candidateId, ctx.project.declaration.projectId, decidedAt);
        }
        for (const candidateId of ignoreIds) ignoreCandidate(state, candidateId);
        return true;
      });
    }
    if (associateIds.length > 0) {
      const second = await withProgress(
        ctx,
        `Accepting ${associateIds.length} associated candidate(s)`,
        (r) => `Accepted ${r.accepted.length} revision(s)`,
        () =>
          runImport(ctx.project, ctx.env, {
            harness: null,
            dryRun: false,
            onlyCandidateIds: associateIds,
            precaptured: preview.precaptured,
          }),
      );
      mergeFollowUpReport(report, second);
    }
    report.pending = report.pending.filter((p) => !resolvedIds.has(String(p["candidateId"])));
  } finally {
    await preview.dispose();
  }
}

export function humanImportReport(report: ImportReport): string {
  const lines: string[] = [];
  if (report.dryRun) {
    lines.push(
      `Dry run: ${report.wouldAccept.length} candidate(s) would be accepted, ` +
        `${report.unchanged} unchanged, ${report.outOfScope} out of scope, ` +
        `${report.pending.length} pending, ${report.ignored} ignored.`,
    );
    if (report.secretDetection.enabled) {
      lines.push("Secret detection not evaluated: a dry run captures no bundle bytes.");
    }
  } else {
    lines.push(
      `Accepted ${report.accepted.length} revision(s); ${report.unchanged} unchanged, ` +
        `${report.outOfScope} out of scope, ${report.pending.length} pending, ${report.ignored} ignored.`,
    );
    if (report.accepted.length > 0 && report.storeCommit) {
      lines.push(`Store commit ${report.storeCommit.slice(0, 12)}.`);
      if (!report.projectionFresh) lines.push(PROJECTION_DEFERRED_NOTE);
    }
  }
  if (report.flagged.length > 0) {
    const oldest = report.flagged
      .map((flagged) => String(flagged["firstFlaggedAt"] ?? ""))
      .filter(Boolean)
      .sort()[0];
    const days = oldest === undefined ? 0 : ageDays(oldest);
    const age = days === 0 ? "less than a day" : `${days} day(s)`;
    lines.push(
      `Withheld ${report.flagged.length} candidate(s) with suspected secrets; oldest withheld for ${age}.` +
        (days >= 14 ? " Harness retention may delete the source." : ""),
    );
    for (const flagged of report.flagged) {
      lines.push(
        `  ${flagged["candidateId"]} (${flagged["harnessId"]} ${flagged["sourceSessionId"]}):`,
      );
      const hits = (flagged["suspectedSecrets"] ?? []) as SecretHit[];
      const unscanned = (flagged["unscanned"] ?? []) as UnscannedFile[];
      for (const line of renderSuspectedHits(hits, unscanned)) lines.push(`    ${line}`);
    }
    const target =
      report.flagged.length === 1 ? String(report.flagged[0]!["candidateId"]) : "<candidate-id>";
    lines.push(
      `Accept a withheld candidate explicitly with \`glia accept ${target}\`; the override is persisted.`,
    );
  }
  for (const accepted of report.accepted) {
    if (accepted.flaggedRules.length > 0) {
      lines.push(
        `Accepted ${accepted.sessionId} despite suspected secrets ` +
          `(${accepted.flaggedRules.join(", ")}); the override is persisted in its metadata.`,
      );
    }
    // Per-Session Fork Family note: most of a fork twin's events already
    // live in the Store, stated where the acceptance is reported.
    if (accepted.familyHint !== null) {
      lines.push(`${accepted.sessionId} ${familyHintText(accepted.familyHint)}`);
    }
  }
  if (report.recoveryCommit) {
    lines.push(
      `Recovered uncommitted Store residue from an interrupted operation in commit ${report.recoveryCommit.slice(0, 12)}.`,
    );
  }
  if (report.conflicted.length > 0) {
    lines.push(
      `Skipped ${report.conflicted.length} candidate(s) whose Session is frozen in a Session Conflict; ` +
        `resolve with \`glia resolve\`, then re-run the import to accept the newest bytes.`,
    );
  }
  if (report.tombstoned.length > 0) {
    lines.push(
      `Skipped ${report.tombstoned.length} tombstoned candidate(s): a deleted Source Identity is ` +
        `never accepted automatically again; re-admit explicitly with \`glia accept <id>\`.`,
    );
  }
  if (report.pending.length > 0) {
    lines.push(`Run \`glia candidates\` to inspect pending candidates, then \`glia accept <id>\`.`);
  }
  if (report.prunedWithheld.length > 0) {
    lines.push(
      `Recorded ${report.prunedWithheld.length} withheld candidate(s) whose Harness source disappeared.`,
    );
    for (const loss of report.prunedWithheld) {
      lines.push(
        `warning: withheld candidate ${loss.candidateId} source was no longer discoverable.`,
      );
    }
  }
  for (const failure of report.adapterFailures) {
    lines.push(`warning: ${failure.harnessId} discovery failed: ${failure.message}`);
  }
  for (const err of report.sourceErrors) {
    lines.push(`warning: candidate ${err.candidateId}: ${err.message}`);
  }
  return lines.join("\n");
}
