// DSE-002 ordinary-page baseline: the SAME fixture objects later projected
// onto the design-system page, edited through the normal editor on a normal
// page. Real UI gestures only (layer selection, keyboard nudge, opacity
// input, undo); source read-back from the copied package files; revision and
// manifest negative controls. Companion evidence for EDITOR-PARITY.md rows.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { serveLocalPackage } from "@smallpen/background";
import { servePenpotFrontend } from "@smallpen/web";

import {
  buildEditorFoundationValues,
  buildEditorPackageValues,
} from "../test/fixtures/design-system-editor-fixture.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const repositoryRoot = join(root, "..");
const require = createRequire(join(repositoryRoot, "frontend", "package.json"));
const { chromium } = require("playwright");
const frontendRoot = join(repositoryRoot, "frontend", "resources", "public");
const auditDir = join(root, "audits", "2026-09-12-dse-002");

const scratch = await mkdtemp(join(tmpdir(), "smallpen-dse-baseline-"));
async function writePackage(dir, values) {
  for (const [entry, value] of values) {
    const path = join(dir, entry);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(value, null, 2));
  }
}
const productPath = `${scratch}/editor.smallpen`;
// The canvas fixture manifest declares this exact library source path.
const foundationPath = `${scratch}/canvas-shared.smallpen`;
await writePackage(productPath, buildEditorPackageValues());
await writePackage(foundationPath, buildEditorFoundationValues());

const background = await serveLocalPackage({ packagePath: productPath, port: 0 });
const web = await servePenpotFrontend({
  backendUrl: background.url,
  frontendRoot,
  port: 0,
});

const homeScreenPath = join(productPath, "screens", "canvas-page-home.json");
const readNode = async (nodeId) => {
  const screen = JSON.parse(await readFile(homeScreenPath, "utf8"));
  return screen.presentations[0].nodes[nodeId];
};
// Persistence flushes on a ~3s beat; poll the source file instead of sleeping.
async function waitForNodeField(nodeId, field, expected) {
  const deadline = Date.now() + 10_000;
  let last;
  while (Date.now() < deadline) {
    last = (await readNode(nodeId))[field];
    if (last === expected) return last;
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return last;
}

const browser = await chromium.launch({ headless: true });
let failed = false;
let pageRef = null;
const consoleErrors = [];
const failedResponses = [];
const commitResponses = [];

try {
  const page = await browser.newPage({ viewport: { height: 1000, width: 1440 } });
  pageRef = page;
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(String(error.message)));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  page.on("request", async (request) => {
    if (request.url().includes("/v1/penpot/commit") && request.method() === "POST") {
      commitResponses.push(
        "body:" + JSON.stringify(request.postData()),
      );
    }
  });
  page.on("response", async (response) => {
    if (response.url().includes("/v1/penpot/commit")) {
      commitResponses.push(response.status());
    }
    if (response.status() < 400) return;
    failedResponses.push({
      body: await response.text().catch(() => ""),
      status: response.status(),
      url: response.url(),
    });
  });

  const endpoint = (path) => {
    const base = new URL(background.url);
    base.pathname = `${base.pathname.replace(/\/+$/, "")}${path}`;
    return base.href;
  };
  const revision = async () =>
    (await (await fetch(endpoint("/v1/ui/design-system"))).json()).revision;

  const rev0 = await revision();
  const nodeTextBefore = await readNode("node_editor_nested_text");
  const nodeNestedBefore = await readNode("node_editor_nested");
  assert.equal(nodeTextBefore.text, "Nested text");
  assert.equal(nodeNestedBefore.opacity, undefined);

  await page.goto(web.workspaceUrl, { waitUntil: "domcontentloaded" });
  await page.getByTestId("viewport").waitFor({ timeout: 30_000 });
  await page.getByTestId("left-sidebar").waitFor();
  await page.getByTestId("right-sidebar").waitFor();
  await page.getByTestId("toolbar-options").waitFor({ state: "attached", timeout: 30_000 });
  assert.deepEqual(pageErrors, [], "workspace booted without page errors");
  await page.screenshot({ path: join(auditDir, "baseline-home.png") });

  // Expand the layer tree down to the nested container (Home → Content →
  // Nested Container) and select its text child.
  const expand = async (rowName) => {
    const row = page.getByTestId("layer-row").filter({ hasText: rowName }).first();
    await row.waitFor({ timeout: 15_000 });
    const toggle = row.getByTestId("toggle-content");
    if ((await toggle.count()) && (await toggle.getAttribute("aria-expanded")) !== "true") {
      await toggle.click();
    }
    return row;
  };
  await expand("Home");
  await expand("Content");
  await expand("Nested Container");
  await expand("Nested Row");
  const textRow = page.getByTestId("layer-row").filter({ hasText: "Nested Text" }).first();
  await textRow.waitFor({ timeout: 15_000 });

  // -- Move via the native X coordinate input: real gesture → mod-obj(x) ----
  // Penpot measures inputs show coordinates relative to the parent frame
  // (canonical x=20 inside the container); typing +3 lands x=23 in source.
  const nodePathBefore = await readNode("node_editor_nested_path");
  const pathRow = page.getByTestId("layer-row").filter({ hasText: "Nested Triangle" }).first();
  await pathRow.waitFor({ timeout: 15_000 });
  await pathRow.click();
  const measuresSection = page.locator('section[aria-label="shape-measures-section"]');
  await measuresSection.waitFor({ timeout: 10_000 });
  await measuresSection.locator('input[type="text"]').first().waitFor({ timeout: 10_000 });
  const inputs = await measuresSection.locator('input[type="text"]').all();
  const inputValues = [];
  let xInput = null;
  for (const input of inputs) {
    const value = await input.inputValue();
    inputValues.push(value);
    if (value === `${nodePathBefore.x}`) {
      xInput = input;
    }
  }
  assert.ok(xInput, `X input not found (values=${JSON.stringify(inputValues)})`);
  await xInput.fill(`${nodePathBefore.x + 3}`);
  await xInput.press("Enter");
  // Penpot encodes PATH position in content/points/selrect: the canonical
  // node x stays, and the LOCAL pathData absorbs the delta. Compare the
  // leading M x-coordinate.
  const firstX = (pathData) => Number(/^M\s*(-?[\d.]+)/.exec(pathData)?.[1] ?? NaN);
  let nudgedPathData;
  {
    const deadline = Date.now() + 10_000;
    let current = (await readNode("node_editor_nested_path")).pathData;
    while (Date.now() < deadline && firstX(current) === firstX(nodePathBefore.pathData)) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      current = (await readNode("node_editor_nested_path")).pathData;
    }
    nudgedPathData = current;
  }
  assert.equal(
    firstX(nudgedPathData),
    firstX(nodePathBefore.pathData) + 3,
    `X edit did not reach the source pathData (${nudgedPathData})`,
  );

  // -- Undo (Ctrl/Cmd+Z): inverse commit restores the source position ------
  await page.keyboard.press("ControlOrMeta+z");
  {
    const deadline = Date.now() + 10_000;
    let current = nudgedPathData;
    while (Date.now() < deadline && firstX(current) !== firstX(nodePathBefore.pathData)) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      current = (await readNode("node_editor_nested_path")).pathData;
    }
    assert.equal(
      firstX(current),
      firstX(nodePathBefore.pathData),
      `undo did not restore source pathData (${current})`,
    );
  }

  // -- Opacity via the native property panel (proven SmallPen input) --------
  const containerRow = page
    .getByTestId("layer-row")
    .filter({ hasText: "Nested Container" })
    .first();
  await containerRow.click();
  // The selection switch is async: wait until the measures panel shows the
  // container's width, otherwise the opacity edit lands on the previous
  // selection (the PATH).
  await page.waitForFunction(
    () => {
      const section = document.querySelector(
        'section[aria-label="shape-measures-section"]',
      );
      if (!section) return false;
      return Array.from(section.querySelectorAll('input[type="text"]')).some(
        (input) => input.value === "320",
      );
    },
    { timeout: 10_000 },
  );
  const opacityInput = page
    .locator('section[aria-label="Layer menu section"] input[type="text"]')
    .first();
  await opacityInput.waitFor({ timeout: 10_000 });
  await opacityInput.fill("77");
  await opacityInput.press("Enter");
  const opac = await waitForNodeField("node_editor_nested", "opacity", 0.77);
  assert.equal(
    opac,
    0.77,
    `opacity edit did not reach the source (opacity=${opac})`,
  );

  // -- Undo restores opacity -------------------------------------------------
  await page.keyboard.press("ControlOrMeta+z");
  const opacUndone = await waitForNodeField("node_editor_nested", "opacity", nodeNestedBefore.opacity ?? undefined);
  assert.notEqual(
    opacUndone,
    0.77,
    "undo did not restore source opacity",
  );

  // -- Negative control: canonical manifest unchanged (no new page) ---------
  const manifest = JSON.parse(
    await readFile(join(productPath, "manifest.json"), "utf8"),
  );
  assert.equal(manifest.entries.screens.length, 2, "screen count drifted");
  assert.equal(
    manifest.entries.screens.filter((entry) => entry.includes("canvas-page-home")).length,
    1,
    "home screen entry drifted",
  );

  await page.screenshot({ path: join(auditDir, "baseline-after-edits.png") });
  assert.deepEqual(pageErrors, [], "no page errors during edits");

  console.log(
    JSON.stringify({
      rev0,
      revFinal: await revision(),
      nudge: {
        before: firstX(nodePathBefore.pathData),
        after: firstX(nudgedPathData),
      },
      status: "passed",
    }),
  );
} catch (error) {
  failed = true;
  console.error("DSE-002 baseline e2e: FAIL");
  console.error(error);
  if (failedResponses.length) {
    console.error("failedResponses:", JSON.stringify(failedResponses));
  }
  if (consoleErrors.length) {
    console.error("consoleErrors:", JSON.stringify(consoleErrors.slice(0, 10)));
  }
  console.error("commitResponses:", JSON.stringify(commitResponses));
  try {
    if (pageRef) {
      console.error(
        "body:",
        (await pageRef.locator("body").innerText().catch(() => "")).slice(0, 400).replace(/\n/g, " | "),
      );
    }
  } catch {}
} finally {
  await browser.close();
  await web.close?.();
  await background.close?.();
  await rm(scratch, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
