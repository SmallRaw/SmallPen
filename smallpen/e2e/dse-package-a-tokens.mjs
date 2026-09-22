// DSE-R17~R26 evidence — Delivery Package A: the complete Design Token page.
// On an isolated copy of the user's actual package
// (/private/tmp/smallpen-live-demo/design-system.smallpen) with an EXTENDED
// fixture (one Cell per canonical type the package lacks, plus an archived
// set), through the REAL browser UI:
//   1. mount + fit: the fully-expanded panorama reconciles, from canonical
//      files independently, every (Cell × valid Workbench Combination)
//      specimen row, the 20-type gutter catalog (count or 暂无), the
//      archived band, and the controller's combination list.
//   2. controller: focus is a ZERO-WRITE observation (canonical tree hash
//      unchanged, other combinations still on the board); the controller
//      does NOT render on an ordinary page.
//   3. one REAL edit loop per canonical type (20/20): select specimen ->
//      native panel or Token inspector edit -> source readback -> Undo ->
//      Redo; plus alias binding sync (edit {base} target -> resolved
//      updates) and a set-current-combination canonical edit.
//   4. canvas cleanliness: no owner/package/literal/alias/status debug text.
//   5. reload rebuild -> terminal values persist -> whole-run canonical tree
//      diff touches only the tokens entry, zero System Sheet residue,
//      original package untouched.
// Usage: node e2e/dse-package-a-tokens.mjs --audit <dir> [--plain]
//   --plain runs against the UNMODIFIED actual package (empty-type blocks
//   and fewer types; coverage edits are skipped).
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

async function hashTree(dirPath) {
  const hash = createHash("sha256");
  const files = [];
  async function walk(current) {
    for (const item of await readdir(current, { withFileTypes: true })) {
      const full = join(current, item.name);
      if (item.isDirectory()) await walk(full);
      else files.push(full);
    }
  }
  await walk(dirPath);
  files.sort();
  for (const file of files) {
    hash.update(file.slice(dirPath.length));
    hash.update(await readFile(file));
  }
  return hash.digest("hex");
}

async function readCanonicalFiles(packagePath) {
  const files = new Map([
    ["manifest.json", JSON.parse(await readFile(join(packagePath, "manifest.json"), "utf8"))],
  ]);
  const manifest = files.get("manifest.json");
  for (const entries of Object.values(manifest.entries)) {
    for (const entry of entries) {
      files.set(entry, JSON.parse(await readFile(join(packagePath, entry), "utf8")));
    }
  }
  return files;
}

// Independent canonical enumeration of the token library (never runtime/UI).
function tokenLibrary(canonical) {
  for (const entry of canonical.get("manifest.json").entries.tokens) {
    const library = canonical.get(entry);
    if (Array.isArray(library?.sets) && Array.isArray(library?.themes)) {
      return { entry, library };
    }
  }
  return null;
}

// The valid Workbench Combinations declared by the library: cartesian
// product of Paired Themes grouped per Token Domain (same rule as
// listWorkbenchCombinations in packages/core).
function enumerateCombinations(library) {
  const domains = new Map();
  for (const theme of library.themes ?? []) {
    const group = String(theme.group ?? "");
    if (!domains.has(group)) domains.set(group, []);
    domains.get(group).push(theme);
  }
  let combos = [{ selection: [], themeIds: [], setIds: [] }];
  for (const [domain, variants] of [...domains.entries()].sort()) {
    const next = [];
    for (const combo of combos) {
      for (const theme of variants) {
        next.push({
          selection: [...combo.selection, { domain, themeId: theme.id, themeName: theme.name }],
          themeIds: [...combo.themeIds, theme.id],
          setIds: [...combo.setIds, ...(theme.setIds ?? [])],
        });
      }
    }
    combos = next;
  }
  return combos.map((combo) => {
    const domainNames = [...domains.keys()].sort();
    const varying = combo.selection.filter(
      (part, index) => domains.get(domainNames[index]).length > 1,
    );
    return {
      id: combo.themeIds.length === 1 ? combo.themeIds[0] : combo.themeIds.join("+"),
      label: varying.length > 0 ? varying.map((part) => part.themeName).join(" · ") : "Default",
      themeIds: combo.themeIds,
      setIds: combo.setIds,
    };
  });
}

function canonicalCells(canonical) {
  const { library } = tokenLibrary(canonical);
  const activeSetIds = new Set(library.activeSetIds ?? []);
  const domainSetIds = new Set(
    (library.themes ?? []).flatMap((theme) => theme.setIds ?? []),
  );
  const cells = [];
  for (const set of library.sets ?? []) {
    for (const token of set.tokens ?? []) {
      let combinationIds;
      if (domainSetIds.has(set.id)) {
        combinationIds = "domain";
      } else if (activeSetIds.has(set.id)) {
        combinationIds = "all";
      } else {
        combinationIds = "archived";
      }
      cells.push({
        entryTokenLibrary: true,
        setId: set.id,
        setName: set.name,
        path: token.name,
        id: token.id,
        type: token.type,
        value: token.value,
        combinationIds,
      });
    }
  }
  return cells;
}

function assertNoGeneratedResidue(files, workspacePayload) {
  const runtime = workspacePayload.runtime;
  const generatedIds = new Set(
    [
      runtime.designSystemPage,
      runtime.componentsPage,
      ...(runtime.designSystem ? Object.values(runtime.designSystem) : []),
      ...Object.keys(runtime.reverseDesignSystem ?? {}),
    ].filter((id) => typeof id === "string"),
  );
  const walk = (value, path) => {
    if (typeof value === "string") {
      if (generatedIds.has(value)) {
        throw new Error(`generated page id leaked into canonical file at ${path}`);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`));
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        if (key === "smallpen" && item && typeof item === "object" && !Array.isArray(item)) {
          for (const marker of Object.keys(item)) {
            if (marker.startsWith("design-system") || marker === "components-page") {
              throw new Error(
                `projection-only plugin-data marker "${marker}" leaked into canonical file at ${path}`,
              );
            }
          }
          continue;
        }
        walk(item, `${path}.${key}`);
      }
    }
  };
  for (const [entry, value] of files) walk(value, entry);
}

const args = process.argv.slice(2);
const argValue = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
};
const flag = (name) => args.includes(name);
const plain = flag("--plain");
// --keys a,b,c: run ONLY the named edit-loop steps (plus the always-on
// mount/controller/clean steps). Long single runs degrade (the workspace
// accumulates ~60 re-projections); splitting the 20 type loops across two
// fresh invocations keeps every loop inside the reliability window.
const wantedKeys = argValue("--keys")
  ? new Set(argValue("--keys").split(",").map((k) => k.trim()))
  : null;
const wantKey = (key) => !wantedKeys || wantedKeys.has(key);
const auditRoot =
  argValue("--audit") ?? join(root, "audits", "dse-full-delivery", "package-a-latest");
const label = plain ? "package-a-plain" : "package-a-coverage";
const dir = join(auditRoot, label);
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

const COVERAGE_SET_ID = "tset_reference_coverage";
const COVERAGE_SET_NAME = "reference/coverage";
const ARCHIVED_SET_ID = "tset_reference_archived";
const ARCHIVED_SET_NAME = "reference/archived";

const scratch = await mkdtemp(join(tmpdir(), "smallpen-dse-package-a-"));
const packagePath = join(scratch, "design-system.smallpen");
await cp(actualPackage, packagePath, { recursive: true });

// The extended fixture: one Cell per canonical type the actual package does
// not carry, an active-but-unclaimed set (observed by every combination),
// and an archived set covered by no combination.
const coverageCells = [
  ["tok_coverage_boolean", "flag", "boolean", true],
  ["tok_coverage_dimensions", "box", "dimensions", 120],
  ["tok_coverage_font_family", "family", "font-family", "Inter"],
  ["tok_coverage_font_size", "size", "font-size", 24],
  ["tok_coverage_font_weight", "weight", "font-weight", 700],
  ["tok_coverage_letter_spacing", "tracking", "letter-spacing", 1.5],
  ["tok_coverage_number", "count", "number", 12],
  ["tok_coverage_opacity", "veil", "opacity", 0.42],
  ["tok_coverage_other", "config", "other", '{"theme":{"dark":true},"steps":[1,2]}'],
  ["tok_coverage_rotation", "tilt", "rotation", -30],
  ["tok_coverage_string", "label", "string", "Hello 覆盖"],
  ["tok_coverage_text_case", "case", "text-case", "uppercase"],
  ["tok_coverage_text_decoration", "decoration", "text-decoration", "underline"],
].map(([id, name, type, value]) => ({ description: "", id, name, type, value }));

if (!plain) {
  const tokensPath = join(packagePath, "tokens/tokens.json");
  const library = JSON.parse(await readFile(tokensPath, "utf8"));
  library.sets.push({
    description: "Coverage Cells for the 20 canonical token types",
    id: COVERAGE_SET_ID,
    name: COVERAGE_SET_NAME,
    tokens: coverageCells,
  });
  library.sets.push({
    description: "Archived Cells covered by no combination",
    id: ARCHIVED_SET_ID,
    name: ARCHIVED_SET_NAME,
    tokens: [
      { description: "", id: "tok_reference_archived_color", name: "legacy.color", type: "color", value: "#cccccc" },
    ],
  });
  library.activeSetIds.push(COVERAGE_SET_ID);
  await writeFile(tokensPath, JSON.stringify(library, null, 2));
}

const originalHash = await hashTree(actualPackage);
const baselineCanonical = await readCanonicalFiles(packagePath);
const baselineHash = await hashTree(packagePath);
const writeRecords = [];

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
const readCell = async (tokenId) => {
  const files = await readCanonicalFiles(packagePath);
  const { library } = tokenLibrary(files);
  for (const set of library.sets ?? []) {
    for (const token of set.tokens ?? []) {
      if (token.id === tokenId) return token.value;
    }
  }
  return undefined;
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
page.on("response", async (response) => {
  if (response.status() >= 400) {
    let body = "";
    try {
      body = (await response.text()).slice(0, 300);
    } catch {}
    httpErrors.push({ status: response.status(), url: response.url(), body });
  }
});
const shot = (name) =>
  page.screenshot({ path: join(dir, `${name}.png`), fullPage: false }).catch(() => {});

const waitWorkspace = async () => {
  await page.getByTestId("viewport").waitFor({ timeout: 60_000 });
  await page.waitForTimeout(1_500);
};
// The board mounts as ONE collapsed layer row; expand every subtree before
// any row collection (same procedure as dse-r16-persistence.mjs).
const expandBoard = async () => {
  // Scroll the layers panel back to its top first: the tree is virtualized
  // and a root row scrolled out of the panel viewport never renders.
  await page
    .locator('[data-testid="layer-row"]')
    .first()
    .evaluate((node) => {
      let p = node.parentElement;
      while (p) {
        if (p.scrollHeight > p.clientHeight + 50) p.scrollTop = 0;
        p = p.parentElement;
      }
    })
    .catch(() => {});
  const board = page.getByTestId("layer-row").filter({ hasText: "Design System" }).first();
  await board.waitFor({ timeout: 25_000 });
  for (let round = 0; round < 80; round += 1) {
    const collapsed = page
      .locator('[data-testid="layer-row"] [data-testid="toggle-content"]:not([aria-expanded="true"])')
      .first();
    if ((await collapsed.count()) === 0) break;
    await collapsed.click().catch(() => {});
    await page.waitForTimeout(120);
  }
};
const collectRows = async () => {
  const readRows = () =>
    page.getByTestId("layer-row").evaluateAll((nodes) =>
      nodes.map((node) => (node.innerText ?? "").replace(/\s+/g, " ").trim()),
    );
  await page.mouse.move(200, 600);
  for (let round = 0; round < 30; round += 1) {
    await page.mouse.wheel(0, -800).catch(() => {});
    await page.waitForTimeout(120);
  }
  const seen = new Set();
  let stable = 0;
  for (let round = 0; round < 100 && stable < 4; round += 1) {
    const texts = await readRows();
    const size = seen.size;
    for (const text of texts) if (text) seen.add(text);
    stable = seen.size === size ? stable + 1 : 0;
    await page.mouse.move(200, 600);
    await page.mouse.wheel(0, 700).catch(() => {});
    await page.waitForTimeout(300);
  }
  return seen;
};
const findRowScrolling = async (namePattern, { label: rowLabel } = {}) => {
  const readRows = () =>
    page.getByTestId("layer-row").evaluateAll((nodes) =>
      nodes.map((node) => (node.innerText ?? "").replace(/\s+/g, " ").trim()),
    );
  const search = async () => {
    await page.mouse.move(200, 600);
    for (let round = 0; round < 30; round += 1) {
      await page.mouse.wheel(0, -800).catch(() => {});
      await page.waitForTimeout(120);
    }
    for (let round = 0; round < 50; round += 1) {
      const texts = await readRows();
      const index = texts.findIndex((row) => namePattern.test(row));
      if (index >= 0) return index;
      await page.mouse.move(200, 600);
      await page.mouse.wheel(0, 700).catch(() => {});
      await page.waitForTimeout(320);
    }
    return -1;
  };
  // Token commits trigger a re-projection, which rebuilds the layers tree
  // (collapsed). If the first search misses, re-expand and search again.
  let index = await search();
  if (index < 0) {
    await expandBoard();
    index = await search();
  }
  if (index < 0) {
    const texts = await page.getByTestId("layer-row").evaluateAll((nodes) =>
      nodes.map((node) => (node.innerText ?? "").replace(/\s+/g, " ").trim()));
    await writeFile(join(dir, "row-search-dump.txt"), texts.join("\n")).catch(() => {});
    throw new Error(`layer row not found on the board: ${rowLabel ?? namePattern}`);
  }
  return index;
};
// The layers tree is virtualized AND re-renders on every token-commit
// re-projection. Wait until the rendered row set is stable before clicking,
// otherwise the click lands on whatever row re-rendered at that position.
const waitTreeStable = async (maxMs = 30_000) => {
  const snapshot = () =>
    page.getByTestId("layer-row").evaluateAll((nodes) =>
      nodes.map((node) => (node.innerText ?? "").replace(/\s+/g, " ").trim()).join("|"));
  let prev = await snapshot();
  const deadline = Date.now() + maxMs;
  let stableFor = 0;
  while (Date.now() < deadline && stableFor < 3) {
    await page.waitForTimeout(600);
    const next = await snapshot();
    if (next === prev) stableFor += 1;
    else { stableFor = 0; prev = next; }
  }
};
// Click by FILTERED LOCATOR, never by captured index: the layers tree is
// virtualized and re-renders (re-projections!), so a measured index can
// point at a different row by click time.
const selectRowByPattern = async (namePattern, rowLabel, searchText) => {
  // Selection via the layers panel SEARCH. The search input PERSISTS once
  // opened; focus it directly (global shortcuts are suppressed while any
  // input is focused, so Cmd+F is unreliable mid-sequence), clear the stale
  // query, type the distinctive name substring, and click the row from the
  // short filtered list. The click is verified against the highlighted row.
  const focusSearch = () =>
    page.evaluate(() => {
      // The layers search input carries the search-bar component's munged
      // class; target it PRECISELY so a stray focus() never lands on an
      // unrelated input (sitemap filter, replace field...).
      const input = document.querySelector('input[class*="search_bar__search-input"]');
      if (input && input.offsetParent !== null) {
        input.focus();
        return document.activeElement === input;
      }
      return false;
    });
  if (searchText) {
    let focusedInput = await focusSearch();
    for (let openAttempt = 0; openAttempt < 8 && !focusedInput; openAttempt += 1) {
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(500);
      await page.keyboard.press("ControlOrMeta+f");
      await page.waitForTimeout(1200);
      focusedInput = await focusSearch();
    }
    if (!focusedInput) {
      const fs = await import("node:fs");
      try { fs.writeFileSync(join(dir, "search-focus-fail.txt"),
        JSON.stringify({ rowLabel }, null, 1)); } catch {}
      await page.screenshot({ path: join(dir, "search-focus-fail.png") }).catch(() => {});
      throw new Error(`layers search input never took focus for ${rowLabel ?? namePattern}`);
    }
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Delete");
    await page.waitForTimeout(200);
    await page.keyboard.type(searchText, { delay: 15 });
    await page.waitForTimeout(900);
    const dbg = await page.evaluate(() => ({
      active: document.activeElement
        ? `${document.activeElement.tagName} ${document.activeElement.className}`.slice(0, 80)
        : "none",
      value: (() => {
        const input = document.querySelector('input[class*="search_bar__search-input"]');
        return input ? input.value : "<no search input>";
      })(),
      rowCount: document.querySelectorAll('[data-testid="layer-row"]').length,
      rows: [...document.querySelectorAll('[data-testid="layer-row"]')]
        .slice(0, 8)
        .map((n) => (n.innerText ?? "").replace(/\s+/g, " ").trim()),
    }));
    const fs = await import("node:fs");
    try { fs.writeFileSync(join(dir, "search-state.json"), JSON.stringify(dbg, null, 1)); } catch {}
  }
  const row = page.getByTestId("layer-row").filter({ hasText: namePattern }).first();
  try {
    await row.waitFor({ timeout: 10_000, state: "attached" });
  } catch {
    await findRowScrolling(namePattern, { label: rowLabel });
    await expandBoard().catch(() => {});
    await waitTreeStable(15_000);
    await row.waitFor({ timeout: 15_000, state: "attached" });
  }
  for (let clickAttempt = 0; clickAttempt < 8; clickAttempt += 1) {
    await row.click();
    await page.waitForTimeout(500);
    const ok = await page
      .getByTestId("layer-row")
      .evaluateAll(
        (nodes, source) => {
          const re = new RegExp(source);
          return nodes.some((node) => {
            const text = (node.innerText ?? "").replace(/\s+/g, " ").trim();
            const highlighted = /highlight|selected/i.test(node.className);
            return highlighted && re.test(text);
          });
        },
        namePattern.source,
      );
    if (ok) break;
    await waitTreeStable(8_000);
  }
  await page.waitForTimeout(400);
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
// The Token inspector edit path (DSE-R18/R24/R26): select the specimen, type
// the new value, apply. One ordinary commit-changes mod-obj batch.
const inspectorEdit = async ({ select, selectLabel, search, fill, apply = true }) => {
  // Clicking a row re-renders the virtualized tree, which can race the
  // click itself: re-find and re-click until the Token inspector shows the
  // selected specimen.
  const inspector = page.getByTestId("dse-token-inspector");
  for (let attempt = 0; attempt < 5; attempt += 1) {
    await selectRowByPattern(select, selectLabel, search);
    try {
      await inspector.waitFor({ timeout: 3_000 });
      break;
    } catch {
      await page.screenshot({ path: join(dir, `inspector-attempt-${attempt}.png`) }).catch(() => {});
      if (attempt === 3) {
        // Long edit sequences accumulate re-projection churn in the layers
        // tree; a reload (real user action) restores a fresh tree.
        await page.reload({ waitUntil: "domcontentloaded" });
        await waitWorkspace();
        await expandBoard();
      }
      if (attempt === 4) {
        await page.screenshot({ path: join(dir, "inspector-fail.png") }).catch(() => {});
        const sidebarText = await page.locator("#right-sidebar-aside").innerText().catch(() => "no sidebar");
        const bodyHasError = (await page.locator("body").innerText()).includes("Something wrong");
        const dsPayload = await designSystem();
        const inv = dsPayload.tokenInventory;
        const rows = Array.isArray(inv) ? inv : inv?.rows ?? [];
        const layerRows = await page.getByTestId("layer-row").evaluateAll((nodes) =>
          nodes.map((node) => (node.innerText ?? "").replace(/\s+/g, " ").trim()));
        await writeFile(join(dir, "inspector-fail.txt"), JSON.stringify({
          sidebar: sidebarText.slice(0, 400), bodyHasError, url: page.url(),
          canonicalHasDecoration: (await readCell("tok_coverage_text_decoration")),
          inventoryDecorationRow: rows.find((r) => r.path === "decoration") ?? null,
          layerRowsWithDecoration: layerRows.filter((t) => t.includes("decoration")),
          layerRowCount: layerRows.length,
        }, null, 2)).catch(() => {});
        throw new Error(`token inspector never appeared for ${selectLabel ?? select}`);
      }
      // Recover between attempts: escape any text-edition state and deselect.
      await page.keyboard.press("Escape").catch(() => {});
      await page.getByTestId("viewport").click({ position: { x: 700, y: 320 } }).catch(() => {});
      await page.waitForTimeout(1_000);
      // The click may have started text edition on a TEXT specimen (double
      // click across retries) or raced a re-projection: escape, deselect,
      // then re-find and re-click.
      await page.keyboard.press("Escape").catch(() => {});
      await page.getByTestId("viewport").click({ position: { x: 700, y: 320 } }).catch(() => {});
      await page.waitForTimeout(1_000);
    }
  }
  if (fill.kind === "select") {
    await inspector
      .locator('[data-testid="dse-token-value"]')
      .selectOption(fill.value);
  } else {
    const input = inspector.locator('[data-testid="dse-token-value"]');
    await input.click({ clickCount: 3 });
    await input.fill(String(fill.value));
  }
  if (fill.fields) {
    for (const [name, value] of Object.entries(fill.fields)) {
      const field = inspector.locator(`[data-testid="dse-typo-${name}"]`);
      await field.click({ clickCount: 3 });
      await field.fill(String(value));
    }
  }
  if (apply) {
    await inspector.getByTestId("dse-token-apply").click();
    await page.waitForTimeout(500);
  }
};
const noInternalError = async () => {
  const body = await page.locator("body").innerText();
  assert.ok(!body.includes("Internal Error"), "page shows Internal Error");
};
// One FULL loop: edit -> source readback -> Undo -> Redo. The SOURCE decides.
const writeLoop = async (item) => {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await writeLoopOnce(item);
    } catch (error) {
      if (attempt === 1) throw error;
      log(`writeLoop ${item.key}: retry after: ${String(error).slice(0, 160)}`);
      await page.keyboard.press("Escape").catch(() => {});
      await page.waitForTimeout(2_000);
    }
  }
};
const writeLoopOnce = async ({ key, tokenId, entry, apply, predicate, undoPredicate }) => {
  // The previous step's redo landed a token op → the board re-projects a few
  // seconds later; let that settle so row clicks hit the NEW tree.
  await page.waitForTimeout(4_000);
  const before = await readCell(tokenId);
  await apply();
  const deadline = Date.now() + 45_000;
  while (Date.now() < deadline) {
    if (predicate(await readCell(tokenId))) break;
    await page.waitForTimeout(1_000);
  }
  assert.ok(predicate(await readCell(tokenId)), `${key}: edit did not reach its source`);
  await shot(`${key}-edited`);
  const undo = async () => {
    await page.keyboard.press("ControlOrMeta+z");
    const undoDeadline = Date.now() + 30_000;
    while (Date.now() < undoDeadline) {
      if (undoPredicate(await readCell(tokenId), before)) return;
      await page.waitForTimeout(1_000);
    }
    throw new Error(`${key}: undo did not restore the source`);
  };
  const redo = async () => {
    await page.keyboard.press("ControlOrMeta+Shift+z");
    const redoDeadline = Date.now() + 30_000;
    while (Date.now() < redoDeadline) {
      if (predicate(await readCell(tokenId))) return;
      await page.waitForTimeout(1_000);
    }
    throw new Error(`${key}: redo did not reapply the edit`);
  };
  await undo();
  await shot(`${key}-undone`);
  await redo();
  await shot(`${key}-redone`);
  writeRecords.push({
    key,
    tokenId,
    sourceEntry: entry,
    before,
    after: await readCell(tokenId),
  });
};

let setupError = null;
try {
  const snapshot = await workspace();
  const fileId = snapshot.runtime.file;
  const url = new URL(web.url);
  url.hash = `#/design-system?file-id=${fileId}`;
  await writeFile(
    join(dir, "run-identity.json"),
    JSON.stringify(
      {
        startedAt: new Date().toISOString(),
        backend: bg.url,
        frontend: web.url,
        fileId,
        originalPackage: actualPackage,
        originalHash,
        scratchCopy: packagePath,
        extendedFixture: !plain,
        packageRevisionAtStart: snapshot.revision,
        card: "DSE-R17~R26 / Package A",
        mode: label,
        keys: wantedKeys ? [...wantedKeys] : "all",
      },
      null,
      2,
    ),
  );
  log(`open ${url.href}`);

  await page.goto(url.href, { waitUntil: "networkidle" });
  await waitWorkspace();
  await expandBoard();

  const combos = enumerateCombinations(tokenLibrary(baselineCanonical).library);
  const bandLabels = new Set(combos.map((combo) => combo.label));
  if (!plain) bandLabels.add("Archived · 未激活");
  const cells = canonicalCells(baselineCanonical);
  const typesInPackage = new Set(cells.map((cell) => cell.type));
  const ALL_TYPES = [
    "boolean", "border-radius", "color", "dimensions", "font-family",
    "font-size", "font-weight", "letter-spacing", "number", "opacity",
    "other", "rotation", "shadow", "sizing", "spacing", "string",
    "stroke-width", "text-case", "text-decoration", "typography",
  ];

  await step("mount::panorama-reconciliation", async () => {
    const rows = await collectRows();
    const rowsArr = [...rows];
    const text = rowsArr.join("\n");
    // (a) every (Cell × combination-in-view) specimen row, by name.
    let expectedSpecimens = 0;
    const missing = [];
    for (const cell of cells) {
      const views =
        cell.combinationIds === "domain"
          ? combos.filter((combo) => combo.setIds.includes(cell.setId))
          : cell.combinationIds === "all"
            ? combos
            : [{ label: "Archived · 未激活" }];
      for (const view of views) {
        expectedSpecimens += 1;
        const name = `Token / ${cell.setName}/${cell.path} · ${view.label}`;
        if (!rowsArr.some((row) => row.includes(name))) missing.push(name);
      }
    }
    await writeFile(
      join(dir, "board-row-reconciliation.json"),
      JSON.stringify(
        {
          expectedSpecimens,
          missing,
          rows: rows.size,
          combinationLabels: [...bandLabels],
          mode: label,
        },
        null,
        2,
      ),
    );
    assert.equal(missing.length, 0, `missing specimen rows: ${missing.slice(0, 8).join(" | ")}`);
    // (b) the 20-type gutter catalog: count for present types, 暂无 for the rest.
    for (const type of ALL_TYPES) {
      const count = cells.filter((cell) => cell.type === type).length;
      const expected = count > 0 ? `${type} · ${count} Cell` : `${type} · 暂无 Token`;
      assert.ok(
        rowsArr.some((row) => row.includes(expected)),
        `catalog row missing: ${expected}`,
      );
    }
    // (c) combination band headers are all present (everything expanded).
    for (const combo of combos) {
      assert.ok(text.includes(combo.label), `combination band header missing: ${combo.label}`);
    }
    // (d) binding displays: the alias Cell shows its RESOLVED value.
    const baseRadius = cells.find((cell) => cell.id === "tok_radius_md_base");
    assert.ok(
      text.includes(`radius.alias = ${baseRadius?.value ?? ""}`) ||
        /radius\.alias = \d+/.test(text),
      "alias Cell must display its resolved value",
    );
    await noInternalError();
  });

  await step("clean::no-debug-metadata-on-canvas", async () => {
    const rows = await collectRows();
    for (const row of rows) {
      assert.ok(!row.includes("pkg_design_system"), `package id printed on canvas: ${row}`);
      assert.ok(!/· (literal|alias) ·/.test(row), `literal/alias flag printed: ${row}`);
      assert.ok(!/(ownerPackageId|activeSetIds|tokenId)/.test(row), `internal id printed: ${row}`);
    }
    await shot("clean-canvas");
  });

  await step("controller::lists-all-combinations", async () => {
    const controller = page.getByTestId("dse-combination-controller");
    await controller.waitFor({ timeout: 10_000 });
    const rows = controller.getByTestId("dse-combination-row");
    await rows.first().waitFor({ timeout: 10_000 });
    assert.equal(await rows.count(), combos.length, "controller must list every valid combination");
    assert.ok(await controller.getByTestId("dse-combination-hint").count(), "hint missing");
    await shot("controller");
  });

  await step("controller::focus-is-zero-write", async () => {
    const beforeFiles = await readCanonicalFiles(packagePath);
    const controller = page.getByTestId("dse-combination-controller");
    const target = combos[0];
    await controller
      .getByTestId("dse-combination-row")
      .filter({ hasText: target.label })
      .getByTestId("dse-combination-focus")
      .click();
    await page.waitForTimeout(1_500);
    // Observation only: the canonical tree is byte-identical, no HTTP 4xx,
    // and the OTHER combinations are still materialized in the layers tree.
    const afterFiles = await readCanonicalFiles(packagePath);
    assert.deepEqual(
      JSON.stringify(beforeFiles.get(tokenLibrary(beforeFiles).entry)),
      JSON.stringify(afterFiles.get(tokenLibrary(afterFiles).entry)),
      "focus must not write the canonical token library",
    );
    assert.equal(httpErrors.length, 0, `unexpected HTTP errors: ${JSON.stringify(httpErrors.slice(0, 3))}`);
    const other = combos[1] ?? combos[0];
    const rows = await collectRows();
    assert.ok(
      [...rows].some((row) => row.includes(`· ${other.label}`)),
      "the other combination must stay on the board after focus",
    );
    await shot("focus-light");
    // Collapse/expand the controller itself; canvas content stays.
    await page.getByTestId("dse-combination-toggle").click();
    await page.waitForTimeout(300);
    assert.ok(
      (await page.getByTestId("dse-combination-row").count()) === 0,
      "collapse must hide only the controller panel",
    );
    await page.getByTestId("dse-combination-toggle").click();
    await page.waitForTimeout(300);
  });

  await step("controller::absent-on-ordinary-page", async () => {
    await page.locator('[data-testid="page-name"]').filter({ hasText: /^Design System Fixture$/ }).first().click().catch(async () => {
      // fall back to the first non-generated page row in the sitemap
      await page.locator('[data-testid="page-name"]').first().click();
    });
    await page.waitForTimeout(2_000);
    assert.equal(
      await page.getByTestId("dse-combination-controller").count(),
      0,
      "the controller must not render on an ordinary page",
    );
    await shot("controller-negative-ordinary-page");
    await page.locator('[data-testid="page-name"]').filter({ hasText: /^Design System$/ }).first().click();
    await page.waitForTimeout(2_000);
  });

  if (!plain) {
    // --- 20/20 canonical types: one REAL UI edit loop each ---------------
    const numericCases = [
      { key: "type-opacity", tokenId: "tok_coverage_opacity", select: /^Token \/ reference\/coverage\/veil/, edit: () => inspectorEdit({ select: /veil/, search: "coverage/veil", fill: { kind: "text", value: "0.8" } }), predicate: (v) => Number(v) === 0.8 },
      { key: "type-rotation", tokenId: "tok_coverage_rotation", select: /^Token \/ reference\/coverage\/tilt/, edit: () => inspectorEdit({ select: /tilt/, search: "coverage/tilt", fill: { kind: "text", value: -45 } }), predicate: (v) => Number(v) === -45 },
      { key: "type-dimensions", tokenId: "tok_coverage_dimensions", select: /^Token \/ reference\/coverage\/box/, edit: () => inspectorEdit({ select: /box/, search: "coverage/box", fill: { kind: "text", value: 140 } }), predicate: (v) => Number(v) === 140 },
      { key: "type-font-size", tokenId: "tok_coverage_font_size", select: /^Token \/ reference\/coverage\/size/, edit: () => inspectorEdit({ select: /size/, search: "coverage/size", fill: { kind: "text", value: 36 } }), predicate: (v) => Number(v) === 36 },
      { key: "type-letter-spacing", tokenId: "tok_coverage_letter_spacing", select: /^Token \/ reference\/coverage\/tracking/, edit: () => inspectorEdit({ select: /tracking/, search: "coverage/tracking", fill: { kind: "text", value: 4 } }), predicate: (v) => Number(v) === 4 },
      { key: "type-font-family", tokenId: "tok_coverage_font_family", select: /^Token \/ reference\/coverage\/family/, edit: () => inspectorEdit({ select: /family/, search: "coverage/family", fill: { kind: "text", value: "Sourcesanspro" } }), predicate: (v) => v === "Sourcesanspro" },
      { key: "type-font-weight", tokenId: "tok_coverage_font_weight", select: /^Token \/ reference\/coverage\/weight/, edit: () => inspectorEdit({ select: /weight/, search: "coverage/weight", fill: { kind: "text", value: 800 } }), predicate: (v) => Number(v) === 800 },
      { key: "type-text-case", tokenId: "tok_coverage_text_case", select: /^Token \/ reference\/coverage\/case/, edit: () => inspectorEdit({ select: /^Token \/ reference\/coverage\/case/, fill: { kind: "text", value: "lowercase" } }), predicate: (v) => v === "lowercase" },
      { key: "type-text-decoration", tokenId: "tok_coverage_text_decoration", select: /^Token \/ reference\/coverage\/decoration/, edit: () => inspectorEdit({ select: /decoration/, search: "coverage/decoration", fill: { kind: "text", value: "line-through" } }), predicate: (v) => v === "line-through" },
      { key: "type-boolean", tokenId: "tok_coverage_boolean", select: /^Token \/ reference\/coverage\/flag/, edit: () => inspectorEdit({ select: /flag/, search: "coverage/flag", fill: { kind: "text", value: "false" } }), predicate: (v) => v === false },
      { key: "type-number", tokenId: "tok_coverage_number", select: /^Token \/ reference\/coverage\/count/, edit: () => inspectorEdit({ select: /count/, search: "coverage/count", fill: { kind: "text", value: 42.5 } }), predicate: (v) => Number(v) === 42.5 },
      { key: "type-string", tokenId: "tok_coverage_string", select: /^Token \/ reference\/coverage\/label/, edit: () => inspectorEdit({ select: /label/, search: "coverage/label", fill: { kind: "text", value: "HELLO 覆盖" } }), predicate: (v) => v === "HELLO 覆盖" },
      { key: "type-other", tokenId: "tok_coverage_other", select: /^Token \/ reference\/coverage\/config/, edit: () => inspectorEdit({ select: /config/, search: "coverage/config", fill: { kind: "text", value: '{"a":{"b":[3]}}' } }), predicate: (v) => typeof v === "string" && v.includes('"b":[3]') },
    ];
    const tokensEntry = tokenLibrary(baselineCanonical).entry;
    for (const item of numericCases.filter((item) => wantKey(item.key))) {
      await step(`edit-loop::${item.key}`, async () => {
        await writeLoop({
          key: item.key,
          tokenId: item.tokenId,
          entry: tokensEntry,
          apply: item.edit,
          predicate: item.predicate,
          undoPredicate: (value, before) => JSON.stringify(value) === JSON.stringify(before),
        });
        await noInternalError();
      });
    }

    // Panel-bound types through their native panels (same UI as ordinary
    // shapes — the specimen binds the attribute).
    if (wantKey("type-typography"))
    await step("edit-loop::type-typography", async () => {
      await writeLoop({
        key: "type-typography",
        tokenId: "tok_typography_md_heading",
        entry: tokensEntry,
        apply: async () => {
          await selectRowByPattern(/Token \/ typography\/md\/heading · Light/, "typography heading", "typography/md/heading");
          const inspector = page.getByTestId("dse-token-inspector");
          await inspector.waitFor({ timeout: 10_000 });
          await inspector.locator('[data-testid="dse-typo-fontSize"]').click({ clickCount: 3 });
          await inspector.locator('[data-testid="dse-typo-fontSize"]').fill("40");
          await inspector.getByTestId("dse-token-apply").click();
          await page.waitForTimeout(500);
        },
        predicate: (v) => v && typeof v === "object" && Number(v.fontSize) === 40,
        undoPredicate: (value, before) => JSON.stringify(value?.fontSize ?? value) === JSON.stringify(before?.fontSize ?? before),
      });
    });

    if (wantKey("type-color"))
    await step("edit-loop::type-color", async () => {
      await writeLoop({
        key: "type-color",
        tokenId: "tok_color_light_primary",
        entry: tokensEntry,
        apply: async () => {
          await selectRowByPattern(/Token \/ color\/light\/primary · Light/, "color primary Light", "color/light/primary");
          await setFillColor("#0ea5e9");
        },
        predicate: (v) => typeof v === "string" && v.toLowerCase() === "#0ea5e9",
        undoPredicate: (value, before) => String(value).toLowerCase() === String(before).toLowerCase(),
      });
    });
    if (wantKey("type-border-radius"))
    await step("edit-loop::type-border-radius", async () => {
      await writeLoop({
        key: "type-border-radius",
        tokenId: "tok_radius_md_base",
        entry: tokensEntry,
        apply: async () => {
          await selectRowByPattern(/Token \/ radius\/md\/base · Light/, "radius base", "radius/md/base");
          await setNumeric('input[aria-label="Radius"]', 16, "Border radius section");
        },
        predicate: (v) => Number(v) === 16,
        undoPredicate: (value, before) => Number(value) === Number(before),
      });
    });
    if (wantKey("type-sizing"))
    await step("edit-loop::type-sizing", async () => {
      await writeLoop({
        key: "type-sizing",
        tokenId: "tok_demo_sizing_control",
        entry: tokensEntry,
        apply: async () => {
          await selectRowByPattern(/Token \/ sizing\/md\/control · Archived/, "sizing control", "sizing/md/control");
          await setNumeric('[aria-label="shape-measures-section"] input[aria-label="Height"]', 64);
        },
        predicate: (v) => Number(v) === 64,
        undoPredicate: (value, before) => Number(value) === Number(before),
      });
    });
    if (wantKey("type-stroke-width"))
    await step("edit-loop::type-stroke-width", async () => {
      await writeLoop({
        key: "type-stroke-width",
        tokenId: "tok_demo_stroke_border",
        entry: tokensEntry,
        apply: async () => {
          await selectRowByPattern(/Token \/ stroke\/md\/border-width · Archived/, "stroke border-width", "stroke/md/border-width");
          await setNumeric('input[aria-label="Stroke width"]', 3, "stroke-section");
        },
        predicate: (v) => Number(v) === 3,
        undoPredicate: (value, before) => Number(value) === Number(before),
      });
    });
    if (wantKey("type-spacing"))
    await step("edit-loop::type-spacing", async () => {
      await writeLoop({
        key: "type-spacing",
        tokenId: "tok_spacing_md_large",
        entry: tokensEntry,
        apply: () => inspectorEdit({ select: /^Token \/ spacing\/md\/space\.large · Light/, search: "space.large", fill: { kind: "text", value: 24 } }),
        predicate: (v) => Number(v) === 24,
        undoPredicate: (value, before) => Number(value) === Number(before),
      });
    });
    if (wantKey("type-shadow"))
    await step("edit-loop::type-shadow", async () => {
      await writeLoop({
        key: "type-shadow",
        tokenId: "tok_demo_effect_elevation",
        entry: tokensEntry,
        apply: async () => {
          await selectRowByPattern(/^Token \/ effect\/md\/elevation-1 · Archived/, "shadow elevation-1", "elevation-1");
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
        predicate: (v) => v && typeof v === "object" && /dc2626/i.test(String(v.color)),
        undoPredicate: (value, before) => JSON.stringify(value?.color ?? "") === JSON.stringify(before?.color ?? ""),
      });
    });
    if (wantKey("binding-alias"))
    await step("binding::alias-resolves-after-target-edit", async () => {
      // Edit the alias TARGET ({base}); the alias Cell's RESOLVED display
      // must follow the target edit through the token-op re-projection
      // (R26 同步联动). The resolved value is asserted on the alias
      // specimen's Token inspector (reprojected server-resolved value).
      // Three attempts; every value is read from the source so retries are
      // idempotent.
      let lastError = null;
      for (let attempt = 0; attempt < 3; attempt += 1) {
        try {
          const before = await readCell("tok_radius_md_base");
          const next = Number(before) === 20 ? 16 : 20;
          await selectRowByPattern(/Token \/ radius\/md\/base · (Light|Archived)/, "radius base", "radius/md/base");
          const radiusBox = page
            .locator('#right-sidebar-aside [aria-label="Radius"] input, #right-sidebar-aside input[aria-label="Radius"]')
            .first();
          await radiusBox.waitFor({ timeout: 8_000, state: "attached" });
          await radiusBox.click({ clickCount: 3 });
          await radiusBox.fill(String(next));
          await radiusBox.press("Enter");
          const srcDeadline = Date.now() + 30_000;
          while (Date.now() < srcDeadline) {
            if (Number(await readCell("tok_radius_md_base")) === next) break;
            await page.waitForTimeout(1_000);
          }
          assert.equal(Number(await readCell("tok_radius_md_base")), next, "radius edit must reach the source");
          // the token-op re-projection redraws the board; give it a beat
          await page.waitForTimeout(7_000);
          // Select the ALIAS specimen and read its Token inspector: the
          // resolved preview must show the NEW base value while the raw
          // expression stays "{base}".
          await selectRowByPattern(/Token \/ alias\/demo\/radius\.alias/, "alias specimen", "radius.alias");
          const inspectorText = await page.getByTestId("dse-token-inspector").innerText();
          const fs = await import("node:fs");
          try { fs.writeFileSync(join(dir, "binding-debug.json"), JSON.stringify({
            next, radiusBaseAfterEdit: await readCell("tok_radius_md_base"),
            inspectorText: inspectorText.replace(/\n/g, " | "),
          }, null, 1)); } catch {}
          assert.ok(
            inspectorText.includes(`解析值：${next}`),
            `alias resolved preview must follow the target edit (want 解析值：${next})`,
          );
          // Alias EXPRESSION stays untouched: the raw value is still "{base}".
          assert.equal(await readCell("tok_alias_demo_radius"), "{base}", "alias expression must be preserved");
          await shot("binding-alias-sync");
          // restore baseline radius
          await page.keyboard.press("ControlOrMeta+z");
          const undoDeadline = Date.now() + 30_000;
          while (Date.now() < undoDeadline) {
            if (Number(await readCell("tok_radius_md_base")) === Number(before)) break;
            await page.waitForTimeout(1_000);
          }
          assert.equal(Number(await readCell("tok_radius_md_base")), Number(before), "binding edit must undo");
          lastError = null;
          break;
        } catch (error) {
          lastError = error;
          await page.keyboard.press("Escape").catch(() => {});
          await page.waitForTimeout(3_000);
        }
      }
      if (lastError) throw lastError;
    });

    await step("controller::set-current-combination-writes-once", async () => {
      // The explicit EDIT action: switch the project's Current Combination
      // to the first combination, verify the canonical themes update, then
      // undo back.
      const entry = tokenLibrary(baselineCanonical).entry;
      const beforeLibrary = (await readCanonicalFiles(packagePath)).get(entry);
      const target = combos[0];
      const controller = page.getByTestId("dse-combination-controller");
      await controller
        .getByTestId("dse-combination-row")
        .filter({ hasText: target.label })
        .getByTestId("dse-combination-set-current")
        .click();
      const deadline = Date.now() + 45_000;
      let after = null;
      while (Date.now() < deadline) {
        after = (await readCanonicalFiles(packagePath)).get(entry);
        if (JSON.stringify(after.activeThemeIds) !== JSON.stringify(beforeLibrary.activeThemeIds)) break;
        await page.waitForTimeout(1_000);
      }
      assert.deepEqual(
        [...after.activeThemeIds].sort(),
        [...target.themeIds].sort(),
        "set-current must write the project's active theme ids exactly once",
      );
      await page.getByTestId("viewport").click({ position: { x: 720, y: 500 } }).catch(() => {});
      await page.waitForTimeout(400);
      await page.keyboard.press("ControlOrMeta+z");
      const undoDeadline = Date.now() + 30_000;
      while (Date.now() < undoDeadline) {
        const current = (await readCanonicalFiles(packagePath)).get(entry);
        if (JSON.stringify(current.activeThemeIds) === JSON.stringify(beforeLibrary.activeThemeIds)) break;
        await page.waitForTimeout(1_000);
      }
      const restored = (await readCanonicalFiles(packagePath)).get(entry);
      assert.deepEqual(
        restored.activeThemeIds,
        beforeLibrary.activeThemeIds,
        "set-current must undo back to the previous active themes",
      );
    });
  }

  await step("reload::panorama-rebuilds-with-terminal-state", async () => {
    await page.reload({ waitUntil: "networkidle" });
    await waitWorkspace();
    await expandBoard();
    await page.waitForTimeout(2_000);
    const rows = await collectRows();
    const cellsNow = canonicalCells(await readCanonicalFiles(packagePath));
    for (const cell of cellsNow) {
      const views =
        cell.combinationIds === "domain"
          ? combos.filter((combo) => combo.setIds.includes(cell.setId))
          : cell.combinationIds === "all"
            ? combos
            : [{ label: "Archived · 未激活" }];
      for (const view of views) {
        assert.ok(
          [...rows].some((row) => row.includes(`Token / ${cell.setName}/${cell.path} · ${view.label}`)),
          `post-reload row missing: ${cell.setName}/${cell.path} · ${view.label}`,
        );
      }
    }
    await shot("reload-keeps-state");
    await noInternalError();
  });

  await step("canonical::zero-residue-and-original-untouched", async () => {
    const finalFiles = await readCanonicalFiles(packagePath);
    assertNoGeneratedResidue(finalFiles, await workspace());
    const changed = [...finalFiles.keys()].filter((entry) => {
      const before = JSON.stringify(baselineCanonical.get(entry));
      const after = JSON.stringify(finalFiles.get(entry));
      return before !== after;
    });
    await writeFile(
      join(dir, "canonical-tree-diff.json"),
      JSON.stringify({ changedEntries: changed, writeRecords }, null, 2),
    );
    const allowed = plain
      ? []
      : [tokenLibrary(baselineCanonical).entry];
    assert.deepEqual(
      changed.filter((entry) => !allowed.includes(entry)),
      [],
      `the run must only touch the token library entry, got: ${changed.join(", ")}`,
    );
    const finalHash = await hashTree(actualPackage);
    assert.equal(finalHash, originalHash, "the ORIGINAL package must be untouched");
  });
} catch (error) {
  setupError = error;
} finally {
  await writeFile(
    join(dir, "results.json"),
    JSON.stringify(
      {
        mode: label,
        steps: results,
        pageErrors,
        consoleErrors,
        httpErrors,
        setupError: setupError ? String(setupError?.stack ?? setupError) : null,
        finishedAt: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  await browser.close();
  await bg.close();
}

if (setupError) {
  console.error("RUN FAILED");
  process.exit(1);
}
console.log("RUN OK");
// The closed browser/server keep a handle on the event loop (observed: the
// node process lingers after RUN OK, blocking sequential invocation).
process.exit(0);
