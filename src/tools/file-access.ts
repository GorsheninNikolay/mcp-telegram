import { realpathSync } from "node:fs";
import { open, realpath, stat, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, delimiter, dirname, extname, isAbsolute, join, sep } from "node:path";
import { isSafeAbsolutePath } from "./shared.js";

/** Legacy full-profile path checks. Messaging transfers use safe-transfer.ts.
 * Defaults are the separate Outbox/Inbox directories. Explicit roots apply only
 * to legacy full-profile tools and never expand the messaging profile. */
export const FILE_DIRS_ENV = "MCP_TELEGRAM_FILE_DIRS";

// Windows paths compare case-insensitively (realpath returns the on-disk case there). macOS
// volumes may be case-sensitive, so its paths compare exactly: a mismatch only refuses.
const CASE_INSENSITIVE = process.platform === "win32";
/** First-level folders under home that hold credentials and app state. */
const HOME_PRIVATE = new Set(["library", "appdata"]);
/** Folders that run what is put into them (PowerShell profiles live in Documents). */
const AUTORUN_FOLDERS = new Set(["powershell", "windowspowershell"]);

const norm = (p: string) => (CASE_INSENSITIVE ? p.toLowerCase() : p);

function realOrNull(p: string): string | null {
  try {
    return realpathSync.native(p);
  } catch {
    return null;
  }
}

function unique(paths: Array<string | null>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const p of paths) {
    if (p && !seen.has(norm(p))) {
      seen.add(norm(p));
      out.push(p);
    }
  }
  return out;
}

/** Path segments of `child` below `root`, or null when `child` is not inside `root`. */
function segmentsBelow(child: string, root: string): string[] | null {
  const c = norm(child);
  const r = norm(root);
  if (c === r) return [];
  const prefix = r.endsWith(sep) ? r : r + sep;
  if (!c.startsWith(prefix)) return null;
  return child
    .slice(prefix.length)
    .split(/[\\/]+/)
    .filter(Boolean);
}

function configuredRoots(): string[] | null {
  const raw = process.env[FILE_DIRS_ENV];
  if (!raw?.trim()) return null;
  return unique(
    raw
      .split(delimiter)
      .map((s) => s.trim())
      .filter((s) => isAbsolute(s))
      .map(realOrNull),
  );
}

export function readRoots(): string[] {
  return configuredRoots() ?? unique([realOrNull(join(homedir(), "TelegramMCP", "Outbox"))]);
}

export function writeRoots(): string[] {
  return configuredRoots() ?? unique([realOrNull(join(homedir(), "TelegramMCP", "Inbox"))]);
}

/** True when `real` is inside one of `roots` without passing through a hidden or private folder. */
function allowedBy(real: string, roots: string[]): boolean {
  const home = realOrNull(homedir());
  return roots.some((root) => {
    const below = segmentsBelow(real, root);
    if (below === null) return false;
    if (below.some((seg) => seg.startsWith("."))) return false;
    if (below.some((seg) => AUTORUN_FOLDERS.has(seg.toLowerCase()))) return false;
    // When the root is home or above it, app data under home stays private. A root chosen
    // inside home (Downloads, the Windows temp folder under AppData, a configured folder)
    // was picked on purpose, so only what is below it is checked.
    if (home && segmentsBelow(home, root) !== null) {
      const underHome = segmentsBelow(real, home);
      if (underHome?.[0] && HOME_PRIVATE.has(underHome[0].toLowerCase())) return false;
      if (underHome?.some((seg) => seg.startsWith("."))) return false;
    }
    return true;
  });
}

/** Same file as one of the credential files (compared by device and inode, not by spelling). */
async function isCredentialFile(real: string, credentialFiles: string[]): Promise<boolean> {
  let target: { dev: number; ino: number };
  try {
    target = await stat(real);
  } catch {
    return false;
  }
  for (const f of credentialFiles) {
    try {
      const s = await stat(f);
      if (s.dev === target.dev && s.ino === target.ino) return true;
    } catch {
      // missing credential file: nothing to protect
    }
  }
  return false;
}

function outsideMessage(path: string, roots: string[], verb: "read" | "write"): string {
  const where = roots.length ? roots.join(", ") : "(none configured)";
  return `Refusing to ${verb} ${path}: allowed folders are ${where}, hidden files and folders excluded. To allow another folder, add it to ${FILE_DIRS_ENV}.`;
}

/**
 * Resolve a file the caller wants to upload. Returns its real path, or throws with a
 * message the model can relay to the user.
 */
export async function checkReadablePath(path: string, credentialFiles: string[]): Promise<string> {
  if (!isSafeAbsolutePath(path)) throw new Error(`Not an absolute local file path: ${path}`);
  let real: string;
  try {
    real = await realpath(path);
  } catch {
    throw new Error(`File not found: ${path}`);
  }
  if (await isCredentialFile(real, credentialFiles)) {
    throw new Error(`Refusing to read ${path}: it holds Telegram credentials`);
  }
  const roots = readRoots();
  if (!allowedBy(real, roots)) throw new Error(outsideMessage(path, roots, "read"));
  if (!(await stat(real)).isFile()) throw new Error(`Not a regular file: ${path}`);
  return real;
}

/**
 * Reserve where a download may be written. The folder must exist and be allowed; an
 * existing file is never replaced: `name (1).ext`, `name (2).ext`, ... is used instead.
 * The returned file is created empty with an exclusive open, so two downloads never pick
 * the same name; the caller writes into it, or removes it with {@link releaseReservedPath}
 * if the download fails. Existing files (credential files included) are never touched.
 */
export async function prepareWritablePath(path: string, _credentialFiles: string[]): Promise<string> {
  if (!isSafeAbsolutePath(path)) throw new Error(`Not an absolute local file path: ${path}`);
  const name = basename(path);
  if (!name || name.startsWith(".")) throw new Error(`Refusing to write ${path}: hidden file names are not allowed`);
  // Windows alternate data streams (`file.txt:stream`) would write into an existing file.
  if (process.platform === "win32" && name.includes(":")) {
    throw new Error(`Refusing to write ${path}: ':' is not allowed in a file name`);
  }
  let dir: string;
  try {
    dir = await realpath(dirname(path));
  } catch {
    throw new Error(`Folder does not exist: ${dirname(path)}`);
  }
  const roots = writeRoots();
  const first = join(dir, name);
  if (!allowedBy(first, roots)) throw new Error(outsideMessage(path, roots, "write"));

  const ext = extname(name);
  const stem = ext ? name.slice(0, -ext.length) : name;
  for (let n = 0; n < 100; n++) {
    const candidate = n === 0 ? first : join(dir, `${stem} (${n})${ext}`);
    try {
      const handle = await open(candidate, "wx", 0o600);
      await handle.close();
      return candidate;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    }
  }
  throw new Error(`Refusing to write ${path}: too many files with this name already exist`);
}

/** Remove a file reserved by {@link prepareWritablePath} when nothing was written into it. */
export async function releaseReservedPath(path: string): Promise<void> {
  try {
    if ((await stat(path)).size === 0) await unlink(path);
  } catch {
    // already gone
  }
}
