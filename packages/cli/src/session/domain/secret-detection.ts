import { join } from "node:path";
import {
  scanFiles,
  type DetectionResult,
  type SecretHit,
  type UnscannedFile,
} from "../../core/security/secret-detection.ts";

/** The format-aware rules are shared; captured Source Bundle traversal
 * and persisted Candidate evaluation remain Session responsibilities. */
export * from "../../core/security/secret-detection.ts";

export interface PersistedEvaluation {
  bundleDigest: string;
  rulesetVersion: number;
  evaluatedAt: string;
  hits: SecretHit[];
  unscanned: UnscannedFile[];
}

/**
 * Scans every file of a captured Source Bundle in staging as a byte
 * stream. A file that cannot be fully scanned is reported, never
 * silently counted as clean.
 */
export async function detectSecrets(
  stagingDir: string,
  captured: { files: { path: string }[] },
): Promise<DetectionResult> {
  return await scanFiles(
    captured.files.map((file) => ({
      path: file.path,
      source: join(stagingDir, file.path),
    })),
  );
}
