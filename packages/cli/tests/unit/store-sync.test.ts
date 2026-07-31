import { describe, expect, test } from "bun:test";
import { validateStoreRemoteUrl } from "../../src/core/store/remote-url.ts";
import { validateStoreMarker } from "../../src/core/store/marker.ts";
import { selectCandidate, type SessionConflictDoc } from "../../src/session/domain/conflict.ts";
import { GliaError } from "../../src/core/output/errors.ts";

// Assembled at runtime so no repo file carries a token the secret-detection
// url-userinfo-password rule can match in source form (see tests/helpers.ts).
const HTTPS_CRED_URL = ["https", "://user:secret@example.com/store.git"].join("");

function codeOf(fn: () => void): string | null {
  try {
    fn();
    return null;
  } catch (err) {
    return err instanceof GliaError ? err.code : "not-a-glia-error";
  }
}

describe("store remote URL validation", () => {
  test("accepts credential-free URLs across transports", () => {
    for (const url of [
      "https://example.com/team/store.git",
      "http://example.com/store.git",
      "ssh://git@example.com/team/store.git",
      "ssh://example.com/team/store.git",
      "git@example.com:team/store.git",
      "example.com:team/store.git",
      "file:///var/stores/project.git",
      "/var/stores/project.git",
    ]) {
      expect(codeOf(() => validateStoreRemoteUrl(url))).toBeNull();
    }
  });

  test("rejects any http(s) userinfo — with or without a password", () => {
    expect(codeOf(() => validateStoreRemoteUrl("https://user@example.com/store.git"))).toBe(
      "USAGE",
    );
    expect(codeOf(() => validateStoreRemoteUrl(HTTPS_CRED_URL))).toBe("USAGE");
    expect(codeOf(() => validateStoreRemoteUrl("http://token@example.com/store.git"))).toBe(
      "USAGE",
    );
  });

  test("rejects passwords on ssh and scp-style URLs but allows a user name", () => {
    expect(
      codeOf(() =>
        validateStoreRemoteUrl(["ssh", "://user:secret@example.com/store.git"].join("")),
      ),
    ).toBe("USAGE");
    expect(codeOf(() => validateStoreRemoteUrl("user:secret@example.com:team/store.git"))).toBe(
      "USAGE",
    );
    expect(codeOf(() => validateStoreRemoteUrl("ssh://user@example.com/store.git"))).toBeNull();
  });

  test("rejects relative paths and empty input", () => {
    expect(codeOf(() => validateStoreRemoteUrl(""))).toBe("USAGE");
    expect(codeOf(() => validateStoreRemoteUrl("stores/project.git"))).toBe("USAGE");
  });

  test("never echoes a possible credential back in error details", () => {
    try {
      validateStoreRemoteUrl(HTTPS_CRED_URL);
      expect.unreachable();
    } catch (err) {
      expect(JSON.stringify((err as GliaError).details)).not.toContain("secret");
    }
  });
});

describe("store marker validation", () => {
  test("a missing marker on existing history is STORE_MISMATCH, distinguished in details", () => {
    try {
      validateStoreMarker(null, "prj_a", "remote");
      expect.unreachable();
    } catch (err) {
      expect((err as GliaError).code).toBe("STORE_MISMATCH");
      expect((err as GliaError).details["reason"]).toBe("missing_marker");
    }
  });

  test("a mismatched projectId is STORE_MISMATCH", () => {
    expect(
      codeOf(() =>
        validateStoreMarker(
          { storeFormatVersion: 1, projectId: "prj_b", epoch: 0 },
          "prj_a",
          "remote",
        ),
      ),
    ).toBe("STORE_MISMATCH");
  });

  test("a newer storeFormatVersion is refused politely", () => {
    expect(
      codeOf(() =>
        validateStoreMarker(
          { storeFormatVersion: 99, projectId: "prj_a", epoch: 0 },
          "prj_a",
          "remote",
        ),
      ),
    ).toBe("STATE_TOO_NEW");
  });

  test("a matching marker passes", () => {
    expect(
      codeOf(() =>
        validateStoreMarker(
          { storeFormatVersion: 1, projectId: "prj_a", epoch: 0 },
          "prj_a",
          "remote",
        ),
      ),
    ).toBeNull();
  });
});

describe("conflict candidate selection", () => {
  const doc: SessionConflictDoc = {
    schemaVersion: 1,
    sessionId: "ses_x",
    candidates: [
      {
        key: "k1",
        digest: "aaa111",
        acceptedAt: "2026-07-15T10:00:00Z",
        harnessId: "claude-code",
        sourceSessionId: "s",
      },
      {
        key: "k2",
        digest: "bbb222",
        acceptedAt: "2026-07-15T11:00:00Z",
        harnessId: "claude-code",
        sourceSessionId: "s",
      },
    ],
  };

  test("selects by digest, accepting a unique prefix", () => {
    expect(selectCandidate(doc, "bbb222").key).toBe("k2");
    expect(selectCandidate(doc, "aaa").key).toBe("k1");
  });

  test("an unknown digest is NOT_FOUND and an ambiguous prefix is USAGE", () => {
    expect(codeOf(() => selectCandidate(doc, "ccc"))).toBe("NOT_FOUND");
    const ambiguous: SessionConflictDoc = {
      ...doc,
      candidates: [
        { ...doc.candidates[0]!, digest: "abc111" },
        { ...doc.candidates[1]!, digest: "abc222" },
      ],
    };
    expect(codeOf(() => selectCandidate(ambiguous, "abc"))).toBe("USAGE");
  });

  test("two candidates sharing one digest resolve to the earlier acceptance time", () => {
    const sameDigest: SessionConflictDoc = {
      ...doc,
      candidates: [
        { ...doc.candidates[0]!, key: "k9", digest: "ddd444", acceptedAt: "2026-07-15T12:00:00Z" },
        { ...doc.candidates[1]!, key: "k3", digest: "ddd444", acceptedAt: "2026-07-15T09:00:00Z" },
      ],
    };
    const chosen = selectCandidate(sameDigest, "ddd444");
    expect(chosen.key).toBe("k3");
    expect(chosen.acceptedAt).toBe("2026-07-15T09:00:00Z");
  });
});
