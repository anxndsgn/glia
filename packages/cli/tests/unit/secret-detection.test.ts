import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RULESET_VERSION,
  detectSecrets,
  maskPreview,
  scanBytes,
  withholdsAcceptance,
} from "../../src/session/domain/secret-detection.ts";
import { FAKE_KEY } from "../helpers.ts";

const scanText = (text: string) => scanBytes(new TextEncoder().encode(text), "source/t.jsonl");

/**
 * One seeded, clearly fake credential per shipped rule, assembled at
 * runtime: no file in this repo may contain a token the rules can match
 * in source form (see FAKE_KEY in tests/helpers.ts).
 */
const SEEDED: Record<string, string> = {
  "pem-private-key": ["-----BEGIN RSA PRIVATE", "KEY-----"].join(" "),
  jwt: ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiJmYWtlIn0", "c2lnbmF0dXJlZmFrZQ"].join("."),
  "url-userinfo-password": ["postgres", "://admin:hunter2@db.internal.example:5432/app"].join(""),
  "aws-access-key-id": ["AKIA", "IOSFODNN7EXAMPLE"].join(""),
  "github-token": ["ghp", "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef0123"].join("_"),
  "anthropic-api-key": FAKE_KEY,
  "openai-api-key": ["sk", "proj-FAKEFAKEFAKEFAKEFAKEFAKE"].join("-"),
  "slack-token": ["xoxb", "123456789-abcdefghij"].join("-"),
  "stripe-secret-key": ["sk_live", "FAKEFAKEFAKE1234"].join("_"),
  "npm-token": ["npm", "FAKEFAKEFAKEFAKEFAKEFAKE"].join("_"),
};

describe("secret detection ruleset", () => {
  for (const [ruleId, value] of Object.entries(SEEDED)) {
    test(`${ruleId} flags its seeded credential and masks the preview`, () => {
      const hits = scanText(`prefix text ${value} suffix`);
      expect(hits.map((h) => h.ruleId)).toContain(ruleId);
      for (const hit of hits) {
        expect(hit.preview.length).toBeLessThan(value.length);
        expect(hit.preview).not.toContain(value);
        expect(hit.cursor).toBe("line:1");
        expect(hit.file).toBe("source/t.jsonl");
      }
    });
  }

  test("an Anthropic key is not double-reported as an OpenAI key", () => {
    const hits = scanText(`token=${SEEDED["anthropic-api-key"]}`);
    expect(hits.map((h) => h.ruleId)).toEqual(["anthropic-api-key"]);
  });

  test("ordinary transcript text produces no hits", () => {
    const clean = [
      "please fix the flaky auth token test",
      "commit 3df12ad0b449ec7b8e0787b8e078abcdef012345 normalized the markers",
      "sha256 d1e8a70b5ccab1dc2f56bbf7e99f064a660c08e361a35751b9c483c88943d082",
      "https://github.com/anthropics/glia/pull/42",
    ].join("\n");
    expect(scanText(clean)).toHaveLength(0);
  });

  test("scanning is byte-level: a key inside binary-looking bytes is found", () => {
    const bytes = new Uint8Array([
      0,
      1,
      2,
      255,
      254,
      ...new TextEncoder().encode(["-----BEGIN EC PRIVATE", "KEY-----"].join(" ")),
      0,
      128,
    ]);
    const hits = scanBytes(bytes, "source/blob.bin");
    expect(hits.map((h) => h.ruleId)).toEqual(["pem-private-key"]);
  });

  test("maskPreview keeps the self-evident prefix plus a stable non-reversible tag", () => {
    const masked = maskPreview(SEEDED["anthropic-api-key"]!, 7);
    expect(masked).toMatch(/^sk-ant-…\[[0-9a-f]{4}\]$/);
    // Equal matches share a tag; distinct matches almost surely differ.
    expect(maskPreview(SEEDED["anthropic-api-key"]!, 7)).toBe(masked);
    expect(maskPreview(["sk-ant", "api03-OTHERKEYOTHERKEY"].join("-"), 7)).not.toBe(masked);
    for (const value of Object.values(SEEDED)) {
      const preview = maskPreview(value, 7);
      expect(preview).not.toBe(value);
      expect(value.startsWith(preview.slice(0, preview.indexOf("…")))).toBeTrue();
    }
  });
});

describe("detectSecrets over a staged bundle", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "glia-detect-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("scans every listed file and never alters bytes", async () => {
    const path = join(dir, "source", "transcript.jsonl");
    const content = `{"text":"key ${SEEDED["aws-access-key-id"]} leaked"}\n`;
    await Bun.write(path, content);
    const captured = {
      files: [
        { path: "source/transcript.jsonl", size: content.length, mediaType: "x", sha256: "x" },
      ],
    };
    const result = await detectSecrets(dir, captured);
    expect(result.rulesetVersion).toBe(RULESET_VERSION);
    expect(result.hits.map((h) => h.ruleId)).toEqual(["aws-access-key-id"]);
    expect(withholdsAcceptance(result)).toBeTrue();
    expect(await Bun.file(path).text()).toBe(content);
  });

  test("a file that cannot be scanned is reported, never counted clean", async () => {
    const captured = {
      files: [{ path: "source/missing.jsonl", size: 1, mediaType: "x", sha256: "x" }],
    };
    const result = await detectSecrets(dir, captured);
    expect(result.hits).toHaveLength(0);
    expect(result.unscanned).toHaveLength(1);
    expect(result.unscanned[0]!.file).toBe("source/missing.jsonl");
    expect(withholdsAcceptance(result)).toBeTrue();
  });
});
