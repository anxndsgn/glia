import { GliaError } from "../output/errors.ts";

export function digestHex(digest: string): string {
  const match = /^sha256:([0-9a-f]{64})$/.exec(digest);
  if (!match) {
    throw new GliaError("INTERNAL", `not a self-describing sha256 digest: ${digest}`);
  }
  return match[1]!;
}
