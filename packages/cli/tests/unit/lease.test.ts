import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WriterLease } from "../../src/core/store/lease.ts";

let root: string;
let lockFile: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "glia-lease-test-"));
  lockFile = join(root, "writer.sqlite");
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

test("a corrupt lease database preserves its SQLite error instead of reporting contention", async () => {
  await Bun.write(lockFile, "This is not a SQLite database.");
  await expect(WriterLease.acquire(lockFile, 50)).rejects.toMatchObject({
    code: "SQLITE_NOTADB",
  });
});

test("a held lease times out and becomes available after release", async () => {
  const holder = await WriterLease.acquire(lockFile, 1_000);
  try {
    await expect(WriterLease.acquire(lockFile, 50)).rejects.toMatchObject({
      code: "PROJECT_BUSY",
    });
  } finally {
    holder.release();
  }
  const next = await WriterLease.acquire(lockFile, 1_000);
  next.release();
});

test("a waiting writer acquires the lease when the holder releases it", async () => {
  const holder = await WriterLease.acquire(lockFile, 1_000);
  const waiting = WriterLease.acquire(lockFile, 1_000);
  await Bun.sleep(40);
  holder.release();
  const next = await waiting;
  next.release();
});
