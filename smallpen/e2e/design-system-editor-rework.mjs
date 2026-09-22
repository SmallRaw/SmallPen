// DSE-R05/R06/R07 rework acceptance (2026-09-15) on a NEW build:
//   Phase A (zero-component package):
//     A1 native editor mounts on #/design-system, token specimens are real
//        native layer rows, a specimen row opens the native property panel
//     A2 the insert panel shows the CREATE entry with no components at all
//        (DSE-R05 fix), the insert-instance section is hidden with a reason
//     A3 clicking 新建组件 writes a real component definition + instance
//        into the chosen source container (source readback)
//     A4 undo restores the zero-component source; the create entry survives
//     A5 reload keeps the undone state
//   Phase B (standard package, all specimen types):
//     B1 insert an existing variant into a source container (no drag)
//     B2 per-token-type matrix through the NATIVE panels, each followed by
//        source readback + undo readback: fill, radius, height(sizing),
//        stroke-width, shadow blur; spacing via the native Tokens panel is
//        attempted last (allowed by R07; recorded honestly if unstable)
//     B3 negative control: canonical manifest untouched
// Evidence (log + screenshots) lands in audits/2026-09-15-dse-rework/.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, readFile, rm, writeFile, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { serveLocalPackage } from "@smallpen/background";
import { servePenpotFrontend } from "@smallpen/web";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const repositoryRoot = join(root, "..");
const auditRoot = join(root, "audits", "2026-09-15-dse-rework");
const require = createRequire(join(repositoryRoot, "frontend", "package.json"));
const { chromium } = require("playwright");
const frontendRoot = join(repositoryRoot, "frontend", "resources", "public");

// Extra token sets injected into the scratch copy so the board carries a
// sizing / stroke-width / shadow specimen (the base fixture only ships
// color + radius; the values mirror design-system-editor-fixture.mjs).
const EXTRA_TOKEN_SETS = [
  {
    description: "Control sizing Cells (rework e2e).",
    id: "tset_rework_sizing",
    name: "sizing/md",
    tokens: [
      {
        description: "Control height sizing Cell.",
        id: "tok_rework_sizing_control",
        name: "control",
        type: "sizing",
        value: 40,
      },
    ],
  },
  {
    description: "Stroke width Cells (rework e2e).",
    id: "tset_rework_stroke",
    name: "stroke/md",
    tokens: [
      {
        description: "Border stroke width Cell.",
        id: "tok_rework_stroke_border",
        name: "border-width",
        type: "stroke-width",
        value: 1,
      },
    ],
  },
  {
    description: "Elevation effect Cells (rework e2e).",
    id: "tset_rework_effect",
    name: "effect/md",
    tokens: [
      {
        description: "Elevation shadow effect Cell.",
        id: "tok_rework_effect_elevation",
        name: "elevation-1",
        type: "shadow",
        value: {
          blur: 4,
          color: "rgba(0, 0, 0, 0.24)",
          offsetX: 0,
          offsetY: 2,
          spread: 0,
        },
      },
    ],
  },
];

async function preparePackage(scratch, { zeroComponents, noContainer, readOnly }) {
  const target = join(scratch, "design-system.smallpen");
  await cp(
    join(root, "test", "fixtures", "design-system.smallpen"),
    target,
    { recursive: true },
  );
  const manifestPath = join(target, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  delete manifest.libraries;
  if (noContainer || readOnly) {
    // No-destination: the root canvas stops being a FRAME (a GROUP is not a
    // writable container) and every other node goes away. Read-only: a
    // broken interaction source produces a projection warning, which the
    // Background reports as packageStatus.readOnly (the product's own
    // read-only path).
    for (const screenEntry of manifest.entries.screens) {
      const screenPath = join(target, screenEntry);
      const screen = JSON.parse(await readFile(screenPath, "utf8"));
      for (const presentation of screen.presentations) {
        const nodes = presentation.nodes ?? {};
        if (noContainer) {
          presentation.nodes = {
            node_canvas: { ...nodes.node_canvas, type: "GROUP", children: [] },
          };
        }
        if (readOnly) {
          // Canonical-valid interaction whose destination screen does not
          // exist: the loader accepts it, the Web projection collects the
          // broken destination as a warning -> packageStatus.readOnly.
          presentation.interactions = [
            {
              id: "int_rework_missing_destination",
              name: "Missing destination",
              sourceNodeId: nodes.node_canvas.id,
              trigger: "activate",
              action: {
                type: "navigate",
                screen: { packageId: "pkg_missing", assetId: "scr_missing_destination" },
              },
            },
          ];
        }
      }
      await writeFile(screenPath, JSON.stringify(screen, null, 2));
    }
  }
  if (zeroComponents) {
    manifest.entries.components = [];
    // Instances of the removed component must go too, or the reference
    // validator (missing_component) rejects the package at load.
    for (const screenEntry of manifest.entries.screens) {
      const screenPath = join(target, screenEntry);
      const screen = JSON.parse(await readFile(screenPath, "utf8"));
      for (const presentation of screen.presentations) {
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
  }
  await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  if (!zeroComponents) {
    const tokensPath = join(target, "tokens", "tokens.json");
    const tokens = JSON.parse(await readFile(tokensPath, "utf8"));
    tokens.sets.push(...EXTRA_TOKEN_SETS);
    await writeFile(tokensPath, JSON.stringify(tokens, null, 2));
  }
  return { manifestPath, manifestBefore: JSON.parse(await readFile(manifestPath, "utf8")), packagePath: target };
}

function step(results, label) {
  return async (fn, name) => {
    const stepName = `${label}::${name}`;
    try {
      await fn();
      results.push({ name: stepName, ok: true });
      console.log(`STEP ${stepName}: PASS`);
    } catch (error) {
      results.push({ name: stepName, ok: false, error: String(error) });
      console.error(`STEP ${stepName}: FAIL`);
      throw error;
    }
  };
}

async function runPhase({
  label,
  zeroComponents,
  noContainer = false,
  readOnly = false,
  browser,
}) {
  const dir = join(auditRoot, label);
  await mkdir(dir, { recursive: true });
  const scratch = await mkdtemp(join(tmpdir(), `smallpen-dse-${label}-`));
  const { manifestPath, manifestBefore, packagePath } = await preparePackage(scratch, { zeroComponents, noContainer, readOnly });
  const bg = await serveLocalPackage({ packagePath });
  const web = await servePenpotFrontend({
    backendUrl: bg.url,
    frontendRoot,
    port: 0,
  });
  const pageErrors = [];
  const consoleErrors = [];
  const allLogs = [];
  const failedCommits = [];
  const results = [];
  const stepFn = step(results, label);
  let pageRef = null;
  let failed = false;

  try {
    const endpoint = (path) => {
      const base = new URL(bg.url);
      base.pathname = `${base.pathname.replace(/\/+$/, "")}${path}`;
      return base.href;
    };
    const snapshot = await (await fetch(endpoint("/v1/workspace"))).json();
    const fileId = snapshot.runtime.file;
    const designSystem = () =>
      fetch(endpoint("/v1/ui/design-system")).then((r) => r.json());
    const workspace = () =>
      fetch(endpoint("/v1/workspace")).then((r) => r.json());
    const componentSets = (payload) => {
      const sets = [];
      for (const entry of payload.manifest.entries.components) {
        const value = payload.entries[entry];
        for (const set of Array.isArray(value?.componentSets) ? value.componentSets : [value]) {
          sets.push(set);
        }
      }
      return sets;
    };
    const instanceCount = (payload) => {
      let count = 0;
      for (const entry of payload.manifest.entries.screens) {
        const screen = payload.entries[entry];
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
    const tokenRow = (payload, setName, path) => {
      const inv = payload.tokenInventory;
      const rows = Array.isArray(inv) ? inv : inv?.rows ?? [];
      return rows.find((row) => row.setName === setName && row.path === path);
    };
    const waitFor = async (predicate, label, timeout = 25_000) => {
      const deadline = Date.now() + timeout;
      let last;
      while (Date.now() < deadline) {
        last = await designSystem();
        if (predicate(last)) return last;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      throw new Error(`source readback timeout: ${label}`);
    };
    const waitForToken = (setName, path, predicate, label) =>
      waitFor(
        (payload) => predicate(tokenRow(payload, setName, path)),
        label,
      );

    const page = await browser.newPage({ viewport: { height: 1000, width: 1440 } });
    pageRef = page;
    page.on("pageerror", (error) => {
      pageErrors.push(String(error.message));
      allLogs.push(`pageerror: ${error.message}`);
    });
    page.on("console", (msg) => {
      allLogs.push(`${msg.type()}: ${msg.text().slice(0, 300)}`);
      if (msg.type() === "error" && !msg.text().includes("404")) {
        consoleErrors.push(msg.text().slice(0, 200));
      }
    });
    page.on("response", async (response) => {
      if (response.status() >= 400) {
        let body = "";
        try {
          body = (await response.text()).slice(0, 500);
        } catch {}
        let reqBody = "";
        try {
          reqBody = response.request().postData() ?? "";
          const { writeFileSync } = await import("node:fs");
          writeFileSync(join(dir, `failed-commit-${Date.now()}.json`), reqBody);
        } catch {}
        allLogs.push(`HTTP ${response.status()} ${response.url()}: ${body}`);
        allLogs.push(`FAILED-REQ ${reqBody.slice(0, 200)}`);
      }
    });
    let commitPosts = 0;
    page.on("request", (request) => {
      if (request.url().endsWith("/commit") && request.method() === "POST") {
        commitPosts += 1;
        try {
          const payload = JSON.parse(request.postData());
          const digest = (payload.changes ?? []).map((change) => {
            const attrs = (change.operations ?? []).map((op) => op.attr).join(",");
            return `${change.type}:${change.id}${attrs ? `(${attrs})` : ""}`;
          });
          failedCommits.push(digest);
        } catch {}
      }
    });
    const url = new URL(web.url);
    url.hash = `#/design-system?file-id=${fileId}`;

    const noInternalError = async () => {
      const body = await page.locator("body").innerText();
      assert.ok(!body.includes("Internal Error"), "page shows Internal Error");
    };
    const shot = (name) =>
      page.screenshot({ path: join(dir, `${name}.png`), fullPage: false }).catch(() => {});

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
      await page.waitForTimeout(400);
      return row;
    };
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
      await page.keyboard.press("Escape");
    };
    const findInput = (selector) => {
      // The property aria-label may sit on the input itself or on its
      // wrapper (ds numeric-input variants).
      return page
        .locator(`${selector}, ${selector.replace("input[", "[")} input`)
        .first();
    };
    const setNumeric = async (selector, value, headerAria) => {
      let input = findInput(selector);
      try {
        await input.waitFor({ timeout: 4_000 });
      } catch {
        // The options section may be collapsed: open it via its header.
        if (headerAria) {
          await page
            .locator(`[aria-label="${headerAria}"]`)
            .first()
            .click()
            .catch(() => {});
          await page.waitForTimeout(600);
        }
        input = findInput(selector);
        try {
          await input.waitFor({ timeout: 6_000 });
        } catch (error) {
          const sidebar = await page
            .getByTestId("right-sidebar")
            .innerText()
            .catch(() => "<no sidebar>");
          console.log(`SETNUMERIC-MISS ${selector} sidebar=${sidebar.slice(0, 600)}`);
          throw error;
        }
      }
      await input.click({ clickCount: 3 });
      await input.fill(String(value));
      await input.press("Enter");
    };

    await page.goto(url.href, { waitUntil: "domcontentloaded" });
    await waitWorkspace();

    // -- A1/B-mount: native editor + real layer tree over generated content
    await stepFn(async () => {
      assert.ok(
        (await page.getByTestId("left-sidebar").count()) > 0,
        "layers/left sidebar missing",
      );
      assert.ok(
        (await page.getByTestId("right-sidebar").count()) > 0,
        "properties/right sidebar missing",
      );
      await expandBoard();
      const specimens = await page.getByTestId("dse-token-specimen").count();
      if (zeroComponents) {
        assert.ok(specimens >= 2, `expected color+radius specimens, saw ${specimens}`);
        // R01 real-UI check: the sample tree is absent on a zero-component
        // package and every specimen row is a native layer (no duplicates).
        const rows = await page.getByTestId("layer-row").count();
        await shot("01-mount-specimens");
        console.log(`INFO specimens=${specimens} rows=${rows}`);
      } else {
        assert.ok(specimens >= 5, `expected 5 specimen types, saw ${specimens}`);
        await shot("01-mount-specimens");
      }
      await noInternalError();
      assert.deepEqual(pageErrors, [], "page errors during mount");
    });

    // Click a specimen row and confirm the native property panel opens.
    // (Skipped read-only: the properties panel stays inert there.)
    await (readOnly
      ? Promise.resolve()
      : stepFn(async () => {
      await selectRow("color/light/surface-variant");
      await page.getByTestId("shape-fill-section").waitFor({ timeout: 10_000 });
      await shot("02-specimen-native-panel");
      await noInternalError();
      }));

    if (noContainer || readOnly) {
      // -- negative phases: the panel must refuse with an exact reason ----
      await stepFn(async () => {
        const assetsUrl = new URL(page.url());
        assetsUrl.hash = assetsUrl.hash.includes("layout=")
          ? assetsUrl.hash.replace(/layout=[^&]*/, "layout=assets")
          : `${assetsUrl.hash}&layout=assets`;
        await page.evaluate((hash) => {
          window.location.hash = hash;
        }, assetsUrl.hash.substring(assetsUrl.hash.indexOf("#") + 1));
        await page.reload({ waitUntil: "domcontentloaded" });
        await dismissOnboarding();
        await page.getByTestId("right-sidebar").waitFor({ timeout: 30_000 });
        const panel = page.getByTestId("dse-insert-panel");
        await panel.waitFor({ timeout: 20_000 });
        await page.waitForTimeout(800);
        if (readOnly) {
          const ws = await workspace();
          assert.equal(
            ws.packageStatus?.readOnly,
            true,
            "fixture must surface packageStatus.readOnly",
          );
        }
        const reason = panel.getByTestId("dse-insert-reason");
        await reason.waitFor({ timeout: 10_000 });
        const text = await reason.innerText();
        if (noContainer) {
          assert.match(text, /没有可写源容器/, `unexpected reason: ${text}`);
        } else {
          assert.match(text, /只读/, `unexpected reason: ${text}`);
        }
        assert.equal(
          await panel.getByTestId("dse-create-button").count(),
          0,
          "refused panel must not offer the create entry",
        );
        assert.equal(
          await panel.getByTestId("dse-insert-button").count(),
          0,
          "refused panel must not offer the insert entry",
        );
        assert.equal(
          await panel.getByTestId("dse-insert-target").count(),
          0,
          "refused panel must not offer a fake destination select",
        );
        await shot("negative-refusal");
        await noInternalError();
      });

      console.log(`DSE rework ${label}: PASS`);
      return { failed: false, results };
    }

    if (zeroComponents) {
      // -- A2: create entry visible without any components (DSE-R05) -------
      await stepFn(async () => {
        const assetsUrl = new URL(page.url());
        assetsUrl.hash = assetsUrl.hash.includes("layout=")
          ? assetsUrl.hash.replace(/layout=[^&]*/, "layout=assets")
          : `${assetsUrl.hash}&layout=assets`;
        await page.evaluate((hash) => {
          window.location.hash = hash;
        }, assetsUrl.hash.substring(assetsUrl.hash.indexOf("#") + 1));
        await page.reload({ waitUntil: "domcontentloaded" });
        await dismissOnboarding();
        await page.getByTestId("right-sidebar").waitFor({ timeout: 30_000 });
        const panel = page.getByTestId("dse-insert-panel");
        await panel.waitFor({ timeout: 20_000 });
        await page.waitForTimeout(800);
        assert.ok(
          (await panel.getByTestId("dse-create-button").count()) > 0,
          "create-first-component entry missing on a zero-component package",
        );
        assert.ok(
          (await panel.getByTestId("dse-insert-component").count()) === 0,
          "insert-instance section must not offer an empty component select",
        );
        assert.ok(
          (await panel.getByTestId("dse-insert-no-components").count()) > 0,
          "no-components reason missing",
        );
        await shot("03-create-entry-zero-components");
        await noInternalError();
      });

      // -- A3: create the FIRST component, read definition + instance -----
      await stepFn(async () => {
        const panel = page.getByTestId("dse-insert-panel");
        const target = panel.getByTestId("dse-insert-target");
        await target.waitFor({ timeout: 10_000 });
        await page.waitForTimeout(1_500);
        await target.evaluate((el) => {
          const option = el.options[1];
          el.value = option.value;
          el.dispatchEvent(new Event("change", { bubbles: true }));
        });
        const before = await workspace();
        assert.equal(
          componentSets(before).length,
          0,
          "fixture must start with zero component sets",
        );
        await panel.getByTestId("dse-create-button").click();
        let after = before;
        for (let poll = 0; poll < 30; poll += 1) {
          await page.waitForTimeout(1_000);
          after = await workspace();
          if (componentSets(after).length > 0) break;
        }
        const sets = componentSets(after);
        assert.equal(sets.length, 1, `expected exactly one created set, saw ${sets.length}`);
        // A plain component stores its main instance in located form.
        const component = sets[0];
        assert.ok(component.mainNodeId, "created component has no main node");
        assert.ok(component.name, "created component has no name");
        // The created main instance lives on the source screen as a
        // COMPONENT node bound to the definition.
        let mainFound = null;
        for (const entry of after.manifest.entries.screens) {
          const screen = after.entries[entry];
          for (const presentation of screen.presentations) {
            const node = presentation.nodes[component.mainNodeId];
            if (node) mainFound = node;
          }
        }
        assert.ok(mainFound, "created main instance missing from the source screen");
        assert.ok(
          mainFound.type === "COMPONENT" || mainFound.type === "FRAME",
          `unexpected main node type ${mainFound.type}`,
        );
        await shot("04-first-component-created");
        console.log(
          `INFO create component=${component.id} main=${component.mainNodeId} name=${component.name} type=${mainFound.type} revision=${after.revision}`,
        );

        // Same name, second creation: must yield a DISTINCT component
        // identity (same-name different identity acceptance).
        await panel.getByTestId("dse-create-button").click();
        let again = after;
        for (let poll = 0; poll < 30; poll += 1) {
          await page.waitForTimeout(1_000);
          again = await workspace();
          if (componentSets(again).length > componentSets(after)) break;
        }
        const setsAgain = componentSets(again);
        assert.equal(setsAgain.length, 2, `expected two same-name components, saw ${setsAgain.length}`);
        assert.equal(
          new Set(setsAgain.map((s) => s.id)).size,
          2,
          "same-name creations must keep distinct identities",
        );
        assert.ok(
          setsAgain.every((s) => s.name === "New Component"),
          "both creations should carry the same visible name",
        );
        await shot("04b-second-same-name-component");
        console.log(
          `INFO same-name identities=${setsAgain.map((s) => s.id.slice(0, 13)).join(",")} revision=${again.revision}`,
        );
        await noInternalError();
      });

      // -- A4: undo restores zero components; entry survives ---------------
      await stepFn(async () => {
        // Undo in-session (a reload would clear the undo stack): switch the
        // sidebar back to Layers via its tab, then focus the viewport.
        const layersTab = page
          .getByRole("button", { name: /^layers$/i })
          .or(page.locator('button:has-text("LAYERS")'))
          .first();
        if (await layersTab.count()) {
          await layersTab.click().catch(() => {});
          await page.waitForTimeout(600);
        }
        await page.getByTestId("viewport").click({ position: { x: 20, y: 20 } }).catch(() => {});
        let payload = await workspace();
        let previous = componentSets(payload).length;
        for (let attempt = 0; attempt < 4 && componentSets(payload).length > 0; attempt += 1) {
          await page.keyboard.press("ControlOrMeta+z");
          const deadline = Date.now() + 12_000;
          while (Date.now() < deadline) {
            payload = await workspace();
            if (componentSets(payload).length < previous) break;
            await page.waitForTimeout(1_000);
          }
          previous = componentSets(payload).length;
        }
        console.log(
          `INFO undo diagnostics: sets=${componentSets(payload).length} commitPosts=${commitPosts}`,
        );
        assert.equal(
          componentSets(payload).length,
          0,
          "undo did not remove the created component",
        );
        assert.equal(
          instanceCount(payload),
          0,
          "undo did not remove the created instance",
        );
        // Back to the Assets layout (a reload here is safe: the undo is
        // already committed) and confirm the create entry survived.
        const assetsUrl2 = new URL(page.url());
        assetsUrl2.hash = assetsUrl2.hash.includes("layout=")
          ? assetsUrl2.hash.replace(/layout=[^&]*/, "layout=assets")
          : `${assetsUrl2.hash}&layout=assets`;
        await page.evaluate((hash) => {
          window.location.hash = hash;
        }, assetsUrl2.hash.substring(assetsUrl2.hash.indexOf("#") + 1));
        await page.reload({ waitUntil: "domcontentloaded" });
        await dismissOnboarding();
        await page.getByTestId("right-sidebar").waitFor({ timeout: 30_000 });
        const panel2 = page.getByTestId("dse-insert-panel");
        await panel2.waitFor({ timeout: 20_000 });
        assert.ok(
          (await panel2.getByTestId("dse-create-button").count()) > 0,
          "create entry disappeared after undo",
        );
        await shot("05-undo-restores-zero-components");
      });

      // -- A5: reload keeps the undone state --------------------------------
      await stepFn(async () => {
        await page.reload({ waitUntil: "domcontentloaded" });
        await waitWorkspace();
        const payload = await workspace();
        assert.equal(
          componentSets(payload).length,
          0,
          "undo did not persist across reload",
        );
        await noInternalError();
      });
    } else {
      // -- B1: insert an existing variant into a source container ----------
      await stepFn(async () => {
        const assetsUrl = new URL(page.url());
        assetsUrl.hash = assetsUrl.hash.includes("layout=")
          ? assetsUrl.hash.replace(/layout=[^&]*/, "layout=assets")
          : `${assetsUrl.hash}&layout=assets`;
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
          await control.evaluate((el) => {
            const option = el.options[1];
            el.value = option.value;
            el.dispatchEvent(new Event("change", { bubbles: true }));
          });
        };
        await selectStable("dse-insert-target");
        await selectStable("dse-insert-component");
        const before = await workspace();
        await panel.getByTestId("dse-insert-button").click();
        let after = before;
        for (let poll = 0; poll < 30 && instanceCount(after) <= instanceCount(before); poll += 1) {
          await page.waitForTimeout(1_000);
          after = await workspace();
        }
        assert.ok(
          instanceCount(after) > instanceCount(before),
          `instance count did not grow (before=${instanceCount(before)} after=${instanceCount(after)})`,
        );
        await shot("06-insert-existing-instance");
        await noInternalError();
      });

      // -- B1b: create a NEW component on a multi-component package --------
      await stepFn(async () => {
        const panel = page.getByTestId("dse-insert-panel");
        const target = panel.getByTestId("dse-insert-target");
        await target.waitFor({ timeout: 10_000 });
        await page.waitForTimeout(1_500);
        await target.evaluate((el) => {
          const option = el.options[1];
          el.value = option.value;
          el.dispatchEvent(new Event("change", { bubbles: true }));
        });
        const before = await workspace();
        const setsBefore = componentSets(before).length;
        await panel.getByTestId("dse-create-button").click();
        let after = before;
        for (let poll = 0; poll < 30; poll += 1) {
          await page.waitForTimeout(1_000);
          after = await workspace();
          if (componentSets(after).length > setsBefore) break;
        }
        const sets = componentSets(after);
        assert.equal(
          sets.length,
          setsBefore + 1,
          `expected one more component set, saw ${sets.length} (was ${setsBefore})`,
        );
        // Undo restores the multi-component baseline.
        const layersTab = page
          .getByRole("button", { name: /^layers$/i })
          .or(page.locator('button:has-text("LAYERS")'))
          .first();
        if (await layersTab.count()) {
          await layersTab.click().catch(() => {});
          await page.waitForTimeout(600);
        }
        await page.getByTestId("viewport").click({ position: { x: 20, y: 20 } }).catch(() => {});
        let payload = after;
        for (let attempt = 0; attempt < 3 && componentSets(payload).length > setsBefore; attempt += 1) {
          await page.keyboard.press("ControlOrMeta+z");
          const deadline = Date.now() + 12_000;
          while (Date.now() < deadline) {
            payload = await workspace();
            if (componentSets(payload).length === setsBefore) break;
            await page.waitForTimeout(1_000);
          }
        }
        assert.equal(
          componentSets(payload).length,
          setsBefore,
          "undo did not restore the multi-component baseline",
        );
        console.log(`INFO B1b create+undo ok sets=${setsBefore}`);
      });

      // -- B2: token-type matrix through the native panels ------------------
      const matrix = [
        {
          name: "fill",
          // The first non-white literal color Cell becomes the fill
          // specimen: color/light/surface-variant (#e7e0ec).
          select: "color/light/surface-variant",
          edit: () => setFillColor("#22c55e"),
          expect: (value) => value === "#22c55e",
          undoExpect: (value) => value === "#e7e0ec",
          setName: "color/light",
          path: "surface-variant",
          shotBefore: "07-fill-before",
          shotAfter: "08-fill-after",
        },
        {
          name: "radius",
          select: "radius/md/base",
          edit: () =>
            setNumeric('input[aria-label="Radius"]', 16, "Border radius section"),
          expect: (value) => value === 16,
          undoExpect: (value) => value === 8,
          setName: "radius/md",
          path: "base",
          shotAfter: "09-radius-after",
        },
        {
          name: "sizing-height",
          select: "sizing/md/control",
          edit: () =>
            setNumeric(
              '[aria-label="shape-measures-section"] input[aria-label="Height"]',
              64,
            ),
          expect: (value) => value === 64,
          undoExpect: (value) => value === 40,
          setName: "sizing/md",
          path: "control",
          shotAfter: "10-sizing-after",
        },
        {
          name: "stroke-width",
          select: "stroke/md/border-width",
          edit: () =>
            setNumeric('input[aria-label="Stroke width"]', 3, "stroke-section"),
          expect: (value) => value === 3,
          undoExpect: (value) => value === 1,
          setName: "stroke/md",
          path: "border-width",
          shotAfter: "11-stroke-after",
        },
        {
          name: "shadow-blur",
          select: "effect/md/elevation-1",
          edit: async () => {
            // The blur field lives in the shadow row's advanced popover.
            const more = page
              .locator('[data-testid="shadow-section"] [aria-label="open more options"]')
              .first();
            for (let attempt = 0; attempt < 3; attempt += 1) {
              if (await more.count()) {
                await more.click().catch(() => {});
                await page.waitForTimeout(900);
              }
              const blur = page.locator('input[aria-label="Blur"]').first();
              if (await blur.count()) break;
            }
            // The advanced shadow fields render without aria-labels; the
            // DOM order (verified via dump) is X, BLUR, SPREAD, Y, color,
            // opacity — blur carries the Cell's current value (4).
            const blurInput = page
              .locator('[data-testid="shadow-section"] input')
              .nth(1);
            await blurInput.waitFor({ timeout: 10_000 });
            await blurInput.click({ clickCount: 3 });
            await blurInput.fill("24");
            await blurInput.press("Enter");
          },
          expect: (value) =>
            typeof value === "object" && value !== null && Number(value.blur) === 24,
          undoExpect: (value) =>
            typeof value === "object" && value !== null && Number(value.blur) === 4,
          setName: "effect/md",
          path: "elevation-1",
          shotAfter: "12-shadow-after",
        },
      ];

      // Back to the Layers layout for the matrix.
      const layersUrl = new URL(page.url());
      layersUrl.hash = layersUrl.hash.replace(/layout=[^&]*/, "layout=layers");
      await page.evaluate((hash) => {
        window.location.hash = hash;
      }, layersUrl.hash.substring(layersUrl.hash.indexOf("#") + 1));
      await page.reload({ waitUntil: "domcontentloaded" });
      await waitWorkspace();
      await expandBoard();

      for (const item of matrix) {
        await stepFn(async () => {
          // A panel click can race the section render; one full retry keeps
          // the acceptance honest (the source readback decides, not the UI).
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              if (item.shotBefore) await shot(item.shotBefore);
              await selectRow(item.select);
              await page.waitForTimeout(800);
              await shot(`select-${item.name}`);
              const sidebarText = await page
                .getByTestId("right-sidebar")
                .innerText()
                .catch(() => "<none>");
              console.log(
                `INFO select ${item.name}: sidebar=${sidebarText.replace(/\n/g, " | ").slice(0, 240)}`,
              );
              await item.edit();
              await waitForToken(
                item.setName,
                item.path,
                (row) => row && item.expect(row.effectiveValue ?? row.value),
                `${item.name} token not written to the source`,
                40_000,
              );
              if (item.shotAfter) await shot(item.shotAfter);
              // Undo and prove the Cell is restored in the source.
              await page.keyboard.press("ControlOrMeta+z");
              await waitForToken(
                item.setName,
                item.path,
                (row) => row && item.undoExpect(row.effectiveValue ?? row.value),
                `${item.name} token not restored by undo`,
                40_000,
              );
              await noInternalError();
              return;
            } catch (error) {
              if (attempt === 1) throw error;
              console.log(`INFO retry ${item.name}: ${String(error).slice(0, 120)}`);
            }
          }
        });
      }

    // -- B4: text color edit on the component sample writes the definition
    await stepFn(async () => {
      // Exact-match the sample Label row: the decoration "Token label" row
      // also contains the substring.
      const labelRow = page
        .getByTestId("layer-row")
        .filter({ has: page.getByText("Label", { exact: true }) })
        .first();
      await labelRow.waitFor({ timeout: 20_000 });
      await labelRow.click();
      await page.waitForTimeout(800);
      const rowText = await labelRow.innerText();
      const sidebar = await page
        .getByTestId("right-sidebar")
        .innerText()
        .catch(() => "<none>");
      console.log(
        `INFO B4 row=${rowText.replace(/\n/g, "|")} sidebar=${sidebar.replace(/\n/g, "|").slice(0, 220)}`,
      );
      await shot("14a-text-color-selected");
      await setFillColor("#22d3ee");
      await shot("14b-text-color-edited");
      const ws0 = await workspace();
      const componentsEntry = ws0.manifest.entries.components[0];
      assert.ok(componentsEntry, "package has no components entry");
      let sampleLogged = false;
      let hit = false;
      const deadline = Date.now() + 40_000;
      while (Date.now() < deadline && !hit) {
        const wsNow = await workspace();
        const served = JSON.stringify(wsNow.entries?.[componentsEntry] ?? "");
        let raw = "";
        try {
          raw = await readFile(
            join(scratch, "design-system.smallpen", componentsEntry),
            "utf8",
          );
        } catch {}
        hit = served.includes("#22d3ee") || raw.includes("#22d3ee");
        if (!sampleLogged) {
          sampleLogged = true;
          console.log(
            `INFO B4 served-hit=${served.includes("#22d3ee")} file-hit=${raw.includes("#22d3ee")} revision=${wsNow.revision}`,
          );
        }
        if (!hit) await page.waitForTimeout(1_000);
      }
      assert.ok(hit, "text color edit did not reach the component definition");
      await shot("14-text-color-after");
      await page.keyboard.press("ControlOrMeta+z");
      const undoDeadline = Date.now() + 25_000;
      let gone = false;
      while (Date.now() < undoDeadline && !gone) {
        try {
          gone = !(
            await readFile(
              join(scratch, "design-system.smallpen", componentsEntry),
              "utf8",
            )
          ).includes("#22d3ee");
        } catch {}
        if (!gone) await page.waitForTimeout(1_000);
      }
      assert.ok(gone, "undo did not restore the label color");
      await noInternalError();
    });

    // -- B5: spacing Cell edited through the native TOKENS panel ----------
    // The Tokens panel is file-scoped; if the generated-page context blocks
    // the context menu, the same panel on the normal page (Fixture Canvas)
    // is the fallback the card allows.
    await stepFn(async () => {
      const openTokensPanel = async () => {
        await page
          .locator('button:has-text("TOKENS")')
          .first()
          .click();
        await page.waitForTimeout(1_200);
      };
      const findPill = () =>
        page
          .getByTestId("left-sidebar")
          .getByText("small", { exact: true })
          .first();
      const tryContextClick = async (locator) => {
        const box = await locator.boundingBox();
        if (!box) return false;
        await page.mouse.click(
          box.x + box.width / 2,
          box.y + box.height / 2,
          { button: "right" },
        );
        await page.waitForTimeout(1_200);
        return (await menu.count()) > 0;
      };
      const menu = page.getByTestId("tokens-context-menu-for-token");
      const openMenu = async () => {
        for (const context of ["ds-page", "normal-page"]) {
          await openTokensPanel();
          const pill = findPill();
          await pill.waitFor({ timeout: 15_000 });
          if (await tryContextClick(pill)) return context;
          const parent = pill.locator("xpath=..");
          if (await tryContextClick(parent)) return context;
          if (context === "ds-page") {
            // Move to the normal screen page and retry there.
            const pageRow = page
              .getByTestId("layer-row")
              .filter({ hasText: "Design System Fixture · Desktop" })
              .first();
            if (await pageRow.count()) {
              await pageRow.click().catch(() => {});
              await page.waitForTimeout(1_500);
            }
          }
        }
        return null;
      };

      await openTokensPanel();
      const pill = findPill();
      await pill.waitFor({ timeout: 15_000 });
      await shot("15a-spacing-context-menu");
      const usedContext = await openMenu();
      console.log(`INFO B5 context-menu opened on: ${usedContext}`);
      await menu
        .getByText(/Edit spacing token/i)
        .first()
        .click();
      const modal = page.getByTestId("token-update-create-modal");
      await modal.waitFor({ timeout: 8_000 });
      const valueInput = modal
        .locator('input[aria-label="Value"], [aria-label="Value"] input')
        .first();
      await valueInput.waitFor({ timeout: 8_000 });
      await valueInput.click({ clickCount: 3 });
      await valueInput.fill("12");
      await page
        .getByRole("button", { name: /^save$/i })
        .first()
        .click();
      await waitForToken(
        "spacing/md",
        "space.small",
        (row) => row && Number(row.effectiveValue ?? row.value) === 12,
        "spacing token not written from the Tokens panel",
        40_000,
      );
      await shot("15-spacing-tokens-panel");
      await page
        .getByTestId("viewport")
        .click({ position: { x: 20, y: 20 } })
        .catch(() => {});
      await page.keyboard.press("ControlOrMeta+z");
      await waitForToken(
        "spacing/md",
        "space.small",
        (row) => row && Number(row.effectiveValue ?? row.value) === 4,
        "spacing token not restored by undo",
        40_000,
      );
      await noInternalError();
    });
    }

    // -- final: canonical manifest untouched --------------------------------
    await stepFn(async () => {
      const manifestAfter = JSON.parse(await readFile(manifestPath, "utf8"));
      assert.equal(
        manifestAfter.entries.screens.length,
        manifestBefore.entries.screens.length,
        "generated page leaked into canonical screens",
      );
      assert.equal(
        manifestAfter.entries.components.length,
        manifestBefore.entries.components.length,
        "component entries drifted",
      );
    });

    console.log(`DSE rework ${label}: PASS`);
  } catch (error) {
    failed = true;
    console.error(`DSE rework ${label}: FAIL`);
    console.error(error);
    console.error("pageErrors:", JSON.stringify(pageErrors));
    console.error("consoleErrors:", JSON.stringify(consoleErrors.slice(0, 8)));
    console.error("failedCommits:", JSON.stringify(failedCommits));
    console.error("debugLogs:", allLogs.filter((l) => l.startsWith("HTTP") || l.startsWith("FAILED-REQ")).join("\n"));
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
    await web.close?.();
    await bg.close?.();
    await rm(scratch, { recursive: true, force: true });
    console.log(`STEP SUMMARY ${label} ` + JSON.stringify(results));
  }
  return { failed, results };
}

const browser = await chromium.launch({
  headless: true,
  args: ["--disable-dev-shm-usage", "--disable-gpu", "--disable-software-rasterizer"],
});

const phases = [];
for (const spec of [
  { label: "DSE-R06-phaseA-zero-components", zeroComponents: true },
  { label: "DSE-R07-phaseB-matrix", zeroComponents: false },
  { label: "DSE-R06-phaseC-no-container", noContainer: true },
  { label: "DSE-R06-phaseD-read-only", readOnly: true },
]) {
  try {
    phases.push(await runPhase({ ...spec, browser }));
  } catch (error) {
    console.error(`PHASE ${spec.label} crashed:`, String(error).slice(0, 300));
    phases.push({ failed: true, results: [] });
  }
}
await browser.close();
process.exitCode = phases.some((phase) => phase.failed) ? 1 : 0;
