import { join } from "node:path";
import { GliaError } from "../output/errors.ts";
import { requireSupportedSchemaVersion } from "../state/schema-version.ts";
import { canonicalContainerBytes, DECLARATION_KEY_REGISTRY } from "./canonical.ts";

export const GLIA_JSON = "glia.json";
export const DECLARATION_SCHEMA_VERSION = 1;

export interface SecretDetectionDeclaration {
  enabled: boolean;
  unknownKeys?: Record<string, unknown>;
}

export interface StoreDeclaration {
  remote?: string;
  unknownKeys?: Record<string, unknown>;
}

export interface GliaDeclaration {
  schemaVersion: number;
  projectId: string;
  store: StoreDeclaration;
  secretDetection: SecretDetectionDeclaration;
  /** Unrecognized top-level fields are preserved across declaration rewrites. */
  unknownKeys?: Record<string, unknown>;
}

const RECOGNIZED_DECLARATION_KEYS = new Set([
  "schemaVersion",
  "projectId",
  "store",
  "secretDetection",
]);
const RECOGNIZED_STORE_KEYS = new Set(["remote"]);
const RECOGNIZED_SECRET_DETECTION_KEYS = new Set(["enabled"]);

export function declarationFile(worktree: string): string {
  return join(worktree, GLIA_JSON);
}

function unknownKeysOf(
  value: Record<string, unknown>,
  recognized: ReadonlySet<string>,
): Record<string, unknown> | undefined {
  const unknownKeys: Record<string, unknown> = {};
  for (const [key, nestedValue] of Object.entries(value)) {
    if (!recognized.has(key)) unknownKeys[key] = nestedValue;
  }
  return Object.keys(unknownKeys).length > 0 ? unknownKeys : undefined;
}

export function createDeclaration(projectId: string): GliaDeclaration {
  return {
    schemaVersion: DECLARATION_SCHEMA_VERSION,
    projectId,
    store: {},
    secretDetection: { enabled: true },
  };
}

export function parseDeclaration(input: unknown, source = GLIA_JSON): GliaDeclaration {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new GliaError("INVALID_DECLARATION", "glia.json must be a JSON object");
  }
  const obj = input as Record<string, unknown>;
  requireSupportedSchemaVersion(
    "glia.json declaration",
    source,
    obj["schemaVersion"],
    DECLARATION_SCHEMA_VERSION,
  );
  if (obj["schemaVersion"] !== DECLARATION_SCHEMA_VERSION) {
    throw new GliaError(
      "INVALID_DECLARATION",
      `glia.json schemaVersion must be ${DECLARATION_SCHEMA_VERSION}`,
    );
  }
  if (typeof obj["projectId"] !== "string" || obj["projectId"].length === 0) {
    throw new GliaError("INVALID_DECLARATION", "glia.json projectId must be a non-empty string");
  }

  const storeValue = obj["store"] ?? {};
  if (typeof storeValue !== "object" || storeValue === null || Array.isArray(storeValue)) {
    throw new GliaError("INVALID_DECLARATION", "glia.json store must be an object");
  }
  const storeRaw = storeValue as Record<string, unknown>;
  const remote = storeRaw["remote"];
  if (remote !== undefined && (typeof remote !== "string" || remote.length === 0)) {
    throw new GliaError(
      "INVALID_DECLARATION",
      "glia.json store.remote must be a non-empty string when present",
    );
  }

  const secretValue = obj["secretDetection"] ?? { enabled: true };
  if (
    typeof secretValue !== "object" ||
    secretValue === null ||
    Array.isArray(secretValue) ||
    typeof (secretValue as Record<string, unknown>)["enabled"] !== "boolean"
  ) {
    throw new GliaError(
      "INVALID_DECLARATION",
      'glia.json secretDetection must be { "enabled": boolean } when present',
    );
  }
  const secretRaw = secretValue as Record<string, unknown>;

  const declaration: GliaDeclaration = {
    schemaVersion: DECLARATION_SCHEMA_VERSION,
    projectId: obj["projectId"],
    store: typeof remote === "string" ? { remote } : {},
    secretDetection: { enabled: secretRaw["enabled"] as boolean },
  };
  const storeUnknown = unknownKeysOf(storeRaw, RECOGNIZED_STORE_KEYS);
  if (storeUnknown) declaration.store.unknownKeys = storeUnknown;
  const secretUnknown = unknownKeysOf(secretRaw, RECOGNIZED_SECRET_DETECTION_KEYS);
  if (secretUnknown) declaration.secretDetection.unknownKeys = secretUnknown;
  const topUnknown = unknownKeysOf(obj, RECOGNIZED_DECLARATION_KEYS);
  if (topUnknown) declaration.unknownKeys = topUnknown;
  return declaration;
}

export async function readDeclaration(worktree: string): Promise<GliaDeclaration | null> {
  const file = Bun.file(declarationFile(worktree));
  if (!(await file.exists())) return null;
  try {
    return parseDeclaration(JSON.parse(await file.text()), declarationFile(worktree));
  } catch (error) {
    if (error instanceof GliaError) throw error;
    throw new GliaError(
      "INVALID_DECLARATION",
      `glia.json is not valid JSON: ${(error as Error).message}`,
    );
  }
}

export function declarationBytes(declaration: GliaDeclaration): string {
  const { unknownKeys: storeUnknown, ...storeKnown } = declaration.store;
  const { unknownKeys: secretUnknown, ...secretKnown } = declaration.secretDetection;
  return canonicalContainerBytes(
    {
      schemaVersion: declaration.schemaVersion,
      projectId: declaration.projectId,
      store: { ...storeKnown, ...storeUnknown },
      secretDetection: { ...secretKnown, ...secretUnknown },
      ...declaration.unknownKeys,
    },
    DECLARATION_KEY_REGISTRY,
  );
}

export async function writeDeclaration(
  worktree: string,
  declaration: GliaDeclaration,
): Promise<void> {
  await Bun.write(declarationFile(worktree), declarationBytes(declaration));
}
