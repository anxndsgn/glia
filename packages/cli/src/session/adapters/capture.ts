import { dirname, join } from "node:path";
import { mkdir, readdir } from "node:fs/promises";
import { GliaError } from "../../core/output/errors.ts";
import type {
  BundleFile,
  CapturedBundle,
  FileTouch,
  SessionCandidate,
  StagingArea,
} from "./types.ts";

/** Discovery probes Harness roots that legitimately may not exist. */
export async function directoryExists(path: string): Promise<boolean> {
  try {
    await readdir(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * The one File Touch normalization rule, shared by every adapter: a path is
 * normalized only when the source states it absolutely. It must not diverge
 * per Harness.
 */
export function touch(operation: FileTouch["operation"], sourcePath: string): FileTouch {
  return {
    operation,
    sourcePath,
    normalizedPath: sourcePath.startsWith("/") ? sourcePath : null,
  };
}

export async function sha256File(path: string): Promise<{ sha256: string; size: number }> {
  const file = Bun.file(path);
  const bytes = await file.arrayBuffer();
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(bytes);
  return { sha256: hasher.digest("hex"), size: bytes.byteLength };
}

/**
 * Copies a candidate's allowlisted source files into staging byte-for-byte.
 * Adapters never follow arbitrary paths or symlinks beyond the allowlist.
 * A missing required artifact is SOURCE_INCOMPLETE, never a partial Session.
 */
export async function captureAllowlisted(
  candidate: SessionCandidate,
  staging: StagingArea,
): Promise<CapturedBundle> {
  const files: BundleFile[] = [];
  for (const ref of candidate.sourceFiles) {
    const source = Bun.file(ref.absolutePath);
    if (!(await source.exists())) {
      throw new GliaError(
        "SOURCE_INCOMPLETE",
        `required source artifact is missing: ${ref.absolutePath}`,
        {
          candidateId: candidate.candidateId,
          path: ref.absolutePath,
        },
      );
    }
    const destination = join(staging.dir, ref.bundlePath);
    await mkdir(dirname(destination), { recursive: true });
    await Bun.write(destination, source);
    const { sha256, size } = await sha256File(destination);
    files.push({ path: ref.bundlePath, size, mediaType: ref.mediaType, sha256 });
  }
  return { files };
}

export type SourceCaptureStatus = "current" | "changed" | "missing";

/** Re-hashes live source files and distinguishes mutation from source loss. */
export async function sourceCaptureStatus(
  candidate: SessionCandidate,
  captured: CapturedBundle,
): Promise<SourceCaptureStatus> {
  let changed = false;
  const liveBundlePaths = new Set(candidate.sourceFiles.map((ref) => ref.bundlePath));
  // A freshly discovered allowlist that no longer names captured evidence
  // proves source loss even when the remaining transcript still exists.
  if (captured.files.some((file) => !liveBundlePaths.has(file.path))) return "missing";
  for (const ref of candidate.sourceFiles) {
    // Missing evidence outranks a changed artifact. Inspect every source so a
    // growing transcript cannot hide a concurrently deleted subagent file.
    if (!(await Bun.file(ref.absolutePath).exists())) return "missing";
    const capturedFile = captured.files.find((f) => f.path === ref.bundlePath);
    if (!capturedFile) {
      changed = true;
      continue;
    }
    try {
      const { sha256 } = await sha256File(ref.absolutePath);
      if (sha256 !== capturedFile.sha256) changed = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return "missing";
      throw error;
    }
  }
  return changed ? "changed" : "current";
}

/** Confirms the staged bytes still match the captured hashes after waiting for the writer lease. */
export async function stagingMatchesCapture(
  stagingDir: string,
  captured: CapturedBundle,
): Promise<boolean> {
  for (const file of captured.files) {
    const path = join(stagingDir, file.path);
    if (!(await Bun.file(path).exists())) return false;
    try {
      const current = await sha256File(path);
      if (current.sha256 !== file.sha256 || current.size !== file.size) return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
      throw error;
    }
  }
  return true;
}
