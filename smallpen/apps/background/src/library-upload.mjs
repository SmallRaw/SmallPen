import { dirname, relative } from "node:path";
import {
  importDirectoryUpload,
  MAX_DIRECTORY_UPLOAD_BYTES,
} from "./directory-upload.mjs";

export const MAX_LIBRARY_UPLOAD_BYTES = MAX_DIRECTORY_UPLOAD_BYTES;

// Field names carry browser-relative paths; multipart filenames are not used.
export async function importLibraryUpload(locator, form) {
  const parent = dirname(locator);
  const imported = await importDirectoryUpload(parent, form, {
    kind: "library",
  });
  return {
    path: relative(parent, imported.path).split("\\").join("/"),
    name: imported.name,
  };
}
