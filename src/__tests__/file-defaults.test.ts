import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, it } from "node:test";
import { checkReadablePath, readRoots, writeRoots } from "../tools/file-access.js";
import { formatMedia, messageText, oneLine } from "../tools/shared.js";

const base = realpathSync(mkdtempSync(join(tmpdir(), "legacy-file-policy-")));
const home = process.env.HOME;
const dirs = process.env.MCP_TELEGRAM_FILE_DIRS;
before(() => {
  process.env.HOME = base;
  delete process.env.MCP_TELEGRAM_FILE_DIRS;
  mkdirSync(join(base, "TelegramMCP", "Outbox"), { recursive: true });
  mkdirSync(join(base, "TelegramMCP", "Inbox"), { recursive: true });
});
after(() => {
  if (home === undefined) delete process.env.HOME;
  else process.env.HOME = home;
  if (dirs === undefined) delete process.env.MCP_TELEGRAM_FILE_DIRS;
  else process.env.MCP_TELEGRAM_FILE_DIRS = dirs;
  rmSync(base, { recursive: true, force: true });
});
it("defaults to separate exchange directories, without home or temp roots", async () => {
  assert.deepEqual(readRoots(), [join(base, "TelegramMCP", "Outbox")]);
  assert.deepEqual(writeRoots(), [join(base, "TelegramMCP", "Inbox")]);
  writeFileSync(join(base, "secret"), "test");
  await assert.rejects(checkReadablePath(join(base, "secret"), []));
  await assert.rejects(checkReadablePath("https://example.com/file", []));
});
it("untrusted text cannot forge output lines", () => {
  assert.ok(oneLine("a\nb").includes(" "));
  assert.ok(messageText("a\nb").includes("\n  "));
  assert.equal(typeof formatMedia({ type: "document" }), "string");
});
