import assert from "node:assert/strict";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { get as httpGet } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

import { openPackage } from "@smallpen/local-package";
import { serveLocalPackage } from "@smallpen/background";
import { createWebWorkspaceSnapshot } from "../apps/background/src/web-projection.mjs";

const example = fileURLToPath(
  new URL("../examples/common-components.smallpen", import.meta.url),
);

async function served(context) {
  const parent = await mkdtemp(join(tmpdir(), "smallpen-ds-refs-"));
  const packagePath = join(parent, "common-components.smallpen");
  await cp(example, packagePath, { recursive: true });
  const service = await serveLocalPackage({ packagePath, port: 0 });
  context.after(async () => {
    await service.close();
    await rm(parent, { force: true, recursive: true });
  });
  return { packagePath, service };
}

// The Web's merge of the compact wire form ("compact-1",
// web-projection.mjs compactDesignSystemRefs) back into full sources.
function expandDesignSystemRefs(refs) {
  const {
    componentAxes,
    componentBindings,
    format: _format,
    ...rest
  } = refs;
  return {
    ...rest,
    componentSamples: refs.componentSamples.map((compact) => {
      const { ownerPackageId, sources, ...sample } = compact;
      sample.axes = componentAxes[sample.componentSetId];
      sample.sources = Object.fromEntries(
        Object.entries(sources).map(([nodeId, item]) => [
          nodeId,
          {
            kind: "component-sample",
            componentId: sample.componentSetId,
            variantId: sample.variantId,
            ownerPackageId,
            nodeId: item.nodeId ?? nodeId,
            displayNodeId: nodeId,
            combinationId: sample.combinationId,
            combinationLabel: sample.combinationLabel,
            ...(sample.allCombinations ? { allCombinations: true } : {}),
            familyName: sample.familyName,
            selection: sample.selection,
            occurrencePath: item.occurrence ? nodeId : null,
            ...(item.occurrence
              ? item.overrideNodeId === undefined
                ? {}
                : { overrideNodeId: item.overrideNodeId }
              : { overrideNodeId: null }),
            bindings: Object.fromEntries(
              Object.entries(item.bindings ?? {}).map(([field, index]) => [
                field,
                componentBindings[index],
              ]),
            ),
          },
        ]),
      );
      return sample;
    }),
  };
}

const json = (url) =>
  fetch(url).then(async (response) => ({
    body: await response.json(),
    status: response.status,
  }));

test("the workspace leaves the Design System page data out and the page fetches it on its own", async (context) => {
  const { packagePath, service } = await served(context);
  const workspace = (await json(`${service.url}/v1/workspace`)).body;
  assert.equal(workspace.runtime.designSystemRefs, undefined);
  assert.equal(workspace.runtime.reverseDesignSystem, undefined);
  assert.equal(workspace.runtime.designSystemRefsDeferred, true);
  // The ids the page is drawn with stay in the workspace.
  assert.equal(typeof workspace.runtime.designSystemPage, "string");
  assert.equal(typeof workspace.runtime.designSystem.board, "string");

  const fetched = await json(
    `${service.url}/v1/design-system-refs?revision=${workspace.revision}`,
  );
  assert.equal(fetched.status, 200);
  assert.equal(fetched.body.revision, workspace.revision);
  assert.equal(fetched.body.combinationId, null);
  // The same data the workspace used to carry, Instances in the Web form,
  // with each sample node's source reduced to what is its own.
  const snapshot = await openPackage(packagePath);
  const web = await createWebWorkspaceSnapshot(snapshot);
  const wire = fetched.body.designSystemRefs;
  assert.equal(wire.format, "compact-1");
  assert.deepEqual(
    expandDesignSystemRefs(wire),
    JSON.parse(JSON.stringify(web.runtime.designSystemRefs)),
  );
  const full = JSON.stringify(web.runtime.designSystemRefs).length;
  assert.ok(JSON.stringify(wire).length < full * 0.6);
  const compactDialog = wire.componentSamples.find((sample) => sample.familyName === "Dialog");
  assert.ok(Object.values(compactDialog.sources).every((item) => !("kind" in item) && !("selection" in item)));
  // Adapting the samples for the Web leaves the core samples as they are.
  const dialog = snapshot.runtime.designSystemRefs.componentSamples.find(
    (sample) => sample.familyName === "Dialog",
  );
  const instance = Object.values(dialog.nodes).find((node) => node.componentRef);
  assert.ok(instance, "core sample keeps its Instance reference");
  assert.equal((await json(`${service.url}/v1/design-system-refs`)).status, 200);
});

test("the page data of one combination keeps its own and the all-theme items", async (context) => {
  const { service } = await served(context);
  const all = (await json(`${service.url}/v1/design-system-refs`)).body
    .designSystemRefs;
  const [light, dark] = all.combinations;
  assert.ok(light && dark);
  const one = await json(
    `${service.url}/v1/design-system-refs?combination=${encodeURIComponent(light.id)}`,
  );
  assert.equal(one.status, 200);
  assert.equal(one.body.combinationId, light.id);
  const refs = one.body.designSystemRefs;
  assert.ok(refs.componentSamples.length > 0);
  assert.ok(
    refs.componentSamples.every(
      (sample) => sample.combinationId === light.id || sample.allCombinations,
    ),
  );
  assert.equal(
    refs.componentSamples.length,
    all.componentSamples.filter(
      (sample) => sample.combinationId !== dark.id,
    ).length,
  );
  assert.ok(
    Object.values(refs.specimens).every(
      (ref) => ref.combinationId === light.id || ref.combinationId === null,
    ),
  );
  for (const keys of Object.values(refs.specimenKeysByToken)) {
    assert.ok(keys.every((key) => refs.specimens[key]));
  }
  const unknown = await json(
    `${service.url}/v1/design-system-refs?combination=theme_missing`,
  );
  assert.equal(unknown.status, 404);
  assert.equal(unknown.body.error.code, "unknown_design_system_combination");
});

test("page data for an older revision is refused", async (context) => {
  const { service } = await served(context);
  const stale = await json(`${service.url}/v1/design-system-refs?revision=old`);
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, "stale_revision");
});

test("JSON answers are compressed for clients that accept it", async (context) => {
  const { service } = await served(context);
  const raw = (path, headers = {}) =>
    new Promise((resolve, reject) => {
      const url = new URL(`${service.url}${path}`);
      const request = httpGet(url, { headers }, (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({ body: Buffer.concat(chunks), headers: response.headers }),
        );
      });
      request.once("error", reject);
    });
  const plain = await raw("/v1/design-system-refs");
  assert.equal(plain.headers["content-encoding"], undefined);
  const text = plain.body.toString("utf8");
  for (const [encoding, decode] of [
    ["br", brotliDecompressSync],
    ["gzip", gunzipSync],
  ]) {
    for (const path of ["/v1/design-system-refs", "/v1/workspace"]) {
      const encoded = await raw(path, { "accept-encoding": `${encoding}, identity` });
      assert.equal(encoded.headers["content-encoding"], encoding, path);
      assert.match(encoded.headers.vary, /accept-encoding/);
      const decoded = decode(encoded.body).toString("utf8");
      if (path === "/v1/design-system-refs") {
        assert.equal(decoded, text);
        assert.ok(encoded.body.length < text.length / 4);
      } else {
        assert.equal(JSON.parse(decoded).runtime.designSystemRefsDeferred, true);
      }
    }
  }
  const refused = await raw("/v1/design-system-refs", {
    "accept-encoding": "br;q=0, gzip;q=0",
  });
  assert.equal(refused.headers["content-encoding"], undefined);
  assert.equal(refused.body.toString("utf8"), text);
});

test("the page data carries the page tree in the asked language, indexing the samples it is sent with", async (context) => {
  const { service } = await served(context);
  const zh = (await json(`${service.url}/v1/design-system-refs?locale=zh_cn`)).body;
  const en = (await json(`${service.url}/v1/design-system-refs`)).body;
  const texts = (page) => Object.values(page.nodes).map((node) => node.text).filter(Boolean);
  assert.ok(texts(zh.designSystemPage).includes("设计系统"));
  assert.ok(texts(en.designSystemPage).includes("Design System"));
  const [, dark] = en.designSystemRefs.combinations;
  const one = (await json(`${service.url}/v1/design-system-refs?combination=${encodeURIComponent(dark.id)}`)).body;
  for (const body of [en, one]) {
    const placeholders = Object.values(body.designSystemPage.nodes).filter(
      (node) => node.designSystem.role === "component-sample",
    );
    assert.ok(placeholders.length > 0);
    for (const node of placeholders) {
      assert.ok(body.designSystemRefs.componentSamples[node.designSystem.sample], "sample index is in range");
    }
    for (const node of Object.values(body.designSystemPage.nodes)) {
      if (node.designSystem.role !== "token-cell") continue;
      assert.ok(body.designSystemRefs.specimens[node.designSystem.specimen], "specimen key is sent");
    }
  }
});
