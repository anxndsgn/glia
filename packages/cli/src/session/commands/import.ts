import { autoSaveEnabled, setAutoSave } from "../../core/project/auto-save.ts";
import { runHookInstall } from "../../core/commands/hook.ts";
import { currentSelfCommand, hookExecutablePath } from "./hook-import.ts";
import { PROJECTION_DEFERRED_NOTE } from "../../core/session-module.ts";
import type { CommandDefinition, CommandRunContext } from "../../core/session-module.ts";
import type { CommandOutcome } from "../../core/output/result.ts";
import { GliaError } from "../../core/output/errors.ts";
import { confirmProceed } from "../../core/output/confirm.ts";
import { withProgress } from "../../core/output/progress.ts";
import { isHarnessId, type HarnessId } from "../../core/harnesses/ids.ts";
import { previewEnrollment, runImport, type ImportReport } from "../domain/import.ts";
import { ignoreCandidate, mutateDiscoveryState } from "../domain/discovery-state.ts";
import type { FamilyHint } from "../domain/family-hint.ts";
import { familyHintText } from "./family-display.ts";
import type { SecretHit, UnscannedFile } from "../domain/secret-detection.ts";
import { renderSuspectedHits } from "./render-secret-hits.ts";
import { ageDays } from "../domain/advisories.ts";

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
  const lines = [
    `Enroll repository ${ctx.project.worktree} with Glia?`,
    "",
    `  Store: create a Git-backed Store under ${ctx.project.home}/projects`,
    `  Sessions: import ${preview.wouldImport} Session(s) now from ${preview.discovered} discovered Candidate(s)`,
    `  Secret review: withhold ${preview.withheld} Candidate(s) pending explicit acceptance`,
  ];
  if (preview.pending > 0) {
    lines.push(
      `  Unassociated: skip ${preview.pending} Candidate(s) whose Project could not be determined`,
    );
  }
  if (options["autoSave"] === "on") {
    lines.push("  SessionEnd: capture future Sessions automatically for this repository");
  }
  if (preview.sourceErrors.length > 0) {
    lines.push(
      `  Source errors: ${preview.sourceErrors.length} Candidate(s) could not be previewed`,
    );
  }
  if (preview.adapterFailures.length > 0) {
    lines.push(
      `  Harness discovery failures: ${preview.adapterFailures.length} Harness(es) were not fully inspected`,
      ...preview.adapterFailures.map((failure) => `    ${failure.harnessId}: ${failure.message}`),
    );
  }
  lines.push("", "Continue?");
  if (!(await confirm(lines.join("\n")))) {
    throw new GliaError("CANCELLED", "import cancelled; the repository remains unenrolled", {}, [
      "glia import",
    ]);
  }
}

export const importCommand: CommandDefinition = {
  name: "import",
  projectAccess: (options) =>
    options["dryRun"] === true || options["autoSave"] === "off" ? "read" : "write",
  unenrolledRead: "empty",
  description:
    "discover Sessions, accept associated Candidates into the Store, and refresh the projection; " +
    "leave unassociated Candidates pending; on a terminal, review flagged Candidates (skip with --no-input)",
  options: [
    {
      flags: "--auto-save <mode>",
      description:
        "on: import now and enable future automatic saving; off: disable automatic saving without importing",
    },
    {
      flags: "--hook",
      description: "run the silent SessionEnd automation path (installed by --auto-save on)",
    },
    { flags: "--harness <id>", description: "only inspect one harness (codex or claude-code)" },
    {
      flags: "--dry-run",
      description: "classify and report without capturing or writing anything",
    },
  ],
  async run(ctx, _args, options): Promise<CommandOutcome> {
    // `import --hook` never reaches this run: the CLI dispatcher intercepts
    // the flag and routes through the machine-local hook invocation instead.
    const harness = parseHarnessOption(options["harness"]);
    const dryRun = options["dryRun"] === true;
    const autoSave = options["autoSave"];
    if (autoSave !== undefined && autoSave !== "on" && autoSave !== "off") {
      throw new GliaError("USAGE", "--auto-save must be on or off");
    }
    if (autoSave !== undefined && (dryRun || harness !== null)) {
      throw new GliaError(
        "USAGE",
        "--auto-save applies to the whole Project and cannot combine with --dry-run or --harness",
      );
    }
    if (autoSave === "off") {
      if (ctx.project.enrollment.kind === "enrolled") await setAutoSave(ctx.project, false);
      return {
        json: { autoSave: false },
        human:
          "Automatic saving disabled for this Project on this machine. Saved Sessions are retained.",
      };
    }
    // Interactive resolution follows the terminal: --json, --no-input, and
    // piped stdio all disable it, so scripted imports never block on a prompt.
    const interactive = !ctx.inputDisabled && !dryRun;
    // Discovery walks every harness history and capture reads whole
    // bundles: on a large history this is seconds of silence otherwise.
    const report = await withProgress(
      ctx,
      dryRun ? "Discovering Sessions" : "Importing Sessions",
      (r) =>
        r.dryRun
          ? `Discovered ${r.wouldAccept.length} candidate(s) to accept`
          : `Accepted ${r.accepted.length} revision(s)`,
      () => runImport(ctx.project, ctx.env, { harness, dryRun, onlyCandidateIds: null }),
    );
    if (interactive && report.flagged.length > 0) {
      await resolveFlaggedInteractively(ctx, report);
    }
    let automationNote = "";
    let hooks: CommandOutcome | null = null;
    if (autoSave === "on") {
      hooks = await runHookInstall({
        env: ctx.env,
        executablePath: hookExecutablePath(),
        selfCommand: currentSelfCommand(),
      });
      await setAutoSave(ctx.project, true);
      automationNote = `\n${hooks.human}\nAutomatic saving enabled for this Project on this machine. Approve the SessionEnd hook in each Harness when prompted.`;
    }
    const savingEnabled = await autoSaveEnabled(ctx.project);
    if (!dryRun && !savingEnabled) {
      automationNote =
        "\nTo automatically save future Sessions for this Project on this machine, run `glia import --auto-save on`.";
    }
    return {
      json: {
        ...report,
        autoSave: savingEnabled,
        ...(hooks === null ? {} : { hooks: hooks.json }),
      },
      human: humanImportReport(report) + automationNote,
    };
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
 * accept, skip, or ignore. Accepting re-runs the accept path, which records
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
        { value: "accept", label: "Accept anyway (records the override)" },
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
    lines.push(
      `${report.dryRun ? "Would skip" : "Skipped"} ${report.pending.length} Session(s) whose Project could not be determined; kept pending.`,
      "Review them later with `glia candidates --status pending`, then `glia accept <id>` or `glia accept --interactive`.",
    );
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
