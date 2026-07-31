import { join } from "node:path";
import { cp, mkdir, readdir } from "node:fs/promises";
import type { CommandDefinition } from "../../core/session-module.ts";
import type { CommandOutcome } from "../../core/output/result.ts";
import { GliaError } from "../../core/output/errors.ts";
import { readSessionMeta, readStoredBundle } from "../storage/store-layout.ts";
import { requireSessionUnconflicted } from "../domain/conflict.ts";
import { archiveStateFor } from "../domain/archive.ts";

export const EXPORT_FORMAT_VERSION = 1;

export const exportCommand: CommandDefinition = {
  name: "export",
  description: "export one Session to a stable, versioned public directory format",
  arguments: [{ name: "session-id", description: "the Session ID" }],
  options: [
    {
      flags: "--output <directory>",
      description: "destination directory (must be empty or absent)",
    },
  ],
  async run(ctx, args, options): Promise<CommandOutcome> {
    const sessionId = args[0];
    if (!sessionId) throw new GliaError("USAGE", "session export requires a <session-id>");
    const output = options["output"] !== undefined ? String(options["output"]) : null;
    if (!output) throw new GliaError("USAGE", "session export requires --output <directory>");

    const storeDir = ctx.project.paths.storeDir;
    await requireSessionUnconflicted(storeDir, sessionId);
    const meta = await readSessionMeta(storeDir, sessionId);
    if (!meta) throw new GliaError("NOT_FOUND", `no session ${sessionId}`, { sessionId });
    const bundle = await readStoredBundle(storeDir, sessionId);
    const archiveState = await archiveStateFor(storeDir, sessionId);

    try {
      const existing = await readdir(output);
      if (existing.length > 0) {
        throw new GliaError("DESTINATION_NOT_EMPTY", `destination ${output} is not empty`, {
          output,
        });
      }
    } catch (err) {
      if (err instanceof GliaError) throw err;
      // Destination does not exist yet; export creates it.
    }
    await mkdir(output, { recursive: true });

    await cp(join(bundle.dir, "source"), join(output, "source"), { recursive: true });
    const exportDoc = {
      formatVersion: EXPORT_FORMAT_VERSION,
      sessionId: meta.sessionId,
      revision: meta.currentRevision.digest,
      sourceIdentity: { harnessId: meta.harnessId, sourceSessionId: meta.sourceSessionId },
      project: {
        projectId: ctx.project.declaration.projectId,
        association: meta.association,
        openingPath: meta.openingPath,
      },
      continuation: meta.continuation,
      archiveState,
      acceptedAt: meta.currentRevision.acceptedAt,
      files: bundle.manifest.files,
    };
    await Bun.write(join(output, "session.json"), JSON.stringify(exportDoc, null, 2) + "\n");

    return {
      json: {
        sessionId,
        revision: meta.currentRevision.digest,
        output,
        files: bundle.manifest.files.length,
        archiveState,
      },
      human: `Exported session ${sessionId} (revision ${meta.currentRevision.digest.slice(0, 12)}, archive state ${archiveState}) to ${output}.`,
    };
  },
};
