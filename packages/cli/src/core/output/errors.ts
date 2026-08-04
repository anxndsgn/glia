export type ErrorCode =
  | "USAGE"
  | "NOT_A_GIT_WORKTREE"
  | "NOT_ENROLLED"
  | "STORE_NOT_REALIZED"
  | "PROJECT_NOT_FOUND"
  | "PATH_NOT_BOUND"
  | "BINDING_CONFLICT"
  | "BINDING_CHANGED"
  | "ALIAS_ONLY_WORKTREE"
  | "INPUT_REQUIRED"
  | "CANCELLED"
  | "PROJECT_BUSY"
  | "SOURCE_INCOMPLETE"
  | "NOT_FOUND"
  | "SESSION_CONFLICT"
  | "DESTINATION_NOT_EMPTY"
  | "ASSOCIATION_CONFLICT"
  | "UNSUPPORTED_RUNTIME"
  | "INVALID_DECLARATION"
  | "INVALID_SOURCE"
  | "GIT_FAILED"
  | "STORE_MISMATCH"
  | "REMOTE_REWRITTEN"
  | "SESSION_DELETED"
  | "REWRITE_PUSH_REFUSED"
  | "SYNC_RETRY_EXHAUSTED"
  | "NO_STORE_REMOTE"
  | "STATE_TOO_NEW"
  | "INTERNAL";

export class GliaError extends Error {
  readonly code: ErrorCode;
  readonly details: Record<string, unknown>;

  constructor(code: ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "GliaError";
    this.code = code;
    this.details = details;
  }
}

export function toGliaError(err: unknown): GliaError {
  if (err instanceof GliaError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new GliaError("INTERNAL", message);
}
