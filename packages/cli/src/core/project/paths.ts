import { homedir } from "node:os";
import { join } from "node:path";

export function gliaHome(env: Record<string, string | undefined> = Bun.env): string {
  const fromEnv = env["GLIA_HOME"];
  return fromEnv && fromEnv.length > 0 ? fromEnv : join(homedir(), ".glia");
}

export function identityFile(home: string): string {
  return join(home, "identity.json");
}

/** Machine-global proof that a hook invocation reached glia. */
export function hookLivenessFile(home: string): string {
  return join(home, "hook-liveness.sqlite");
}

/** Serializes machine-local Binding creation and ownership decisions. */
export function bindingsLockFile(home: string): string {
  return join(home, "bindings-lock.sqlite");
}

export interface ProjectPaths {
  projectDir: string;
  storeDir: string;
  stateDir: string;
  cacheDir: string;
  bindingsFile: string;
  writerLockFile: string;
  syncStateFile: string;
  sessionStateDir: string;
  discoveryFile: string;
  /** Withheld Candidates whose Harness source disappeared before acceptance. */
  withheldLossFile: string;
  stagingRoot: string;
  /** Machine-local pending-deletion propagation state. */
  deletionPendingFile: string;
  /** Bystander content preserved before a deletion rewrite, per run. */
  preservedDir: string;
  sessionCacheDir: string;
  currentProjectionFile: string;
  indexesDir: string;
  /** Atomically replaced report from the latest bound hook run. */
  hookReportFile: string;
  /** Size-capped, one-JSON-object-per-line history of hook runs. */
  hookLogFile: string;
  /** Serializes the hook report/log read-modify-write pair across processes. */
  hookStateLockFile: string;
  /** Serializes Binding mutation with cross-Project ownership decisions. */
  bindingsLockFile: string;
}

export function projectPaths(home: string, projectId: string): ProjectPaths {
  const projectDir = join(home, "projects", projectId);
  const stateDir = join(projectDir, "state");
  const cacheDir = join(projectDir, "cache");
  const sessionStateDir = join(stateDir, "session");
  const sessionCacheDir = join(cacheDir, "session");
  return {
    projectDir,
    storeDir: join(projectDir, "store"),
    stateDir,
    cacheDir,
    bindingsFile: join(stateDir, "bindings.json"),
    writerLockFile: join(stateDir, "writer-lock.sqlite"),
    syncStateFile: join(stateDir, "sync.json"),
    sessionStateDir,
    discoveryFile: join(sessionStateDir, "discovery.json"),
    withheldLossFile: join(sessionStateDir, "withheld-losses.json"),
    stagingRoot: join(sessionStateDir, "staging"),
    deletionPendingFile: join(stateDir, "deletion-pending.json"),
    preservedDir: join(stateDir, "preserved"),
    sessionCacheDir,
    currentProjectionFile: join(sessionCacheDir, "current.json"),
    indexesDir: join(sessionCacheDir, "indexes"),
    hookReportFile: join(stateDir, "hook-last-run.json"),
    hookLogFile: join(stateDir, "hook-runs.log"),
    hookStateLockFile: join(stateDir, "hook-state-lock.sqlite"),
    bindingsLockFile: bindingsLockFile(home),
  };
}
