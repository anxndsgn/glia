import { GliaError } from "../../core/output/errors.ts";
import type { CommandOutcome } from "../../core/output/result.ts";
import {
  projectIsEnrolled,
  type CommandRunContext,
  type LoadedProject,
} from "../../core/session-module.ts";
import {
  advisoriesForDiscovery,
  renderDiscoveryAdvisories,
  type SessionAdvisory,
} from "../domain/advisories.ts";
import { asObject as asObjectOrNull } from "../adapters/jsonl.ts";
import { discoverCandidates } from "../domain/discover.ts";

function asObject(value: unknown): Record<string, unknown> {
  return asObjectOrNull(value) ?? { value };
}

export function notEnrolledError(project: LoadedProject): GliaError {
  return new GliaError("NOT_ENROLLED", `repository ${project.worktree} is not enrolled with Glia`, {
    worktree: project.worktree,
    nextSteps: ["glia import"],
  });
}

/** Adds the public enrollment contract and suppresses the synthesized identity. */
export async function decorateEnrollmentOutcome(
  ctx: CommandRunContext,
  outcome: CommandOutcome,
): Promise<CommandOutcome> {
  const enrolled = projectIsEnrolled(ctx.project);
  const json = asObject(outcome.json);
  if (enrolled) {
    return {
      json: { ...json, enrolled: true, projectId: ctx.project.declaration.projectId },
      human: outcome.human,
    };
  }

  const discovery = await discoverCandidates(ctx.project, ctx.env, null);
  const discoveredAdvisories = await advisoriesForDiscovery(ctx.project, discovery);
  const importable = discoveredAdvisories.find((entry) => entry.kind === "importable");
  const notEnrolled: SessionAdvisory = {
    kind: "not_enrolled",
    count: importable?.count ?? 0,
  };
  const existing = Array.isArray(json["advisories"])
    ? (json["advisories"] as SessionAdvisory[])
    : [];
  const advisories = [
    ...existing.filter((entry) => entry.kind !== "importable" && entry.kind !== "not_enrolled"),
    notEnrolled,
  ];
  const statement =
    `This repository is not enrolled with Glia; run \`glia import\` to enroll it. ` +
    `${notEnrolled.count} Session Candidate(s) would be captured.`;
  const importableLines = new Set(
    importable === undefined ? [] : renderDiscoveryAdvisories([importable]),
  );
  const human = outcome.human
    .split("\n")
    .filter((line) => !importableLines.has(line))
    .join("\n");
  return {
    json: { ...json, enrolled: false, projectId: null, advisories },
    human: human.length === 0 ? statement : `${human}\n${statement}`,
  };
}
