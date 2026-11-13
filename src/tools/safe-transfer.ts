import { constants } from "node:fs";
import { lstat, open, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const MAX_TRANSFER_BYTES = 50 * 1024 * 1024;
export const outbox = () => join(homedir(), "TelegramMCP", "Outbox");
export const inbox = () => join(homedir(), "TelegramMCP", "Inbox");

async function validatePath(path: string, root: string): Promise<void> {
  if (!isAbsolute(path) || path !== resolve(path)) throw new Error("An absolute normalized exchange path is required");
  const below = relative(root, path);
  if (!below || below.startsWith(`..${sep}`) || below === ".." || isAbsolute(below))
    throw new Error("Path is outside the exchange directory");
  const parts = path.split(sep).filter(Boolean);
  if (parts.some((part) => part.startsWith("."))) throw new Error("Hidden paths are forbidden");
  let current: string = sep;
  for (const part of parts.slice(0, -1)) {
    current = join(current, part);
    const info = await lstat(current);
    if (info.isSymbolicLink() || !info.isDirectory()) throw new Error("Symlink directories are forbidden");
  }
  if ((await realpath(dirname(path))) !== dirname(path)) throw new Error("Symlink directories are forbidden");
}

export async function snapshotUpload(
  path: string,
  credentials: string[],
  root = outbox(),
): Promise<{ name: string; bytes: Buffer }> {
  await validatePath(path, root);
  if (
    /^(?:credentials?(?:[._-].*)?|api[-_]credentials?(?:[._-].*)?|id_rsa|id_ed25519|session(?:[._-].*)?)$/i.test(
      basename(path),
    ) ||
    /\.(?:session|pem|key|p12|pfx)$/i.test(path)
  )
    throw new Error("Credential file names are forbidden");
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const before = await handle.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size > MAX_TRANSFER_BYTES)
      throw new Error("Upload requires a single-link regular file of at most 50 MiB");
    for (const credential of credentials) {
      const info = await stat(credential).catch(() => null);
      if (info && before.dev === info.dev && before.ino === info.ino) throw new Error("Credential files are forbidden");
    }
    // Read at most limit+1 even if the file grows after fstat.
    const bytes = Buffer.alloc(Math.min(before.size + 1, MAX_TRANSFER_BYTES + 1));
    let size = 0;
    while (size < bytes.length) {
      const result = await handle.read(bytes, size, bytes.length - size, size);
      if (!result.bytesRead) break;
      size += result.bytesRead;
    }
    const after = await handle.stat();
    if (
      size !== before.size ||
      after.size !== before.size ||
      after.mtimeMs !== before.mtimeMs ||
      after.ctimeMs !== before.ctimeMs ||
      after.nlink !== 1
    )
      throw new Error("Upload source changed during snapshot");
    return { name: basename(path), bytes: bytes.subarray(0, size) };
  } finally {
    await handle.close();
  }
}

export async function writeDownload(path: string, bytes: Buffer, root = inbox()): Promise<void> {
  if (bytes.length > MAX_TRANSFER_BYTES) throw new Error("Download exceeds 50 MiB");
  await validatePath(path, root);
  const handle = await open(
    path,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  // Keep the exclusive descriptor through writing. A partial file is retained on failure;
  // unlinking a name could delete a replacement owned by another process.
  try {
    await handle.writeFile(bytes);
  } finally {
    await handle.close();
  }
}
