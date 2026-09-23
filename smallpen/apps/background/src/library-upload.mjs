import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import { SmallPenError } from "@smallpen/core";
import { openPackage } from "@smallpen/local-package";

export const MAX_LIBRARY_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_FILES = 2000;

function invalid(message) {
  throw new SmallPenError("invalid_library_upload", message);
}

// Field names carry browser-relative paths; multipart filenames are not used.
export async function importLibraryUpload(locator, form) {
  const files = [...form.entries()];
  if (!files.length || files.length > MAX_FILES) invalid("Select a library with 1–2000 files.");
  const seen = new Set();
  let root;
  let total = 0;
  for (const [path, file] of files) {
    const parts = path.split("/");
    if (parts.length < 2 || path.length > 1024 || /[\\:\x00-\x1f]/.test(path) ||
        parts.some((part) => !part || part.startsWith(".") || /[. ]$/.test(part)) ||
        parts.some((part) => /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
      invalid("The library contains an unsafe file path.");
    }
    root ??= parts[0];
    if (parts[0] !== root || typeof file.arrayBuffer !== "function") invalid("Select one library directory.");
    const key = path.normalize("NFC").toLowerCase();
    if (seen.has(key)) invalid("The library contains duplicate file paths.");
    seen.add(key);
    total += file.size;
    if (total > MAX_LIBRARY_UPLOAD_BYTES) invalid("The library exceeds the 50 MB upload limit.");
  }
  const manifestFile = form.get(`${root}/manifest.json`);
  if (!manifestFile) invalid("Select the library directory containing manifest.json.");
  let manifest;
  try {
    manifest = JSON.parse(await manifestFile.text());
  } catch {
    invalid("The library manifest is not valid JSON.");
  }
  // A single-directory selection cannot include sibling dependencies. Do not
  // accidentally resolve their paths against unrelated files on this computer.
  if (!manifest || typeof manifest !== "object" ||
      Object.keys(manifest.dependencies ?? {}).length ||
      Object.keys(manifest.libraries ?? {}).length) {
    invalid("Import a self-contained library without external dependencies.");
  }
  const parent = dirname(locator);
  const container = await mkdtemp(join(parent, "imported-library-"));
  const target = join(container, "library.smallpen");
  try {
    for (const [path, file] of files) {
      const destination = join(target, ...path.split("/").slice(1));
      await mkdir(dirname(destination), { recursive: true });
      await writeFile(destination, Buffer.from(await file.arrayBuffer()), { flag: "wx" });
    }
    await openPackage(target);
    return { path: relative(parent, target).split("\\").join("/"), name: manifest.name ?? basename(root) };
  } catch (error) {
    // Only the unique directory allocated by this request is removed.
    await rm(container, { recursive: true, force: true });
    throw error;
  }
}
