import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";

export function isWithinRoot(rootPath, candidatePath) {
  const child = relative(rootPath, candidatePath);
  return child === "" || (!child.startsWith("..") && !isAbsolute(child));
}

export async function pathExists(path) {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

// Reads a file only when it is a regular file. A FIFO or device in a Package
// (an archive can carry one) would otherwise block the read, the write lock
// and a thread-pool thread forever. Opening without blocking and checking the
// opened handle leaves no gap between the check and the read.
//
// With `maxBytes`, a file larger than the limit fails with code EFILETOOBIG
// (and `size`/`maxBytes` on the error) instead of being buffered whole; the
// read itself is bounded too, so a file growing after the size check cannot
// pass the limit either.
export async function readRegularFile(path, encoding, { maxBytes } = {}) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NONBLOCK ?? 0));
  try {
    const info = await handle.stat();
    if (!info.isFile()) {
      const error = new Error(`Not a regular file: ${path}`);
      error.code = "ENOTREGULAR";
      throw error;
    }
    if (maxBytes === undefined) return await handle.readFile(encoding);
    const tooBig = (size) =>
      Object.assign(new Error(`File exceeds ${maxBytes} bytes: ${path}`), {
        code: "EFILETOOBIG",
        maxBytes,
        size,
      });
    if (info.size > maxBytes) throw tooBig(info.size);
    const chunks = [];
    let length = 0;
    while (length <= maxBytes) {
      const chunk = Buffer.alloc(Math.min(Math.max(info.size - length, 0), maxBytes - length) + 1);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, length);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      length += bytesRead;
    }
    if (length > maxBytes) throw tooBig(length);
    const bytes = Buffer.concat(chunks, length);
    return encoding ? bytes.toString(encoding) : bytes;
  } finally {
    await handle.close();
  }
}

// Writes a new file and flushes it to stable storage before returning. The
// file must not exist yet: commits never truncate an inode in place because
// unchanged candidate files are hard links shared with the live Package.
export async function writeFileDurable(path, data, encoding) {
  const handle = await open(path, "wx");
  try {
    await handle.writeFile(data, encoding);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

// Flushes directory entries (creates, renames, unlinks). Some platforms and
// file systems (notably Windows) cannot open or sync a directory; durability
// there relies on the file-level syncs alone.
export async function syncDirectory(path) {
  let handle;
  try {
    handle = await open(path, "r");
    await handle.sync();
  } catch (error) {
    if (
      !["EISDIR", "EPERM", "EACCES", "EINVAL", "ENOTSUP", "EBADF"].includes(
        error?.code,
      )
    ) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}
