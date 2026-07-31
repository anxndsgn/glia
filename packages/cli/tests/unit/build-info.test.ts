import { describe, expect, test } from "bun:test";
import { buildIdentityLine, buildInfo, CLI_VERSION } from "../../src/core/build-info.ts";

describe("build provenance", () => {
  test("an uninjected run reports an explicit unknown, never a fabricated value", () => {
    // Tests run the source directly under the development toolchain, so
    // no compile-time provenance exists: the honest answer is `unknown`
    // for both fields, not a probed or cached git fact.
    const info = buildInfo();
    expect(info.version).toBe(CLI_VERSION);
    expect(info.commit).toBe("unknown");
    expect(info.builtAt).toBe("unknown");
  });

  test("the identity line carries version, commit, and build time", () => {
    expect(
      buildIdentityLine({ version: "0.0.1", commit: "a1b2c3d", builtAt: "2026-07-19T01:18Z" }),
    ).toBe("0.0.1 (a1b2c3d 2026-07-19T01:18Z)");
    expect(buildIdentityLine(buildInfo())).toBe(`${CLI_VERSION} (unknown unknown)`);
  });
});
