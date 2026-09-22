// DSE-R16 evidence: the generated Design System page NEVER persists. On an
// isolated copy of the user's actual package
// (/private/tmp/smallpen-live-demo/design-system.smallpen), through the REAL
// browser UI:
//   mount rebuild from canonical -> one full loop per write class
//   (Token Cell / component definition / page occurrence override:
//   source readback + diff + Undo + Redo) -> decoration edit through a native
//   panel is a no-op -> external package edit rebuilds the board -> alias
//   readonly negative -> reload rebuild -> whole-run canonical tree diff with
//   zero System Sheet residue -> original package untouched.
// Usage: node e2e/dse-r16-persistence.mjs --audit <dir> [--zero-components]
//   --zero-components strips component entries + instances from the isolated
//   copy (same procedure as dse-early-slice.mjs): the gating must hold with
//   the same force on a package without any component.
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

// Canonical-independent read of the isolated copy: manifest + every entry,
// straight from disk. Never derived from /v1/workspace or the board itself.
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

// Every Token Cell in the copy's own token library, enumerated from the
// canonical FILE (not from runtime refs, not from the UI projection).
function canonicalTokenCells(canonical) {
  const cells = [];
  for (const entry of canonical.get("manifest.json").entries.tokens) {
    const library = canonical.get(entry);
    for (const set of library.sets ?? []) {
      for (const token of set.tokens ?? []) {
        cells.push({ entry, set: set.name, path: token.name, id: token.id });
      }
    }
  }
  return cells;
}

// System Sheet residue must never appear in a canonical file: neither the
// generated page/board/decoration runtime ids nor the projection-only
// plugin-data markers.
function assertNoGeneratedResidue(files, workspacePayload) {
  const runtime = workspacePayload.runtime;
  const generatedIds = new Set(
    [
      runtime.designSystemPage,
      runtime.componentsPage,
      runtime.designSystem?.board,
      runtime.designSystem?.tokenLabel,
      runtime.designSystem?.tokensSection,
      runtime.designSystem?.componentsSection,
      runtime.designSystem?.pagesSection,
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
const zeroComponents = flag("--zero-components");
const auditRoot =
  argValue("--audit") ?? join(root, "audits", "dse-full-delivery", "r16-latest");
const label = zeroComponents ? "r16-zero" : "r16-actual";
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

const scratch = await mkdtemp(join(tmpdir(), "smallpen-dse-r16-"));
const packagePath = join(scratch, "design-system.smallpen");
await cp(actualPackage, packagePath, { recursive: true });

if (zeroComponents) {
  // Same stripping as dse-early-slice.mjs: remove the component entries and
  // every INSTANCE node (instances referencing removed components would fail
  // the reference validator at load).
  const manifestPath = join(packagePath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.entries.components = [];
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
const baselineCanonical = await readCanonicalFiles(packagePath);
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
const rowValue = (row) => JSON.stringify(row?.effectiveValue ?? row?.value);
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
const findRowScrolling = async (namePattern, { label } = {}) => {
  const readRows = () =>
    page.getByTestId("layer-row").evaluateAll((nodes) =>
      nodes.map((node) => (node.innerText ?? "").replace(/\s+/g, " ").trim()),
    );
  // A previous selectRowByPattern may have left a layers-SEARCH query
  // active; on the panorama tree that filter hides every non-matching row
  // (e.g. "Card / idle" after searching "color/light/primary"). Clear the
  // field before scrolling so the full tree renders again. fill("") goes
  // through the input's real event path (a native Event dispatch does not
  // reach the React-controlled value).
  const searchInput = page.locator('input[class*="search_bar__search-input"]').first();
  if (await searchInput.count()) {
    await searchInput.fill("").catch(() => {});
    await page.waitForTimeout(900);
  }
  // The tree window-renders: every search starts from the top of the panel
  // so rows above the previous search are visible again.
  await page.mouse.move(200, 600);
  for (let round = 0; round < 30; round += 1) {
    await page.mouse.wheel(0, -800).catch(() => {});
    await page.waitForTimeout(120);
  }
  for (let round = 0; round < 40; round += 1) {
    const texts = await readRows();
    const index = texts.findIndex((row) => namePattern.test(row));
    if (index >= 0) return index;
    await page.mouse.move(200, 600);
    await page.mouse.wheel(0, 700).catch(() => {});
    await page.waitForTimeout(350);
  }
  throw new Error(`layer row not found on the board: ${label ?? namePattern}`);
};
// One top-to-bottom pass accumulating every rendered row text (the mount and
// reload reconciliation checks ALL rows, not just one). Row innerTexts carry
// trailing badge chips ("Token", "装饰"), so consumers match with regexes.
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
  for (let round = 0; round < 80 && stable < 4; round += 1) {
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
const escapeReg = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const rowsMatch = (rows, pattern) => [...rows].some((text) => pattern.test(text));
// Selection via the layers panel SEARCH: the panorama tree is deep and
// virtualized; direct clicks race the windowing. The search filters the
// tree to a short stable list. The click is verified against the
// highlighted row.
const selectRowByPattern = async (namePattern, label) => {
  await page.getByTestId("layer-row").first().waitFor({ timeout: 30_000, state: "attached" }).catch(() => {});
  await page.keyboard.press("Escape").catch(() => {});
  await page.evaluate(() => {
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
  });
  await page.waitForTimeout(300);
  await page.keyboard.press("ControlOrMeta+f");
  await page.waitForTimeout(900);
  let focused = await page.evaluate(() =>
    document.activeElement && document.activeElement.tagName === "INPUT");
  for (let attempt = 0; attempt < 6 && !focused; attempt += 1) {
    await page.keyboard.press("Escape").catch(() => {});
    await page.waitForTimeout(500);
    await page.keyboard.press("ControlOrMeta+f");
    await page.waitForTimeout(1000);
    focused = await page.evaluate(() =>
      document.activeElement && document.activeElement.tagName === "INPUT");
  }
  if (focused) {
    // Derive a searchable name substring from the row pattern: strip the
    // "Token / " prefix anchor and regex escapes.
    const searchText = String(namePattern.source)
      .replace("^\\(\?:Token \\/ )?", "")
      .replace("^Token \\/ ", "")
      .replace("^", "")
      .replace(/\\\//g, "/")
      .replace("\\( |\\$)", "")
      .split("\\")[0]
      .slice(0, 44);
    await page.keyboard.press("ControlOrMeta+a");
    await page.keyboard.press("Delete");
    await page.waitForTimeout(200);
    await page.keyboard.type(searchText, { delay: 15 });
    await page.waitForTimeout(1_000);
  }
  const row = page.getByTestId("layer-row").filter({ hasText: namePattern }).first();
  try {
    await row.waitFor({ timeout: 10_000, state: "attached" });
  } catch {
    await findRowScrolling(namePattern, { label });
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
    await page.waitForTimeout(1_500);
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
const noInternalError = async () => {
  const body = await page.locator("body").innerText();
  assert.ok(!body.includes("Internal Error"), "page shows Internal Error");
};

// One FULL write loop for one class: panel edit -> source readback (with
// revision + focused diff record) -> Undo restores the source -> Redo
// reapplies it. The SOURCE decides (package files read back from disk),
// never the UI.
const writeLoop = async ({ key, expectedEntry, extract, sourceValue, undoValue, redoValue }) => {
  const undo = async (predicate, label) => {
    await page.waitForTimeout(5_000);
    // A token-op commit triggers a board re-projection; a Cmd+Z pressed
    // inside that swap window can be dropped. Re-press while the source has
    // not restored (the stack top IS this loop's edit, so a re-press is the
    // same undo).
    let presses = 0;
    const deadline = Date.now() + 75_000;
    while (Date.now() < deadline) {
      if (predicate(await sourceValue())) return;
      await page.waitForTimeout(1_500);
      if (presses < 4) {
        await page.evaluate(() => {
          if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        });
        await page.keyboard.press("ControlOrMeta+z");
        presses += 1;
      }
    }
    throw new Error(`${key}: undo did not restore the source (${label})`);
  };
  const redo = async (predicate, label) => {
    await page.waitForTimeout(5_000);
    let presses = 0;
    await page.keyboard.press("ControlOrMeta+Shift+z");
    const deadline = Date.now() + 75_000;
    while (Date.now() < deadline) {
      if (predicate(await sourceValue())) return;
      await page.waitForTimeout(1_500);
      if (presses < 4) {
        await page.evaluate(() => {
          if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
        });
        await page.keyboard.press("ControlOrMeta+Shift+z");
        presses += 1;
      }
    }
    throw new Error(`${key}: redo did not reapply the edit (${label})`);
  };
  const beforeRevision = (await workspace()).revision;
  const beforeFiles = await readCanonicalFiles(packagePath);
  await redoValue.apply();
  const redoDeadline = Date.now() + 40_000;
  while (Date.now() < redoDeadline) {
    if (redoValue.predicate(await sourceValue())) break;
    await page.waitForTimeout(1_000);
  }
  assert.ok(
    redoValue.predicate(await sourceValue()),
    `${key}: edit did not reach its source`,
  );
  const afterRevision = (await workspace()).revision;
  await undo(redoValue.undoPredicate ?? undoValue.predicate, "after edit");
  await redo(redoValue.predicate, "after undo");
  writeRecords.push({
    key,
    target: redoValue.target,
    revisionBefore: beforeRevision,
    revisionAfter: afterRevision,
    sourceEntry: expectedEntry,
    diff: {
      before: extract(beforeFiles.get(expectedEntry)),
      after: extract((await readCanonicalFiles(packagePath)).get(expectedEntry)),
    },
  });
  await shot(`${key}-redone`);
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
        card: "DSE-R16",
        zeroComponents,
      },
      null,
      2,
    ),
  );

  await page.goto(url.href, { waitUntil: "domcontentloaded" });
  await waitWorkspace();
  await expandBoard();
  await shot("01-mount");

  // --- mount: the board rebuilds from the canonical snapshot. The expected
  // rows are enumerated independently from the package FILES on disk.
  await step("mount::rebuild-from-canonical", async () => {
    assert.ok((await page.getByTestId("left-sidebar").count()) > 0, "layers sidebar missing");
    assert.ok((await page.getByTestId("right-sidebar").count()) > 0, "properties sidebar missing");
    const cells = canonicalTokenCells(baselineCanonical);
    assert.equal(cells.length, 19, "fixture expectation: 19 Token Cells in this package");
    const rows = await collectRows();
    const missing = cells
      .map((cell) => ({
        expected: `Token / ${cell.set}/${cell.path}`,
        pattern: new RegExp(`^Token / ${escapeReg(cell.set)}/${escapeReg(cell.path)}( |$)`),
      }))
      .filter(({ expected, pattern }) => !rowsMatch(rows, pattern))
      .map(({ expected }) => expected);
    await writeFile(
      join(dir, "mount-row-reconciliation.json"),
      JSON.stringify({ expected: cells.length, collected: rows.size, missing }, null, 2),
    );
    assert.deepEqual(missing, [], "rebuilt board is missing canonical Token Cell rows");
    await noInternalError();
    assert.equal(pageErrors.length, 0, `page errors: ${pageErrors.join(" | ")}`);
  });

  // --- write class 1: Token Cell (color/light/primary fill) ---------------
  await step("write::token-cell", async () => {
    const extract = (library) => {
      const token = library.sets
        .find((set) => set.id === "tset_color_light")
        .tokens.find((item) => item.id === "tok_color_light_primary");
      return token.$value ?? token.value;
    };
    const baseline = extract(baselineCanonical.get("tokens/tokens.json"));
    const target = baseline === "#0ea5e9" ? "#ef4444" : "#0ea5e9";
    await selectRowByPattern(/^Token \/ color\/light\/primary/, "token primary");
    await shot("02-token-selected");
    await writeLoop({
      key: "token-cell",
      expectedEntry: "tokens/tokens.json",
      extract,
      sourceValue: async () => JSON.parse(await readFile(join(packagePath, "tokens/tokens.json"), "utf8")),
      undoValue: {
        predicate: (library) => extract(library) === baseline,
      },
      redoValue: {
        target: { kind: "token-cell", ownerPackageId: "pkg_design_system", setId: "tset_color_light", tokenId: "tok_color_light_primary", path: "primary", field: "fill" },
        apply: () => setFillColor(target),
        predicate: (library) => extract(library) === target,
      },
    });
  });

  // --- write class 2: component definition (Card / idle Label fill) --------
  // Zero-components variant: the package has no component, the step has no
  // target; the gating classes that remain are token-cell + page occurrence.
  if (!zeroComponents) await step("write::component-definition", async () => {
    const extract = (components) =>
      components.componentSets
        .find((set) => set.id === "cmp_card_set")
        .variants.find((variant) => variant.id === "var_card_idle")
        .nodes.node_card_idle_label.fills;
    const baseline = extract(baselineCanonical.get("components/components.json"))[0].color;
    const target = baseline === "#22d3ee" ? "#f59e0b" : "#22d3ee";
    const familyIndex = await findRowScrolling(/^Card \/ idle( |$)/, { label: "Card / idle" });
    const readRows = () =>
      page.getByTestId("layer-row").evaluateAll((nodes) =>
        nodes.map((node) => (node.innerText ?? "").replace(/\s+/g, " ").trim()),
      );
    const texts = await readRows();
    const labelIndex = texts
      .slice(familyIndex + 1, familyIndex + 4)
      .findIndex((row) => /^Label( |$)/.test(row) && !row.includes("·"));
    assert.ok(labelIndex >= 0, "Card idle definition Label row not found");
    await page.getByTestId("layer-row").nth(familyIndex + 1 + labelIndex).click();
    await page.waitForTimeout(600);
    await shot("03-component-label-selected");
    await writeLoop({
      key: "component-definition",
      expectedEntry: "components/components.json",
      extract,
      sourceValue: async () =>
        JSON.parse(await readFile(join(packagePath, "components/components.json"), "utf8")),
      undoValue: {
        predicate: (components) => extract(components)[0].color === baseline,
      },
      redoValue: {
        target: { kind: "component-definition", componentSetId: "cmp_card_set", variantId: "var_card_idle", sourceNodeId: "node_card_idle_label", field: "fills" },
        apply: () => setFillColor(target),
        predicate: (components) => extract(components)[0].color === target,
      },
    });
  });

  // --- write class 3: page occurrence override (Primary Swatch fill) -------
  await step("write::page-occurrence-override", async () => {
    const extract = (screen) => screen.presentations[0].nodes.node_swatch_primary.fills;
    const baseline = extract(baselineCanonical.get("screens/screen.json"))[0].color;
    const target = baseline === "#f59e0b" ? "#22c55e" : "#f59e0b";
    await selectRowByPattern(/^Primary Swatch/, "Primary Swatch page node");
    await shot("04-page-node-selected");
    const componentsDuring = await readCanonicalFiles(packagePath);
    await writeLoop({
      key: "page-occurrence",
      expectedEntry: "screens/screen.json",
      extract,
      sourceValue: async () => JSON.parse(await readFile(join(packagePath, "screens/screen.json"), "utf8")),
      undoValue: {
        predicate: (screen) => extract(screen)[0].color === baseline,
      },
      redoValue: {
        target: { kind: "page-occurrence", screenId: "scr_design_system", presentationId: "pres_desktop", nodeId: "node_swatch_primary", field: "fills" },
        apply: () => setFillColor(target),
        predicate: (screen) => extract(screen)[0].color === target,
      },
    });
    // The occurrence edit must not have leaked into the component masters.
    const componentsNow = await readCanonicalFiles(packagePath);
    assert.equal(
      JSON.stringify(componentsDuring.get("components/components.json")),
      JSON.stringify(componentsNow.get("components/components.json")),
      "page occurrence edit mutated the component definitions",
    );
  });

  // --- decoration: a native-panel edit on a caption is an explicit no-op ---
  await step("negative::decoration-edit-is-noop", async () => {
    const before = await readCanonicalFiles(packagePath);
    const revisionBefore = (await workspace()).revision;
    const httpBefore = httpErrors.length;
    // The panorama caption is the clean "Label · primary = <value>" line
    // (owner/set/status moved to the selection panel, DSE-R18/R26).
    await selectRowByPattern(/^Label · primary = /, "token caption decoration");
    await shot("05-decoration-selected");
    const hadFillSection = (await page.getByTestId("shape-fill-section").count()) > 0;
    if (hadFillSection) {
      await setFillColor("#22c55e");
      await page.waitForTimeout(2_500);
    } else {
      log("INFO caption decoration opens no fill section (readonly by panel absence)");
    }
    const after = await readCanonicalFiles(packagePath);
    for (const [entry, value] of before) {
      assert.equal(
        JSON.stringify(value),
        JSON.stringify(after.get(entry)),
        `decoration edit mutated canonical entry ${entry}`,
      );
    }
    await noInternalError();
    assert.equal(
      httpErrors.length,
      httpBefore,
      "the decoration no-op must not fail the commit batch",
    );
    await writeFile(
      join(dir, "decoration-noop.json"),
      JSON.stringify({ mutated: false, panelPresent: hadFillSection, revisionBefore, revisionAfter: (await workspace()).revision }, null, 2),
    );
  });

  // --- external update: a direct canonical file edit rebuilds the board ----
  await step("external::update-rebuilds-board", async () => {
    const library = JSON.parse(await readFile(join(packagePath, "tokens/tokens.json"), "utf8"));
    const surface = library.sets
      .find((set) => set.id === "tset_color_light")
      .tokens.find((token) => token.id === "tok_color_light_surface");
    // Adaptive target keeps the step idempotent across reruns.
    const surfaceValue = () => surface.$value ?? surface.value;
    const externalValue = surfaceValue() === "#112233" ? "#445566" : "#112233";
    const externalBaseline = surfaceValue();
    if (surface.$value !== undefined) surface.$value = externalValue;
    else surface.value = externalValue;
    await writeFile(join(packagePath, "tokens/tokens.json"), JSON.stringify(library, null, 2));
    // The backend watch/refresh cycle re-opens the package; the board is a
    // pure function of that canonical snapshot, so the row must follow. The
    // external-revision swap re-projects the whole file: wait for the layer
    // tree to come back before continuing.
    await waitForToken("color/light", "surface", (value) => value === externalValue, "external surface edit", 30_000);
    const rowsBackDeadline = Date.now() + 45_000;
    let rowsBack = 0;
    while (Date.now() < rowsBackDeadline) {
      rowsBack = await page.getByTestId("layer-row").count();
      if (rowsBack > 10) break;
      await page.waitForTimeout(1_000);
    }
    await expandBoard();
    await page.waitForTimeout(1_500);
    rowsBack = await page.getByTestId("layer-row").count();
    await shot("06-external-rebuilt");
    assert.ok(rowsBack > 10, `layer tree did not rebuild after the external update (${rowsBack} rows)`);
    assert.equal(pageErrors.length, 0, `page errors: ${pageErrors.join(" | ")}`);
    await writeFile(
      join(dir, "external-update.json"),
      JSON.stringify({ baseline: externalBaseline, written: externalValue }, null, 2),
    );
  });

  // --- alias negative: direct edit fails without writing the source --------
  await step("negative::alias-cell-edit-rejected", async () => {
    const beforeRow = tokenRow(await designSystem(), "alias/demo", "radius.alias");
    await expandBoard();
    await selectRowByPattern(/^Token \/ alias\/demo\/radius\.alias/, "alias radius");
    await shot("07-alias-selected");
    const radiusInput = page.locator('input[aria-label="Radius"]').first();
    if (await radiusInput.count()) {
      await radiusInput.click({ clickCount: 3 }).catch(() => {});
      await radiusInput.fill("24").catch(() => {});
      await radiusInput.press("Enter").catch(() => {});
      await page.waitForTimeout(2_000);
    } else if ((await page.getByTestId("shape-fill-section").count()) > 0) {
      await setFillColor("#22c55e");
      await page.waitForTimeout(2_000);
    } else {
      log("INFO alias display opens no editable section (readonly by panel absence)");
    }
    const afterRow = tokenRow(await designSystem(), "alias/demo", "radius.alias");
    await writeFile(
      join(dir, "alias-negative.json"),
      JSON.stringify(
        {
          beforeValue: rowValue(beforeRow),
          afterValue: rowValue(afterRow),
          rejected: httpErrors.filter((e) => e.status === 422),
        },
        null,
        2,
      ),
    );
    assert.equal(rowValue(afterRow), rowValue(beforeRow), "alias Cell value must not change via direct shape edit");
    await noInternalError();
  });

  // --- reload: the board rebuilds again from canonical ----------------------
  await step("refresh::reload-rebuilds-board", async () => {
    const before = await workspace();
    await page.reload({ waitUntil: "domcontentloaded" });
    await waitWorkspace();
    await expandBoard();
    const after = await workspace();
    assert.equal(after.revision, before.revision, "revision drifted across reload");
    const cells = canonicalTokenCells(await readCanonicalFiles(packagePath));
    const rows = await collectRows();
    const missing = cells
      .map((cell) => ({
        expected: `Token / ${cell.set}/${cell.path}`,
        pattern: new RegExp(`^Token / ${escapeReg(cell.set)}/${escapeReg(cell.path)}( |$)`),
      }))
      .filter(({ expected, pattern }) => !rowsMatch(rows, pattern))
      .map(({ expected }) => expected);
    await writeFile(
      join(dir, "reload-row-reconciliation.json"),
      JSON.stringify({ expected: cells.length, collected: rows.size, missing }, null, 2),
    );
    assert.deepEqual(missing, [], "reloaded board is missing canonical Token Cell rows");
    await shot("08-reload-rebuilt");
    assert.equal(pageErrors.length, 0, `page errors: ${pageErrors.join(" | ")}`);
  });

  // --- whole-run canonical tree diff: exactly the intended source entries ---
  await step("reconcile::canonical-tree-diff", async () => {
    const finalCanonical = await readCanonicalFiles(packagePath);
    const finalWorkspace = await workspace();
    const changed = [...baselineCanonical.keys()].filter((entry) => {
      if (entry === "manifest.json") return false;
      return (
        JSON.stringify(baselineCanonical.get(entry)) !==
        JSON.stringify(finalCanonical.get(entry))
      );
    });
    const expectedEntries = zeroComponents
      ? ["screens/screen.json", "tokens/tokens.json"]
      : ["components/components.json", "screens/screen.json", "tokens/tokens.json"];
    await writeFile(
      join(dir, "canonical-tree-diff.json"),
      JSON.stringify(
        {
          changedEntries: changed.sort(),
          expected: expectedEntries,
          perEntry: changed.map((entry) => ({
            entry,
            intent:
              entry === "tokens/tokens.json"
                ? "Token Cell write (redo) + external surface edit"
                : entry === "components/components.json"
                  ? "component definition write (redo)"
                  : "page occurrence override write (redo)",
          })),
        },
        null,
        2,
      ),
    );
    assert.deepEqual(
      changed.sort(),
      expectedEntries,
      "the whole run must change exactly the intended source entries",
    );
    // The three intended writes are persisted in the canonical tree: each
    // final value must equal the write loop's recorded post-redo state.
    const record = (key) => writeRecords.find((item) => item.key === key);
    const tokenExtract = (library) => {
      const token = library.sets
        .find((set) => set.id === "tset_color_light")
        .tokens.find((item) => item.id === "tok_color_light_primary");
      return token.$value ?? token.value;
    };
    const componentExtract = (components) =>
      components.componentSets
        .find((set) => set.id === "cmp_card_set")
        .variants.find((variant) => variant.id === "var_card_idle")
        .nodes.node_card_idle_label.fills;
    const pageExtract = (screen) =>
      screen.presentations[0].nodes.node_swatch_primary.fills;
    assert.equal(
      JSON.stringify(tokenExtract(finalCanonical.get("tokens/tokens.json"))),
      JSON.stringify(record("token-cell").diff.after),
      "token Cell redo value missing from the canonical tree",
    );
    assert.notEqual(
      record("token-cell").diff.after,
      record("token-cell").diff.before,
      "token Cell record shows no change",
    );
    if (!zeroComponents) {
      assert.equal(
        JSON.stringify(componentExtract(finalCanonical.get("components/components.json"))),
        JSON.stringify(record("component-definition").diff.after),
        "component definition redo value missing from the canonical tree",
      );
    }
    assert.equal(
      JSON.stringify(pageExtract(finalCanonical.get("screens/screen.json"))),
      JSON.stringify(record("page-occurrence").diff.after),
      "page occurrence redo value missing from the canonical tree",
    );
    // Zero System Sheet residue anywhere in the canonical tree.
    assertNoGeneratedResidue(finalCanonical, finalWorkspace);
    await writeFile(join(dir, "write-records.json"), JSON.stringify(writeRecords, null, 2));
  });

  // --- negative: the user's ORIGINAL package untouched ----------------------
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
    JSON.stringify({ label, results, setupError, pageErrors, consoleErrors, httpErrors }, null, 2),
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
console.log(`DSE R16 persistence (${label}): ${exited ? "PASS" : `FAIL (${failed.length}) setup=${setupError ? "error" : "none"}`}`);
process.exit(exited ? 0 : 1);
