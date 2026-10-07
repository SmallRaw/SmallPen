// Browser directory handles stay in IndexedDB, scoped to this Web origin.
// The service validates and edits a working copy; save acknowledgements wait
// for these writes to the selected directory to finish.
const STORE = "directories";
const dirty = new Set();
let database;

function fail(code, message, path) {
  throw Object.assign(new Error(message), { code, path });
}

export function supportsDirectoryAccess(runtime = globalThis) {
  return (
    runtime.isSecureContext === true &&
    typeof runtime.showDirectoryPicker === "function"
  );
}

function parts(path) {
  const segments = path.split("/");
  if (
    !path ||
    path.length > 1024 ||
    /[\\:\x00-\x1f]/.test(path) ||
    segments.some(
      (s) =>
        !s ||
        s.startsWith(".") ||
        /[. ]$/.test(s) ||
        /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s),
    )
  )
    fail("native_invalid_path", "Invalid Package file path.", path);
  return segments;
}

async function digest(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((n) => n.toString(16).padStart(2, "0"))
    .join("");
}

async function fileHandle(root, path, create = false) {
  const segments = parts(path);
  let parent = root;
  for (const segment of segments.slice(0, -1))
    parent = await parent.getDirectoryHandle(segment, { create });
  return {
    parent,
    handle: await parent.getFileHandle(segments.at(-1), { create }),
  };
}

async function localHash(root, path) {
  try {
    return await digest(
      await (
        await (await fileHandle(root, path)).handle.getFile()
      ).arrayBuffer(),
    );
  } catch (error) {
    if (error.name === "NotFoundError") return null;
    throw error;
  }
}

// macOS can hide registered document packages from directory pickers.
// Selecting their parent still grants access to the enclosed directory.
export async function resolvePackageDirectory(root) {
  try {
    await root.getFileHandle("manifest.json");
    return root;
  } catch (error) {
    if (error.name !== "NotFoundError") throw error;
  }
  let selected;
  for await (const entry of root.values()) {
    if (entry.kind !== "directory" || !/\.smallpen$/i.test(entry.name))
      continue;
    if (selected)
      fail(
        "native_missing_manifest",
        "Select a folder containing one Package.",
      );
    selected = entry;
  }
  if (!selected) fail("native_missing_manifest", "Select the Package folder.");
  await selected.getFileHandle("manifest.json");
  return selected;
}

export async function readDirectory(
  root,
  { maxFiles = 2000, maxBytes = 50 * 1024 * 1024 } = {},
) {
  const form = new FormData();
  const hashes = {};
  let count = 0,
    size = 0;
  async function visit(directory, prefix = "") {
    for await (const entry of directory.values()) {
      if (entry.name.startsWith(".")) continue;
      const path = prefix + entry.name;
      parts(path);
      if (entry.kind === "directory") await visit(entry, path + "/");
      else {
        const file = await entry.getFile();
        size += file.size;
        if (++count > maxFiles || size > maxBytes)
          fail(
            "native_upload_limit",
            "The Package exceeds the 50 MB / 2000 file limit.",
          );
        hashes[path] = await digest(await file.arrayBuffer());
        form.append(`${root.name}/${path}`, file, entry.name);
      }
    }
  }
  await visit(root);
  if (!hashes["manifest.json"])
    fail(
      "native_missing_manifest",
      "Select the Package folder containing manifest.json.",
    );
  return { form, hashes };
}

// Preflight every managed file before writing. Checkpoint each completed file
// so disk/permission failures can retry, including a partially completed save.
// Only canonical Package files are managed; unrelated files stay untouched.
export async function syncDirectory(root, state, listing, read, checkpoint) {
  const desired = new Map();
  for (const item of listing) {
    parts(item.path);
    if (desired.has(item.path) || !/^[a-f0-9]{64}$/.test(item.sha256))
      fail("native_invalid_path", "Invalid Package file listing.", item.path);
    desired.set(item.path, item);
  }
  state.pending = true;
  await checkpoint();
  const changes = [];
  for (const path of new Set([
    ...Object.keys(state.files),
    ...desired.keys(),
  ])) {
    const previous = state.files[path];
    const item = desired.get(path);
    const actual = await localHash(root, path);
    const expected = previous?.local ?? null;
    const next = item?.sha256 ?? null;
    if (actual !== expected && actual !== next)
      fail(
        "native_file_conflict",
        "A local Package file changed outside SmallPen. It was not overwritten.",
        path,
      );
    if (item && (previous?.remote !== next || actual === null)) {
      const bytes = await read(path);
      if ((await digest(bytes)) !== next)
        fail(
          "native_checksum_mismatch",
          "Package file checksum mismatch.",
          path,
        );
      changes.push({ path, bytes, sha256: next, actual });
    } else if (!item || actual !== expected)
      changes.push({ path, sha256: next, actual });
  }
  changes.sort(
    (a, b) =>
      Number(a.sha256 === null) - Number(b.sha256 === null) ||
      Number(a.path === "manifest.json") - Number(b.path === "manifest.json") ||
      a.path.localeCompare(b.path),
  );
  for (const { path, bytes, sha256, actual } of changes) {
    if (sha256 === null) {
      if (actual !== null) {
        const { parent } = await fileHandle(root, path);
        await parent.removeEntry(parts(path).at(-1));
      }
      delete state.files[path];
    } else {
      if (actual !== sha256) {
        const { handle } = await fileHandle(root, path, true);
        const writable = await handle.createWritable();
        try {
          await writable.write(bytes);
          await writable.close();
        } catch (error) {
          await writable.abort().catch(() => {});
          throw error;
        }
      }
      state.files[path] = { local: sha256, remote: sha256 };
    }
    await checkpoint();
  }
  state.pending = false;
  await checkpoint();
}

function db() {
  database ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("smallpen-local-directories", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore(STORE, { keyPath: "fileId" });
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return database;
}

async function storage(method, value) {
  const connection = await db();
  return new Promise((resolve, reject) => {
    const transaction = connection.transaction(
      STORE,
      method === "put" ? "readwrite" : "readonly",
    );
    const request = transaction
      .objectStore(STORE)
      [method](...(value === undefined ? [] : [value]));
    transaction.oncomplete = () => resolve(request.result);
    transaction.onabort = transaction.onerror = () =>
      reject(transaction.error ?? request.error);
  });
}

async function permission(handle, request) {
  const options = { mode: "readwrite" };
  if ((await handle.queryPermission(options)) === "granted") return;
  if (request && (await handle.requestPermission(options)) === "granted")
    return;
  fail(
    "native_permission_required",
    "Local folder access is required. Reopen the Package from Home and grant write access to retry saving.",
  );
}

async function responseJson(response) {
  const body = await response.json();
  if (!response.ok)
    fail(
      body.error?.code ?? "native_request_failed",
      body.error?.message ?? "Package request failed.",
    );
  return body;
}

async function remoteIndex(fileId, backendUrl) {
  return responseJson(
    await fetch(
      `${backendUrl}/v1/package-files?file-id=${encodeURIComponent(fileId)}`,
    ),
  );
}

export async function syncPackage(
  fileId,
  backendUrl,
  { requestPermission = false, onCommit } = {},
) {
  if (!fileId) return;
  const initial = await storage("get", fileId);
  if (!initial) return;
  onCommit?.();
  const run = async () => {
    const state = await storage("get", fileId);
    dirty.add(fileId);
    // Persist pending before requesting access: a refused save must remain
    // associated with the original directory across navigation or restart.
    state.pending = true;
    await storage("put", state);
    await permission(state.handle, requestPermission);
    const index = await remoteIndex(fileId, backendUrl);
    await syncDirectory(
      state.handle,
      state,
      index.files,
      async (path) => {
        const response = await fetch(
          `${backendUrl}/v1/package-files?file-id=${encodeURIComponent(fileId)}&revision=${encodeURIComponent(index.revision)}&path=${encodeURIComponent(path)}`,
        );
        if (!response.ok) await responseJson(response);
        return new Uint8Array(await response.arrayBuffer());
      },
      () => storage("put", state),
    );
    dirty.delete(fileId);
  };
  if (globalThis.navigator?.locks)
    return navigator.locks.request(
      `smallpen-directory-${initial.directoryKey}`,
      run,
    );
  return run();
}

export async function prepareOpen(locator, backendUrl) {
  const state = (await storage("getAll")).find(
    (item) => item.locator === locator,
  );
  if (state) {
    await permission(state.handle, true);
    await syncPackage(state.fileId, backendUrl);
  }
}

export async function localDirectories() {
  return (await storage("getAll")).map(({ locator, name }) => ({
    locator,
    name,
  }));
}

export async function openDirectory(handle, backendUrl) {
  await permission(handle, true);
  handle = await resolvePackageDirectory(handle);
  const previous = [];
  for (const state of await storage("getAll")) {
    if (await handle.isSameEntry(state.handle)) previous.push(state);
  }
  // Preserve an incomplete save when the same folder is selected again.
  const pending = previous.find((state) => state.pending);
  if (pending) {
    await syncPackage(pending.fileId, backendUrl);
    return { url: pending.url };
  }
  const { form, hashes } = await readDirectory(handle);
  const opened = await responseJson(
    await fetch("/packages/import", { method: "POST", body: form }),
  );
  const fileId = new URL(opened.url).searchParams.get("file-id");
  const index = await remoteIndex(fileId, backendUrl);
  await storage("put", {
    fileId,
    handle,
    name: handle.name,
    locator: opened.packagePath,
    url: opened.url,
    directoryKey: previous[0]?.directoryKey ?? fileId,
    pending: false,
    files: Object.fromEntries(
      index.files.map(({ path, sha256 }) => [
        path,
        { local: hashes[path] ?? null, remote: hashes[path] ? sha256 : null },
      ]),
    ),
  });
  return opened;
}

if (typeof window !== "undefined")
  window.addEventListener("beforeunload", (event) => {
    if (dirty.size) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
