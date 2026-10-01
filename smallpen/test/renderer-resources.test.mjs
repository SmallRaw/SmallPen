import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { promisify } from "node:util";

import opentype from "opentype.js";

import { listPackageEntries, loadPackageFromValues } from "@smallpen/core";
import { createEvidence } from "@smallpen/local-package";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "roundtrip.smallpen");
const words = "The quick brown fox jumps over the lazy dog ";

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

function longText(length) {
  return words.repeat(Math.ceil(length / words.length)).slice(0, length);
}

function textNode(text, overrides = {}) {
  return {
    children: [],
    fills: [{ color: "#111827", type: "solid" }],
    height: 400,
    id: "node_rectangle",
    name: "Long text",
    text,
    textStyle: {
      fontFamily: "sourcesanspro",
      fontId: "sourcesanspro",
      fontSize: 14,
      fontStyle: "normal",
      fontWeight: 400,
      letterSpacing: 0,
      lineHeight: 1.2,
      textAlign: "left",
      verticalAlign: "top",
    },
    type: "TEXT",
    width: 600,
    x: 80,
    y: 96,
    ...overrides,
  };
}

function richBlocks(text) {
  return [
    {
      runs: [
        { fills: [{ color: "#dc2626", type: "solid" }], text: text.slice(0, 10) },
        { text: text.slice(10) },
      ],
    },
  ];
}

async function render(nodes, scale = 1) {
  const values = await fixtureValues();
  Object.assign(values.get("screens/roundtrip.json").presentations[0].nodes, nodes);
  const product = await loadPackageFromValues(
    "memory://renderer-resources.smallpen",
    values,
  );
  return createEvidence(product, {
    scale,
    selector: { viewFormat: "screenshot" },
  });
}

async function counting(target, method, action) {
  const original = target[method];
  let calls = 0;
  target[method] = function counted(...args) {
    calls += 1;
    return original.apply(this, args);
  };
  try {
    await action();
  } finally {
    target[method] = original;
  }
  return calls;
}

for (const rich of [false, true]) {
  const kind = rich ? "rich" : "plain";

  test(`${kind} text builds outlines only for glyphs that can reach the canvas`, async () => {
    const text = longText(50_000);
    const node = textNode(text, {
      growType: "auto-width",
      ...(rich ? { textBlocks: richBlocks(text) } : {}),
    });
    const outlines = await counting(
      opentype.Glyph.prototype,
      "getPath",
      () => render({ node_rectangle: node }, 0.1),
    );
    // The 800px canvas shows about a hundred glyphs of one 14px line.
    assert.ok(outlines > 0, "visible glyphs still draw");
    assert.ok(outlines < 1_000, `outlined ${outlines} of ${text.length} glyphs`);
  });

  test(`${kind} text wrapping measures each glyph a bounded number of times`, async () => {
    const text = longText(20_000);
    const node = textNode(text, {
      textStyle: { ...textNode("").textStyle, fontSize: 2 },
      width: 8_000,
      ...(rich ? { textBlocks: richBlocks(text) } : {}),
    });
    const kerning = await counting(
      opentype.Font.prototype,
      "getKerningValue",
      () => render({ node_rectangle: node }, 0.1),
    );
    assert.ok(
      kerning < text.length * 4,
      `kerned ${kerning} pairs for ${text.length} characters`,
    );
  });
}

test("long text draws the same pixels as its visible prefix", async () => {
  const visible = longText(300);
  const prefix = await render({
    node_rectangle: textNode(visible, { growType: "auto-width" }),
  });
  const full = await render({
    node_rectangle: textNode(visible + longText(20_000), {
      growType: "auto-width",
    }),
  });
  assert.equal(full.render.renderHash, prefix.render.renderHash);
});

test("a 200k character text renders inside a 192MB heap", async () => {
  const script = `
    import { readFile } from "node:fs/promises";
    import { join } from "node:path";
    const { listPackageEntries, loadPackageFromValues } = await import(${JSON.stringify(import.meta.resolve("@smallpen/core"))});
    const { createEvidence } = await import(${JSON.stringify(import.meta.resolve("@smallpen/local-package"))});
    const fixture = ${JSON.stringify(fixture)};
    const manifest = JSON.parse(await readFile(join(fixture, "manifest.json"), "utf8"));
    const values = new Map([["manifest.json", manifest]]);
    for (const entry of listPackageEntries(manifest).entries) {
      values.set(entry, JSON.parse(await readFile(join(fixture, entry), "utf8")));
    }
    const nodes = values.get("screens/roundtrip.json").presentations[0].nodes;
    nodes.node_rectangle = ${JSON.stringify(textNode("", { growType: "auto-width" }))};
    nodes.node_rectangle.text = ${JSON.stringify(words)}.repeat(5000).slice(0, 200000);
    const product = await loadPackageFromValues("memory://heap.smallpen", values);
    const { render } = await createEvidence(product, {
      scale: 0.1,
      selector: { viewFormat: "screenshot" },
    });
    process.stdout.write(String(render.width));
  `;
  const { stdout } = await promisify(execFile)(
    process.execPath,
    ["--max-old-space-size=192", "--input-type=module", "-e", script],
    { maxBuffer: 1024 * 1024 },
  );
  assert.equal(stdout, "80");
});

test("an unsupported paint color is reported once, not once per pixel", async () => {
  const { render: result } = await render({
    node_rectangle: {
      children: [],
      fills: [{ color: "hsl(0, 0%, 0%)", type: "solid" }],
      height: 120,
      id: "node_rectangle",
      name: "Odd color",
      type: "RECTANGLE",
      width: 240,
      x: 80,
      y: 96,
    },
  });
  assert.deepEqual(
    result.diagnostics.map(({ code }) => code),
    ["unsupported_render_color"],
  );
});

test("layer blur buffers cover the blurred subtree, not the whole canvas", async () => {
  const Original = globalThis.Float32Array;
  let largest = 0;
  globalThis.Float32Array = class extends Original {
    constructor(...args) {
      super(...args);
      largest = Math.max(largest, this.length);
    }
  };
  let result;
  try {
    result = await render(
      {
        node_rectangle: {
          blur: { type: "layer-blur", value: 4 },
          children: [],
          fills: [{ color: "#2563eb", type: "solid" }],
          height: 20,
          id: "node_rectangle",
          name: "Blurred icon",
          type: "RECTANGLE",
          width: 20,
          x: 80,
          y: 96,
        },
      },
      2,
    );
  } finally {
    globalThis.Float32Array = Original;
  }
  const canvas = result.render.width * result.render.height * 4;
  // 40px of ink plus three box radii (8px) on each side, four channels.
  assert.ok(largest <= (40 + 2 * 25) ** 2 * 4, `allocated ${largest} of ${canvas}`);
});
