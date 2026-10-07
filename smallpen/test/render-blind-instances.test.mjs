// A resized Instance found wrong by the Flowboard blind test: its children
// kept their Component positions and sizes whatever their constraints.
// Expected values are what Penpot itself commits when the same copy is
// resized from 100x60 to 200x100 in the editor (common/geom/shapes/
// constraints.cljc), and its flex layout for a layout root.
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { inflateSync } from "node:zlib";

import {
  listPackageEntries,
  loadPackageFromValues,
  projectScreen,
} from "@smallpen/core";
import { createEvidence } from "@smallpen/local-package";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "roundtrip.smallpen");

function rect(id, box, extra = {}) {
  return {
    children: [],
    fills: [{ color: "#2563eb", type: "solid" }],
    id,
    name: id,
    type: "RECTANGLE",
    ...box,
    ...extra,
  };
}

// The constraint probe Component: one child per constraint, 100x60.
function probeNodes() {
  const nodes = {
    node_left: rect("node_left", { height: 10, width: 20, x: 10, y: 6 }),
    node_right: rect("node_right", { height: 10, width: 20, x: 70, y: 6 }, {
      "constraints-h": "right",
    }),
    node_lr: rect("node_lr", { height: 6, width: 80, x: 10, y: 20 }, {
      "constraints-h": "leftright",
    }),
    node_center: rect("node_center", { height: 8, width: 20, x: 40, y: 30 }, {
      "constraints-h": "center",
      "constraints-v": "center",
    }),
    node_scale: rect("node_scale", { height: 8, width: 30, x: 10, y: 42 }, {
      "constraints-h": "scale",
      "constraints-v": "scale",
    }),
    node_corner: rect("node_corner", { height: 10, width: 10, x: 80, y: 44 }, {
      "constraints-h": "right",
      "constraints-v": "bottom",
    }),
    node_tb: rect("node_tb", { height: 14, width: 6, x: 50, y: 42 }, {
      "constraints-v": "topbottom",
    }),
    node_box: {
      children: ["node_box_dot"],
      "constraints-h": "leftright",
      fills: [],
      height: 10,
      id: "node_box",
      name: "box",
      type: "FRAME",
      width: 40,
      x: 50,
      y: 2,
    },
    node_box_dot: rect("node_box_dot", { height: 4, width: 4, x: 30, y: 2 }, {
      "constraints-h": "right",
    }),
  };
  return {
    node_root: {
      children: Object.keys(nodes).filter((id) => id !== "node_box_dot"),
      fills: [{ color: "#f1f5f9", type: "solid" }],
      height: 60,
      id: "node_root",
      name: "Probe",
      type: "COMPONENT",
      width: 100,
      x: 0,
      y: 0,
    },
    ...nodes,
  };
}

function flexNodes() {
  return {
    node_row: {
      children: ["node_fill", "node_fixed"],
      fills: [],
      height: 20,
      id: "node_row",
      layout: "flex",
      "layout-flex-dir": "row",
      name: "Row",
      type: "COMPONENT",
      width: 100,
      x: 0,
      y: 0,
    },
    node_fixed: rect("node_fixed", { height: 20, width: 20, x: 0, y: 0 }),
    node_fill: rect("node_fill", { height: 20, width: 80, x: 20, y: 0 }, {
      "layout-item-h-sizing": "fill",
    }),
  };
}

async function snapshotWith(instances, extraNodes = {}) {
  const manifest = JSON.parse(await readFile(join(fixture, "manifest.json"), "utf8"));
  const values = new Map([["manifest.json", manifest]]);
  for (const entry of listPackageEntries(manifest).entries) {
    values.set(entry, JSON.parse(await readFile(join(fixture, entry), "utf8")));
  }
  manifest.entries.components = ["components/probe.json"];
  const axes = [{ domain: ["base"], id: "axis_kind", name: "Kind", role: "configuration" }];
  values.set("components/probe.json", {
    componentSets: [
      ["cmp_probe", probeNodes(), "node_root"],
      ["cmp_row", flexNodes(), "node_row"],
    ].map(([id, nodes, rootId]) => ({
      axes,
      category: "Probes",
      description: id,
      id,
      name: id,
      variants: [{ id: `var_${id}`, nodes, rootId, selection: { axis_kind: "base" } }],
      visibility: "public",
    })),
  });
  const nodes = values.get("screens/roundtrip.json").presentations[0].nodes;
  delete nodes.node_rectangle;
  nodes.node_canvas.children = [];
  for (const [id, component, box] of instances) {
    nodes[id] = {
      children: [],
      id,
      instance: {
        component: { assetId: component, packageId: "pkg_roundtrip" },
        overrides: {},
        variant: { axis_kind: "base" },
      },
      name: id,
      type: "INSTANCE",
      ...box,
    };
    nodes.node_canvas.children.push(id);
  }
  Object.assign(nodes, extraNodes);
  nodes.node_canvas.children.push(...Object.keys(extraNodes).filter((id) => !id.includes("child")));
  return loadPackageFromValues("memory://render-blind-instances.smallpen", values);
}

function box(node) {
  return [node.x, node.y, node.width, node.height].map((value) => Math.round(value * 1000) / 1000);
}

test("a resized Instance moves and resizes its children by their constraints", async () => {
  const snapshot = await snapshotWith([
    ["node_same", "cmp_probe", { height: 60, width: 100, x: 20, y: 20 }],
    ["node_grown", "cmp_probe", { height: 100, width: 200, x: 20, y: 120 }],
  ]);
  const { nodes } = projectScreen(snapshot, "scr_roundtrip");
  const child = (instance, source) => box(nodes[`${instance}__${source}`]);
  // The Component size projects the source unchanged.
  assert.deepEqual(child("node_same", "node_right"), [70, 6, 20, 10]);
  // Penpot's own commit for the 100x60 → 200x100 resize, parent-relative.
  assert.deepEqual(child("node_grown", "node_right"), [170, 6, 20, 10]);
  assert.deepEqual(child("node_grown", "node_lr"), [10, 20, 180, 6]);
  assert.deepEqual(child("node_grown", "node_center"), [90, 50, 20, 8]);
  assert.deepEqual(child("node_grown", "node_scale"), [20, 70, 60, 13.333]);
  assert.deepEqual(child("node_grown", "node_corner"), [180, 84, 10, 10]);
  assert.deepEqual(child("node_grown", "node_tb"), [50, 42, 6, 54]);
  // Without constraints a board's child pins to its left and top.
  assert.deepEqual(child("node_grown", "node_left"), [10, 6, 20, 10]);
  // A child board that grows passes the change on to its own children.
  assert.deepEqual(child("node_grown", "node_box"), [50, 2, 140, 10]);
  assert.deepEqual(child("node_grown", "node_box_dot"), [130, 2, 4, 4]);
});

test("a resized Instance of a flex Component lays its children out again", async () => {
  const snapshot = await snapshotWith([
    ["node_row_copy", "cmp_row", { height: 20, width: 200, x: 20, y: 20 }],
  ]);
  const { nodes } = projectScreen(snapshot, "scr_roundtrip");
  assert.deepEqual(box(nodes.node_row_copy__node_fill), [20, 0, 180, 20]);
  assert.deepEqual(box(nodes.node_row_copy__node_fixed), [0, 0, 20, 20]);
});

test("boards clip their children unless they show their content", async () => {
  const overflowing = (id, extra) => ({
    [id]: {
      children: [`${id}_child`],
      fills: [],
      height: 40,
      id,
      name: id,
      type: "FRAME",
      width: 40,
      x: id.endsWith("shown") ? 200 : 100,
      y: 100,
      ...extra,
    },
    [`${id}_child`]: rect(`${id}_child`, { height: 20, width: 80, x: 10, y: 10 }),
  });
  const snapshot = await snapshotWith([
    // Shrunk below its Component size, the copy clips what no longer fits.
    ["node_small", "cmp_probe", { height: 40, width: 60, x: 20, y: 300 }],
  ], {
    ...overflowing("node_clipped", {}),
    ...overflowing("node_shown", { "show-content": true }),
  });
  const evidence = await createEvidence(snapshot, {
    scale: 1,
    selector: { viewFormat: "screenshot" },
  });
  const { bytes, width } = evidence.render;
  const chunks = [];
  const buffer = Buffer.from(bytes);
  for (let offset = 8; offset < buffer.length; ) {
    const length = buffer.readUInt32BE(offset);
    if (buffer.toString("ascii", offset + 4, offset + 8) === "IDAT") {
      chunks.push(buffer.subarray(offset + 8, offset + 8 + length));
    }
    offset += length + 12;
  }
  const pixels = inflateSync(Buffer.concat(chunks));
  const pixel = (x, y) => {
    const offset = y * (width * 4 + 1) + 1 + x * 4;
    return [pixels[offset], pixels[offset + 1], pixels[offset + 2]];
  };
  const blue = [37, 99, 235];
  const background = [244, 244, 245];
  assert.deepEqual(pixel(120, 120), blue, "inside the clipping frame");
  assert.deepEqual(pixel(160, 120), background, "clipped past the frame");
  assert.deepEqual(pixel(260, 120), blue, "a frame that shows its content");
  // The 6-wide topbottom child ends up at y 42..48 of the 40-high copy.
  assert.deepEqual(pixel(20 + 30 + 3, 300 + 45), background, "clipped by the copy");
});

test("a missing variant draws the closest one and names the Axis value no variant selects", async () => {
  const snapshot = await snapshotWith([
    ["node_bad", "cmp_probe", { height: 60, width: 100, x: 20, y: 20 }],
  ]);
  const nodes = snapshot.entries["screens/roundtrip.json"].presentations[0].nodes;
  nodes.node_bad.instance.variant = { axis_kind: "huge" };
  const projection = projectScreen(snapshot, "scr_roundtrip");
  assert.equal(projection.nodes.node_bad.type, "INSTANCE");
  const [diagnostic] = projection.diagnostics;
  assert.equal(diagnostic.code, "stale_instance_variant");
  assert.equal(diagnostic.instanceId, "node_bad");
  // Named for the agent: the copy, its component, the value it lost and the
  // variant it is drawn with meanwhile.
  assert.match(diagnostic.message, /uses .+ with Kind=huge, which it no longer has; it is drawn as Kind=base/);
});
