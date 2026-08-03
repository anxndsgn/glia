/**
 * The bundled agent skill: one SKILL.md teaching coding agents how to use
 * glia. The markdown is the single source of truth, embedded at compile
 * time; the version placeholder is filled at install time so an upgraded
 * CLI re-installs as a visible content change rather than a silent one.
 */

import template from "../../../assets/SKILL.md" with { type: "text" };

export const SKILL_NAME = "glia";

const VERSION_PLACEHOLDER = "__GLIA_VERSION__";

export function renderSkillContent(version: string): string {
  return template.replace(VERSION_PLACEHOLDER, version);
}

/** Whether a SKILL.md was written by glia — the frontmatter version marker
 * is the ownership signal. A hand-written skill that happens to be named
 * `glia` lacks it, and removal must leave such a directory alone. */
export function isManagedSkillContent(content: string): boolean {
  return /(^|\n)\s*glia_version:/.test(content);
}
