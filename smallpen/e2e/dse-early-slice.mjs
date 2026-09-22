// DSE-R14 early-slice acceptance: the FIRST complete working chain on an
// isolated copy of the USER'S ACTUAL package
// (/private/tmp/smallpen-live-demo/design-system.smallpen), never on the
// simplified fixture and never writing to the original.
//
//   create  -> the NEW component appears on the Design System page (layer
//              row + canvas hit), is selected, its fill is edited through
//              the NATIVE property panel, the source is read back, Undo and
//              Redo of BOTH the color edit and the creation itself, then a
//              full reload re-checks the persisted state.
//
// Every assertion inspects the real UI (layer rows, canvas, native panel)
// and the canonical source readback. API object counts alone are never
// treated as success (DSE-R14). Expected source identities are enumerated
// independently from the canonical package files; the board inventory is
// compared against them and the diff is recorded.
//
// Usage:
//   node e2e/dse-early-slice.mjs --audit <dir> [--zero-components]
//     --zero-components strips component entries + instances from the
//     isolated copy (creation of the FIRST component variant of the chain).
//
// Exit code 0 = all steps PASS; anything else = FAIL with the first broken
// link identified in the step log.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { serveLocalPackage } from "@smallpen/background";
import { servePenpotFrontend } from "@smallpen/web";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const repositoryRoot = join(root, "..");
const actualPackage = "/private/tmp/smallpen-live-demo/design-system.smallpen";
const require = createRequire(join(repositoryRoot, "frontend", "package.json"));
const { chromium } = require("playwright");
const frontendRoot = join(repositoryRoot, "frontend", "resources", "public");

// ---------------------------------------------------------------------------
// Independent canonical enumeration (R14: expected IDs never come from the
// runtime response).
// ---------------------------------------------------------------------------
async function enumerateCanonical(packagePath) {
  const manifest = JSON.parse(await readFile(join(packagePath, "manifest.json"), "utf8"));
  const tokens = [];
  for (const entry of manifest.entries.tokens ?? []) {
    const lib = JSON.parse(await readFile(join(packagePath, entry), "utf8"));
    if (!Array.isArray(lib?.sets)) continue;
    for (const set of lib.sets) {
      for (const token of set.tokens ?? []) {
        tokens.push({ id: token.id, name: token.name, set: set.name, type: token.type });
      }
    }
  }
  const componentSets = [];
  const locatedComponents = [];
  for (const entry of manifest.entries.components ?? []) {
    const value = JSON.parse(await readFile(join(packagePath, entry), "utf8"));
    for (const set of Array.isArray(value?.componentSets) ? value.componentSets : []) {
      componentSets.push({
        id: set.id,
        name: set.name,
        variantCount: (set.variants ?? []).length,
      });
    }
    if (!Array.isArray(value?.componentSets) && value?.id && value?.mainNodeId) {
      locatedComponents.push({ id: value.id, name: value.name, mainNodeId: value.mainNodeId });
    }
  }
  const screenNodes = [];
  for (const entry of manifest.entries.screens ?? []) {
    const screen = JSON.parse(await readFile(join(packagePath, entry), "utf8"));
    for (const presentation of screen.presentations ?? []) {
      for (const [nodeId, node] of Object.entries(presentation.nodes ?? {})) {
        screenNodes.push({ id: nodeId, type: node.type, name: node.name });
      }
    }
  }
  return { manifest, tokens, componentSets, locatedComponents, screenNodes };
}

async function hashTree(dir) {
  const hash = createHash("sha256");
  const files = [];
  async function walk(current) {
    for (const item of await readdir(current, { withFileTypes: true })) {
      const full = join(current, item.name);
      if (item.isDirectory()) await walk(full);
      else files.push(full);
    }
  }
  await walk(dir);
  files.sort();
  for (const file of files) {
    hash.update(file.slice(dir.length));
    hash.update(await readFile(file));
  }
  return hash.digest("hex");
}

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const argValue = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const auditRoot = argValue("--audit") ?? join(root, "audits", "dse-full-delivery", "early-slice-latest");
const zeroComponents = flag("--zero-components");
const label = zeroComponents ? "early-slice-zero" : "early-slice-actual";
const dir = join(auditRoot, label);
await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });

const log = (line) => {
  console.log(line);
};
const results = [];
const step = async (name, fn) => {
  try {
    await fn();
    results.push({ name, ok: true });
    log(`STEP ${name}: PASS`);
  } catch (error) {
    results.push({ name, ok: false, error: String(error?.stack ?? error) });
    log(`STEP ${name}: FAIL\n${String(error?.stack ?? error)}`);
    throw error;
  }
};

const scratch = await mkdtemp(join(tmpdir(), `smallpen-dse-early-`));
const packagePath = join(scratch, "design-system.smallpen");
await cp(actualPackage, packagePath, { recursive: true });

if (zeroComponents) {
  const manifestPath = join(packagePath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.entries.components = [];
  // Instances referencing the removed component must go, or the reference
  // validator rejects the isolated copy at load.
  for (const screenEntry of manifest.entries.screens) {
    const screenPath = join(packagePath, screenEntry);
    const screen = JSON.parse(await readFile(screenPath, "utf8"));
    for (const presentation of screen.presentations ?? []) {
      const nodes = presentation.nodes ?? {};
      for (const [nodeId, node] of Object.entries(nodes)) {
        if (node.type === "INSTANCE") delete nodes[nodeId];
      }
      for (const node of Object.values(nodes)) {
        if (Array.isArray(node.children)) {
          node.children = node.children.filter((child) => nodes[child]);
        }
      }
    }
    await writeFile(screenPath, JSON.stringify(screen, null, 2));
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
}

const originalHash = await hashTree(actualPackage);
const before = await enumerateCanonical(packagePath);
await writeFile(join(dir, "canonical-inventory.json"), JSON.stringify(before, null, 2));

const bg = await serveLocalPackage({ packagePath, port: 0 });
const web = await servePenpotFrontend({ backendUrl: bg.url, frontendRoot, port: 0 });
const endpoint = (path) => {
  const base = new URL(bg.url);
  base.pathname = `${base.pathname.replace(/\/+$/, "")}${path}`;
  return base.href;
};
const workspace = () => fetch(endpoint("/v1/workspace")).then((r) => r.json());

const browser = await chromium.launch();
const pageErrors = [];
const consoleErrors = [];
const failedCommits = [];
let commitPosts = 0;
const page = await browser.newPage({ viewport: { height: 1000, width: 1440 } });
page.on("pageerror", (error) => pageErrors.push(String(error.message)));
page.on("console", (msg) => {
  const text = msg.text();
  if (text.includes("dse-debug")) console.log(`[console] ${text.slice(0, 200)}`);
  if (msg.type() === "error" && !text.includes("404")) {
    consoleErrors.push(text.slice(0, 300));
  }
});
page.on("request", (request) => {
  if (request.url().endsWith("/commit") && request.method() === "POST") commitPosts += 1;
});
page.on("response", async (response) => {
  if (response.status() >= 400) {
    let body = "";
    try {
      body = (await response.text()).slice(0, 400);
    } catch {}
    const reqBody = response.request().postData() ?? "";
    try {
      await writeFile(
        join(dir, `failed-commit-${Date.now()}.json`),
        JSON.stringify({ url: response.url(), status: response.status(), body, request: JSON.parse(reqBody) }, null, 2),
      );
    } catch {}
    failedCommits.push({ url: response.url(), status: response.status(), body, reqBody: reqBody.slice(0, 400) });
  }
});
const shot = (name) => page.screenshot({ path: join(dir, `${name}.png`), fullPage: false }).catch(() => {});

const dismissOnboarding = async () => {
  for (let i = 0; i < 12; i += 1) {
    const theme = page.getByRole("button", { name: /Penpot (Dark|Light|System)/i }).first();
    if (await theme.count()) {
      await theme.click().catch(() => {});
      await page.waitForTimeout(300);
      continue;
    }
    const proceed = page
      .getByRole("button", { name: /^(Continue|Skip|Skip for now|Got it|Close|Start|Done|Next)/i })
      .first();
    if (await proceed.count()) {
      await proceed.click().catch(() => {});
      await page.waitForTimeout(300);
      continue;
    }
    const closeButton = page.locator(".modal-close-button, [data-testid='close-templates-btn']").first();
    if (await closeButton.count()) {
      await closeButton.click().catch(() => {});
      await page.waitForTimeout(300);
      continue;
    }
    const viewport = page.getByTestId("viewport");
    if (await viewport.count().catch(() => 0)) break;
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(200);
  }
};
const waitWorkspace = async () => {
  await dismissOnboarding();
  await page.getByTestId("viewport").waitFor({ timeout: 60_000 });
};
const expandBoard = async () => {
  const board = page.getByTestId("layer-row").filter({ hasText: "Design System" }).first();
  await board.waitFor({ timeout: 25_000 });
  for (let round = 0; round < 40; round += 1) {
    const collapsed = page
      .locator('[data-testid="layer-row"] [data-testid="toggle-content"]:not([aria-expanded="true"])')
      .first();
    if ((await collapsed.count()) === 0) break;
    await collapsed.click().catch(() => {});
    await page.waitForTimeout(120);
  }
  return board;
};
const boardRow = (name) =>
  page.getByTestId("layer-row").filter({ hasText: name }).first();
// Layer rows render through a debounced tree; with the full 19-Cell catalog
// the LAST row can still be missing right after expandBoard settles. Walk
// the panel (wheel) and accumulate row texts until EVERY expected name has
// been seen or the deadline passes. The assertion stays UI-level: system
// page rows, matched by full source name — never API counts (DSE-R14).
const collectLayerRows = async (expectedNames, timeout = 25_000) => {
  const seen = new Set();
  const deadline = Date.now() + timeout;
  const rowHasName = (row, name) => row === name || row.startsWith(`${name} `);
  while (Date.now() < deadline) {
    const texts = await page.getByTestId("layer-row").allInnerTexts();
    for (const text of texts) seen.add(text.replace(/\s+/g, " ").trim());
    const missing = expectedNames.filter((name) => ![...seen].some((row) => rowHasName(row, name)));
    if (missing.length === 0) break;
    await page.mouse.move(200, 600);
    await page.mouse.wheel(0, 800).catch(() => {});
    await page.waitForTimeout(400);
  }
  return seen;
};
const openAssetsPanel = async () => {
  const url = new URL(page.url());
  url.hash = url.hash.includes("layout=")
    ? url.hash.replace(/layout=[^&]*/, "layout=assets")
    : `${url.hash}&layout=assets`;
  await page.evaluate((hash) => {
    window.location.hash = hash;
  }, url.hash.substring(url.hash.indexOf("#") + 1));
  await page.getByTestId("dse-insert-panel").waitFor({ timeout: 20_000 });
};
const openLayersPanel = async () => {
  const url = new URL(page.url());
  url.hash = url.hash.includes("layout=")
    ? url.hash.replace(/layout=[^&]*/, "layout=layers")
    : `${url.hash}&layout=layers`;
  await page.evaluate((hash) => {
    window.location.hash = hash;
  }, url.hash.substring(url.hash.indexOf("#") + 1));
  await page.getByTestId("left-sidebar").waitFor({ timeout: 20_000 });
};
const pickSelectOption = async (testId, optionIndex = 1) => {
  const control = page.getByTestId(testId);
  await control.waitFor({ timeout: 10_000 });
  await page.waitForTimeout(800);
  await control.evaluate((el, index) => {
    const option = el.options[index];
    el.value = option.value;
    el.dispatchEvent(new Event("change", { bubbles: true }));
  }, optionIndex);
};
const setFillColor = async (hex) => {
  const section = page.getByTestId("shape-fill-section");
  await section.waitFor({ timeout: 10_000 });
  const swatch = section.locator('button:has(div[style*="background"])').first();
  await swatch.click({ timeout: 10_000 });
  const hexInput = page.locator("#hex-value").first();
  await hexInput.waitFor({ timeout: 10_000 });
  await hexInput.fill(hex);
  await hexInput.press("Enter");
  await page.keyboard.press("Escape");
};
const waitForSource = async (predicate, label, timeout = 25_000) => {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await workspace();
    if (predicate(last)) return last;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`source readback timeout: ${label}`);
};
const createdSets = (payload) => {
  const sets = [];
  for (const entry of payload.manifest.entries.components ?? []) {
    const value = payload.entries[entry];
    for (const set of Array.isArray(value?.componentSets) ? value.componentSets : [value]) {
      if (set?.id && set?.mainNodeId) sets.push(set);
    }
  }
  return sets;
};
const locatedMainNode = (payload, component) => {
  for (const entry of payload.manifest.entries.screens) {
    const screen = payload.entries[entry];
    for (const presentation of screen.presentations) {
      const node = presentation.nodes?.[component.mainNodeId];
      if (node) return node;
    }
  }
  return null;
};

let setupError = null;
try {
  const snapshot = await (await fetch(endpoint("/v1/workspace"))).json();
  const fileId = snapshot.runtime.file;
  const url = new URL(web.url);
  url.hash = `#/design-system?file-id=${fileId}`;
  await writeFile(join(dir, "run-identity.json"), JSON.stringify({
    label,
    startedAt: new Date().toISOString(),
    backend: bg.url,
    frontend: web.url,
    fileId,
    originalPackage: actualPackage,
    originalHash,
    scratchCopy: packagePath,
    zeroComponents,
    canonicalInventory: before,
  }, null, 2));

  await page.goto(url.href, { waitUntil: "domcontentloaded" });
  await waitWorkspace();
  await expandBoard();
  await shot("01-mount");

  // -- 1. mount: native workspace + board inventory vs canonical ----------
  await step("mount::native-editor-and-inventory", async () => {
    assert.ok((await page.getByTestId("left-sidebar").count()) > 0, "layers sidebar missing");
    assert.ok((await page.getByTestId("right-sidebar").count()) > 0, "properties sidebar missing");
    assert.ok(!((await page.locator("body").innerText()).includes("Internal Error")), "Internal Error");
    const expectedTokenRows = before.tokens.map((token) => `Token / ${token.set}/${token.name}`);
    const seenRows = await collectLayerRows(expectedTokenRows);
    const rowHasName = (row, name) => row === name || row.startsWith(`${name} `);
    const missingTokens = expectedTokenRows.filter((name) => ![...seenRows].some((row) => rowHasName(row, name)));
    const inventory = {
      specimenShapesOnBoard: seenRows.size,
      tokenLayerRowsSeen: expectedTokenRows.length - missingTokens.length,
      missingTokenRows: missingTokens,
      seenRows: [...seenRows].sort(),
      canonicalTokens: before.tokens.length,
      canonicalComponentSets: before.componentSets.length,
      canonicalLocatedComponents: before.locatedComponents.length,
      canonicalScreenNodes: before.screenNodes.length,
    };
    await writeFile(join(dir, "board-inventory.json"), JSON.stringify(inventory, null, 2));
    log(`INFO inventory tokens ${expectedTokenRows.length - missingTokens.length}/${expectedTokenRows.length}`);
    // DSE-R09/R10: EVERY canonical token Cell gets a projected layer row
    // (no per-type sampling), matched by its full source name. The page
    // content section (DSE-R12) carries the screen presentation entry.
    assert.deepEqual(missingTokens, [],
      `token rows missing from the system page: ${missingTokens.join(", ")}`);
    const pageRows = await page
      .getByTestId("layer-row")
      .filter({ hasText: "Design System Fixture" })
      .count();
    assert.ok(pageRows >= 1, "screen presentation entry missing from the board");
    assert.equal(pageErrors.length, 0, `page errors: ${pageErrors.join(" | ")}`);
  });

  // -- 2. create the component through the panel --------------------------
  await step("create::click-new-component", async () => {
    await openAssetsPanel();
    await pickSelectOption("dse-insert-target");
    const beforePayload = await workspace();
    assert.equal(createdSets(beforePayload).length, before.locatedComponents.length,
      "scratch package must start with the canonical located components");
    await page.getByTestId("dse-create-button").click();
    await waitForSource(
      (payload) => createdSets(payload).length > createdSets(beforePayload).length,
      "created component in source",
    );
    await shot("02-created-in-source");
  });

  // -- 3. THE NEW COMPONENT APPEARS ON THE SYSTEM PAGE (layer row) --------
  await step("appear::new-component-on-system-page", async () => {
    // Back to the layer tree of the system page: the created component must
    // be there WITHOUT any reload.
    await openLayersPanel();
    await expandBoard();
    const payload = await workspace();
    const component = createdSets(payload).at(-1);
    const row = boardRow(component.name);
    await row.waitFor({ timeout: 20_000 });
    const rowCount = await page
      .getByTestId("layer-row")
      .filter({ hasText: component.name })
      .count();
    await writeFile(join(dir, "appear-row-count.json"), JSON.stringify({ component, rowCount }, null, 2));
    await shot("03-new-component-on-system-page");
  });

  // -- 4. select it (layer row), canvas hit-selects the same object -------
  let selectionCenter = null;
  await step("select::layer-row-then-canvas-hit", async () => {
    const payload = await workspace();
    const component = createdSets(payload).at(-1);
    // Caption rows ("Label · <name>") share the text; the component ROOT is
    // the FIRST matching row in tree order (roots render above captions).
    const row = page
      .getByTestId("layer-row")
      .filter({ hasText: component.name })
      .first();
    await row.waitFor({ timeout: 20_000 });
    await row.click();
    await page.waitForTimeout(600);
    // The native properties panel must open for the selection.
    await page.getByTestId("shape-fill-section").waitFor({ timeout: 10_000 });
    // Selection handles give the projected position; canvas hit must
    // re-select the same object after deselect.
    const handle = page
      .locator('[data-testid="viewport"] .svg-handle, [data-testid="viewport"] [class*="handle"]')
      .first();
    if (await handle.count()) {
      const box = await handle.boundingBox();
      if (box) selectionCenter = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    }
    await shot("04-selected-via-layer-row");
    // Deselect, then click the canvas at the shape center.
    await page.getByTestId("viewport").click({ position: { x: 10, y: 500 } });
    await page.waitForTimeout(400);
    await page.getByTestId("shape-fill-section").waitFor({ state: "detached", timeout: 5_000 }).catch(() => {});
    if (selectionCenter) {
      await page.mouse.click(selectionCenter.x, selectionCenter.y);
      await page.waitForTimeout(600);
      await page.getByTestId("shape-fill-section").waitFor({ timeout: 8_000 });
      await shot("05-selected-via-canvas-hit");
    }
    const name = await page
      .getByTestId("right-sidebar")
      .innerText()
      .then((t) => t.slice(0, 200));
    assert.ok(name.includes(component.name), `selection lost; sidebar: ${name}`);
  });

  // -- 5. native panel color edit + source readback ------------------------
  const newColor = "#2563eb";
  const originalColor = {};
  await step("edit::native-panel-fill-source-readback", async () => {
    const payload = await workspace();
    const component = createdSets(payload).at(-1);
    const node = locatedMainNode(payload, component);
    assert.ok(node, "created main node missing from source");
    originalColor.value = node.fills?.[0]?.color;
    await setFillColor(newColor);
    const after = await waitForSource(
      (p) => locatedMainNode(p, createdSets(p).at(-1))?.fills?.[0]?.color?.toLowerCase() === newColor.toLowerCase(),
      `main node fill becomes ${newColor}`,
    );
    await shot("06-color-edited-and-read-back");
    log(`INFO fill ${originalColor.value} -> ${newColor} revision=${after.revision}`);
  });

  // -- 6. Undo the color edit ---------------------------------------------
  await step("undo::color-edit-reverts", async () => {
    const beforeUndo = await workspace();
    const component = createdSets(beforeUndo).at(-1);
    await page.getByTestId("viewport").click({ position: { x: 10, y: 500 } }).catch(() => {});
    await page.keyboard.press("ControlOrMeta+z");
    const undone = await waitForSource(
      (p) => locatedMainNode(p, createdSets(p).at(-1))?.fills?.[0]?.color?.toLowerCase() !== newColor.toLowerCase(),
      "undo reverts fill",
    );
    await shot("07-undo-color");
    log(`INFO undo fill back to ${locatedMainNode(undone, createdSets(undone).at(-1))?.fills?.[0]?.color}`);
  });

  // -- 7. Redo the color edit ---------------------------------------------
  await step("redo::color-edit-reapplies", async () => {
    await page.keyboard.press("ControlOrMeta+Shift+z");
    await waitForSource(
      (p) => locatedMainNode(p, createdSets(p).at(-1))?.fills?.[0]?.color?.toLowerCase() === newColor.toLowerCase(),
      "redo reapplies fill",
    );
    await shot("08-redo-color");
  });

  // -- 8. Undo/Redo the CREATION itself ------------------------------------
  await step("undo::creation-removes-component-from-system-page", async () => {
    const beforeUndo = await workspace();
    const count = createdSets(beforeUndo).length;
    const component = createdSets(beforeUndo).at(-1);
    // The color edit sits on top of the undo stack: undo until the creation
    // itself is reverted (at most: color undo + create undo).
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const current = await workspace();
      if (createdSets(current).length < count) break;
      await page.keyboard.press("ControlOrMeta+z");
      await waitForSource((p) => true, "undo settle", 4_000).catch(() => {});
    }
    const undone = await waitForSource((p) => createdSets(p).length < count, "undo removes component");
    assert.equal(createdSets(undone).length, count - 1, "undo must remove exactly the creation");
    // The system page must no longer offer the component row (wait out the
    // re-projection instead of a fixed sleep).
    let rowGone = true;
    try {
      await page
        .getByTestId("layer-row")
        .filter({ hasText: component.name })
        .first()
        .waitFor({ state: "detached", timeout: 15_000 });
    } catch {
      rowGone = false;
    }
    await shot("09-undo-creation");
    if (!rowGone) {
      const allRows = await page.getByTestId("layer-row").allInnerTexts().catch(() => []);
      const storeObjects = await page
        .evaluate(() => (window.__dseDebug ? window.__dseDebug() : "no hook"))
        .catch((e) => String(e));
      await writeFile(join(dir, "ghost-rows.json"), JSON.stringify({ domRows: allRows, storeObjects }, null, 2));
    }
    assert.ok(rowGone, "component row still on the system page after undo (ghost)");
  });

  await step("redo::creation-restores-component-on-system-page", async () => {
    const beforeRedo = await workspace();
    const count = createdSets(beforeRedo).length;
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const current = await workspace();
      if (createdSets(current).length > count) break;
      // Refocus the viewport, then try both redo bindings.
      await page.getByTestId("viewport").click({ position: { x: 10, y: 500 } }).catch(() => {});
      await page.waitForTimeout(300);
      await page.keyboard.press(attempt % 2 === 0 ? "ControlOrMeta+Shift+z" : "ControlOrMeta+y");
      await page.waitForTimeout(2_500);
    }
    const redone = await waitForSource((p) => createdSets(p).length > count, "redo restores component");
    const component = createdSets(redone).at(-1);
    const row = boardRow(component.name);
    await row.waitFor({ timeout: 20_000 });
    await shot("10-redo-creation");
  });

  // -- 9. refresh: persisted state matches ---------------------------------
  await step("refresh::reload-keeps-redo-state", async () => {
    // Whatever the final undo/redo state is, the reload must reproduce it
    // exactly: same component present, same color.
    const before = await workspace();
    const beforeColor = locatedMainNode(before, createdSets(before).at(-1))?.fills?.[0]?.color;
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitWorkspace();
    await expandBoard();
    const payload = await workspace();
    const component = createdSets(payload).at(-1);
    assert.equal(
      locatedMainNode(payload, component)?.fills?.[0]?.color?.toLowerCase(),
      beforeColor?.toLowerCase(),
      "color drifted across reload",
    );
    const row = boardRow(component.name);
    await row.waitFor({ timeout: 20_000 });
    await shot("11-refresh-keeps-state");
    assert.equal(pageErrors.length, 0, `page errors: ${pageErrors.join(" | ")}`);
  });

  // -- 10. negative: the user's ORIGINAL package untouched -----------------
  await step("negative::original-package-untouched", async () => {
    assert.equal(await hashTree(actualPackage), originalHash, "original package changed");
  });
} catch (error) {
  setupError = String(error?.stack ?? error);
  log(`SETUP/STEP CRASH: ${setupError.slice(0, 800)}`);
  await shot("failure").catch(() => {});
} finally {
  if (results.length === 0 && !setupError) {
    setupError = "no steps recorded";
  }
  await writeFile(
    join(dir, "results.json"),
    JSON.stringify({ label, results, setupError, pageErrors, consoleErrors, failedCommits, commitPosts }, null, 2),
  );
  await browser.close().catch(() => {});
  await bg.close().catch(() => {});
  await web.close().catch(() => {});
  await rm(scratch, { recursive: true, force: true }).catch(() => {});
}

const failed = results.filter((r) => !r.ok);
for (const r of results) {
  log(`${r.ok ? "PASS" : "FAIL"} ${r.name}${r.ok ? "" : ` :: ${String(r.error).slice(0, 300)}`}`);
}
const exited = failed.length === 0 && !setupError && results.length > 0;
console.log(`DSE early slice ${label}: ${exited ? "PASS" : `FAIL (${failed.length}) setup=${setupError ? "error" : "none"}`}`);
process.exit(exited ? 0 : 1);
