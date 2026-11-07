import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import test from "node:test";
import { applyOperationBatch, batchHistoryPath, openPackage, readBatchHistory } from "@smallpen/local-package";

const exec = promisify(execFile);
const cli = new URL("../apps/cli/bin/smallpen.mjs", import.meta.url).pathname;

test("public writes keep a byte-bounded recent history with replay and changes intact", async context => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-ledger-capacity-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "example.smallpen");
  await cp(new URL("fixtures/roundtrip.smallpen", import.meta.url), path, { recursive: true });
  let revision = (await openPackage(path)).revision;
  const apply = async (batchId, operations) => {
    const batch = { batchId, baseRevision: revision, operations };
    const result = await applyOperationBatch(path, batch);
    revision = result.revision;
    return { batch, result };
  };
  // A valid large text entry makes each later undo substantial. Never
  // synthesize ledger JSON: only the public writer may create its history.
  const content = "é".repeat(3 * 1024 * 1024);
  await apply("content", [{ type: "add-presentation-node", screenId: "scr_roundtrip",
    presentationId: "pres_desktop", parentId: "node_canvas", node: {
      id: "node_content", type: "TEXT", name: "Content", x: 0, y: 0,
      width: 300, height: 24, children: [], text: content,
    } }]);
  let previous, last;
  for (let index = 1; index <= 7; index++) {
    if (index === 6) previous = revision;
    last = await apply(`edit_${index}`, [{ type: "update-presentation-node",
      screenId: "scr_roundtrip", presentationId: "pres_desktop",
      nodeId: "node_content", changes: { text: content + index } }]);
  }
  const ledgerPath = await batchHistoryPath(path);
  assert.ok((await stat(ledgerPath)).size <= 32 * 1024 * 1024);
  const history = await readBatchHistory(path);
  assert.ok(history.some(entry => entry.baseRevision === previous));
  assert.ok(history.some(entry => entry.batchId === last.batch.batchId));
  const recorded = await readFile(ledgerPath, "utf8");
  const replays = await Promise.all([applyOperationBatch(path, last.batch), applyOperationBatch(path, last.batch)]);
  assert.ok(replays.every(result => result.alreadyApplied));
  assert.equal(await readFile(ledgerPath, "utf8"), recorded);
  assert.equal((await openPackage(path)).revision, last.result.revision);
  const { stdout } = await exec(process.execPath, [cli, "changes", path, "--since", previous, "--json"], { maxBuffer: 1024 * 1024 });
  const changes = JSON.parse(stdout);
  assert.ok(changes.changeCount > 0);
  assert.equal(changes.historyWindow[0].maxBytes, 32 * 1024 * 1024);
  assert.equal(changes.historyWindow[0].retainedBatches, history.length);
  assert.equal(changes.note, undefined, "the retained window has no missing inverse");
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  assert.ok(ledger[last.batch.batchId].result.inverseBatch);
  assert.ok(!Object.hasOwn(ledger[last.batch.batchId].result.guidance.undo.args, "batch"),
    "the cache must store the inverse once, not duplicate it in guidance");
  assert.ok(isDeepStrictEqual(replays[0].guidance.undo.args.batch, last.result.inverseBatch),
    "replay restores the public confirmation without duplicating stored data");
  assert.ok(Object.keys(ledger).length < 8, "oldest records are pruned by bytes, not only count");
});

test("an oversized inverse cannot block a valid save or lose its retry receipt", async context => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-ledger-entry-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "example.smallpen");
  await cp(new URL("fixtures/roundtrip.smallpen", import.meta.url), path, { recursive: true });
  const before = await openPackage(path);
  const content = "é".repeat(17 * 1024 * 1024);
  const created = await applyOperationBatch(path, { batchId: "content", baseRevision: before.revision, operations: [
    { type: "add-presentation-node", screenId: "scr_roundtrip", presentationId: "pres_desktop", parentId: "node_canvas", node: {
      id: "node_content", type: "TEXT", name: "Content", x: 0, y: 0, width: 300, height: 24, children: [], text: content,
    } },
  ] });
  const ledgerPath = await batchHistoryPath(path);
  const batch = { batchId: "oversized", baseRevision: created.revision, operations: [
    { type: "update-presentation-node", screenId: "scr_roundtrip", presentationId: "pres_desktop",
      nodeId: "node_content", changes: { text: "replacement" } },
  ] };
  const written = await applyOperationBatch(path, batch);
  assert.notEqual(written.revision, created.revision);
  assert.equal(written.history.status, "partial");
  assert.equal(written.history.reason, "inverse_exceeds_capacity");
  assert.ok(written.inverseBatch, "the immediate caller still receives its undo batch");
  const saved = await openPackage(path);
  assert.equal(saved.revision, written.revision);
  assert.equal(saved.entries["screens/roundtrip.json"].presentations[0].nodes.node_content.text, "replacement");
  const receipt = JSON.parse(await readFile(ledgerPath, "utf8")).oversized;
  assert.equal(receipt.revision, written.revision);
  assert.equal(receipt.result.inverseBatch, undefined);
  assert.equal(receipt.result.guidance.undo, undefined);
  assert.ok((await stat(ledgerPath)).size <= 32 * 1024 * 1024);
  const replay = await applyOperationBatch(path, batch);
  assert.equal(replay.alreadyApplied, true);
  assert.equal(replay.revision, written.revision);
  assert.equal(replay.history.status, "partial");
  assert.equal((await readBatchHistory(path)).at(-1).history.status, "partial");
  const batchPath = join(root, "retry.json");
  await writeFile(batchPath, JSON.stringify(batch));
  const retry = JSON.parse((await exec(process.execPath, [cli, "advanced", "apply", path, "--batch", batchPath, "--json"])).stdout);
  assert.equal(retry.alreadyApplied, true);
  assert.equal(retry.history.replayRetained, true);
  const current = JSON.parse((await exec(process.execPath, [cli, "changes", path, "--since", written.revision, "--json"])).stdout);
  assert.equal(current.changeCount, 0);
  assert.equal(current.historyWindow[0].incompleteBatches, 1);
  await assert.rejects(exec(process.execPath, [cli, "changes", path, "--since", created.revision, "--json"]),
    error => JSON.parse(error.stdout).error.code === "batch_history_unavailable");
});
