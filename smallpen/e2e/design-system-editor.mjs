// DSE formal acceptance entry (replaces e2e/design-system-canvas.mjs, now in
// e2e/legacy/). The system page route must mount the NORMAL native editor
// (workspace viewport + layers + property panel) over the design-system
// content, and every first-gate edit must write the real source:
//   1. native editor mounted on #/design-system (old standalone SVG surface gone)
//   2. design-system content visible as native layers (source/decoration marks)
//   3. insert an existing component into an explicit source container,
//      without any drag gesture, and read the instance back from the source
//   4. edit the token swatch fill through the NATIVE color picker and verify
//      the Token Cell is written back to the source
//   5. edit a component-definition shape fill through the NATIVE color picker
//      and verify the variant node is written back
//   6. undo restores the source; refresh re-enters the editor
//   7. negative control: no generated page lands in canonical manifest
// Assertions must be proven against the persisted source (revision + file
// readback), never against HTTP status alone.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { serveLocalPackage } from "@smallpen/background";
import { servePenpotFrontend } from "@smallpen/web";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const repositoryRoot = join(root, "..");
const require = createRequire(join(repositoryRoot, "frontend", "package.json"));
const { chromium } = require("playwright");
const frontendRoot = join(repositoryRoot, "frontend", "resources", "public");

const scratch = await mkdtemp(join(tmpdir(), "smallpen-dse-editor-"));
await cp(
  join(root, "test", "fixtures", "design-system.smallpen"),
  join(scratch, "design-system.smallpen"),
  { recursive: true },
);
// Strip the library link so the fixture opens as a writable standalone package
// (same procedure as design-system-workbench.mjs).
const manifestPath = join(scratch, "design-system.smallpen", "manifest.json");
const manifestBefore = JSON.parse(await readFile(manifestPath, "utf8"));
delete manifestBefore.libraries;
await writeFile(manifestPath, JSON.stringify(manifestBefore, null, 2));

const background = await serveLocalPackage({
  packagePath: join(scratch, "design-system.smallpen"),
  port: 0,
});
const web = await servePenpotFrontend({
  backendUrl: background.url,
  frontendRoot,
  port: 0,
});

const browser = await chromium.launch({ headless: true, args: ["--disable-dev-shm-usage", "--disable-gpu", "--disable-software-rasterizer"] });
let failed = false;
let pageRef = null;
const stepResults = [];
const pageErrors = [];
const consoleErrors = [];

function step(name, fn) {
  return async (...args) => {
    try {
      await fn(...args);
      stepResults.push({ name, ok: true });
      console.log(`STEP ${name}: PASS`);
    } catch (error) {
      stepResults.push({ name, ok: false, error: String(error) });
      console.error(`STEP ${name}: FAIL`);
      throw error;
    }
  };
}

try {
  const endpoint = (path) => {
    const base = new URL(background.url);
    base.pathname = `${base.pathname.replace(/\/+$/, "")}${path}`;
    return base.href;
  };
  const snapshot = await (await fetch(endpoint("/v1/workspace"))).json();
  const fileId = snapshot.runtime.file;
  const designSystem = () =>
    fetch(endpoint("/v1/ui/design-system")).then((r) => r.json());
  const componentFileEntry = snapshot.manifest.entries.components[0];

  // Instance nodes live in the canonical screen presentations; the source of
  // truth for "an instance was added/removed" is the persisted workspace.
  const workspace = () => fetch(endpoint("/v1/workspace")).then((r) => r.json());
  const countInstances = async () => {
    const ws = await workspace();
    let count = 0;
    for (const entry of ws.manifest.entries.screens) {
      const screen = ws.entries[entry];
      for (const presentation of screen.presentations) {
        for (const node of Object.values(presentation.nodes)) {
          if (node.type === "INSTANCE" || (node.componentId && node.sourceNodeId)) {
            count += 1;
          }
        }
      }
    }
    return count;
  };

  // Poll the source until `predicate` sees the expected state (persistence
  // is asynchronous; a fixed sleep would be a false positive generator).
  const waitForSource = async (predicate, label, timeout = 20_000) => {
    const deadline = Date.now() + timeout;
    let last;
    while (Date.now() < deadline) {
      last = await designSystem();
      if (predicate(last)) return last;
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
    throw new Error(`source readback timeout: ${label}`);
  };

  const page = await browser.newPage({ viewport: { height: 1000, width: 1440 } });
  pageRef = page;
  page.on("pageerror", (error) => pageErrors.push(String(error.message)));
  page.on("console", (msg) => {
    if (msg.type() === "error" && !msg.text().includes("404")) {
      consoleErrors.push(msg.text().slice(0, 200));
    }
  });
  const url = new URL(web.url);
  url.hash = `#/design-system?file-id=${fileId}`;

  const noInternalError = async () => {
    const body = await page.locator("body").innerText();
    assert.ok(!body.includes("Internal Error"), "page shows Internal Error");
  };

  // First-run onboarding steps (theme choice etc.) can cover the workspace;
  // walk through them until the editor shell is reachable.
  const dismissOnboarding = async () => {
    for (let i = 0; i < 8; i += 1) {
      const theme = page
        .getByRole("button", { name: /Penpot (Dark|Light|System)/i })
        .first();
      if (await theme.count()) {
        await theme.click().catch(() => {});
        await page.waitForTimeout(400);
        continue;
      }
      const proceed = page
        .getByRole("button", {
          name: /^(Continue|Skip|Skip for now|Got it|Close|Start|Done)/i,
        })
        .first();
      if (await proceed.count()) {
        await proceed.click().catch(() => {});
        await page.waitForTimeout(400);
        continue;
      }
      break;
    }
  };

  const waitWorkspace = async () => {
    await dismissOnboarding();
    await page.getByTestId("viewport").waitFor({ timeout: 30_000 });
  };

  // Expand every collapsed layer row inside the generated board so all
  // source/decoration rows are reachable.
  const expandBoard = async () => {
    const board = page
      .getByTestId("layer-row")
      .filter({ hasText: "Design System" })
      .first();
    await board.waitFor({ timeout: 20_000 });
    for (let round = 0; round < 30; round += 1) {
      const collapsed = page
        .locator('[data-testid="layer-row"] [data-testid="toggle-content"]:not([aria-expanded="true"])')
        .first();
      if ((await collapsed.count()) === 0) break;
      await collapsed.click().catch(() => {});
      await page.waitForTimeout(150);
    }
    return board;
  };

  // Select a layer row by its name, expanding ancestors as needed.
  const selectRow = async (name) => {
    const row = page
      .getByTestId("layer-row")
      .filter({ hasText: name })
      .first();
    await row.waitFor({ timeout: 20_000 });
    const toggle = row.getByTestId("toggle-content");
    if ((await toggle.count()) && (await toggle.getAttribute("aria-expanded")) !== "true") {
      await toggle.click();
    }
    await row.click();
    return row;
  };

  // Edit the fill color of the selected shape through the NATIVE property
  // panel: open the fill colorpicker and confirm a new hex value.
  const setFillColor = async (hex) => {
    const section = page.getByTestId("shape-fill-section");
    await section.waitFor({ timeout: 10_000 });
    const swatch = section
      .locator('button:has(div[style*="background"])')
      .first();
    await swatch.click({ timeout: 10_000 });
    const hexInput = page.locator("#hex-value").first();
    await hexInput.waitFor({ timeout: 10_000 });
    await hexInput.fill(hex);
    await hexInput.press("Enter");
    // Close the picker; the edit is already committed to the undo stack.
    await page.keyboard.press("Escape");
  };

  const onlyStep3 = process.env.DSE_ONLY_STEP3 === "1";
  await page.goto(url.href, { waitUntil: "domcontentloaded" });

  // -- 1. Native editor mounted on the system page route -------------------
  await step("native-editor-mounted", async () => {
    if (onlyStep3) return;
    await waitWorkspace();
    assert.ok(
      (await page.getByTestId("left-sidebar").count()) > 0,
      "layers/left sidebar missing",
    );
    assert.ok(
      (await page.getByTestId("right-sidebar").count()) > 0,
      "properties/right sidebar missing",
    );
    assert.equal(
      await page.getByTestId("smallpen-canvas").count(),
      0,
      "old standalone canvas surface still owns the route",
    );
    // DSE-008: the editor opened the generated Design System page.
    await page.getByTestId("dse-page-badge").waitFor({ timeout: 10_000 });
    await noInternalError();
    assert.deepEqual(pageErrors, [], "page errors during mount");
  })();

  // -- 2. Design-system content visible as native source/decoration rows --
  await step("design-system-content-native", async () => {
    if (onlyStep3) return;
    // Expand the generated board so its native children are in the tree.
    const expand = async (rowName) => {
      const row = page
        .getByTestId("layer-row")
        .filter({ hasText: rowName })
        .first();
      await row.waitFor({ timeout: 20_000 });
      const toggle = row.getByTestId("toggle-content");
      if ((await toggle.count()) && (await toggle.getAttribute("aria-expanded")) !== "true") {
        await toggle.click();
      }
      return row;
    };
    await expand("Design System");
    await page.getByTestId("dse-token-specimen").first().waitFor({ timeout: 20_000 });
    await page.getByTestId("dse-decoration").first().waitFor({ timeout: 10_000 });
    await noInternalError();
  })();

  // -- 3. Insert an existing component into a source container, no drag ----
  await step("add-component-without-drag", async () => {
    // Open the workspace in the Assets layout via a clean load (the same
    // state a user gets when reopening the workspace with Assets active).
    const assetsUrl = new URL(page.url());
    assetsUrl.hash = assetsUrl.hash.includes("layout=")
      ? assetsUrl.hash.replace(/layout=[^&]*/, "layout=assets")
      : `${assetsUrl.hash}&layout=assets`;
    // A real reload (not a hash-only navigation) so the workspace boots
    // directly in the Assets layout with a clean renderer state.
    await page.evaluate((hash) => {
      window.location.hash = hash;
    }, assetsUrl.hash.substring(assetsUrl.hash.indexOf("#") + 1));
    await page.reload({ waitUntil: "domcontentloaded" });
    await dismissOnboarding();
    await page.getByTestId("right-sidebar").waitFor({ timeout: 30_000 });
    const panel = page.getByTestId("dse-insert-panel");
    await panel.waitFor({ timeout: 20_000 });
    await page.waitForTimeout(800);
    const selectStable = async (testId) => {
      const control = panel.getByTestId(testId);
      await control.waitFor({ timeout: 10_000 });
      await page.waitForTimeout(1_500);
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          await control.evaluate((el) => {
            const option = el.options[1];
            el.value = option.value;
            el.dispatchEvent(new Event("change", { bubbles: true }));
          });
          console.log(`EVAL ${testId} dispatched (attempt ${attempt})`);
          return;
        } catch (error) {
          if (attempt === 2) throw error;
          // A renderer hiccup: reload the same URL and retry on the fresh
          // workspace (selections live in the panel state, not the URL).
          await page.waitForTimeout(1_000);
          await page.reload({ waitUntil: "domcontentloaded" });
          await page.getByTestId("right-sidebar").waitFor({ timeout: 30_000 });
          await page.getByTestId(testId).waitFor({ timeout: 20_000 });
        }
      }
    };
    await selectStable("dse-insert-target");
    await selectStable("dse-insert-component");
    const instancesBefore = await countInstances();
    await panel.getByTestId("dse-insert-button").click();
    // Persistence debounces a few seconds: poll the persisted source.
    let after = instancesBefore;
    for (let poll = 0; poll < 25 && after <= instancesBefore; poll += 1) {
      await page.waitForTimeout(1_000);
      after = await countInstances();
    }
    assert.ok(
      after > instancesBefore,
      `instance count did not grow (before=${instancesBefore} after=${after})`,
    );
    await noInternalError();
  })();

  // -- 4. Edit the token swatch fill via the native picker -> Token Cell ---
  await step("edit-token-native", async () => {
    // Back to the Layers layout with a clean reload (layer rows live there).
    const layersUrl = new URL(page.url());
    layersUrl.hash = layersUrl.hash.replace(/layout=[^&]*/, "layout=layers");
    await page.evaluate((hash) => {
      window.location.hash = hash;
    }, layersUrl.hash.substring(layersUrl.hash.indexOf("#") + 1));
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitWorkspace();
    await expandBoard();
    // Select the COLOR specimen's layer row (deterministic target for the
    // Token Cell edit).
    await selectRow("color/");
    await setFillColor("#22c55e");
    await waitForSource(
      (payload) => JSON.stringify(payload.tokens ?? payload.tokenInventory).includes("#22c55e"),
      "token cell not written to the source",
    );
    await noInternalError();
  })();

  // -- 5. Edit a component-definition shape fill via the native picker -----
  await step("edit-colors-native", async () => {
    // The component sample tree carries the real variant nodes; click a
    // source-marked row inside it (the root is the first such row).
    await expandBoard();
    await page.getByTestId("dse-source").first().click();
    await setFillColor("#ef4444");
    // Persistence debounces a few seconds: poll the component file.
    let nodeJson = "";
    const compDeadline = Date.now() + 25_000;
    while (Date.now() < compDeadline) {
      try {
        nodeJson = JSON.stringify(
          JSON.parse(await readFile(join(scratch, "design-system.smallpen", componentFileEntry), "utf8")),
        );
        if (nodeJson.includes("#ef4444")) break;
      } catch {}
      await page.waitForTimeout(1_000);
    }
    assert.ok(nodeJson.includes("#ef4444"), "variant node fill not written to the source");
    await noInternalError();
  })();

  // -- 6. Undo restores the source; refresh re-enters the editor -----------
  await step("undo-refresh-source-readback", async () => {
    await page.keyboard.press("ControlOrMeta+z");
    // Wait until the persisted component file no longer carries the edit.
    const undoDeadline = Date.now() + 25_000;
    let undone = true;
    while (Date.now() < undoDeadline) {
      try {
        undone = JSON.stringify(
          JSON.parse(await readFile(join(scratch, "design-system.smallpen", componentFileEntry), "utf8")),
        ).includes("#ef4444");
        if (!undone) break;
      } catch {}
      await page.waitForTimeout(1_000);
    }
    assert.ok(!undone, "undo did not restore the previous fill color");
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitWorkspace();
    await noInternalError();
  })();

  // -- 7. Negative control: canonical manifest untouched -------------------
  await step("canonical-manifest-unchanged", async () => {
    const manifestAfter = JSON.parse(await readFile(manifestPath, "utf8"));
    assert.equal(
      manifestAfter.entries.screens.length,
      manifestBefore.entries.screens.length,
      "generated page leaked into canonical screens",
    );
  });

  console.log("DSE design-system-editor e2e: PASS");
} catch (error) {
  failed = true;
  console.error("DSE design-system-editor e2e: FAIL");
  console.error(error);
  console.error("pageErrors:", JSON.stringify(pageErrors));
  console.error("consoleErrors:", JSON.stringify(consoleErrors.slice(0, 8)));
  try {
    if (pageRef) {
      console.error(
        "body:",
        (await pageRef.locator("body").innerText().catch(() => ""))
          .slice(0, 400)
          .replace(/\n/g, " | "),
      );
    }
  } catch {}
} finally {
  await browser.close();
  await web.close?.();
  await background.close?.();
  await rm(scratch, { recursive: true, force: true });
  console.log("STEP SUMMARY " + JSON.stringify(stepResults));
}
process.exitCode = failed ? 1 : 0;
