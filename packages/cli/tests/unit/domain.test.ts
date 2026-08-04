import { describe, expect, test } from "bun:test";
import { sessionIdOf } from "../../src/session/domain/identity.ts";
import { bundleDigest, manifestOf } from "../../src/session/storage/bundle.ts";
import {
  ARCHIVE_SCHEMA_VERSION,
  mergeArchiveMarker,
  type ArchiveMarker,
} from "../../src/session/domain/archive.ts";

describe("session identity", () => {
  test("is deterministic and depends only on the source identity pair", () => {
    const a = sessionIdOf({ harnessId: "codex", sourceSessionId: "abc" });
    const b = sessionIdOf({ harnessId: "codex", sourceSessionId: "abc" });
    expect(a).toBe(b);
    expect(a).toMatch(/^ses_[0-9a-f]{32}$/);
    expect(sessionIdOf({ harnessId: "claude-code", sourceSessionId: "abc" })).not.toBe(a);
    expect(sessionIdOf({ harnessId: "codex", sourceSessionId: "abd" })).not.toBe(a);
  });
});

describe("bundle digest", () => {
  const file = (path: string, sha256: string) => ({
    path,
    size: 10,
    mediaType: "application/jsonl",
    sha256,
  });

  test("is stable under file ordering", () => {
    const d1 = bundleDigest(manifestOf({ files: [file("a", "1"), file("b", "2")] }));
    const d2 = bundleDigest(manifestOf({ files: [file("b", "2"), file("a", "1")] }));
    expect(d1).toBe(d2);
  });

  test("changes when any byte-level content changes", () => {
    const d1 = bundleDigest(manifestOf({ files: [file("a", "1")] }));
    const d2 = bundleDigest(manifestOf({ files: [file("a", "CHANGED")] }));
    expect(d1).not.toBe(d2);
  });
});

describe("archive marker merge", () => {
  const marker = (
    state: ArchiveMarker["state"],
    transitionedAt: string,
    replicaId: string,
  ): ArchiveMarker => ({
    schemaVersion: ARCHIVE_SCHEMA_VERSION,
    sessionId: "ses_test",
    state,
    transitionedAt,
    replicaId,
  });

  test("the latest transition wins", () => {
    const older = marker("archived", "2026-07-20T00:00:00.000Z", "rpl_z");
    const newer = marker("active", "2026-07-20T00:00:01.000Z", "rpl_a");
    expect(mergeArchiveMarker(older, newer)).toEqual(newer);
    expect(mergeArchiveMarker(newer, older)).toEqual(newer);
  });

  test("equal timestamps choose the lexically larger Replica ID", () => {
    const smaller = marker("archived", "2026-07-20T00:00:00.000Z", "rpl_a");
    const larger = marker("active", "2026-07-20T00:00:00.000Z", "rpl_z");
    expect(mergeArchiveMarker(smaller, larger)).toEqual(larger);
    expect(mergeArchiveMarker(larger, smaller)).toEqual(larger);
  });
});
