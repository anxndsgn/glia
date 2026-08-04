import { Database } from "bun:sqlite";
import { mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";
import { hookLivenessFile } from "../project/paths.ts";
import type { LoadedProject } from "../session-module.ts";
import { writeFileAtomic, writeJsonAtomic } from "../state/atomic-file.ts";
import { WriterLease } from "../store/lease.ts";

const HOOK_LOG_MAX_BYTES = 64 * 1024;
const HOOK_STATE_LOCK_TIMEOUT_MS = 10_000;

export interface HookLiveness {
  schemaVersion: 1;
  lastRunAt: string;
}

export interface HookRunReport {
  schemaVersion: 1;
  startedAt: string;
  finishedAt: string;
  outcome: "success" | "busy" | "error";
  summary: Record<string, unknown>;
}

async function readText(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export async function touchHookLiveness(
  home: string,
  at = new Date().toISOString(),
): Promise<void> {
  const path = hookLivenessFile(home);
  await mkdir(dirname(path), { recursive: true });
  const db = new Database(path, { create: true });
  try {
    db.exec("PRAGMA busy_timeout = 500");
    db.exec(`CREATE TABLE IF NOT EXISTS hook_liveness (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      schema_version INTEGER NOT NULL,
      last_run_at TEXT NOT NULL
    )`);
    db.query(
      `INSERT INTO hook_liveness (singleton, schema_version, last_run_at)
       VALUES (1, 1, ?)
       ON CONFLICT(singleton) DO UPDATE SET
         schema_version = 1,
         last_run_at = MAX(hook_liveness.last_run_at, excluded.last_run_at)`,
    ).run(at);
  } finally {
    db.close();
  }
}

export async function readHookLiveness(home: string): Promise<HookLiveness | null> {
  const path = hookLivenessFile(home);
  if (!(await Bun.file(path).exists())) return null;
  const db = new Database(path, { readonly: true });
  try {
    const row = db
      .query(
        "SELECT schema_version AS schemaVersion, last_run_at AS lastRunAt FROM hook_liveness WHERE singleton = 1",
      )
      .get() as Partial<HookLiveness> | null;
    return row?.schemaVersion === 1 && typeof row.lastRunAt === "string"
      ? { schemaVersion: 1, lastRunAt: row.lastRunAt }
      : null;
  } finally {
    db.close();
  }
}

export async function readHookRunReport(project: LoadedProject): Promise<HookRunReport | null> {
  const text = await readText(project.paths.hookReportFile);
  if (text === null) return null;
  const raw = JSON.parse(text) as Partial<HookRunReport>;
  if (
    raw.schemaVersion !== 1 ||
    typeof raw.startedAt !== "string" ||
    typeof raw.finishedAt !== "string" ||
    !["success", "busy", "error"].includes(String(raw.outcome)) ||
    typeof raw.summary !== "object" ||
    raw.summary === null
  ) {
    return null;
  }
  return raw as HookRunReport;
}

/** Atomically replaces the latest report and keeps a bounded JSONL history. */
export async function recordHookRun(project: LoadedProject, report: HookRunReport): Promise<void> {
  const lease = await WriterLease.acquire(
    project.paths.hookStateLockFile,
    HOOK_STATE_LOCK_TIMEOUT_MS,
  );
  try {
    const latest = await readHookRunReport(project);
    if (latest === null || compareReports(report, latest) >= 0) {
      await writeJsonAtomic(project.paths.hookReportFile, report);
    }
    const previous = (await readText(project.paths.hookLogFile)) ?? "";
    const pruned = Array.isArray(report.summary["prunedWithheld"])
      ? (report.summary["prunedWithheld"] as Record<string, unknown>[])
      : [];
    const currentLines = [boundedRunLine(report)];
    for (const record of pruned) {
      const lossLine = boundedLogLine({
        event: "withheld_source_lost",
        candidateId: record["candidateId"],
        firstFlaggedAt: record["firstFlaggedAt"],
        prunedAt: record["prunedAt"],
      });
      if (logLinesBytes([...currentLines, lossLine]) > HOOK_LOG_MAX_BYTES) break;
      currentLines.push(lossLine);
    }
    const previousLines = previous.split("\n").filter((line) => line.length > 0);
    while (
      previousLines.length > 0 &&
      logLinesBytes([...previousLines, ...currentLines]) > HOOK_LOG_MAX_BYTES
    ) {
      previousLines.shift();
    }
    await writeFileAtomic(
      project.paths.hookLogFile,
      [...previousLines, ...currentLines].join("\n") + "\n",
    );
  } finally {
    lease.release();
  }
}

function compareReports(left: HookRunReport, right: HookRunReport): number {
  return (
    left.finishedAt.localeCompare(right.finishedAt) || left.startedAt.localeCompare(right.startedAt)
  );
}

function boundedRunLine(report: HookRunReport): string {
  const full = JSON.stringify(report);
  if (Buffer.byteLength(full + "\n") <= HOOK_LOG_MAX_BYTES) return full;
  return boundedLogLine({
    schemaVersion: report.schemaVersion,
    startedAt: report.startedAt,
    finishedAt: report.finishedAt,
    outcome: report.outcome,
    summary: { truncated: true },
  });
}

function boundedLogLine(value: unknown): string {
  const full = JSON.stringify(value);
  if (Buffer.byteLength(full + "\n") <= HOOK_LOG_MAX_BYTES) return full;
  return JSON.stringify({ event: "truncated" });
}

function logLinesBytes(lines: readonly string[]): number {
  return Buffer.byteLength(lines.join("\n") + "\n");
}

export const hookLogMaxBytes = HOOK_LOG_MAX_BYTES;
