// DSP-018: Token Cell editing — variant override via put-token.
// Tests the write path: intent → prepareOperationBatch → canonical state.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  listPackageEntries,
  loadPackageFromValues,
  prepareOperationBatch,
} from "@smallpen/core";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "design-system.smallpen");

async function fixtureValues() {
  const manifest = JSON.parse(
    await readFile(join(fixture, "manifest.json"), "utf8"),
  );
  const { entries } = listPackageEntries(manifest);
  const values = new Map([["manifest.json", manifest]]);
  for (const entry of entries) {
    values.set(entry, JSON.parse(await readFile(join(fixture, entry), "utf8")));
  }
  return values;
}

async function snapshot() {
  return loadPackageFromValues("memory://dsp-edit.smallpen", await fixtureValues());
}

test("DSP-018-A: set-token-value writes base radius 8→12", async () => {
  const before = await snapshot();
  const batch = {
    baseRevision: before.revision,
    batchId: "dsp018a-radius",
    operations: [{
      type: "set-token-value",
      filePath: "tokens/tokens.json",
      path: "base",
      value: 12,
    }],
  };
  const after = await prepareOperationBatch(before, batch);
  const lib = after.snapshot.entries["tokens/tokens.json"];
  const base = lib.sets.find((s) => s.name === "radius/md")
    ?.tokens.find((t) => t.name === "base");
  assert.equal(base?.value, 12);
  const surface = lib.sets.find((s) => s.name === "color/light")
    ?.tokens.find((t) => t.name === "surface");
  assert.equal(surface?.value, "#ffffff");
});

test("DSP-018-A: inverse batch restores original value", async () => {
  const s0 = await snapshot();
  const b1 = {
    baseRevision: s0.revision, batchId: "dsp018-inv-1",
    operations: [{ type: "set-token-value", filePath: "tokens/tokens.json", path: "base", value: 12 }],
  };
  const s1 = await prepareOperationBatch(s0, b1);
  const s2 = await prepareOperationBatch(s1.snapshot, s1.result.inverseBatch);
  const lib = s2.snapshot.entries["tokens/tokens.json"];
  const base = lib.sets.find((s) => s.name === "radius/md")
    ?.tokens.find((t) => t.name === "base");
  assert.equal(base?.value, 8);
});

test("DSP-018-B: alias expression preserved when editing shared target", async () => {
  const s0 = await snapshot();
  const b1 = {
    baseRevision: s0.revision, batchId: "dsp018b-base",
    operations: [{ type: "set-token-value", filePath: "tokens/tokens.json", path: "base", value: 16 }],
  };
  const s1 = await prepareOperationBatch(s0, b1);
  const lib = s1.snapshot.entries["tokens/tokens.json"];
  const alias = lib.sets.find((s) => s.name === "alias/demo")
    ?.tokens.find((t) => t.name === "radius.alias");
  assert.equal(alias?.value, "{base}");
  const base = lib.sets.find((s) => s.name === "radius/md")
    ?.tokens.find((t) => t.name === "base");
  assert.equal(base?.value, 16);
});



test("DSP-019-A: composite typography value edit", async () => {
  const s0 = await snapshot();
  const typoSet = s0.entries["tokens/tokens.json"].sets
    .find((s) => s.name === "typography/md");
  const heading = typoSet?.tokens.find((t) => t.name === "heading");
  assert.ok(heading, "heading token exists");

  const b1 = {
    baseRevision: s0.revision, batchId: "dsp019-typo",
    operations: [{
      type: "set-token-value",
      filePath: "tokens/tokens.json",
      path: "heading",
      value: { ...heading.value, fontSize: 32 },
    }],
  };
  const s1 = await prepareOperationBatch(s0, b1);
  const lib = s1.snapshot.entries["tokens/tokens.json"];
  const updated = lib.sets.find((s) => s.name === "typography/md")
    ?.tokens.find((t) => t.name === "heading");
  assert.equal(updated?.value.fontSize, 32);
});

test("DSP-019-B: spacing token cell edit", async () => {
  const s0 = await snapshot();
  const b1 = {
    baseRevision: s0.revision, batchId: "dsp019-spacing",
    operations: [{ type: "set-token-value", filePath: "tokens/tokens.json", path: "space.medium", value: 12 }],
  };
  const s1 = await prepareOperationBatch(s0, b1);
  const lib = s1.snapshot.entries["tokens/tokens.json"];
  const spacing = lib.sets.find((s) => s.name === "spacing/md")
    ?.tokens.find((t) => t.name === "space.medium");
  assert.equal(spacing?.value, 12);
});
