import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readdir, readFile, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { applyOperationBatch, batchHistoryPath, defaultHistoryCacheRoot, openPackage, readBatchHistory } from "@smallpen/local-package";

const fixture = new URL("fixtures/roundtrip.smallpen", import.meta.url);
const cli = new URL("../apps/cli/bin/smallpen.mjs", import.meta.url).pathname;
const exec = promisify(execFile);

async function example(context) {
  const root = await mkdtemp(join(tmpdir(), "smallpen-history-cache-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "example.smallpen");
  await cp(fixture, path, { recursive: true });
  const before = await openPackage(path);
  const batch = { batchId: "first", baseRevision: before.revision, operations: [{
    type: "update-presentation-node", screenId: "scr_roundtrip", presentationId: "pres_desktop",
    nodeId: "node_rectangle", changes: { opacity: 0.25 },
  }] };
  const result = await applyOperationBatch(path, batch);
  return { root, path, batch, result };
}

test("a public write leaves no operation ledger or Git configuration in the project", async context => {
  const { root, path, batch, result } = await example(context);
  assert.ok((await readdir(root)).every(name => !name.includes("batches.json")));
  assert.ok(!(await readdir(root)).includes(".gitignore"));
  const cache = await batchHistoryPath(path);
  assert.ok(!cache.startsWith(root));
  assert.ok((await stat(cache)).isFile());
  const { stdout } = await exec(process.execPath, [cli, "changes", path, "--since", batch.baseRevision, "--json"]);
  assert.ok(JSON.parse(stdout).changeCount > 0, "the next CLI process shares the same cached history");
  const replay = await applyOperationBatch(path, batch);
  assert.equal(replay.alreadyApplied, true);
  assert.equal(replay.revision, result.revision);
});

test("legacy history migrates once without changing its design or losing retry identity", async context => {
  const { root, path, batch, result } = await example(context);
  const cache = await batchHistoryPath(path);
  const original = await readFile(cache, "utf8");
  await rename(cache, `${path}.batches.json`);
  const reads = await Promise.all([readBatchHistory(path), readBatchHistory(path)]);
  assert.ok(reads.every(history => history.length === 1));
  assert.equal(await readFile(cache, "utf8"), original);
  await assert.rejects(stat(`${path}.batches.json`), error => error.code === "ENOENT");
  assert.equal((await openPackage(path)).revision, result.revision);
  const batchPath = join(root, "retry.json");
  await writeFile(batchPath, JSON.stringify(batch));
  const { stdout } = await exec(process.execPath, [cli, "advanced", "apply", path, "--batch", batchPath, "--json"]);
  assert.equal(JSON.parse(stdout).alreadyApplied, true);
});

test("opening a legacy Package moves its bookkeeping out of the project", async context => {
  const { path, result } = await example(context);
  const cache = await batchHistoryPath(path);
  await rename(cache, `${path}.batches.json`);
  assert.equal((await openPackage(path)).revision, result.revision);
  await assert.rejects(stat(`${path}.batches.json`), error => error.code === "ENOENT");
  assert.equal((await readBatchHistory(path)).length, 1);
});

test("package copies have separate caches while filesystem aliases share one", async context => {
  const { root, path, batch } = await example(context);
  const copy = join(root, "copy.smallpen"), alias = join(root, "alias.smallpen");
  await cp(fixture, copy, { recursive: true });
  await applyOperationBatch(copy, { ...batch, operations: [{ ...batch.operations[0], changes: { opacity: 0.5 } }] });
  assert.notEqual(await batchHistoryPath(path), await batchHistoryPath(copy));
  await symlink(path, alias, process.platform === "win32" ? "junction" : "dir");
  assert.equal(await batchHistoryPath(alias), await batchHistoryPath(path));
});

test("an older App's recreated ledger merges into the cache under the package lock", async context => {
  const { path, batch, result } = await example(context);
  const cache = await batchHistoryPath(path);
  const first = await readFile(cache, "utf8");
  const second = { batchId: "second", baseRevision: result.revision,
    operations: [{ ...batch.operations[0], changes: { opacity: 0.5 } }] };
  await applyOperationBatch(path, second);
  await rename(cache, `${path}.batches.json`);
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  await utimes(`${path}.batches.json`, old, old);
  await writeFile(cache, first);
  assert.deepEqual((await readBatchHistory(path)).map(entry => entry.batchId), ["first", "second"]);
  await assert.rejects(stat(`${path}.batches.json`), error => error.code === "ENOENT");
  assert.equal((await applyOperationBatch(path, second)).alreadyApplied, true);
});

test("idle cache expiry clears runtime history and leaves the saved design intact", async context => {
  const { path, result } = await example(context);
  const cache = await batchHistoryPath(path);
  const backup = `${cache}.unreadable-00000000-0000-4000-8000-000000000000.bak`;
  await cp(cache, backup);
  const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
  await utimes(cache, old, old);
  await utimes(backup, old, old);
  assert.deepEqual(await readBatchHistory(path), []);
  await assert.rejects(stat(cache), error => error.code === "ENOENT");
  await assert.rejects(stat(backup), error => error.code === "ENOENT");
  assert.equal((await openPackage(path)).revision, result.revision);
});

test("a damaged legacy file is preserved in cache without discarding valid cached history", async context => {
  const { path } = await example(context);
  const cache = await batchHistoryPath(path);
  await writeFile(`${path}.batches.json`, "{ broken");
  assert.equal((await readBatchHistory(path)).length, 1);
  await assert.rejects(stat(`${path}.batches.json`), error => error.code === "ENOENT");
  const backup = (await readdir(dirname(cache))).find(name => name.startsWith("batches.json.unreadable-"));
  assert.equal(await readFile(join(dirname(cache), backup), "utf8"), "{ broken");
});

test("an unavailable cache reports tracking failure while allowing the design to save", async context => {
  const { root, path, batch, result } = await example(context);
  const unusable = join(root, "not-a-directory");
  await writeFile(unusable, "a file");
  const previous = process.env.SMALLPEN_HISTORY_CACHE_DIR;
  process.env.SMALLPEN_HISTORY_CACHE_DIR = unusable;
  try {
    const written = await applyOperationBatch(path, { batchId: "cache-unavailable", baseRevision: result.revision,
      operations: [{ ...batch.operations[0], changes: { opacity: 0.5 } }] });
    assert.equal(written.history.status, "unavailable");
    assert.equal((await openPackage(path)).revision, written.revision);
    await assert.rejects(stat(`${path}.batches.json`), error => error.code === "ENOENT");
  } finally {
    if (previous === undefined) delete process.env.SMALLPEN_HISTORY_CACHE_DIR;
    else process.env.SMALLPEN_HISTORY_CACHE_DIR = previous;
  }
});

test("default cache locations follow the platform and require no project configuration", () => {
  assert.equal(defaultHistoryCacheRoot({ platform: "darwin", home: "/Users/Example", env: {} }), "/Users/Example/Library/Caches/SmallPen/history");
  assert.equal(defaultHistoryCacheRoot({ platform: "linux", home: "/home/example", env: { XDG_CACHE_HOME: "/cache" } }), "/cache/smallpen/history");
  assert.equal(defaultHistoryCacheRoot({ platform: "linux", home: "/home/example", env: { XDG_CACHE_HOME: "relative" } }), "/home/example/.cache/smallpen/history");
  assert.equal(defaultHistoryCacheRoot({ platform: "win32", home: "C:\\Users\\Example", env: {} }), "C:\\Users\\Example\\AppData\\Local\\SmallPen\\Cache\\history");
});
