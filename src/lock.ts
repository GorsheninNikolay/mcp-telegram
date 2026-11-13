import { type ChildProcess, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_SESSION_DIR = join(homedir(), ".mcp-telegram");

function resolveSessionDir(): string {
  const sessionPath = process.env.TELEGRAM_SESSION_PATH;
  if (sessionPath) return dirname(sessionPath);
  return DEFAULT_SESSION_DIR;
}

/**
 * Create the session folder as 0700, or tighten an existing one. The dedicated default
 * folder (~/.mcp-telegram) is made 0700; it used to keep whatever mode it was created
 * with (seen as 0775), so another account in the group could swap daemon.sock or
 * daemon.lock. A custom folder (TELEGRAM_SESSION_PATH in, say, ~/Documents) is shared
 * with other files, so it only loses group/other write. No-op on Windows.
 */
export function secureSessionDir(dir: string, dedicatedDir = DEFAULT_SESSION_DIR): void {
  // Create-or-keep in one call, then always check: no window between "missing" and
  // "created" in which another process could plant a wider folder.
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (lstatSync(dir).isSymbolicLink()) throw new Error("State directory must not be a symlink");
  if (process.platform === "win32") return;
  let mode: number;
  try {
    mode = statSync(dir).mode & 0o7777;
  } catch {
    return;
  }
  // Shared folder: drop only group/other write, keep setgid/sticky and read access.
  const wanted = dir === dedicatedDir ? 0o700 : mode & ~0o022;
  if (mode === wanted) return;
  try {
    chmodSync(dir, wanted);
  } catch (e) {
    // stderr: stdout is the MCP channel. Best effort, but never silent.
    console.error(
      `[mcp-telegram] could not tighten permissions of ${dir} (${(e as Error).message}); other accounts may be able to replace session files there`,
    );
  }
}

export function lockPath(): string {
  return join(resolveSessionDir(), "daemon.lock");
}

const WIN_PIPE_PREFIX = "\\\\.\\pipe\\mcp-telegram-";

/**
 * Windows has no filesystem-path IPC in Node: `net.Server.listen(path)` only accepts the
 * named-pipe namespace (`\\.\pipe\...`), so listening on `<sessionDir>/daemon.sock` fails
 * with `listen EACCES` and the master dies before it ever reaches Telegram.
 *
 * The name is derived from the session dir so two accounts (different TELEGRAM_SESSION_PATH)
 * get separate pipes, and it is lower-cased first because Windows paths are case-insensitive:
 * otherwise a master started via `C:\Users\x` and a client started via `c:\users\x` would look
 * for each other on two different pipes and both would try to become master.
 */
function winPipeName(dir: string): string {
  const normalized = dir.toLowerCase();
  const slug = normalized.replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  // Pipe names are length-capped. Hash long dirs instead of truncating, so two deep paths
  // sharing a prefix can't collapse onto one pipe and cross-talk between accounts.
  if (slug.length <= 64) return WIN_PIPE_PREFIX + slug;
  return WIN_PIPE_PREFIX + createHash("sha1").update(normalized).digest("hex").slice(0, 32);
}

export function socketPath(): string {
  if (process.platform === "win32") return winPipeName(resolveSessionDir());
  return join(resolveSessionDir(), "daemon.sock");
}

/**
 * Try to acquire the master lock.
 * Returns true if this process is now the master.
 * Returns false if another live master process holds the lock.
 *
 * Uses PID file + kill -0 to detect stale locks after crashes.
 */
let lockHolder: ChildProcess | null = null;
export async function tryAcquireLock(): Promise<boolean> {
  if (lockHolder) return false;
  secureSessionDir(dirname(lockPath()));
  // Refuse a still-running legacy owner, which does not participate in flock.
  if (existsSync(lockPath())) {
    const pid = Number(readFileSync(lockPath(), "utf8").trim());
    if (Number.isSafeInteger(pid) && pid > 0) {
      try {
        process.kill(pid, 0);
        return false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false;
      }
    }
  }
  const child = spawn(
    fileURLToPath(new URL("../native/session-lock", import.meta.url)),
    [join(dirname(lockPath()), "owner.flock")],
    { stdio: ["pipe", "pipe", "ignore"] },
  );
  return new Promise((resolve) => {
    let acquired = false;
    child.on("error", () => resolve(false));
    child.once("exit", () => {
      if (lockHolder === child) {
        lockHolder = null;
        // Losing the OS lock must never leave a Telegram owner running.
        process.exit(1);
      }
      if (!acquired) resolve(false);
    });
    child.stdout?.once("data", (data) => {
      if (data.toString() !== "locked\n") {
        child.kill();
        resolve(false);
        return;
      }
      acquired = true;
      lockHolder = child;
      resolve(true);
    });
  });
}

export function releaseLock(): void {
  const child = lockHolder;
  lockHolder = null;
  child?.stdin?.end();
}

export function releaseSocket(): void {
  if (!lockHolder) return;
  try {
    unlinkSync(socketPath());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
