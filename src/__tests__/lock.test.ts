import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import { lockPath, releaseLock, releaseSocket, socketPath, tryAcquireLock } from "../lock.js";

const dir = mkdtempSync(join(tmpdir(), "mcp-flock-"));
const original = process.env.TELEGRAM_SESSION_PATH;
before(() => {
  process.env.TELEGRAM_SESSION_PATH = join(dir, "session");
});
after(() => {
  releaseLock();
  if (original === undefined) delete process.env.TELEGRAM_SESSION_PATH;
  else process.env.TELEGRAM_SESSION_PATH = original;
  // flock inode may only be removed when no process is using this test directory.
  setTimeout(() => rmSync(dir, { recursive: true, force: true }), 100);
});

describe("kernel session lock", () => {
  it("excludes concurrent owners, including after stale legacy PID", async () => {
    writeFileSync(lockPath(), "999999999");
    assert.equal(await tryAcquireLock(), true);
    const competitor = spawn("./native/session-lock", [join(dir, "owner.flock")], { stdio: ["pipe", "pipe", "pipe"] });
    const code = await new Promise((resolve) => competitor.once("exit", resolve));
    assert.equal(code, 1);
    assert.equal(await tryAcquireLock(), false);
    releaseLock();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(await tryAcquireLock(), true);
    releaseLock();
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
  it("refuses a live legacy owner", async () => {
    writeFileSync(lockPath(), String(process.ppid));
    assert.equal(await tryAcquireLock(), false);
  });
  it("never removes a foreign socket on import or exit", () => {
    writeFileSync(socketPath(), "foreign socket placeholder");
    releaseSocket();
    assert.equal(readFileSync(socketPath(), "utf8"), "foreign socket placeholder");
    assert.equal(existsSync(join(dir, "owner.flock")), true);
  });
});
