import assert from "node:assert/strict";
import { link, mkdir, mkdtemp, open, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, it } from "node:test";
import { MAX_TRANSFER_BYTES, snapshotUpload, writeDownload } from "../tools/safe-transfer.js";

let base: string;
let outbox: string;
let inbox: string;
before(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), "safe-transfer-")));
  outbox = join(base, "Outbox");
  inbox = join(base, "Inbox");
  await mkdir(outbox);
  await mkdir(inbox);
});
after(async () => {
  await rm(base, { recursive: true, force: true });
});
it("rejects URLs, escape paths, hidden paths, directories, symlinks and hardlinks", async () => {
  const file = join(outbox, "source");
  await writeFile(file, "bytes");
  await writeFile(join(outbox, ".env"), "synthetic credential");
  await symlink(file, join(outbox, "link"));
  await symlink(outbox, join(base, "alias"));
  for (const path of [
    "https://example.com",
    join(base, "secret"),
    join(outbox, ".env"),
    outbox,
    join(outbox, "link"),
    join(base, "alias", "source"),
  ]) {
    await assert.rejects(snapshotUpload(path, [], outbox));
  }
  await writeFile(join(outbox, "credentials.json"), "synthetic credential");
  await assert.rejects(snapshotUpload(join(outbox, "credentials.json"), [], outbox));
  await link(file, join(outbox, "hardlink"));
  await assert.rejects(snapshotUpload(file, [], outbox));
  await assert.rejects(snapshotUpload(join(outbox, "hardlink"), [], outbox));
});
it("rejects credential inode and oversize regular file by descriptor", async () => {
  const path = join(outbox, "ordinary-name");
  await writeFile(path, "synthetic secret");
  await assert.rejects(snapshotUpload(path, [path], outbox));
  const huge = join(outbox, "huge");
  const handle = await open(huge, "w");
  await handle.truncate(MAX_TRANSFER_BYTES + 1);
  await handle.close();
  await assert.rejects(snapshotUpload(huge, [], outbox));
});
it("sends a stable snapshot after the original name is replaced, including >20 MiB", async () => {
  const path = join(outbox, "large.bin");
  const content = Buffer.alloc(21 * 1024 * 1024, 7);
  await writeFile(path, content);
  const snapshot = await snapshotUpload(path, [], outbox);
  await writeFile(path, "replacement");
  assert.equal(snapshot.name, "large.bin");
  assert.deepEqual(snapshot.bytes, content);
});
it("creates downloads exclusively and refuses symlinks, outside paths and overwrite", async () => {
  const path = join(inbox, "media");
  await writeDownload(path, Buffer.from("original"), inbox);
  await assert.rejects(writeDownload(path, Buffer.from("replacement"), inbox));
  assert.equal(await readFile(path, "utf8"), "original");
  await symlink(path, join(inbox, "link"));
  for (const target of [join(inbox, "link"), join(inbox, ".env"), join(base, "other")]) {
    await assert.rejects(writeDownload(target, Buffer.from("x"), inbox));
  }
  const results = await Promise.allSettled([
    writeDownload(join(inbox, "race"), Buffer.from("a"), inbox),
    writeDownload(join(inbox, "race"), Buffer.from("b"), inbox),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
});
