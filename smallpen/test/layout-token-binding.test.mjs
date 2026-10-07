import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { inflateSync } from "node:zlib";

import {
  applyEffectiveTokenBindings,
  listPackageEntries,
  loadPackageFromValues,
  prepareOperationBatch,
  projectComponentVariant,
  projectEffectiveSnapshot,
  projectScreen,
  selectTokenThemes,
  SMALLPEN_FORMAT_CAPABILITIES,
} from "@smallpen/core";
import { createEvidence, openPackage } from "@smallpen/local-package";
import { compilePenpotChanges } from "@smallpen/penpot-adapter";

import { createWebWorkspaceSnapshot } from "../apps/background/src/web-projection.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "variant-acme.smallpen");
const cli = join(here, "..", "apps", "cli", "bin", "smallpen.mjs");
const SCREEN = "scr_home";
const PRESENTATION = "pres_home_mobile";
const ROW = "node_row";
const reference = (assetId = "tok_spacing_md") => ({
  assetId,
  packageId: "pkg_acme",
});

async function layoutValues() {
  const manifest = JSON.parse(
    await readFile(join(fixture, "manifest.json"), "utf8"),
  );
  const values = new Map([["manifest.json", manifest]]);
  for (const entry of listPackageEntries(manifest).entries) {
    values.set(entry, JSON.parse(await readFile(join(fixture, entry), "utf8")));
  }
  const library = values.get("tokens/tokens.json");
  library.sets[0].tokens.find(({ id }) => id === "tok_spacing_md").value = 16;
  library.sets[0].tokens.push({
    description: "",
    id: "tok_spacing_lg",
    name: "spacing.lg",
    type: "spacing",
    value: 48,
  });
  library.sets
    .find(({ id }) => id === "tset_theme_dark")
    .tokens.push({
      description: "",
      id: "tok_spacing_dark_md",
      name: "spacing.md",
      type: "spacing",
      value: 32,
    });
  const row = (id, type, x, y) => ({
    children: ["node_cell_b", "node_cell_a"],
    height: 160,
    id,
    layout: "flex",
    "layout-flex-dir": "row",
    "layout-gap": { columnGap: 3, rowGap: 5 },
    "layout-gap-type": "multiple",
    "layout-padding": { p1: 2, p2: 4, p3: 6, p4: 8 },
    "layout-padding-type": "multiple",
    name: "Token layout",
    tokenBindings: {
      itemSpacing: reference(),
      paddingLeft: reference(),
      paddingTop: reference(),
    },
    type,
    width: 300,
    x,
    y,
  });
  const cells = {
    node_cell_a: {
      children: [],
      fills: [{ color: "#2563eb", type: "solid" }],
      height: 12,
      id: "node_cell_a",
      name: "Blue",
      type: "RECTANGLE",
      width: 20,
      x: 0,
      y: 0,
    },
    node_cell_b: {
      children: [],
      fills: [{ color: "#16a34a", type: "solid" }],
      height: 12,
      id: "node_cell_b",
      name: "Green",
      type: "RECTANGLE",
      width: 20,
      x: 0,
      y: 0,
    },
  };
  const nodes = values.get("screens/first-design.json").presentations[0].nodes;
  nodes.node_home_root.children.push(ROW);
  Object.assign(nodes, cells, { [ROW]: row(ROW, "FRAME", 24, 300) });
  const variant = values.get("components/components.json").componentSets[0]
    .variants[0];
  variant.nodes = {
    ...structuredClone(cells),
    node_button_root: row("node_button_root", "COMPONENT", 0, 0),
  };
  return values;
}

async function layoutPackage() {
  return loadPackageFromValues(
    "memory://layout-tokens.smallpen",
    await layoutValues(),
  );
}

function canonicalRow(snapshot) {
  return snapshot.entries["screens/first-design.json"].presentations[0].nodes[
    ROW
  ];
}

function pngPixel(render, x, y) {
  const chunks = [];
  const bytes = Buffer.from(render.bytes);
  for (let offset = 8; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset);
    if (bytes.toString("ascii", offset + 4, offset + 8) === "IDAT") {
      chunks.push(bytes.subarray(offset + 8, offset + 8 + length));
    }
    offset += length + 12;
  }
  const pixels = inflateSync(Buffer.concat(chunks));
  const offset = y * (render.width * 4 + 1) + 1 + x * 4;
  return [...pixels.subarray(offset, offset + 4)];
}

test("spacing bindings drive screen padding, gaps and pixels in each theme", async () => {
  const light = await layoutPackage();
  const before = structuredClone(canonicalRow(light));
  const dark = selectTokenThemes({ product: light }, ["Theme/Dark"]).product;
  for (const [snapshot, value] of [
    [light, 16],
    [dark, 32],
  ]) {
    const projected = projectScreen(snapshot, SCREEN, {});
    const row = projected.nodes[ROW];
    assert.deepEqual(row["layout-gap"], {
      "column-gap": value,
      "row-gap": value,
    });
    assert.deepEqual(row["layout-padding"], {
      p1: value,
      p2: 4,
      p3: 6,
      p4: value,
    });
    assert.equal(projected.nodes.node_cell_a.x, value);
    assert.equal(projected.nodes.node_cell_a.y, value);
    assert.equal(projected.nodes.node_cell_b.x, value + 20 + value);
    const { render } = await createEvidence(snapshot, {
      scale: 1,
      selector: { screenId: SCREEN, viewFormat: "screenshot" },
    });
    assert.deepEqual(
      pngPixel(render, 24 + value + 1, 300 + value + 1),
      [37, 99, 235, 255],
    );
    assert.deepEqual(
      pngPixel(render, 24 + value + 20 + value + 1, 300 + value + 1),
      [22, 163, 74, 255],
    );
  }
  assert.deepEqual(canonicalRow(light), before);
});

test("component previews and page instances resolve the same layout Tokens", async () => {
  const light = await layoutPackage();
  const dark = selectTokenThemes({ product: light }, ["Theme/Dark"]).product;
  for (const [snapshot, value] of [
    [light, 16],
    [dark, 32],
  ]) {
    const variant = snapshot.domain.componentSets.get("cmp_button").variants[0];
    const nodes = projectComponentVariant(snapshot, variant, {});
    const page = projectScreen(snapshot, SCREEN, {});
    assert.equal(nodes.node_cell_b.x, value * 2 + 20);
    assert.equal(
      page.nodes.node_button_one__node_cell_b.x,
      nodes.node_cell_b.x,
    );
    assert.deepEqual(
      page.nodes.node_button_one["layout-padding"],
      nodes.node_button_root["layout-padding"],
    );
  }
});

test("one-axis gap bindings override itemSpacing regardless of field order", async () => {
  const snapshot = await layoutPackage();
  for (const bindings of [
    { rowGap: reference("tok_spacing_lg"), itemSpacing: reference() },
    { itemSpacing: reference(), rowGap: reference("tok_spacing_lg") },
  ]) {
    const node = applyEffectiveTokenBindings(
      { ...canonicalRow(snapshot), tokenBindings: bindings },
      snapshot,
    );
    assert.deepEqual(node["layout-gap"], { "column-gap": 16, "row-gap": 48 });
    assert.equal(
      SMALLPEN_FORMAT_CAPABILITIES.canonicalPackage.tokenBindingFields.includes(
        "rowGap",
      ),
      true,
    );
    assert.equal(
      SMALLPEN_FORMAT_CAPABILITIES.canonicalPackage.tokenBindingFields.includes(
        "columnGap",
      ),
      true,
    );
  }
  const batch = await prepareOperationBatch(snapshot, {
    baseRevision: snapshot.revision,
    batchId: "axis-binding",
    operations: [
      {
        binding: reference("tok_spacing_lg"),
        field: "columnGap",
        nodeId: ROW,
        screenId: SCREEN,
        type: "set-token-binding",
      },
    ],
  });
  assert.equal(
    projectScreen(batch.snapshot, SCREEN, {}).nodes[ROW]["layout-gap"][
      "column-gap"
    ],
    48,
  );
});

test("column layout uses its row gap and bound spacing follows Penpot's zero floor", async () => {
  const values = await layoutValues();
  const row = values.get("screens/first-design.json").presentations[0].nodes[
    ROW
  ];
  row["layout-flex-dir"] = "column";
  row["layout-gap"] = { columnGap: 3, rowGap: 5, "column-gap": 7 };
  row.tokenBindings.rowGap = reference("tok_spacing_lg");
  const snapshot = await loadPackageFromValues(
    "memory://column-layout.smallpen",
    values,
  );
  const nodes = projectScreen(snapshot, SCREEN, {}).nodes;
  assert.equal(nodes.node_cell_b.y, 16 + 12 + 48);
  assert.equal(nodes.node_cell_b.x, 16);
  const unboundColumn = applyEffectiveTokenBindings(
    {
      ...row,
      tokenBindings: { rowGap: reference("tok_spacing_lg") },
    },
    snapshot,
  );
  assert.deepEqual(unboundColumn["layout-gap"], {
    "column-gap": 7,
    "row-gap": 48,
  });

  values
    .get("tokens/tokens.json")
    .sets[0].tokens.find(({ id }) => id === "tok_spacing_md").value = -8;
  const negative = await loadPackageFromValues(
    "memory://negative-spacing.smallpen",
    values,
  );
  const clamped = projectScreen(negative, SCREEN, {}).nodes;
  assert.equal(clamped.node_cell_a.x, 0);
  assert.equal(clamped.node_cell_a.y, 0);
  assert.equal(clamped.node_cell_b.y, 12 + 48);
});

test("an instance's own layout bindings resolve without losing the source's other sides", async () => {
  const values = await layoutValues();
  const instance = values.get("screens/first-design.json").presentations[0]
    .nodes.node_button_one;
  instance.tokenBindings = {
    columnGap: reference("tok_spacing_lg"),
    paddingRight: reference("tok_spacing_lg"),
  };
  const snapshot = await loadPackageFromValues(
    "memory://instance-layout.smallpen",
    values,
  );
  const view = projectScreen(snapshot, SCREEN, {}).nodes;
  assert.deepEqual(view.node_button_one["layout-gap"], {
    "column-gap": 48,
    "row-gap": 16,
  });
  assert.deepEqual(view.node_button_one["layout-padding"], {
    p1: 16,
    p2: 48,
    p3: 6,
    p4: 16,
  });
  assert.equal(view.node_button_one__node_cell_b.x, 84);
});

async function served(snapshot) {
  const effective = projectEffectiveSnapshot(snapshot, {});
  const web = await createWebWorkspaceSnapshot(effective, {});
  return { ...effective, runtime: web.runtime };
}

function nativeEdit(snapshot, applied, edits = [], nodeId = ROW) {
  return {
    changes: [
      {
        id: snapshot.runtime.nodes[SCREEN][PRESENTATION][nodeId],
        operations: [
          { attr: "applied-tokens", type: "set", val: applied },
          ...edits,
        ],
        "page-id": snapshot.runtime.pages[SCREEN][PRESENTATION],
        type: "mod-obj",
      },
    ],
    commitId: "layout-token-edit",
  };
}

test("detaching one gap axis keeps its shown number and the other axis bound", async () => {
  const canonical = await layoutPackage();
  const current = await served(canonical);
  const batch = compilePenpotChanges(
    current,
    nativeEdit(current, {
      "row-gap": "spacing.md",
      p1: "spacing.md",
      p4: "spacing.md",
    }),
  );
  const detached = (await prepareOperationBatch(canonical, batch)).snapshot;
  assert.deepEqual(canonicalRow(detached).tokenBindings, {
    rowGap: reference(),
    paddingLeft: reference(),
    paddingTop: reference(),
  });
  assert.equal(canonicalRow(detached).appliedTokens, undefined);
  assert.equal(
    projectScreen(detached, SCREEN, {}).nodes[ROW]["layout-gap"]["column-gap"],
    16,
  );
  const dark = selectTokenThemes({ product: detached }, ["Theme/Dark"]).product;
  assert.deepEqual(projectScreen(dark, SCREEN, {}).nodes[ROW]["layout-gap"], {
    "column-gap": 16,
    "row-gap": 32,
  });
});

test("UI detaches an instance's inherited layout Tokens and can bind it again", async () => {
  const canonical = await layoutPackage();
  const current = await served(canonical);
  const detachedBatch = compilePenpotChanges(
    current,
    nativeEdit(current, {}, [], "node_button_one"),
  );
  const detached = (await prepareOperationBatch(canonical, detachedBatch))
    .snapshot;
  const dark = selectTokenThemes({ product: detached }, ["Theme/Dark"]).product;
  const projected = projectScreen(dark, SCREEN, {}).nodes;
  assert.deepEqual(projected.node_button_one["layout-gap"], {
    "column-gap": 16,
    "row-gap": 16,
  });
  assert.deepEqual(projected.node_button_one["layout-padding"], {
    p1: 16,
    p2: 4,
    p3: 6,
    p4: 16,
  });
  assert.deepEqual(projected.node_button_one.tokenBindings, {});
  const reopened = await served(detached);
  const reboundBatch = compilePenpotChanges(
    reopened,
    nativeEdit(
      reopened,
      {
        "row-gap": "spacing.lg",
        "column-gap": "spacing.lg",
      },
      [],
      "node_button_one",
    ),
  );
  const rebound = (await prepareOperationBatch(detached, reboundBatch))
    .snapshot;
  assert.equal(
    projectScreen(rebound, SCREEN, {}).nodes.node_button_one__node_cell_b.x,
    84,
  );
});

test("UI spacing rebinds, removal and manual padding edits round-trip as bindings", async () => {
  const canonical = await layoutPackage();
  const current = await served(canonical);
  const same = compilePenpotChanges(
    current,
    nativeEdit(current, {
      "row-gap": "spacing.md",
      "column-gap": "spacing.md",
      p1: "spacing.md",
      p4: "spacing.md",
    }),
  );
  assert.equal(same.operations.length, 0);
  const batch = compilePenpotChanges(
    current,
    nativeEdit(
      current,
      {
        "row-gap": "spacing.lg",
        "column-gap": "spacing.md",
        p4: "spacing.md",
      },
      [
        {
          attr: "layout-padding",
          type: "set",
          val: { p1: 10, p2: 4, p3: 6, p4: 16 },
        },
      ],
    ),
  );
  const saved = (await prepareOperationBatch(canonical, batch)).snapshot;
  assert.deepEqual(canonicalRow(saved).tokenBindings, {
    rowGap: reference("tok_spacing_lg"),
    columnGap: reference(),
    paddingLeft: reference(),
  });
  assert.equal(canonicalRow(saved).appliedTokens, undefined);
  assert.deepEqual(
    projectScreen(saved, SCREEN, {}).nodes[ROW]["layout-padding"],
    {
      p1: 10,
      p2: 4,
      p3: 6,
      p4: 16,
    },
  );
  const detached = compilePenpotChanges(
    await served(saved),
    nativeEdit(await served(saved), {}),
  );
  const result = (await prepareOperationBatch(saved, detached)).snapshot;
  assert.equal(canonicalRow(result).tokenBindings, undefined);
  assert.deepEqual(projectScreen(result, SCREEN, {}).nodes[ROW]["layout-gap"], {
    "column-gap": 16,
    "row-gap": 48,
  });
});

function runCli(args, cwd) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      cwd,
      env: { ...process.env, LANG: "en_US.UTF-8", LC_ALL: "", LC_MESSAGES: "" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr, stdout }));
  });
}

test("CLI Token edits update layout after reopen and retries keep a small receipt", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-layout-token-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const packagePath = join(root, "acme.smallpen");
  await cp(fixture, packagePath, { recursive: true });
  for (const [entry, value] of await layoutValues()) {
    await writeFile(join(packagePath, entry), JSON.stringify(value));
  }
  const before = await openPackage(packagePath);
  const batchPath = join(root, "spacing.json");
  await writeFile(
    batchPath,
    JSON.stringify({
      baseRevision: before.revision,
      batchId: "spacing-24",
      operations: [
        {
          setId: "tset_base",
          token: {
            id: "tok_spacing_md",
            name: "spacing.md",
            type: "spacing",
            value: 24,
          },
          type: "put-set-token",
        },
      ],
    }),
  );
  const first = await runCli(
    ["advanced", "apply", packagePath, "--batch", batchPath, "--json"],
    root,
  );
  assert.equal(first.code, 0, first.stdout + first.stderr);
  assert.ok(Buffer.byteLength(first.stdout) < 2000);
  const reopened = await openPackage(packagePath);
  const projected = projectScreen(reopened, SCREEN, {});
  assert.equal(projected.nodes.node_cell_a.x, 24);
  assert.equal(projected.nodes.node_cell_b.x, 68);
  assert.deepEqual(canonicalRow(reopened)["layout-gap"], {
    columnGap: 3,
    rowGap: 5,
  });
  const retried = await runCli(
    ["advanced", "apply", packagePath, "--batch", batchPath, "--json"],
    root,
  );
  assert.equal(retried.code, 0, retried.stdout + retried.stderr);
  assert.equal(JSON.parse(retried.stdout).alreadyApplied, true);
  assert.equal((await openPackage(packagePath)).revision, reopened.revision);
});
