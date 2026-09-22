import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { serveLocalPackage } from "@smallpen/background";
import { servePenpotFrontend } from "@smallpen/web";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const repositoryRoot = join(root, "..");
const require = createRequire(join(repositoryRoot, "frontend", "package.json"));
const { chromium } = require("playwright");
const fixture = join(root, "test", "fixtures", "roundtrip.smallpen");
const frontendRoot = join(repositoryRoot, "frontend", "resources", "public");
const cli = join(root, "apps", "cli", "bin", "smallpen.mjs");
const execFileAsync = promisify(execFile);

async function runCli(args) {
  const { stdout } = await execFileAsync(process.execPath, [cli, ...args], {
    cwd: repositoryRoot,
  });
  return JSON.parse(stdout);
}

async function waitForNodeField(screenPath, nodeId, field, expected) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const screen = JSON.parse(await readFile(screenPath, "utf8"));
    if (screen.presentations[0].nodes[nodeId]?.[field] === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`Penpot ${nodeId}.${field} edit was not written to ${screenPath}`);
}

async function waitForNavigateInteraction(screenPath, nodeId) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const screen = JSON.parse(await readFile(screenPath, "utf8"));
    const interaction = screen.presentations[0].nodes[nodeId]?.interactions?.[0];
    if (interaction?.["action-type"] === "navigate" && interaction.destination) {
      return interaction;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`Penpot navigate interaction was not written to ${screenPath}`);
}

async function waitForPrototypeFlow(screenPath) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const screen = JSON.parse(await readFile(screenPath, "utf8"));
    const flow = screen.presentations[0].prototypeFlows?.[0];
    if (flow?.name === "Flow 1" && flow.startingNodeId === "node_canvas") {
      return flow;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`Penpot Flow start was not written to ${screenPath}`);
}

async function waitForThemeNames(packagePath, expected) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const manifest = JSON.parse(
      await readFile(join(packagePath, "manifest.json"), "utf8"),
    );
    const entry = manifest.entries.tokens[0];
    if (entry) {
      const library = JSON.parse(await readFile(join(packagePath, entry), "utf8"));
      const names = library.themes.map(({ group }) => group);
      if (expected.every((name) => names.includes(name))) return library;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`Theme names were not written to ${packagePath}: ${expected.join(", ")}`);
}

async function waitForRenderer(backgroundUrl, expected) {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const application = await fetch(`${backgroundUrl}/v1/application`).then(
      (response) => response.json(),
    );
    if (application.preferences.renderer === expected) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.fail(`Renderer preference was not updated to ${expected}`);
}

function findNode(value, nodeId) {
  if (!value || typeof value !== "object") return undefined;
  if (value.id === nodeId) return value;
  for (const child of Object.values(value)) {
    const match = findNode(child, nodeId);
    if (match) return match;
  }
  return undefined;
}

async function expandCanvas(page) {
  const canvasLayer = page.getByTestId("layer-row").filter({ hasText: "Canvas" });
  await canvasLayer.waitFor();
  const toggle = canvasLayer.getByTestId("toggle-content");
  await toggle.waitFor();
  const rectangleLayer = page
    .getByTestId("layer-row")
    .filter({ hasText: "Editable Rectangle" });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
  try {
    await rectangleLayer.waitFor();
  } catch (error) {
    throw new Error(
      `Canvas did not expose Editable Rectangle; aria-expanded=${await toggle.getAttribute("aria-expanded")}; ` +
        `layers=${JSON.stringify(await page.getByTestId("layer-row").allInnerTexts())}`,
      { cause: error },
    );
  }
}

async function main() {
  const parent = await mkdtemp(join(tmpdir(), "smallpen-penpot-e2e-"));
  const packagePath = join(parent, "roundtrip.smallpen");
  const screenPath = join(packagePath, "screens", "roundtrip.json");
  const flowIntentPath = join(parent, "flow-intent.json");
  const modifyBatchPath = join(parent, "modify-batch.json");
  await cp(fixture, packagePath, { recursive: true });
  const screen = JSON.parse(await readFile(screenPath, "utf8"));
  const presentation = screen.presentations[0];
  presentation.rootIds = [presentation.rootId, "node_destination"];
  presentation.nodes.node_canvas.children.push("node_viewer_text");
  presentation.nodes.node_rectangle.visible = true;
  presentation.nodes.node_viewer_text = {
    children: [],
    fills: [{ color: "#111827", type: "solid" }],
    height: 32,
    id: "node_viewer_text",
    name: "Viewer Text",
    text: "Viewer text without cached layout",
    textStyle: {
      fontFamily: "Inter",
      fontId: "gfont-inter",
      fontSize: 20,
      fontVariantId: "regular",
      fontWeight: 400,
      lineHeight: 1.2,
    },
    type: "TEXT",
    width: 360,
    x: 80,
    y: 248,
  };
  presentation.nodes.node_destination = {
    children: ["node_destination_text"],
    fills: [{ color: "#0f766e", type: "solid" }],
    height: 600,
    id: "node_destination",
    interactions: [],
    name: "Destination",
    type: "FRAME",
    width: 800,
    x: 960,
    y: 0,
  };
  presentation.nodes.node_destination_text = {
    children: [],
    fills: [{ color: "#ffffff", type: "solid" }],
    height: 40,
    id: "node_destination_text",
    name: "Destination label",
    text: "Destination screen",
    textStyle: {
      fontFamily: "Inter",
      fontId: "gfont-inter",
      fontSize: 28,
      fontVariantId: "600",
      fontWeight: 600,
      lineHeight: 1.2,
    },
    type: "TEXT",
    width: 320,
    x: 80,
    y: 80,
  };
  await writeFile(screenPath, JSON.stringify(screen, null, 2));

  const background = await serveLocalPackage({ packagePath, port: 0 });
  const web = await servePenpotFrontend({
    backendUrl: background.url,
    frontendRoot,
    port: 0,
  });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { height: 900, width: 1440 } });
    const pageErrors = [];
    const pageConsoleErrors = [];
    const failedResponses = [];
    page.on("pageerror", (error) => pageErrors.push(error));
    page.on("console", (message) => {
      if (message.type() === "error") pageConsoleErrors.push(message.text());
    });
    page.on("response", async (response) => {
      if (response.status() < 400) return;
      failedResponses.push({
        body: await response.text().catch(() => ""),
        status: response.status(),
        url: response.url(),
      });
    });

    // `web.url` intentionally points at the local SmallPen Home page. The
    // workspace smoke test must use the resolved Penpot workspace URL so it
    // validates the editor rather than waiting for an editor on Home.
    const cleanWorkspaceUrl = new URL(web.workspaceUrl);
    assert.equal(cleanWorkspaceUrl.search, "");
    assert.doesNotMatch(web.workspaceUrl, /smallpen-backend|smallpen-package/);
    const workspaceQuery = new URLSearchParams(cleanWorkspaceUrl.hash.split("?")[1]);
    assert.match(workspaceQuery.get("file-id"), /^[a-f0-9-]{36}$/);
    assert.match(workspaceQuery.get("page-id"), /^[a-f0-9-]{36}$/);
    assert.equal(workspaceQuery.get("layout"), "layers");
    assert.equal(workspaceQuery.get("team-id"), null);
    await page.goto(web.workspaceUrl, { waitUntil: "domcontentloaded" });
    assert.equal(new URL(page.url()).search, "");
    await page.getByTestId("viewport").waitFor({ timeout: 30_000 });
    await page.getByTestId("left-sidebar").waitFor();
    await page.getByTestId("right-sidebar").waitFor();
    await page.getByTestId("toolbar-options").waitFor();
    await page.getByText("SmallPen Round Trip", { exact: true }).first().waitFor();

    assert.match(await page.title(), /Penpot/);
    assert.equal(await page.getByText("SmallPen Package Workspace").count(), 0);
    assert.equal(await page.getByTestId("mcp-btn").count(), 0);
    assert.deepEqual(pageErrors, []);

    const homePage = await browser.newPage();
    await homePage.goto(web.url, { waitUntil: "domcontentloaded" });
    await homePage.waitForURL(/#\/smallpen$/, { timeout: 30_000 });
    await homePage.getByRole("heading", { exact: true, name: "SmallPen" }).waitFor();
    await homePage.close();

    const missingPage = await browser.newPage();
    const missingUrl = new URL("/", web.origin);
    missingUrl.hash = "#/workspace?file-id=11111111-1111-4111-8111-111111111111&page-id=22222222-2222-4222-8222-222222222222&layout=layers";
    await missingPage.goto(missingUrl.href, { waitUntil: "domcontentloaded" });
    await missingPage.waitForURL(/#\/smallpen$/, { timeout: 30_000 });
    await missingPage.close();

    await expandCanvas(page);
    await page
      .getByTestId("layer-row")
      .filter({ hasText: "Editable Rectangle" })
      .click();
    await page.getByRole("tab", { name: "Prototype" }).click();
    await page.getByRole("button", { name: "Add interaction" }).click();
    await page.getByRole("button", { name: "Options" }).click();
    await page.getByRole("searchbox", { name: "Destination" }).click();
    await page.getByRole("option", { name: "Destination", exact: true }).click();
    let interaction;
    try {
      interaction = await waitForNavigateInteraction(
        screenPath,
        "node_rectangle",
      );
    } catch (error) {
      throw new Error(
        `${error.message}\n` +
          `page errors: ${pageErrors.map(String).join("\n")}\n` +
          `console errors: ${pageConsoleErrors.join("\n")}\n` +
          `failed responses: ${JSON.stringify(failedResponses)}`,
        { cause: error },
      );
    }
    const flow = await waitForPrototypeFlow(screenPath);
    assert.equal(flow.name, "Flow 1");

    // Exercise Penpot's unchanged page-level Prototype UI: with no selected
    // shape it lists every Flow start and previews from the Flow's play button.
    const viewport = page.getByTestId("viewport");
    const viewportBounds = await viewport.boundingBox();
    assert.ok(viewportBounds, "Workspace viewport must have layout bounds");
    await viewport.click({
      position: {
        x: viewportBounds.width / 2,
        y: Math.max(5, viewportBounds.height - 5),
      },
    });
    try {
      await page
        .getByText("Flow starts", { exact: true })
        .waitFor({ timeout: 10_000 });
    } catch (error) {
      throw new Error(
        `Official page-level Flow list did not appear. Right sidebar:\n${await page
          .getByTestId("right-sidebar")
          .innerText()}`,
        { cause: error },
      );
    }
    await page.getByText("Flow 1", { exact: true }).waitFor();

    const [viewer] = await Promise.all([
      page.context().waitForEvent("page"),
      page.getByRole("button", { exact: true, name: "Flow start" }).click(),
    ]);
    const viewerErrors = [];
    const viewerConsoleErrors = [];
    viewer.on("pageerror", (error) => viewerErrors.push(error));
    viewer.on("console", (message) => {
      if (message.type() === "error") viewerConsoleErrors.push(message.text());
    });
    await viewer.waitForLoadState("domcontentloaded");
    try {
      await viewer.locator('[class*="viewport-container"]').first().waitFor({
        timeout: 30_000,
      });
    } catch (error) {
      throw new Error(
        `Prototype viewer did not render at ${viewer.url()}\n` +
          `page errors: ${viewerErrors.map(String).join("\n")}\n` +
          `console errors: ${viewerConsoleErrors.join("\n")}\n` +
          `body: ${(await viewer.locator("body").innerText()).slice(0, 2000)}`,
        { cause: error },
      );
    }
    assert.deepEqual(viewerErrors, []);
    const workspaceSnapshot = await fetch(`${background.url}/v1/workspace`).then(
      (response) => response.json(),
    );
    const rectangleId =
      workspaceSnapshot.runtime.nodes.scr_roundtrip.pres_desktop.node_rectangle;
    const viewerTextId =
      workspaceSnapshot.runtime.nodes.scr_roundtrip.pres_desktop.node_viewer_text;
    const destinationId =
      workspaceSnapshot.runtime.nodes.scr_roundtrip.pres_desktop.node_destination;
    assert.equal(interaction.destination, destinationId);
    const viewerText = viewer.locator(`#shape-${viewerTextId}:visible`).first();
    await viewerText.getByText("Viewer text without cached layout").waitFor();
    assert.equal(await viewerText.locator("foreignObject").count(), 1);
    await viewer.screenshot({
      path: "/tmp/smallpen-penpot-viewer-dashboard.png",
    });
    await viewer.locator(`#shape-${rectangleId}:visible`).first().click();
    await viewer.locator(`#shape-${destinationId}:visible`).first().waitFor({
      timeout: 10_000,
    });
    await viewer.getByText("Destination screen", { exact: true }).waitFor();
    await viewer.screenshot({
      path: "/tmp/smallpen-penpot-viewer-destination.png",
    });
    await viewer.close();

    await page.getByRole("tab", { name: "Tokens" }).click();
    await page.getByTestId("smallpen-tokens-toolbar-button").click();
    const matrix = page.getByTestId("smallpen-token-matrix");
    await matrix.waitFor();
    await matrix.getByRole("button", { exact: true, name: "Theme" }).waitFor();
    await matrix.getByText("Default", { exact: true }).waitFor();
    const addTheme = matrix.getByRole("button", { name: "Add mode" });
    await addTheme.click();
    await matrix.getByRole("button", { exact: true, name: "Theme-1" }).waitFor();
    await addTheme.click();
    await matrix.getByRole("button", { exact: true, name: "Theme-2" }).waitFor();
    const tokenLibrary = await waitForThemeNames(
      packagePath,
      ["Theme", "Theme-1", "Theme-2"],
    );
    assert.deepEqual(
      tokenLibrary.sets.map(({ name }) => name),
      ["Theme/Default", "Theme-1/Default", "Theme-2/Default"],
    );
    await matrix.getByRole("button", { exact: true, name: "Close" }).click();
    await page.getByRole("tab", { name: "Layers" }).click();

    await expandCanvas(page);
    await writeFile(
      flowIntentPath,
      JSON.stringify({
        nodes: [
          {
            children: [],
            height: 64,
            id: "node_cli_live",
            name: "CLI Live Node",
            type: "ELLIPSE",
            width: 160,
            x: 420,
            y: 180,
          },
        ],
        screenId: "scr_roundtrip",
      }),
    );
    const created = await runCli([
      "flow",
      packagePath,
      "--intent",
      flowIntentPath,
      "--batch-id",
      "live-create-1",
      "--json",
    ]);
    await page.waitForTimeout(2000);
    await page.getByTestId("viewport").waitFor({ timeout: 30_000 });
    await expandCanvas(page);
    await page
      .getByTestId("layer-row")
      .filter({ hasText: "CLI Live Node" })
      .waitFor({ timeout: 30_000 });

    await writeFile(
      modifyBatchPath,
      JSON.stringify({
        baseRevision: created.revision,
        batchId: "live-modify-1",
        operations: [
          {
            changes: {
              name: "CLI Synced Node",
              opacity: 0.42,
              x: 560,
              y: 260,
            },
            nodeId: "node_cli_live",
            presentationId: "pres_desktop",
            screenId: "scr_roundtrip",
            type: "update-presentation-node",
          },
        ],
      }),
    );
    const modified = await runCli([
      "apply",
      packagePath,
      "--batch",
      modifyBatchPath,
      "--json",
    ]);
    await page.waitForTimeout(2000);
    await page.getByTestId("viewport").waitFor({ timeout: 30_000 });
    await expandCanvas(page);
    const syncedLayer = page
      .getByTestId("layer-row")
      .filter({ hasText: "CLI Synced Node" });
    await syncedLayer.waitFor({ timeout: 30_000 });
    await syncedLayer.click();
    const opacity = page
      .locator('section[aria-label="Layer menu section"] input[type="text"]')
      .first();
    assert.equal(await opacity.inputValue(), "42");
    await opacity.fill("77");
    await opacity.press("Enter");
    await waitForNodeField(screenPath, "node_cli_live", "opacity", 0.77);
    await page.waitForTimeout(500);
    const readBack = await runCli(["read-view", packagePath, "--json"]);
    const cliNode = findNode(readBack, "node_cli_live");
    assert.match(readBack.revision, /^[a-f0-9]{64}$/);
    assert.notEqual(readBack.revision, modified.revision);
    assert.deepEqual(
      {
        height: cliNode.height,
        name: cliNode.name,
        opacity: cliNode.opacity,
        type: cliNode.type,
        width: cliNode.width,
        x: cliNode.x,
        y: cliNode.y,
      },
      {
        height: 64,
        name: "CLI Synced Node",
        opacity: 0.77,
        type: "ELLIPSE",
        width: 160,
        x: 560,
        y: 260,
      },
    );
    assert.deepEqual(pageErrors, []);
    if (await page.getByTestId("viewport").count() === 0) {
      const report = await page.evaluate(() => {
        const value = globalThis.app?.main?.errors?.last_report;
        return value == null ? "No error report" : globalThis.cljs.core.pr_str(value);
      });
      throw new Error(`Penpot workspace crashed after persistence:\n${report}`);
    }

    const settingsUrl = new URL(web.url);
    settingsUrl.hash = "#/settings/options";
    await page.goto(settingsUrl.href, { waitUntil: "domcontentloaded" });
    const rendererSwitch = page.getByRole("switch");
    await rendererSwitch.waitFor({ timeout: 30_000 });
    assert.equal(await rendererSwitch.isChecked(), false);
    await rendererSwitch.click();
    await waitForRenderer(background.url, "wasm");

    await page.goto(web.workspaceUrl, { waitUntil: "domcontentloaded" });
    await page.getByTestId("canvas-wasm-shapes").waitFor({ timeout: 30_000 });
    assert.deepEqual(pageErrors, []);

    await page.screenshot({
      path: "/tmp/smallpen-penpot-workspace.png",
    });
    process.stdout.write(
      `${JSON.stringify({
        screenshot: "/tmp/smallpen-penpot-workspace.png",
        status: "passed",
        syncedNode: cliNode,
        ui: "penpot",
        url: web.url,
      })}\n`,
    );
  } finally {
    await browser.close();
    await web.close();
    await background.close();
    await rm(parent, { force: true, recursive: true });
  }
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
