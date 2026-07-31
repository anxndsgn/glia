export interface JsonlLine {
  /** 1-based line number in the source file. */
  line: number;
  /** Parsed object, or null when the line is not valid JSON. */
  value: Record<string, unknown> | null;
}

/** Splits a JSONL file into lines, keeping unparseable lines locatable. */
export async function readJsonlLines(path: string): Promise<JsonlLine[]> {
  const text = await Bun.file(path).text();
  const out: JsonlLine[] = [];
  const rawLines = text.split("\n");
  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i] ?? "";
    if (raw.trim().length === 0) continue;
    let value: Record<string, unknown> | null = null;
    try {
      const parsed = JSON.parse(raw) as unknown;
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        value = parsed as Record<string, unknown>;
      }
    } catch {
      value = null;
    }
    out.push({ line: i + 1, value });
  }
  return out;
}

export function asString(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

export function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}
