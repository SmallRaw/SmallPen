// INPUT:  HTML render boundary, real App renderer and exhausted-worker fixture
// OUTPUT: per-page native lifetime and shared-solve parity regressions
// POS:    Prevents long HTML exports from retaining WASM/font state across pages
import assert from "node:assert/strict";
import test from "node:test";
import { defaultTokenWorkspace } from "@smallpen/core";
import { openPackage } from "@smallpen/local-package";
import { selectedDesign } from "../apps/cli/bin/design-output.mjs";
import { renderHtmlReviewPage } from "../apps/cli/bin/html-render.mjs";

// Models a renderer whose native font store fails after its first page.
// A long export must never send its second page into that renderer instance.
const exhaustedWorker = new URL(`data:text/javascript,${encodeURIComponent(`
  import { parentPort, threadId } from 'node:worker_threads';
  let served = 0;
  parentPort.on('message', () => {
    served += 1;
    parentPort.postMessage(served > 1
      ? { error: { code: 'wasm_critical', message: '_store_font' } }
      : { rendered: { served, threadId } });
  });
`)}`);

test("77 HTML pages each finish and terminate their native worker before the next page", async () => {
  const threadIds = new Set();
  const design = { tree: { root: { name: "Font-heavy page" } }, selection: {} };
  for (let index = 0; index < 77; index++) {
    const result = await renderHtmlReviewPage({}, design, { workerUrl: exhaustedWorker });
    assert.equal(result.served, 1);
    assert.ok(!threadIds.has(result.threadId), "no native renderer instance crosses page boundaries");
    threadIds.add(result.threadId);
  }
  assert.equal(threadIds.size, 77);
});

test("isolated native renders keep identical layout, resources and PNG evidence", async () => {
  const product = await openPackage(new URL("fixtures/roundtrip.smallpen", import.meta.url).pathname);
  const workspace = defaultTokenWorkspace({ product });
  const design = selectedDesign(workspace, {});
  const first = await renderHtmlReviewPage(workspace, design);
  const second = await renderHtmlReviewPage(workspace, design);
  assert.equal(first.snapshot.id, second.snapshot.id);
  assert.equal(first.render.resourcesHash, second.render.resourcesHash);
  assert.equal(first.render.renderHash, second.render.renderHash);
  assert.deepEqual(first.snapshot.nodes, second.snapshot.nodes);
  assert.match(first.specification, new RegExp(first.snapshot.id));
  assert.match(first.wireframe, new RegExp(first.snapshot.id));
  assert.equal(first.snapshot.revision, product.revision);
});
