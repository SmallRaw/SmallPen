import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, join, posix } from "node:path";
import { SmallPenError } from "@smallpen/core";
import { openPackage } from "@smallpen/local-package";

export const MAX_DIRECTORY_UPLOAD_BYTES = 50 * 1024 * 1024;
const MAX_FILES = 2000;

// Browser-relative field names carry paths. Multipart filenames never select
// destinations. Each upload owns one new directory and cannot replace files.
export async function importDirectoryUpload(
  parent,
  form,
  { kind = "package" } = {},
) {
  const invalid = (message) => {
    throw new SmallPenError(`invalid_${kind}_upload`, message);
  };
  const files = [...form.entries()];
  if (!files.length || files.length > MAX_FILES)
    invalid(`Select a ${kind} with 1–2000 files.`);
  const seen = new Set();
  let root,
    total = 0;
  for (const [path, file] of files) {
    const parts = path.split("/");
    if (
      parts.length < 2 ||
      path.length > 1024 ||
      /[\\:\x00-\x1f]/.test(path) ||
      parts.some(
        (part) => !part || part.startsWith(".") || /[. ]$/.test(part),
      ) ||
      parts.some((part) =>
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      )
    ) {
      invalid(`The ${kind} contains an unsafe file path.`);
    }
    root ??= parts[0];
    if (parts[0] !== root || typeof file.arrayBuffer !== "function")
      invalid(`Select one ${kind} directory.`);
    const key = path.normalize("NFC").toLowerCase();
    if (seen.has(key)) invalid(`The ${kind} contains duplicate file paths.`);
    seen.add(key);
    total += file.size;
    if (total > MAX_DIRECTORY_UPLOAD_BYTES) {
      throw new SmallPenError(
        kind === "package"
          ? "package_upload_too_large"
          : "invalid_library_upload",
        `The ${kind} exceeds the 50 MB upload limit.`,
      );
    }
  }
  // An HTML package: index.html at the top of the selected directory. It
  // is self-contained, so nothing it names can read files outside it.
  if (!form.get(`${root}/index.html`))
    invalid(`Select the ${kind} directory containing index.html.`);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const container = await mkdtemp(join(parent, `imported-${kind}-`));
  const target = join(
    container,
    kind === "library" ? "library.smallpen" : root,
  );
  try {
    for (const [path, file] of files) {
      const destination = join(target, ...path.split("/").slice(1));
      await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
      await writeFile(destination, Buffer.from(await file.arrayBuffer()), {
        flag: "wx",
        mode: 0o600,
      });
    }
    const snapshot = await openPackage(target);
    return { path: target, name: snapshot.manifest.name, container };
  } catch (error) {
    await rm(container, { recursive: true, force: true });
    throw error;
  }
}
