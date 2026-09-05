import { Database, SQLiteError } from "bun:sqlite";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { GliaError } from "../output/errors.ts";

const DEFAULT_TIMEOUT_MS = 10_000;
const RETRY_DELAY_MS = 25;

export function writerLeaseTimeoutMs(env: Record<string, string | undefined> = Bun.env): number {
  const raw = env["GLIA_LEASE_TIMEOUT_MS"];
  const parsed = raw ? Number.parseInt(raw, 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TIMEOUT_MS;
}

/**
 * One SQLite writer lease per Project, separate from the projection
 * database. Acquired with BEGIN IMMEDIATE and a bounded wait.
 */
export class WriterLease {
  private constructor(private readonly db: Database) {}

  static async acquire(lockFile: string, timeoutMs: number): Promise<WriterLease> {
    await mkdir(dirname(lockFile), { recursive: true });
    const db = new Database(lockFile, { create: true });
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      try {
        db.run("BEGIN IMMEDIATE");
        return new WriterLease(db);
      } catch (error) {
        if (
          !(error instanceof SQLiteError) ||
          (error.code !== "SQLITE_BUSY" && error.code !== "SQLITE_LOCKED")
        ) {
          db.close();
          throw error;
        }
        if (Date.now() >= deadline) {
          db.close();
          throw new GliaError(
            "PROJECT_BUSY",
            "another Glia writer holds this Project's writer lease",
            {
              lockFile,
              timeoutMs,
            },
          );
        }
        await Bun.sleep(RETRY_DELAY_MS);
      }
    }
  }

  release(): void {
    try {
      this.db.run("ROLLBACK");
    } catch {
      // The lease is advisory; a failed rollback still releases on close.
    }
    this.db.close();
  }
}
