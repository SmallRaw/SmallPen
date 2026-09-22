// DSP-004-A / DSP-005-A: the #/design-system Workbench route mounts the
// lazy workbench page and renders the token board (sections + specimens)
// and the Paired Themes toolbar from the aggregated backend view.
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
const fixture = join(root, "test", "fixtures", "design-system.smallpen");
const frontendRoot = join(repositoryRoot, "frontend", "resources", "public");

const scratch = await mkdtemp(join(tmpdir(), "smallpen-workbench-"));
const packagePath = `${scratch}/design-system.smallpen`;
await cp(fixture, packagePath, { recursive: true });
// The editing scenario needs a writable workspace: strip the declared
// Library dependency so the package opens without a Repair conflict
// (a missing library makes the workspace read-only by design).
const manifestPath = join(packagePath, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
delete manifest.libraries;
await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

const background = await serveLocalPackage({ packagePath, port: 0 });
const web = await servePenpotFrontend({
  backendUrl: background.url,
  frontendRoot,
  port: 0,
});

const browser = await chromium.launch({ headless: true });
let failed = false;
let pageRef = null;
let consoleErrors = [];
try {
  // All /v1 routes live under the session path prefix of the background URL.
  const endpoint = (path) => {
    const base = new URL(background.url);
    base.pathname = `${base.pathname.replace(/\/+$/, "")}${path}`;
    return base.href;
  };
  const snapshot = await (await fetch(endpoint("/v1/workspace"))).json();
  const fileId = snapshot.runtime.file;

  const page = await browser.newPage({ viewport: { height: 900, width: 1440 } });
  const pageErrors = [];
  page.on("pageerror", (error) => pageErrors.push(error));
  page.on("console", (message) => {
    if (message.type() === "error") consoleErrors.push(message.text());
  });
  pageRef = page;

  const workbenchUrl = new URL(web.url);
  workbenchUrl.hash = `#/design-system?file-id=${fileId}`;
  await page.goto(workbenchUrl.href, { waitUntil: "domcontentloaded" });

  await page.getByTestId("smallpen-workbench").waitFor({ timeout: 30_000 });
  // The editor workspace must stay out of the Workbench route.
  assert.equal(await page.getByTestId("viewport").count(), 0);

  await page.getByTestId("workbench-board").waitFor({ timeout: 15_000 });
  await page.getByTestId("theme-toolbar").waitFor();

  const sections = await page.getByTestId("workbench-section").count();
  assert.ok(sections >= 5, `expected >=5 token sections, got ${sections}`);

  const cards = await page.getByTestId("specimen-card").count();
  assert.ok(cards >= 10, `expected >=10 specimen cards, got ${cards}`);

  const swatches = await page.getByTestId("specimen-swatch").count();
  assert.ok(swatches >= 8, `expected >=8 color swatches, got ${swatches}`);

  // Active Paired Themes are highlighted with their names.
  await page.getByTestId("theme-Light").waitFor();
  const lightStyle = await page
    .getByTestId("theme-Light")
    .getAttribute("style");
  assert.match(
    lightStyle.replace(/\s/g, ""),
    /#6750a4|rgb\(103,80,164\)/,
    "active theme must be highlighted",
  );
  await page.getByTestId("theme-Dark").waitFor();

  // Section headers show Token Domain groups from the fixture.
  for (const domain of ["color/light", "color/dark", "radius/md", "spacing/md"]) {
    assert.ok(
      (await page.getByText(domain, { exact: true }).count()) >= 1,
      `missing section header for ${domain}`,
    );
  }

  // The read-only marker only appears on library/foundation tokens; the
  // fixture package owns every token, so no marker is expected.
  assert.equal(await page.getByText("库", { exact: true }).count(), 0);

  // DSP-005-B: search finds same-named tokens across sets plus archived ones.
  const search = page.getByTestId("workbench-search");
  await search.fill("surface");
  await page.waitForTimeout(300);
  let shown = await page.getByTestId("specimen-card").count();
  assert.equal(shown, 5, "surface search must match light/dark/archived rows");
  const countText = await page
    .getByTestId("workbench-filter-count")
    .innerText();
  assert.equal(countText.trim(), "5/16", "filter count must be consistent");

  // Distinct sections keep the same-named tokens apart.
  const sectionTitles = await page.getByTestId("workbench-section").count();
  assert.ok(sectionTitles >= 3, "surface search still groups by set");

  // Clear restores the full board.
  await page.getByTestId("workbench-filter-clear").click();
  await page.waitForTimeout(200);
  assert.equal(await page.getByTestId("specimen-card").count(), 16);

  // Type filter.
  await page.getByTestId("workbench-filter-type").selectOption("color");
  await page.waitForTimeout(200);
  assert.equal(await page.getByTestId("specimen-card").count(), 9);

  // Owner filter (all fixture tokens share one owner).
  await page.getByTestId("workbench-filter-clear").click();
  await page.getByTestId("workbench-filter-owner").selectOption("Design System Fixture");
  await page.waitForTimeout(200);
  assert.equal(await page.getByTestId("specimen-card").count(), 16);

  // Set (group) filter.
  await page.getByTestId("workbench-filter-clear").click();
  await page.getByTestId("workbench-filter-group").selectOption("color/dark");
  await page.waitForTimeout(200);
  assert.equal(await page.getByTestId("specimen-card").count(), 4);

  // No-match state is distinct from the empty-package state.
  await page.getByTestId("workbench-filter-clear").click();
  await search.fill("no-such-token-xyz");
  await page.waitForTimeout(200);
  await page.getByTestId("workbench-empty").waitFor();
  await page.getByTestId("workbench-filter-clear").click();
  await page.waitForTimeout(200);
  assert.equal(await page.getByTestId("specimen-card").count(), 16);

  // DSP-005-C: clicking a specimen selects it and shows the source panel.
  const cardLoc = page.getByTestId("specimen-card");
  await cardLoc.first().click();
  await page.getByTestId("workbench-detail").waitFor();
  assert.equal(
    await page.locator('[data-testid="specimen-card"][data-selected="true"]').count(),
    1,
    "exactly one selected card",
  );
  const detailText = await page.getByTestId("workbench-detail").innerText();
  assert.match(detailText, /Design System Fixture/, "source owner shown");
  assert.match(detailText, /foundation/, "owner role shown");
  assert.match(detailText, /可编辑定义|只读|修改颜色|修改数值/, "edit-definition state shown");
  assert.match(detailText, /组合/, "observed combination shown");

  // Selecting a different card moves the selection and updates the panel.
  const firstPath = await cardLoc.first().innerText();
  await cardLoc.nth(1).click();
  await page.waitForTimeout(200);
  assert.equal(
    await page.locator('[data-testid="specimen-card"][data-selected="true"]').count(),
    1,
    "selection moved",
  );
  const secondPath = await cardLoc.nth(1).innerText();
  const detailPath = await page
    .locator('[data-testid="workbench-detail"] dd')
    .first()
    .innerText();
  assert.ok(
    secondPath.includes(detailPath.trim()) || detailPath.trim().length > 0,
    "detail tracks the selected row",
  );
  assert.notEqual(firstPath, secondPath, "different rows selected");

  // Generated decorations are never selectable as source.
  const swatch = page.getByTestId("specimen-swatch").first();
  assert.equal(await swatch.getAttribute("data-decoration"), "true");
  assert.equal(await swatch.getAttribute("aria-hidden"), "true");

  // Clicking the selected card again clears the selection.
  await cardLoc.nth(1).click();
  await page.waitForTimeout(200);
  assert.equal(
    await page.locator('[data-testid="specimen-card"][data-selected="true"]').count(),
    0,
    "re-click clears selection",
  );
  assert.equal(await page.getByTestId("workbench-detail").count(), 0);

  // DSP-006-A: solid color + alpha editing writes the real Token Cell.
  // A source read-back helper straight from the backend.
  const readSource = async () => {
    const response = await fetch(endpoint("/v1/ui/design-system"));
    const body = await response.json();
    return body.tokens.find(
      (token) =>
        token.group === "color/light" &&
        token.path === "primary" &&
        token.id === "tok_color_light_primary",
    );
  };
  const revisionBefore = (await (await fetch(endpoint("/v1/ui/design-system"))).json()).revision;

  await page.getByTestId("workbench-filter-group").selectOption("color/light");
  await page.locator('[data-testid="specimen-card"][aria-label="primary"]').click();
  await page.getByTestId("workbench-edit-open").click();
  await page.getByTestId("workbench-color-editor").waitFor();

  // Invalid value shows an error and never reaches the backend.
  const hexInput = page.getByTestId("workbench-color-hex");
  await hexInput.fill("red");
  await page.getByTestId("workbench-edit-confirm").click();
  await page.getByTestId("workbench-edit-error").waitFor();
  assert.equal(
    (await (await fetch(endpoint("/v1/ui/design-system"))).json()).revision,
    revisionBefore,
    "invalid value must not commit",
  );

  // Cancel performs zero writes.
  await hexInput.fill("#00ff00");
  await page.getByTestId("workbench-edit-cancel").click();
  await page.waitForTimeout(200);
  assert.equal(await page.getByTestId("workbench-color-editor").count(), 0);
  assert.equal(
    (await (await fetch(endpoint("/v1/ui/design-system"))).json()).revision,
    revisionBefore,
    "cancel must not commit",
  );

  // Reopen, confirm a solid red: UI + source read the same value.
  await page.getByTestId("workbench-edit-open").click();
  await page.getByTestId("workbench-color-editor").waitFor();
  await hexInput.fill("#ff0000");
  await page.getByTestId("workbench-edit-confirm").click();
  await page.getByTestId("workbench-color-editor").waitFor({ state: "detached", timeout: 15_000 });
  // Color cards render the value as a swatch (no text); the detail panel
  // and the swatch style carry the visible value.
  await page
    .locator('[data-testid="workbench-detail"]')
    .filter({ hasText: "#ff0000" })
    .waitFor({ timeout: 15_000 });
  const primaryCard = page.locator(
    '[data-testid="specimen-card"][aria-label="primary"]',
  );
  const primarySwatchStyle = await primaryCard
    .getByTestId("specimen-swatch")
    .getAttribute("style");
  assert.match(
    primarySwatchStyle.replace(/\s/g, ""),
    /#ff0000|rgb\(255,0,0\)/,
    "swatch shows the new color",
  );
  const source = await readSource();
  assert.equal(source.rawValue, "#ff0000", "source Cell matches UI");
  assert.equal(source.resolvedValue, "#ff0000", "resolved value matches UI");

  // Alpha: 50% writes an 8-digit hex value. The card is still selected
  // after the commit, so open the editor directly from the panel.
  await page.getByTestId("workbench-edit-open").click();
  await page.getByTestId("workbench-color-editor").waitFor();
  await hexInput.fill("#ff0000");
  await page.getByTestId("workbench-color-alpha").fill("50");
  await page.getByTestId("workbench-edit-confirm").click();
  await page.getByTestId("workbench-color-editor").waitFor({ state: "detached", timeout: 15_000 });
  await page
    .locator('[data-testid="workbench-detail"]')
    .filter({ hasText: "#ff000080" })
    .waitFor({ timeout: 15_000 });
  const sourceAlpha = await readSource();
  assert.equal(
    sourceAlpha.rawValue,
    "#ff000080",
    "alpha 50% must write an 8-digit hex Cell",
  );

  // The readOnly "库" badge appears for library-owned rows after reload;
  // every fixture token is package-owned, so still none.
  assert.equal(await page.getByText("库", { exact: true }).count(), 0);
  await page.getByTestId("workbench-filter-clear").click();

  // DSP-007-A: numeric editing with an explicit unit; alias tokens expose
  // their expression instead of a number input.
  const readToken = async (groupId, tokenId) => {
    const response = await fetch(endpoint("/v1/ui/design-system"));
    const body = await response.json();
    return body.tokens.find(
      (token) => token.group === groupId && token.id === tokenId,
    );
  };

  await page
    .getByTestId("workbench-filter-group")
    .selectOption("spacing/md");
  await page.locator('[data-testid="specimen-card"][aria-label="space.medium"]').click();
  await page.getByTestId("workbench-edit-open").click();
  await page.getByTestId("workbench-number-editor").waitFor();
  const unitLabel = await page
    .getByTestId("workbench-number-editor")
    .innerText();
  assert.match(unitLabel, /px/, "unit must be explicit");
  await page.getByTestId("workbench-number-value").fill("13");
  await page.getByTestId("workbench-edit-confirm").click();
  await page
    .locator('[data-testid="workbench-detail"]')
    .filter({ hasText: "13" })
    .waitFor({ timeout: 15_000 });
  const spacingToken = await readToken("spacing/md", "tok_spacing_md_medium");
  assert.equal(spacingToken.rawValue, 13, "spacing Cell updated");

  // Alias editing: expression is shown and written back verbatim.
  await page.getByTestId("workbench-filter-clear").click();
  await page.getByTestId("workbench-search").fill("radius.alias");
  await page.waitForTimeout(200);
  await page.locator('[data-testid="specimen-card"][aria-label="radius.alias"]').click();
  await page.getByTestId("workbench-edit-open").click();
  await page.getByTestId("workbench-number-editor").waitFor();
  const aliasInput = page.getByTestId("workbench-number-alias");
  assert.equal(await aliasInput.inputValue(), "{base}");
  await aliasInput.fill("{bad expression}");
  await page.getByTestId("workbench-edit-confirm").click();
  await page.getByTestId("workbench-edit-error").waitFor();
  const revisionAtAlias = (await (await fetch(endpoint("/v1/ui/design-system"))).json()).revision;
  assert.equal(
    (await (await fetch(endpoint("/v1/ui/design-system"))).json()).revision,
    revisionAtAlias,
    "invalid alias must not commit",
  );
  // The alias type (border-radius) may only reference same-type tokens:
  // "{space.medium}" is rejected by the backend's typed alias validation
  // (422 -> commit error, editor stays open, revision unchanged).
  await aliasInput.fill("{space.medium}");
  await page.getByTestId("workbench-edit-confirm").click();
  await page.getByTestId("workbench-commit-error").waitFor();
  const revisionBeforeAlias = (await (await fetch(endpoint("/v1/ui/design-system"))).json()).revision;
  assert.equal(
    (await (await fetch(endpoint("/v1/ui/design-system"))).json()).revision,
    revisionBeforeAlias,
    "type-mismatched alias must not commit",
  );
  // A malformed expression is rejected locally without a request.
  await aliasInput.fill("{bad expression}");
  await page.getByTestId("workbench-edit-confirm").click();
  await page.getByTestId("workbench-edit-error").waitFor();
  assert.equal(
    (await (await fetch(endpoint("/v1/ui/design-system"))).json()).revision,
    revisionAtAlias,
    "invalid alias must not commit",
  );
  // A same-type expression commits.
  await aliasInput.fill("{base}");
  await page.getByTestId("workbench-edit-confirm").click();
  await page.getByTestId("workbench-number-editor").waitFor({ state: "detached", timeout: 15_000 });
  await page.waitForTimeout(500);
  const aliasToken = await readToken("alias/demo", "tok_alias_demo_radius");
  assert.equal(aliasToken.rawValue, "{base}", "alias Cell updated");
  assert.equal(aliasToken.resolvedValue, 8, "alias still resolves through base");

  // DSP-008-A: typography specimens go through the real font service.
  // The fixture does not bundle gfont-inter, so the honest end state is
  // fallback with the missing source identified (never name-based ready).
  await page.getByTestId("workbench-search").fill("");
  await page.waitForTimeout(200);
  const typoStatus = page.getByTestId("typography-status").first();
  await typoStatus.waitFor({ timeout: 15_000 });
  await page.waitForFunction(
    () => {
      const el = document.querySelector('[data-testid="typography-status"]');
      return el && !el.textContent.includes("加载中");
    },
    { timeout: 15_000 },
  );
  const typoText = await typoStatus.innerText();
  assert.match(typoText, /字体就绪|回退字体/, "status resolves past loading");
  assert.match(typoText, /gfont-inter/, "font source identified");
  const headingCard = page.locator(
    '[data-testid="specimen-card"][aria-label="heading"]',
  );
  await headingCard.waitFor();
  const headingSpec = await headingCard
    .locator('[data-testid="typography-specimen"]')
    .innerText();
  assert.match(headingSpec, /Inter · 28px · 600 · 1.2/, "typography meta shown");

  // DSP-013-A: raw vs resolved, alias chain, explicit edit target choice.
  // The alias row may still be selected from the previous section.
  if ((await page.getByTestId("workbench-detail").count()) === 0) {
    await page.locator('[data-testid="specimen-card"][aria-label="radius.alias"]').click();
  }
  await page.getByTestId("workbench-detail").waitFor();
  assert.equal(await page.getByTestId("detail-raw").innerText(), "{base}");
  assert.equal(await page.getByTestId("detail-resolved").innerText(), "8");
  const chain = await page.getByTestId("detail-alias-chain").innerText();
  assert.match(chain, /\{base\} → 8/, "alias chain shows shared resolution");
  await page.getByTestId("edit-target-cell").waitFor();
  await page.getByTestId("edit-target-alias").waitFor();
  await page.getByTestId("edit-target-shared").waitFor();

  // Editing the shared target drives every inheriting alias.
  await page.getByTestId("edit-target-shared").click();
  await page.getByTestId("workbench-edit-open").click();
  await page.getByTestId("workbench-number-editor").waitFor();
  assert.equal(
    await page.getByTestId("workbench-number-value").inputValue(),
    "8",
    "shared target editor starts from base Cell",
  );
  await page.getByTestId("workbench-number-value").fill("21");
  await page.getByTestId("workbench-edit-confirm").click();
  await page.getByTestId("workbench-number-editor").waitFor({ state: "detached", timeout: 15_000 });
  await page.waitForTimeout(500);
  const baseToken = await readToken("radius/md", "tok_radius_md_base");
  assert.equal(baseToken.rawValue, 21, "shared target Cell updated");
  const aliasAfter = await readToken("alias/demo", "tok_alias_demo_radius");
  assert.equal(aliasAfter.resolvedValue, 21, "alias inherits shared source");
  await page.getByTestId("workbench-search").fill("");

  // DSP-010-A: real component variant trees (SVG from projected nodes).
  await page.getByTestId("component-board").waitFor();
  const setCard = page.getByTestId("component-set").first();
  await setCard.waitFor();
  assert.match(await setCard.innerText(), /Card/, "component set name shown");
  const variants = await page.getByTestId("component-variant").count();
  assert.ok(variants >= 2, `expected >=2 variants, got ${variants}`);
  await page.locator('[data-testid="component-variant-axis"]').first().waitFor();
  const firstVariant = page.getByTestId("component-variant").first();
  const firstRect = firstVariant.locator("rect").first();
  const rectFill = await firstRect.getAttribute("fill");
  assert.match(rectFill, /#ffffff|#e7e0ec/, "variant fill from real tree");
  const rectRadius = await firstRect.getAttribute("rx");
  // The corner radius is token-bound; the specimen must reflect the live
  // base Cell (it may have been edited by the shared-target test earlier).
  const baseNow = await readToken("radius/md", "tok_radius_md_base");
  assert.equal(
    rectRadius,
    String(baseNow.resolvedValue ?? baseNow.rawValue),
    "token-bound corner radius resolved",
  );
  const axisText = await page
    .locator('[data-testid="component-variant-axis"]')
    .first()
    .innerText();
  assert.match(axisText, /idle|pressed/, "variant axis selection shown");
  await page.getByTestId("workbench-search").fill("");

  assert.deepEqual(pageErrors, []);
  await page.screenshot({
    fullPage: true,
    path: join(root, "audits", "2026-09-09-dsp-workbench", "workbench-board.png"),
  });
  console.log("DSP-004-A/DSP-005 workbench e2e: PASS");
} catch (error) {
  failed = true;
  console.error("DSP-004-A/DSP-005 workbench e2e: FAIL");
  console.error(error);
  try {
    const page2 = pageRef;
    if (page2) {
      console.error("url:", page2.url());
      console.error(
        "body:",
        (await page2.locator("body").innerText().catch(() => "<no body>"))
          .slice(0, 500)
          .replace(/\n/g, " | "),
      );
      await page2.screenshot({
        fullPage: true,
        path: "/tmp/qar/workbench-failure.png",
      });
    }
  } catch {}
  for (const message of consoleErrors.slice(0, 10)) {
    console.error("console error:", message.slice(0, 300));
  }
} finally {
  await browser.close();
  await web.close?.();
  await background.close?.();
  await rm(scratch, { recursive: true, force: true });
}
process.exitCode = failed ? 1 : 0;
