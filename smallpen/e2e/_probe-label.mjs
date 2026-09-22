import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { openPackage } from "@smallpen/local-package";
import { compilePenpotChanges } from "@smallpen/penpot-adapter";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const scratch = await mkdtemp(join(tmpdir(), "dse-label-probe-"));
const target = join(scratch, "design-system.smallpen");
const { cp } = await import("node:fs/promises");
await cp(join(root, "test/fixtures/design-system.smallpen"), target, { recursive: true });
const manifestPath = join(target, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
delete manifest.libraries;
await writeFile2(manifestPath, JSON.stringify(manifest, null, 2));
async function writeFile2(p, v) { const { writeFile } = await import("node:fs/promises"); await writeFile(p, v); }

const snapshot = await openPackage(target);
// find the sample label runtime id: the TEXT component node
const sample = snapshot.runtime.designSystemRefs.componentSample;
const setEntry = snapshot.entries[snapshot.manifest.entries.components[0]];
const componentSet = Array.isArray(setEntry?.componentSets) ? setEntry.componentSets[0] : setEntry;
const variant = componentSet.variants.find((v) => v.id === sample.variantId);
const labelNode = Object.values(variant.nodes).find((n) => n.type === "TEXT");
const labelRuntimeId =
  snapshot.runtime.componentNodes[sample.componentSetId][sample.variantId][labelNode.id];
console.log("label runtime:", labelRuntimeId);

const commit = {
  changes: [
    {
      type: "mod-obj",
      id: labelRuntimeId,
      "page-id": snapshot.runtime.designSystemPage,
      operations: [
        {
          type: "set",
          attr: "fills",
          val: [{ "fill-color": "#22d3ee", "fill-opacity": 1 }],
        },
      ],
    },
  ],
  commitId: "probe-label-fill",
};
try {
  const batch = compilePenpotChanges(snapshot, commit);
  console.log("OPS:", JSON.stringify(batch.operations, null, 1).slice(0, 800));
} catch (error) {
  console.log("COMPILE FAIL:", error.code, error.message);
}
await rm(scratch, { recursive: true, force: true });
