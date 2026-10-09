import { opendir, realpath, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

function fail(status, code, message) {
  throw Object.assign(new Error(message), { status, code });
}

export async function listDirectories(rawPath, directoryRoot) {
  if (
    rawPath !== undefined &&
    (typeof rawPath !== "string" ||
      rawPath.length > 4096 ||
      /[\x00-\x1f]/.test(rawPath))
  )
    fail(422, "invalid_directory_path", "Enter a folder path.");
  let path;
  try {
    const requested = rawPath?.trim() || directoryRoot;
    path = await realpath(
      resolve(directoryRoot, requested === "~" ? homedir() : requested),
    );
    if (!(await stat(path)).isDirectory())
      fail(422, "not_a_directory", "Select a folder.");
    const entries = [];
    let scanned = 0;
    let truncated = false;
    const directory = await opendir(path);
    for await (const entry of directory) {
      if (++scanned > 20000 || entries.length >= 1000) {
        truncated = true;
        break;
      }
      if (entry.name.startsWith(".")) continue;
      const entryPath = join(path, entry.name);
      let isDirectory = entry.isDirectory();
      if (entry.isSymbolicLink())
        isDirectory = await stat(entryPath).then(
          (value) => value.isDirectory(),
          () => false,
        );
      if (isDirectory)
        entries.push({
          name: entry.name,
          path: entryPath,
          package: entry.name.toLowerCase().endsWith(".smallpen"),
        });
    }
    entries.sort((left, right) => left.name.localeCompare(right.name));
    return { path, parent: dirname(path), home: homedir(), entries, truncated };
  } catch (error) {
    if (error.status) throw error;
    if (error.code === "ENOENT")
      fail(404, "directory_not_found", "Folder not found.");
    if (error.code === "ENOTDIR")
      fail(422, "not_a_directory", "Select a folder.");
    fail(403, "directory_unavailable", "Cannot open this folder.");
  }
}
