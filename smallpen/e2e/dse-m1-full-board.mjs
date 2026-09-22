// DSE M1 evidence: the FULL design-system board on an isolated copy of the
// user's actual package (/private/tmp/smallpen-live-demo/design-system.smallpen):
//   1. every canonical Token Cell / group header / caption / component
//      variant / screen node is reachable as a native layer row (by name,
//      never API counts),
//   2. token specimens and page nodes select from the tree AND from a canvas
//      hit, with the native panel showing board coordinates (R08),
//   3. first entry fits the board; leaving and reopening the page restores
//      the user's viewport instead of fitting again (R13),
//   4. the user's original package stays untouched.
//
// Usage: node e2e/dse-m1-full-board.mjs --audit <dir>
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
  for (const entry of manifest.entries.components ?? []) {
    const value = JSON.parse(await readFile(join(packagePath, entry), "utf8"));
    for (const set of Array.isArray(value?.componentSets) ? value.componentSets : []) {
      componentSets.push({
        id: set.id,
        name: set.name,
        variants: (set.variants ?? []).map((variant) => ({
          id: variant.id,
          selection: variant.selection ?? {},
        })),
      });
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
  return { manifest, tokens, componentSets, screenNodes };
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

const args = process.argv.slice(2);
const argValue = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const auditRoot = argValue("--audit") ?? join(root, "audits", "dse-full-delivery", "m1-latest");
const dir = join(auditRoot, "m1-actual");
await rm(dir, { recursive: true, force: true });
await mkdir(dir, { recursive: true });

const log = (line) => console.log(line);
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

const scratch = await mkdtemp(join(tmpdir(), "smallpen-dse-m1-"));
const packagePath = join(scratch, "design-system.smallpen");
await cp(actualPackage, packagePath, { recursive: true });
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

const browser = await chromium.launch();
const pageErrors = [];
const consoleErrors = [];
const page = await browser.newPage({ viewport: { height: 1000, width: 1440 } });
page.on("pageerror", (error) => pageErrors.push(String(error.message)));
page.on("console", (msg) => {
  if (msg.type() === "error" && !msg.text().includes("404")) {
    consoleErrors.push(msg.text().slice(0, 300));
  }
});
const shot = (name) => page.screenshot({ path: join(dir, `${name}.png`), fullPage: false }).catch(() => {});

const waitWorkspace = async () => {
  await page.getByTestId("viewport").waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1_500);
};
const expandBoard = async () => {
  const board = page.getByTestId("layer-row").filter({ hasText: "Design System" }).first();
  await board.waitFor({ timeout: 25_000 });
  for (let round = 0; round < 60; round += 1) {
    const collapsed = page
      .locator('[data-testid="layer-row"] [data-testid="toggle-content"]:not([aria-expanded="true"])')
      .first();
    if ((await collapsed.count()) === 0) break;
    await collapsed.click().catch(() => {});
    await page.waitForTimeout(120);
  }
};
const collectLayerRows = async (expectedNames, timeout = 30_000) => {
  const seen = new Set();
  const deadline = Date.now() + timeout;
  const rowHasName = (row, name) => row === name || row.startsWith(`${name} `);
  while (Date.now() < deadline) {
    const texts = await page.getByTestId("layer-row").allInnerTexts();
    for (const text of texts) seen.add(text.replace(/\s+/g, " ").trim());
    const missing = expectedNames.filter((name) => ![...seen].some((row) => rowHasName(row, name)));
    if (missing.length === 0) break;
    await page.mouse.move(200, 600);
    await page.mouse.wheel(0, 900).catch(() => {});
    await page.waitForTimeout(350);
  }
  return seen;
};
const rowFor = (name) => {
  const row = page.getByTestId("layer-row").filter({ hasText: name }).first();
  return row;
};
const readZoom = async () =>
  page.evaluate(() => {
    const element = document.querySelector('[data-testid="viewport"]');
    return element ? Number.parseFloat(getComputedStyle(element).getPropertyValue("--zoom")) : Number.NaN;
  });
const waitForZoomStable = async () => {
  let last = await readZoom();
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await page.waitForTimeout(400);
    const next = await readZoom();
    if (Number.isFinite(next) && Math.abs(next - last) < 1e-6) return next;
    last = next;
  }
  return last;
};
const panelVisible = async () => {
  await page.getByTestId("shape-fill-section").waitFor({ timeout: 10_000 });
};
const panelXY = async () =>
  page.evaluate(() => {
    const numbers = [...document.querySelectorAll('[data-testid="right-sidebar"] input')]
      .map((input) => input.value)
      .filter((value) => /^-?\d+(\.\d+)?$/.test(value))
      .slice(0, 4)
      .map(Number);
    return numbers;
  });
const deselect = async () => {
  await page.getByTestId("viewport").click({ position: { x: 10, y: 500 } }).catch(() => {});
  await page.waitForTimeout(400);
};
const selectFromLayerRowThenCanvas = async (rowName, label) => {
  // Layer-tree selection opens the native panel at the board coordinates.
  const row = rowFor(rowName);
  await row.waitFor({ timeout: 20_000 });
  await row.click();
  await page.waitForTimeout(700);
  await panelVisible();
  const fromLayer = await panelXY();
  const handle = page
    .locator('[data-testid="viewport"] .svg-handle, [data-testid="viewport"] [class*="handle"]')
    .first();
  const box = (await handle.count()) > 0 ? await handle.boundingBox() : null;
  assert.ok(box, "selection handle must be measurable while the specimen is selected");
  const fromLayerHandle = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await shot(`${label}-layer-selected`);
  // Deselect on the canvas blank area, then the canvas hit at the recorded
  // frame center must reselect the SAME object: the panel reports the same
  // X/Y (never the stale 0/0 from the R08 baseline) for both paths.
  await page.getByTestId("viewport").click({ position: { x: 10, y: 500 } });
  await page.waitForTimeout(500);
  await page.getByTestId("shape-fill-section").waitFor({ state: "detached", timeout: 5_000 }).catch(() => {});
  await page.mouse.click(fromLayerHandle.x, fromLayerHandle.y);
  await page.waitForTimeout(700);
  await panelVisible();
  const fromCanvas = await panelXY();
  await shot(`${label}-canvas-selected`);
  assert.ok(
    fromLayer.length >= 2 && (fromLayer[2] !== 0 || fromLayer[1] !== 0 || fromLayer[0] !== 0),
    `${rowName}: panel coordinates must not be 0/0, saw ${JSON.stringify(fromLayer)}`,
  );
  const same = fromLayer.length === fromCanvas.length &&
    fromLayer.every((value, index) => Math.abs(value - (fromCanvas[index] ?? Number.NaN)) <= 1);
  assert.ok(
    same,
    `${rowName}: layer selection and canvas hit must select the same object ` +
      `(panel ${JSON.stringify(fromLayer)} vs ${JSON.stringify(fromCanvas)})`,
  );
  const sidebar = await page.getByTestId("right-sidebar").innerText();
  assert.ok(
    !sidebar.includes("CANVAS BACKGROUND"),
    `${rowName}: canvas hit must select the object, panel shows no selection`,
  );
  await deselect();
};

let setupError = null;
try {
  const snapshot = await (await fetch(endpoint("/v1/workspace"))).json();
  const fileId = snapshot.runtime.file;
  const url = new URL(web.url);
  url.hash = `#/design-system?file-id=${fileId}`;
  await writeFile(join(dir, "run-identity.json"), JSON.stringify({
    startedAt: new Date().toISOString(),
    backend: bg.url,
    frontend: web.url,
    fileId,
    originalPackage: actualPackage,
    originalHash,
    scratchCopy: packagePath,
    canonicalInventory: before,
  }, null, 2));

  await page.goto(url.href, { waitUntil: "domcontentloaded" });
  await waitWorkspace();
  await expandBoard();
  await shot("01-mount-full-board");

  // -- 1. EVERY canonical item is a reachable native layer row -------------
  await step("inventory::full-board-by-name", async () => {
    const packageId = before.manifest.packageId;
    const tokenRows = before.tokens.map((token) => `Token / ${token.set}/${token.name}`);
    const groupKeys = [...new Set(before.tokens.map((token) => `${token.set}\u0000${token.type}`))];
    const groupHeaders = groupKeys.map((key) => {
      const [setName, type] = key.split("\u0000");
      return `Label · ${packageId} / ${setName} / ${type}`;
    });
    const captions = before.tokens.map((token) => `Label · ${packageId} · ${token.set} · ${token.type} ${token.name} =`);
    const variantRows = before.componentSets.flatMap((set) =>
      (set.variants ?? []).map((variant) => `Label · ${set.name} · State=${variant.selection?.axis_state ?? variant}`),
    );
    const pageRows = before.screenNodes.map((node) => node.name).filter((name) => name && name !== "Design System");
    const expected = [...new Set([...tokenRows, ...groupHeaders, ...captions, ...variantRows, ...pageRows])];
    const seen = await collectLayerRows(expected);
    const missing = expected.filter((name) => ![...seen].some((row) => row === name || row.startsWith(`${name} `)));
    await writeFile(join(dir, "board-row-reconciliation.json"), JSON.stringify({
      expectedCount: expected.length,
      seenCount: seen.size,
      missing,
      seen: [...seen].sort(),
    }, null, 2));
    log(`INFO rows expected=${expected.length} seen=${seen.size} missing=${missing.length}`);
    assert.deepEqual(missing, [], `canonical items missing from the board: ${missing.slice(0, 8).join(" | ")}`);
    assert.equal(pageErrors.length, 0, `page errors: ${pageErrors.join(" | ")}`);
  });

  // -- 2. first entry fits the full board (R13) ----------------------------
  let fitZoom = Number.NaN;
  await step("viewport::first-entry-fits-board", async () => {
    fitZoom = await waitForZoomStable();
    await shot("02-first-entry-fit");
    assert.ok(Number.isFinite(fitZoom) && fitZoom > 0 && fitZoom < 1,
      `first entry must fit the 2958px board into the viewport, zoom=${fitZoom}`);
  });

  // -- 3. token specimen + page node select correctly (R08) ----------------
  const primary = before.tokens.find((token) => token.name === "primary" && token.set === "color/light");
  const specimenRow = `Token / ${primary.set}/${primary.name}`;
  await step("selection::token-specimen-geometry", async () => {
    await selectFromLayerRowThenCanvas(specimenRow, "03-token-specimen");
  });

  const pageNodeName = before.screenNodes.map((node) => node.name)
    .find((name) => name === "Hardcoded Radius Control") ??
    before.screenNodes.map((node) => node.name).find((name) => name && name !== "Design System");
  await step("selection::page-node-geometry", async () => {
    await selectFromLayerRowThenCanvas(pageNodeName, "04-page-node");
  });

  // -- 4. reopening the page restores the user's viewport (R13) ------------
  await step("viewport::reopen-restores-user-viewport", async () => {
    // The user zooms in past the fit zoom.
    await page.getByTestId("viewport").click({ position: { x: 720, y: 500 } }).catch(() => {});
    for (let tick = 0; tick < 6; tick += 1) {
      await page.keyboard.press("ControlOrMeta+=");
      await page.waitForTimeout(200);
    }
    const userZoom = await waitForZoomStable();
    await shot("05-user-zoom-before-reopen");
    assert.ok(Number.isFinite(userZoom) && Math.abs(userZoom - fitZoom) > 0.02,
      `user zoom (${userZoom}) must differ from the initial fit (${fitZoom})`);
    // Leave the generated page and come back WITHOUT a reload: the cached
    // viewport must win over the entry fit.
    await page.locator('[data-testid="page-name"]').filter({ hasText: /^Components$/ }).first().click();
    await page.waitForTimeout(2_500);
    // Exact page-name match: "Design System Fixture · Desktop" ALSO
    // contains "Design System" and must not win.
    await page.locator('[data-testid="page-name"]').filter({ hasText: /^Design System$/ }).first().click();
    await page.waitForTimeout(2_500);
    const reopenZoom = await waitForZoomStable();
    await shot("06-reopen-viewport-restored");
    assert.ok(
      Math.abs(reopenZoom - userZoom) < 0.02,
      `reopening must restore the user viewport ${userZoom}, saw ${reopenZoom} (fit was ${fitZoom})`,
    );
    assert.equal(pageErrors.length, 0, `page errors: ${pageErrors.join(" | ")}`);
  });

  // -- 5. negative: the user's ORIGINAL package untouched ------------------
  await step("negative::original-package-untouched", async () => {
    assert.equal(await hashTree(actualPackage), originalHash, "original package changed");
  });
} catch (error) {
  setupError = String(error?.stack ?? error);
  log(`SETUP/STEP CRASH: ${setupError.slice(0, 800)}`);
  await shot("failure").catch(() => {});
} finally {
  if (results.length === 0 && !setupError) setupError = "no steps recorded";
  await writeFile(
    join(dir, "results.json"),
    JSON.stringify({ label: "m1-actual", results, setupError, pageErrors, consoleErrors }, null, 2),
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
console.log(`DSE M1 full board: ${exited ? "PASS" : `FAIL (${failed.length}) setup=${setupError ? "error" : "none"}`}`);
process.exit(exited ? 0 : 1);
