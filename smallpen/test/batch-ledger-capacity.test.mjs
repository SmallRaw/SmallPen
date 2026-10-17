import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
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
  assert.ok(Object.keys(ledger).length < 8, "oldest records are pruned by bytes, not only count");
});

test("one oversized undo record is refused before the design or history changes", async context => {
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
  const recorded = await readFile(ledgerPath, "utf8");
  await assert.rejects(applyOperationBatch(path, { batchId: "oversized", baseRevision: created.revision, operations: [
    { type: "update-presentation-node", screenId: "scr_roundtrip", presentationId: "pres_desktop",
      nodeId: "node_content", changes: { text: "replacement" } },
  ] }), error => error.code === "batch_history_entry_too_large");
  assert.equal((await openPackage(path)).revision, created.revision);
  assert.equal(await readFile(ledgerPath, "utf8"), recorded);
});
