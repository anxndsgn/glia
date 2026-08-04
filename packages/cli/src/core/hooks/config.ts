import { lstat, readFile } from "node:fs/promises";
import { basename, isAbsolute, join, normalize, sep } from "node:path";
import type { HarnessId } from "../harnesses/ids.ts";
import { harnessHome } from "../harnesses/home.ts";
import { GliaError } from "../output/errors.ts";
import { writeFileAtomic } from "../state/atomic-file.ts";
import {
  arrayElements,
  insertArrayElement,
  insertObjectProperty,
  objectProperties,
  removeArrayElements,
  replaceValue,
  rootRange,
  type ValueRange,
} from "./json-edit.ts";

export type HookInstallStatus = "created" | "updated" | "up_to_date" | "unmanaged";
export type HookRemoveStatus = "removed" | "removed_with_unmanaged" | "not_installed" | "unmanaged";

export interface HookResult {
  harnessId: HarnessId;
  path: string;
  status: HookInstallStatus | HookRemoveStatus;
}

export function hookConfigPath(
  harnessId: HarnessId,
  env: Record<string, string | undefined>,
): string {
  const home = harnessHome(harnessId, env);
  return join(home, harnessId === "claude-code" ? "settings.json" : "hooks.json");
}

export function quoteHookExecutable(path: string): string {
  return `'${path.replaceAll("'", `'"'"'`)}'`;
}

export function hookCommand(commandPrefix: string | readonly string[]): string {
  const prefix = typeof commandPrefix === "string" ? [commandPrefix] : commandPrefix;
  return `${prefix.map(quoteHookExecutable).join(" ")} import --hook`;
}

function quotedAbsolutePaths(encoded: string): string[] | null {
  const tokens = encoded.match(/'(?:[^']|'"'"')*'/g);
  if (tokens === null || tokens.join(" ") !== encoded) return null;
  const paths = tokens.map((token) => token.slice(1, -1).replaceAll(`'"'"'`, "'"));
  return paths.length > 0 && paths.every(isAbsolute) ? paths : null;
}

function isGliaCommandPrefix(paths: readonly string[]): boolean {
  if (paths.length === 1) {
    const executable = basename(paths[0]!);
    return executable === "glia" || executable === "glia.exe";
  }
  if (paths.length !== 2) return false;
  const runtime = basename(paths[0]!);
  if (runtime !== "bun" && !runtime.startsWith("bun-")) return false;
  const script = normalize(paths[1]!);
  return ["cli.ts", "cli.js"].some((name) =>
    script.endsWith(`${sep}${join("packages", "cli", "src", name)}`),
  );
}

function commandExecutables(command: string): string[] | null {
  if (!command.endsWith(" import --hook")) return null;
  return quotedAbsolutePaths(command.slice(0, -" import --hook".length));
}

function isPotentialEditedGliaCommand(command: string): boolean {
  const invocation = /(?:^|\s)import\s+--hook(?:\s|$)/.exec(command);
  if (invocation === null) return false;
  const prefix = command.slice(0, invocation.index).trimEnd();
  const paths = quotedAbsolutePaths(prefix);
  return paths !== null && isGliaCommandPrefix(paths);
}

function hookGroup(commandPrefix: string | readonly string[]): object {
  return {
    hooks: [{ type: "command", command: hookCommand(commandPrefix), timeout: 1 }],
  };
}

function object(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** Exact installed shape, except that the absolute binary path may differ. */
export function isManagedHookGroup(value: unknown): boolean {
  const group = object(value);
  if (group === null || Object.keys(group).length !== 1 || !Array.isArray(group["hooks"])) {
    return false;
  }
  const hooks = group["hooks"];
  if (hooks.length !== 1) return false;
  const handler = object(hooks[0]);
  if (handler === null) return false;
  if (Object.keys(handler).sort().join(",") !== "command,timeout,type") return false;
  const command = handler["command"];
  if (handler["type"] !== "command" || handler["timeout"] !== 1 || typeof command !== "string") {
    return false;
  }
  const paths = commandExecutables(command);
  return paths !== null && isGliaCommandPrefix(paths);
}

function isPotentialEditedGliaGroup(value: unknown): boolean {
  const group = object(value);
  const hooks = group?.["hooks"];
  if (!Array.isArray(hooks)) return false;
  return hooks.some((entry) => {
    const command = object(entry)?.["command"];
    return typeof command === "string" && isPotentialEditedGliaCommand(command);
  });
}

interface LocatedConfig {
  root: ValueRange;
  hooks: ValueRange | null;
  sessionEnd: ValueRange | null;
  sessionEntries: unknown[];
}

function locate(text: string): LocatedConfig {
  const parsed = JSON.parse(text) as unknown;
  const rootObject = object(parsed);
  if (rootObject === null)
    throw new GliaError("INVALID_SOURCE", "hook config root must be an object");
  const root = rootRange(text);
  const hooksProperty = objectProperties(text, root).find((property) => property.name === "hooks");
  if (hooksProperty === undefined) {
    return { root, hooks: null, sessionEnd: null, sessionEntries: [] };
  }
  if (object(rootObject["hooks"]) === null) {
    throw new GliaError("INVALID_SOURCE", "hook config 'hooks' field must be an object");
  }
  const hooks = { start: hooksProperty.start, end: hooksProperty.end };
  const sessionProperty = objectProperties(text, hooks).find(
    (property) => property.name === "SessionEnd",
  );
  if (sessionProperty === undefined) {
    return { root, hooks, sessionEnd: null, sessionEntries: [] };
  }
  const entries = (rootObject["hooks"] as Record<string, unknown>)["SessionEnd"];
  if (!Array.isArray(entries)) {
    throw new GliaError("INVALID_SOURCE", "hook config 'SessionEnd' field must be an array");
  }
  return {
    root,
    hooks,
    sessionEnd: { start: sessionProperty.start, end: sessionProperty.end },
    sessionEntries: entries,
  };
}

async function readConfig(path: string): Promise<string | null> {
  try {
    if ((await lstat(path)).isSymbolicLink()) {
      throw new GliaError("USAGE", `refusing to edit a symlinked hook config at ${path}`);
    }
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

/** Read-only proof that the exact Glia-managed SessionEnd hook is installed. */
export async function managedHookInstalled(
  harnessId: HarnessId,
  env: Record<string, string | undefined>,
): Promise<boolean> {
  const existing = await readConfig(hookConfigPath(harnessId, env));
  if (existing === null) return false;
  const located = locate(existing);
  return located.sessionEntries.some(isManagedHookGroup);
}

export async function installHookConfig(
  harnessId: HarnessId,
  env: Record<string, string | undefined>,
  commandPrefix: string | readonly string[],
): Promise<HookResult> {
  const path = hookConfigPath(harnessId, env);
  const existing = await readConfig(path);
  let text = existing ?? "{}\n";
  let located = locate(text);
  if (located.hooks === null) {
    text = insertObjectProperty(text, located.root, "hooks", {
      SessionEnd: [hookGroup(commandPrefix)],
    });
  } else if (located.sessionEnd === null) {
    text = insertObjectProperty(text, located.hooks, "SessionEnd", [hookGroup(commandPrefix)]);
  } else {
    const managedIndex = located.sessionEntries.findIndex(isManagedHookGroup);
    if (managedIndex >= 0) {
      const current = located.sessionEntries[managedIndex] as {
        hooks: { command: string }[];
      };
      if (current.hooks[0]!.command === hookCommand(commandPrefix)) {
        return { harnessId, path, status: "up_to_date" };
      }
      const range = arrayElements(text, located.sessionEnd)[managedIndex]!;
      text = replaceValue(text, range, hookGroup(commandPrefix));
    } else if (located.sessionEntries.some(isPotentialEditedGliaGroup)) {
      return { harnessId, path, status: "unmanaged" };
    } else {
      text = insertArrayElement(text, located.sessionEnd, hookGroup(commandPrefix));
    }
  }
  await writeFileAtomic(path, text);
  return { harnessId, path, status: existing === null ? "created" : "updated" };
}

export async function removeHookConfig(
  harnessId: HarnessId,
  env: Record<string, string | undefined>,
): Promise<HookResult> {
  const path = hookConfigPath(harnessId, env);
  const existing = await readConfig(path);
  if (existing === null) return { harnessId, path, status: "not_installed" };
  const located = locate(existing);
  if (located.sessionEnd === null) return { harnessId, path, status: "not_installed" };
  const managed = new Set<number>();
  located.sessionEntries.forEach((entry, index) => {
    if (isManagedHookGroup(entry)) managed.add(index);
  });
  if (managed.size === 0) {
    return {
      harnessId,
      path,
      status: located.sessionEntries.some(isPotentialEditedGliaGroup)
        ? "unmanaged"
        : "not_installed",
    };
  }
  const hasEdited = located.sessionEntries.some(
    (entry) => !isManagedHookGroup(entry) && isPotentialEditedGliaGroup(entry),
  );
  await writeFileAtomic(path, removeArrayElements(existing, located.sessionEnd, managed));
  return {
    harnessId,
    path,
    status: hasEdited ? "removed_with_unmanaged" : "removed",
  };
}
