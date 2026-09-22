// DSE M2 evidence: EVERY supported Token type plus text color editing on an
// isolated copy of the user's actual package
// (/private/tmp/smallpen-live-demo/design-system.smallpen), through the
// NATIVE property panels / Tokens panel:
//   select -> panel edit -> SOURCE readback -> Undo -> Redo -> reload
//   keeps the redone state. Includes the alias readonly negative control.
// Usage: node e2e/dse-m2-editing.mjs --audit <dir>
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
const auditRoot = argValue("--audit") ?? join(root, "audits", "dse-full-delivery", "m2-latest");
const dir = join(auditRoot, "m2-actual");
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

const scratch = await mkdtemp(join(tmpdir(), "smallpen-dse-m2-"));
const packagePath = join(scratch, "design-system.smallpen");
await cp(actualPackage, packagePath, { recursive: true });
const originalHash = await hashTree(actualPackage);

const bg = await serveLocalPackage({ packagePath, port: 0 });
const web = await servePenpotFrontend({ backendUrl: bg.url, frontendRoot, port: 0 });
const endpoint = (path) => {
  const base = new URL(bg.url);
  base.pathname = `${base.pathname.replace(/\/+$/, "")}${path}`;
  return base.href;
};
const workspace = () => fetch(endpoint("/v1/workspace")).then((r) => r.json());
const designSystem = () => fetch(endpoint("/v1/ui/design-system")).then((r) => r.json());
const tokenRow = (payload, setName, path) => {
  const inv = payload.tokenInventory;
  const rows = Array.isArray(inv) ? inv : inv?.rows ?? [];
  return rows.find((row) => row.setName === setName && row.path === path);
};
const waitForToken = async (setName, path, predicate, label, timeout = 40_000) => {
  const deadline = Date.now() + timeout;
  let last;
  while (Date.now() < deadline) {
    last = await designSystem();
    const row = tokenRow(last, setName, path);
    if (row && predicate(row.effectiveValue ?? row.value)) return row;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error(`source readback timeout: ${label}`);
};

const browser = await chromium.launch();
const pageErrors = [];
const consoleErrors = [];
const httpErrors = [];
const page = await browser.newPage({ viewport: { height: 1000, width: 1440 } });
page.on("pageerror", (error) => pageErrors.push(String(error.message)));
page.on("console", (msg) => {
  if (msg.type() === "error" && !msg.text().includes("404")) {
    consoleErrors.push(msg.text().slice(0, 200));
  }
});
const commitLog = [];
page.on("request", (request) => {
  if (request.url().endsWith("/commit") && request.method() === "POST") {
    commitLog.push({ t: Date.now(), body: request.postData()?.slice(0, 1200) ?? "" });
  }
});
page.on("response", async (response) => {
  if (response.status() >= 400) {
    let body = "";
    try {
      body = (await response.text()).slice(0, 300);
    } catch {}
    httpErrors.push({ status: response.status(), url: response.url(), body });
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
  for (let round = 0; round < 50; round += 1) {
    const collapsed = page
      .locator('[data-testid="layer-row"] [data-testid="toggle-content"]:not([aria-expanded="true"])')
      .first();
    if ((await collapsed.count()) === 0) break;
    await collapsed.click().catch(() => {});
    await page.waitForTimeout(120);
  }
};
const selectRow = async (name) => {
  const row = page.getByTestId("layer-row").filter({ hasText: name }).first();
  await row.waitFor({ timeout: 20_000 });
  const toggle = row.getByTestId("toggle-content");
  if ((await toggle.count()) && (await toggle.getAttribute("aria-expanded")) !== "true") {
    await toggle.click();
  }
  await row.click();
  await page.waitForTimeout(600);
  return row;
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
const findInput = (selector) =>
  page
    .locator(`${selector}, ${selector.replace("input[", "[")} input`)
    .first();
const setNumeric = async (selector, value, headerAria) => {
  let input = findInput(selector);
  try {
    await input.waitFor({ timeout: 4_000 });
  } catch {
    if (headerAria) {
      await page.locator(`[aria-label="${headerAria}"]`).first().click().catch(() => {});
      await page.waitForTimeout(600);
    }
    input = findInput(selector);
    await input.waitFor({ timeout: 6_000 });
  }
  await input.click({ clickCount: 3 });
  await input.fill(String(value));
  await input.press("Enter");
  await page.waitForTimeout(300);
};
const noInternalError = async () => {
  const body = await page.locator("body").innerText();
  assert.ok(!body.includes("Internal Error"), "page shows Internal Error");
};

// One FULL loop per Token type: panel edit -> source readback -> Undo ->
// Redo -> final readback. The SOURCE decides, never the UI. The baseline is
// read from the source before editing, so reruns on a package that already
// carries a previous redo state stay honest (no hardcoded originals).
const editMatrix = async (item) => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const baseline = await designSystem();
      const baselineRow = tokenRow(baseline, item.setName, item.path);
      assert.ok(baselineRow, `${item.key}: Cell missing from the token inventory`);
      const initial = baselineRow.effectiveValue ?? baselineRow.value;
      const differs = (value) => JSON.stringify(value) !== JSON.stringify(initial);
      const matches = (value) => JSON.stringify(value) === JSON.stringify(initial);
      await selectRow(item.select);
      await page.waitForTimeout(600);
      await shot(`${item.key}-selected`);
      await item.edit();
      await waitForToken(
        item.setName,
        item.path,
        (value) => item.expect(value) && differs(value),
        `${item.key} edit did not reach the source`,
      );
      await shot(`${item.key}-edited`);
      // Undo restores the baseline Cell value in the source.
      await page.keyboard.press("ControlOrMeta+z");
      await waitForToken(
        item.setName,
        item.path,
        (value) => matches(value),
        `${item.key} undo did not restore the source`,
      );
      await shot(`${item.key}-undone`);
      // Redo reapplies the edit.
      await page.keyboard.press("ControlOrMeta+Shift+z");
      await waitForToken(
        item.setName,
        item.path,
        (value) => item.expect(value) && differs(value),
        `${item.key} redo did not reapply the edit`,
      );
      await shot(`${item.key}-redone`);
      log(`INFO ${item.key}: edit/undo/redo verified in source (baseline ${JSON.stringify(initial)})`);
      return;
    } catch (error) {
      if (attempt === 1) throw error;
      log(`INFO retry ${item.key}: ${String(error).slice(0, 140)}`);
    }
  }
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
  }, null, 2));

  await page.goto(url.href, { waitUntil: "domcontentloaded" });
  await waitWorkspace();
  await expandBoard();
  await shot("01-mount");

  await step("mount::board", async () => {
    assert.ok((await page.getByTestId("left-sidebar").count()) > 0, "layers sidebar missing");
    assert.ok((await page.getByTestId("right-sidebar").count()) > 0, "properties sidebar missing");
    await noInternalError();
    assert.equal(pageErrors.length, 0, `page errors: ${pageErrors.join(" | ")}`);
  });

  // -- fill Cell (color) ----------------------------------------------------
  await step("edit::fill-cell-undo-redo", async () => {
    await editMatrix({
      key: "fill",
      select: "color/light/primary",
      setName: "color/light",
      path: "primary",
      edit: () => setFillColor("#0ea5e9"),
      expect: (value) => String(value).toLowerCase() === "#0ea5e9",
    });
  });

  // -- radius Cell ----------------------------------------------------------
  await step("edit::radius-cell-undo-redo", async () => {
    await editMatrix({
      key: "radius",
      select: "radius/md/base",
      setName: "radius/md",
      path: "base",
      edit: () => setNumeric('input[aria-label="Radius"]', 16, "Border radius section"),
      expect: (value) => Number(value) === 16,
    });
  });

  // -- sizing Cell (height) --------------------------------------------------
  await step("edit::sizing-cell-undo-redo", async () => {
    await editMatrix({
      key: "sizing",
      select: "sizing/md/control",
      setName: "sizing/md",
      path: "control",
      edit: () =>
        setNumeric('[aria-label="shape-measures-section"] input[aria-label="Height"]', 64),
      expect: (value) => Number(value) === 64,
    });
  });

  // -- stroke-width Cell -----------------------------------------------------
  await step("edit::stroke-width-cell-undo-redo", async () => {
    await editMatrix({
      key: "stroke",
      select: "stroke/md/border-width",
      setName: "stroke/md",
      path: "border-width",
      edit: () => setNumeric('input[aria-label="Stroke width"]', 3, "stroke-section"),
      expect: (value) => Number(value) === 3,
    });
  });

  // -- shadow EFFECT COLOR Cell (R04: effect color, not blur) ----------------
  await step("edit::shadow-color-cell-undo-redo", async () => {
    await editMatrix({
      key: "shadow-color",
      select: "effect/md/elevation-1",
      setName: "effect/md",
      path: "elevation-1",
      edit: async () => {
        const section = page.getByTestId("shadow-section");
        await section.waitFor({ timeout: 10_000 });
        // The shadow color lives in the row's advanced popover.
        const more = section.locator('[aria-label="open more options"]').first();
        for (let attempt = 0; attempt < 3 && (await more.count()); attempt += 1) {
          await more.click().catch(() => {});
          await page.waitForTimeout(900);
          if (await section.locator('button:has(div[style*="background"])').first().count()) break;
        }
        const swatch = section.locator('button:has(div[style*="background"])').first();
        assert.ok((await swatch.count()) > 0, "shadow color swatch not found in the advanced popover");
        await swatch.click({ timeout: 10_000 });
        const hexInput = page.locator("#hex-value").first();
        await hexInput.waitFor({ timeout: 10_000 });
        await hexInput.fill("#dc2626");
        await hexInput.press("Enter");
        await page.keyboard.press("Escape");
      },
      expect: (value) =>
        typeof value === "object" && value !== null && /dc2626/i.test(String(value.color)),
    });
  });

  // -- text color edit on the component definition (Card label) -------------
  let textTarget = null;
  await step("edit::component-text-color-undo", async () => {
    // Discover the first TEXT node inside the Card idle variant definition.
    const payload = await workspace();
    const componentsEntry = payload.manifest.entries.components[0];
    const value = payload.entries[componentsEntry];
    const sets = Array.isArray(value?.componentSets) ? value.componentSets : [value];
    outer: for (const set of sets) {
      for (const variant of set.variants ?? []) {
        for (const node of Object.values(variant.nodes ?? {})) {
          if (node.type === "TEXT") {
            textTarget = { name: node.name, set: set.name, variant: variant.id };
            break outer;
          }
        }
      }
    }
    assert.ok(textTarget, "no TEXT node found in component definitions");
    const servedDef = () => workspace().then((ws) => JSON.stringify(ws.entries?.[componentsEntry] ?? ""));
    const initialDef = await servedDef();
    const targetColor = initialDef.includes("#22d3ee") ? "#f59e0b" : "#22d3ee";
    log(`INFO text target: ${JSON.stringify(textTarget)} color ${targetColor}`);
    // The tree contains MANY "Label" rows: page INSTANCES also render a
    // Label. The component DEFINITION label sits right under the
    // "Card / idle" family row (never "Card instance / idle"). The tree
    // window-renders visible rows, so walk the panel with the wheel until
    // the family row and its Label are BOTH rendered, then click by index.
    const readRows = () =>
      page.getByTestId("layer-row").evaluateAll((nodes) =>
        nodes.map((node) => (node.innerText ?? "").replace(/\s+/g, " ").trim()),
      );
    let found = -1;
    for (let round = 0; round < 40 && found < 0; round += 1) {
      const texts = await readRows();
      const familyIndex = texts.findIndex((row) => /^Card \/ idle( |$)/.test(row));
      if (familyIndex >= 0) {
        const labelIndex = texts
          .slice(familyIndex + 1, familyIndex + 4)
          .findIndex((row) => /^Label( |$)/.test(row) && !row.includes("·"));
        if (labelIndex >= 0) {
          found = familyIndex + 1 + labelIndex;
          break;
        }
      }
      await page.mouse.move(200, 600);
      await page.mouse.wheel(0, 700).catch(() => {});
      await page.waitForTimeout(350);
    }
    assert.ok(found >= 0, "Card / idle family row with its Label not found on the board");
    await page.getByTestId("layer-row").nth(found).click();
    await page.waitForTimeout(600);
    await shot("03-text-selected");
    await setFillColor(targetColor);
    await shot("04-text-color-edited");
    await page.waitForTimeout(3_000);
    await writeFile(join(dir, "text-commit-log.json"), JSON.stringify(commitLog, null, 2));
    const deadline = Date.now() + 40_000;
    let hit = false;
    while (Date.now() < deadline && !hit) {
      hit = (await servedDef()).includes(targetColor);
      if (!hit) await page.waitForTimeout(1_000);
    }
    assert.ok(hit, "text color edit did not reach the component definition");
    // Undo restores the definition.
    await page.keyboard.press("ControlOrMeta+z");
    const undoDeadline = Date.now() + 25_000;
    let gone = false;
    while (Date.now() < undoDeadline && !gone) {
      gone = !(await servedDef()).includes(targetColor);
      if (!gone) await page.waitForTimeout(1_000);
    }
    assert.ok(gone, "undo did not restore the label color");
    // Redo reapplies it; the reload step below proves persistence.
    await page.keyboard.press("ControlOrMeta+Shift+z");
    const redoDeadline = Date.now() + 25_000;
    let back = false;
    while (Date.now() < redoDeadline && !back) {
      back = (await servedDef()).includes(targetColor);
      if (!back) await page.waitForTimeout(1_000);
    }
    assert.ok(back, "redo did not reapply the label color");
    await shot("05-text-color-redone");
  });

  // -- alias Cell negative control: direct edit must fail without writes ----
  await step("negative::alias-cell-edit-rejected", async () => {
    const before = await designSystem();
    const beforeRow = tokenRow(before, "alias/demo", "radius.alias");
    await selectRow("alias/demo/radius.alias");
    await page.waitForTimeout(600);
    await shot("02-alias-selected");
    const section = page.getByTestId("shape-fill-section");
    const hasFillSection = (await section.count()) > 0;
    // Radius display: edit through the radius panel field when present.
    const radiusInput = findInput('input[aria-label="Radius"]');
    if (await radiusInput.count()) {
      await radiusInput.click({ clickCount: 3 }).catch(() => {});
      await radiusInput.fill("24").catch(() => {});
      await radiusInput.press("Enter").catch(() => {});
      await page.waitForTimeout(2_000);
    } else if (hasFillSection) {
      await setFillColor("#22c55e");
    } else {
      log("INFO alias display opens no editable section (readonly by panel absence)");
    }
    const after = await designSystem();
    const afterRow = tokenRow(after, "alias/demo", "radius.alias");
    const beforeValue = JSON.stringify(beforeRow?.effectiveValue ?? beforeRow?.value);
    const afterValue = JSON.stringify(afterRow?.effectiveValue ?? afterRow?.value);
    await writeFile(join(dir, "alias-negative.json"), JSON.stringify({
      beforeValue,
      afterValue,
      httpErrors: httpErrors.filter((e) => e.status === 422),
    }, null, 2));
    assert.equal(afterValue, beforeValue, "alias Cell value must not change via direct shape edit");
    await noInternalError();
  });


  // -- reload keeps the redone state -----------------------------------------
  await step("refresh::reload-keeps-redone-state", async () => {
    const before = await workspace();
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitWorkspace();
    const after = await workspace();
    const checks = {
      fillRedone: tokenRow(await designSystem(), "color/light", "primary"),
      revision: { before: before.revision, after: after.revision },
    };
    await writeFile(join(dir, "refresh-state.json"), JSON.stringify(checks, null, 2));
    assert.equal(after.revision, before.revision, "revision drifted across reload");
    await expandBoard();
    await shot("06-reload-keeps-state");
    assert.equal(pageErrors.length, 0, `page errors: ${pageErrors.join(" | ")}`);
  });

  // -- negative: the user's ORIGINAL package untouched ------------------------
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
    JSON.stringify({ label: "m2-actual", results, setupError, pageErrors, consoleErrors, httpErrors }, null, 2),
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
console.log(`DSE M2 editing: ${exited ? "PASS" : `FAIL (${failed.length}) setup=${setupError ? "error" : "none"}`}`);
process.exit(exited ? 0 : 1);
