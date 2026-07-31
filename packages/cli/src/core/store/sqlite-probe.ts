import { Database } from "bun:sqlite";
import { GliaError } from "../output/errors.ts";

let probed = false;

/** Probes bun:sqlite and trigram FTS5 once per process; unsupported runtimes fail explicitly. */
export function probeSqliteFts5(): void {
  if (probed) return;
  try {
    const db = new Database(":memory:");
    db.run("CREATE VIRTUAL TABLE probe USING fts5(content, tokenize='trigram')");
    db.close();
    probed = true;
  } catch (err) {
    throw new GliaError(
      "UNSUPPORTED_RUNTIME",
      `this runtime does not provide SQLite with trigram FTS5: ${(err as Error).message}`,
    );
  }
}
