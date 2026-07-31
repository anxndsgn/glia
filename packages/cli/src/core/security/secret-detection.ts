/**
 * Secret Detection per the spec: an advisory gate at the acceptance
 * boundary. Pattern rules only — a rule is admitted only when the
 * credential format is self-evident, so false positives are near zero
 * by construction (ADR 0017). Every hit is a *suspected* secret; a
 * clean scan never means a clean Session.
 */

/** Monotonically increasing ruleset snapshot marker, persisted with hits. */
export const RULESET_VERSION = 1;

export interface SecretHit {
  ruleId: string;
  /** Bundle-relative Source Bundle file. */
  file: string;
  /** Source line or equivalent cursor, e.g. `line:12`. */
  cursor: string;
  /** Short masked preview; never the full matched value. */
  preview: string;
}

export interface UnscannedFile {
  file: string;
  reason: string;
}

export interface DetectionResult {
  rulesetVersion: number;
  hits: SecretHit[];
  /** Files not fully scanned; never silently counted as clean. */
  unscanned: UnscannedFile[];
}

interface PatternRule {
  id: string;
  pattern: RegExp;
  /** Length of the match's self-evident prefix kept in the masked preview. */
  previewKeep: number;
}

/**
 * Rule IDs are stable slugs and are never reused: a semantic change
 * retires the ID and introduces a new one.
 */
const RULES: PatternRule[] = [
  { id: "pem-private-key", pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/g, previewKeep: 10 },
  {
    id: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{8,}/g,
    previewKeep: 3,
  },
  {
    id: "url-userinfo-password",
    pattern: /\b[a-zA-Z][a-zA-Z0-9+.-]*:\/\/[^\s/:@]+:[^\s/@]+@[^\s/]+/g,
    previewKeep: 5,
  },
  { id: "aws-access-key-id", pattern: /\bAKIA[0-9A-Z]{16}\b/g, previewKeep: 4 },
  { id: "github-token", pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, previewKeep: 4 },
  { id: "anthropic-api-key", pattern: /\bsk-ant-[A-Za-z0-9_-]{8,}/g, previewKeep: 7 },
  { id: "openai-api-key", pattern: /\bsk-(?!ant-)[A-Za-z0-9_-]{20,}\b/g, previewKeep: 3 },
  { id: "slack-token", pattern: /\bxox[abposr]-[A-Za-z0-9-]{8,}/g, previewKeep: 4 },
  { id: "stripe-secret-key", pattern: /\bsk_live_[A-Za-z0-9]{8,}\b/g, previewKeep: 8 },
  { id: "npm-token", pattern: /\bnpm_[A-Za-z0-9]{24,}\b/g, previewKeep: 4 },
];

/**
 * The full matched value never appears in any output, state, or error.
 * A preview is the match's self-evident prefix, an ellipsis, and a
 * bracketed four-hex-character tag from the match's SHA-256 digest:
 * equal matches share a tag, distinct matches almost surely differ, and
 * nothing of the value is recoverable from the tag.
 */
export function maskPreview(value: string, keep: number): string {
  const prefix = value.slice(0, Math.min(keep, Math.max(1, value.length - 1)));
  const tag = new Bun.CryptoHasher("sha256").update(value).digest("hex").slice(0, 4);
  return `${prefix}…[${tag}]`;
}

/** Replaces every rule match in display text with its masked preview, so
 * a surface built from source text (e.g. a Session Label) never carries
 * the full value. */
export function redactSecrets(text: string): string {
  let out = text;
  for (const rule of RULES) {
    out = out.replace(rule.pattern, (match) => maskPreview(match, rule.previewKeep));
  }
  return out;
}

/** Scans one file's bytes; latin1 keeps arbitrary bytes 1:1 scannable. */
export function scanBytes(bytes: Uint8Array, file: string): SecretHit[] {
  const text = Buffer.from(bytes).toString("latin1");
  const hits: SecretHit[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i]!;
    for (const rule of RULES) {
      for (const match of line.matchAll(rule.pattern)) {
        hits.push({
          ruleId: rule.id,
          file,
          cursor: `line:${i + 1}`,
          preview: maskPreview(match[0], rule.previewKeep),
        });
      }
    }
  }
  return hits;
}

/** Scans a caller-defined file set without owning its traversal or
 * domain-specific staging layout. */
export async function scanFiles(
  files: { path: string; source: string }[],
): Promise<DetectionResult> {
  const hits: SecretHit[] = [];
  const unscanned: UnscannedFile[] = [];
  for (const file of files) {
    try {
      hits.push(...scanBytes(await Bun.file(file.source).bytes(), file.path));
    } catch (error) {
      unscanned.push({
        file: file.path,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { rulesetVersion: RULESET_VERSION, hits, unscanned };
}

/** A Candidate is withheld when it has hits or files detection could not scan. */
export function withholdsAcceptance(result: DetectionResult): boolean {
  return result.hits.length > 0 || result.unscanned.length > 0;
}
