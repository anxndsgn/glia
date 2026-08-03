/**
 * Where the bundled skill installs: a scope × harness matrix. Scope picks
 * the base directory (the user's home or the current worktree root), the
 * harness picks the skills directory convention beneath it (`.claude/skills`
 * for Claude Code, `.agents/skills` for the Agent Skills standard). A
 * partially flagged matrix completes to defaults — scope to global, harness
 * to both — so `--claude` alone means `~/.claude/skills`.
 */

import { join } from "node:path";

export type SkillScope = "global" | "project";
export type SkillHarness = "claude" | "agents";

export const ALL_SCOPES: readonly SkillScope[] = ["global", "project"];
export const ALL_HARNESSES: readonly SkillHarness[] = ["claude", "agents"];

export interface MatrixFlags {
  readonly global: boolean;
  readonly project: boolean;
  readonly claude: boolean;
  readonly agents: boolean;
}

export interface SkillDestination {
  /** null for a custom `--target` directory. */
  readonly scope: SkillScope | null;
  readonly harness: SkillHarness | null;
  /** The skills directory that holds the skill folder, e.g. `~/.claude/skills`. */
  readonly skillsDir: string;
}

export function anyMatrixFlag(flags: MatrixFlags): boolean {
  return flags.global || flags.project || flags.claude || flags.agents;
}

export function scopesFrom(flags: MatrixFlags): SkillScope[] {
  const scopes: SkillScope[] = [];
  if (flags.global) scopes.push("global");
  if (flags.project) scopes.push("project");
  return scopes.length > 0 ? scopes : ["global"];
}

export function harnessesFrom(flags: MatrixFlags): SkillHarness[] {
  const harnesses: SkillHarness[] = [];
  if (flags.claude) harnesses.push("claude");
  if (flags.agents) harnesses.push("agents");
  return harnesses.length > 0 ? harnesses : [...ALL_HARNESSES];
}

export function skillsDirFor(
  scope: SkillScope,
  harness: SkillHarness,
  homeDir: string,
  worktree: string | null,
): string {
  const base = scope === "global" ? homeDir : worktree;
  if (base === null) throw new Error("project scope requires a worktree root");
  return join(base, harness === "claude" ? ".claude" : ".agents", "skills");
}

/** The cross product; project-scope rows are skipped when no worktree is
 * known — the caller decides whether that absence is an error. */
export function matrixDestinations(
  scopes: readonly SkillScope[],
  harnesses: readonly SkillHarness[],
  homeDir: string,
  worktree: string | null,
): SkillDestination[] {
  const destinations: SkillDestination[] = [];
  for (const scope of scopes) {
    if (scope === "project" && worktree === null) continue;
    for (const harness of harnesses) {
      destinations.push({
        scope,
        harness,
        skillsDir: skillsDirFor(scope, harness, homeDir, worktree),
      });
    }
  }
  return destinations;
}

export function dedupeDestinations(destinations: readonly SkillDestination[]): SkillDestination[] {
  const seen = new Set<string>();
  const unique: SkillDestination[] = [];
  for (const destination of destinations) {
    if (seen.has(destination.skillsDir)) continue;
    seen.add(destination.skillsDir);
    unique.push(destination);
  }
  return unique;
}
