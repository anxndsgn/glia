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
