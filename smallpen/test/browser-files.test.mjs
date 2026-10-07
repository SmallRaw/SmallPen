import assert from "node:assert/strict";
import test from "node:test";
import { createHash } from "node:crypto";
import {
  readDirectory,
  resolvePackageDirectory,
  supportsDirectoryAccess,
  syncDirectory,
} from "../apps/web/src/browser-files.mjs";

const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const missing = () =>
  Object.assign(new Error("missing"), { name: "NotFoundError" });
function directory(values, prefix = "", options = {}) {
  return {
    kind: "directory",
    name: prefix ? prefix.split("/").at(-2) : "Design.smallpen",
    async *values() {
      const names = new Set(
        [...values.keys()]
          .filter((p) => p.startsWith(prefix))
          .map((p) => p.slice(prefix.length).split("/")[0]),
      );
      for (const name of names) {
        if (values.has(prefix + name)) yield await this.getFileHandle(name);
        else yield await this.getDirectoryHandle(name);
      }
    },
    async getDirectoryHandle(name) {
      return directory(values, prefix + name + "/", options);
    },
    async getFileHandle(name, { create = false } = {}) {
      const path = prefix + name;
      if (!create && !values.has(path)) throw missing();
      return {
        kind: "file",
        name,
        async getFile() {
          if (!values.has(path)) throw missing();
          return new File([values.get(path)], name);
        },
        async createWritable() {
          if (options.fail === path) throw new Error("disk full");
          let next;
          return {
            async write(bytes) {
              next = Buffer.from(bytes);
            },
            async close() {
              values.set(path, next);
            },
            async abort() {},
          };
        },
      };
    },
    async removeEntry(name) {
      if (!values.delete(prefix + name)) throw missing();
    },
  };
}
function record(values) {
  return {
    files: Object.fromEntries(
      [...values]
        .filter(([p]) => !p.startsWith("notes/"))
        .map(([p, b]) => [p, { local: hash(b), remote: hash(b) }]),
    ),
  };
}
function listing(values) {
  return [...values].map(([path, b]) => ({
    path,
    sha256: hash(b),
    size: b.length,
  }));
}

test("native directory access requires a secure supported browser", () => {
  assert.equal(
    supportsDirectoryAccess({
      isSecureContext: true,
      showDirectoryPicker() {},
    }),
    true,
  );
  assert.equal(
    supportsDirectoryAccess({
      isSecureContext: false,
      showDirectoryPicker() {},
    }),
    false,
  );
  assert.equal(supportsDirectoryAccess({ isSecureContext: true }), false);
});

test("opening a parent folder resolves its only SmallPen package", async () => {
  const source = new Map([
    ["focusdesk.smallpen/manifest.json", Buffer.from("{}")],
    ["focusdesk.smallpen/screens/home.json", Buffer.from("{}")],
    ["initialization/answers.json", Buffer.from("{}")],
    ["focusdesk.smallpen.batches.json", Buffer.from("{}")],
  ]);
  const selected = await resolvePackageDirectory(directory(source));
  assert.equal(selected.name, "focusdesk.smallpen");
  const { form } = await readDirectory(selected);
  assert.deepEqual(
    [...form.keys()],
    [
      "focusdesk.smallpen/manifest.json",
      "focusdesk.smallpen/screens/home.json",
    ],
  );
});

test("opening a Package directly keeps the selected directory", async () => {
  const selected = directory(new Map([["manifest.json", Buffer.from("{}")]]));
  assert.equal(await resolvePackageDirectory(selected), selected);
});

test("opening a parent with multiple Packages does not choose one silently", async () => {
  const selected = directory(
    new Map([
      ["one.smallpen/manifest.json", Buffer.from("{}")],
      ["two.smallpen/manifest.json", Buffer.from("{}")],
    ]),
  );
  await assert.rejects(resolvePackageDirectory(selected), {
    code: "native_missing_manifest",
  });
});

test("directory read keeps nested and binary files, omits hidden files, and enforces limits", async () => {
  const source = new Map([
    ["manifest.json", Buffer.from("{}")],
    ["blobs/image", Buffer.from([0, 255])],
    [".DS_Store", Buffer.from("hidden")],
  ]);
  const { form, hashes } = await readDirectory(directory(source));
  assert.equal([...form].length, 2);
  assert.deepEqual(
    Buffer.from(await form.get("Design.smallpen/blobs/image").arrayBuffer()),
    source.get("blobs/image"),
  );
  assert.equal(hashes["manifest.json"], hash(source.get("manifest.json")));
  await assert.rejects(
    readDirectory(directory(source), { maxFiles: 1 }),
    /2000|limit/,
  );
});

test("native save writes changes and new blobs, removes managed files, and preserves unrelated files", async () => {
  const source = new Map([
    ["manifest.json", Buffer.from("before")],
    ["screens/main.json", Buffer.from("screen")],
    ["screens/old.json", Buffer.from("old")],
    ["notes/keep.txt", Buffer.from("keep")],
  ]);
  const before = record(source);
  const next = new Map([
    ["manifest.json", Buffer.from("after")],
    ["screens/main.json", Buffer.from("updated")],
    ["blobs/new", Buffer.from([0, 255])],
  ]);
  await syncDirectory(
    directory(source),
    before,
    listing(next),
    async (path) => next.get(path),
    async () => {},
  );
  assert.deepEqual(source.get("blobs/new"), next.get("blobs/new"));
  assert.equal(source.get("screens/main.json").toString(), "updated");
  assert.equal(source.has("screens/old.json"), false);
  assert.equal(source.get("notes/keep.txt").toString(), "keep");
  assert.equal(before.pending, false);
});

test("native save rejects external edits before changing any file", async () => {
  const source = new Map([
    ["manifest.json", Buffer.from("before")],
    ["screens/main.json", Buffer.from("screen")],
  ]);
  const before = record(source);
  source.set("screens/main.json", Buffer.from("external"));
  const next = new Map([
    ["manifest.json", Buffer.from("after")],
    ["screens/main.json", Buffer.from("updated")],
  ]);
  await assert.rejects(
    syncDirectory(
      directory(source),
      before,
      listing(next),
      async (p) => next.get(p),
      async () => {},
    ),
    (e) => e.code === "native_file_conflict",
  );
  assert.equal(source.get("manifest.json").toString(), "before");
  assert.equal(source.get("screens/main.json").toString(), "external");
});

test("partially written saves checkpoint completed files and can retry without losing changes", async () => {
  const source = new Map([
    ["manifest.json", Buffer.from("before")],
    ["screens/a.json", Buffer.from("a")],
    ["screens/b.json", Buffer.from("b")],
  ]);
  const before = record(source);
  const next = new Map([
    ["manifest.json", Buffer.from("after")],
    ["screens/a.json", Buffer.from("A")],
    ["screens/b.json", Buffer.from("B")],
  ]);
  const options = { fail: "screens/b.json" };
  let saved;
  const checkpoint = async () => {
    saved = structuredClone(before);
  };
  await assert.rejects(
    syncDirectory(
      directory(source, "", options),
      before,
      listing(next),
      async (p) => next.get(p),
      checkpoint,
    ),
    /disk full/,
  );
  assert.equal(saved.pending, true);
  assert.equal(saved.files["screens/a.json"].local, hash(Buffer.from("A")));
  assert.equal(source.get("manifest.json").toString(), "before");
  delete options.fail;
  await syncDirectory(
    directory(source),
    saved,
    listing(next),
    async (p) => next.get(p),
    async () => {},
  );
  assert.equal(source.get("manifest.json").toString(), "after");
  assert.equal(source.get("screens/b.json").toString(), "B");
  assert.equal(saved.pending, false);
});

test("unsafe paths and corrupt downloads never write into the selected directory", async () => {
  const source = new Map([["manifest.json", Buffer.from("before")]]);
  const before = record(source);
  for (const path of [
    "../escape",
    "/absolute",
    "C:/escape",
    "dir/../file",
    ".env",
    "dir\\file",
  ])
    await assert.rejects(
      syncDirectory(
        directory(source),
        before,
        [{ path, sha256: hash(Buffer.from("bad")), size: 3 }],
        async () => Buffer.from("bad"),
        async () => {},
      ),
    );
  const next = new Map([["manifest.json", Buffer.from("after")]]);
  await assert.rejects(
    syncDirectory(
      directory(source),
      before,
      listing(next),
      async () => Buffer.from("wrong"),
      async () => {},
    ),
    /checksum/i,
  );
  assert.equal(source.get("manifest.json").toString(), "before");
});
