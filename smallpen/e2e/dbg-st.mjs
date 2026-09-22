import { createRequire } from "node:module";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { serveLocalPackage } from "@smallpen/background";
import { servePenpotFrontend } from "@smallpen/web";
import { buildEditorPackageValues, buildEditorFoundationValues } from "../test/fixtures/design-system-editor-fixture.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const repositoryRoot = join(root, "..");
const require = createRequire(join(repositoryRoot, "frontend", "package.json"));
const { chromium } = require("playwright");
const frontendRoot = join(repositoryRoot, "frontend", "resources", "public");

const scratch = await mkdtemp(join(tmpdir(), "smallpen-dse-dbgst-"));
for (const [entry, value] of buildEditorPackageValues()) {
  await mkdir(dirname(join(scratch, "editor.smallpen", entry)), { recursive: true });
  await writeFile(join(scratch, "editor.smallpen", entry), JSON.stringify(value, null, 2));
}
for (const [entry, value] of buildEditorFoundationValues()) {
  await mkdir(dirname(join(scratch, "canvas-shared.smallpen", entry)), { recursive: true });
  await writeFile(join(scratch, "canvas-shared.smallpen", entry), JSON.stringify(value, null, 2));
}
const background = await serveLocalPackage({ packagePath: join(scratch, "editor.smallpen"), port: 0 });
const web = await servePenpotFrontend({ backendUrl: background.url, frontendRoot, port: 0 });
const browser = await chromium.launch({ headless: true });
try {
  const endpoint = (path) => { const base = new URL(background.url); base.pathname = base.pathname.replace(/\/+$/, "") + path; return base.href; };
  const snapshot = await (await fetch(endpoint("/v1/workspace"))).json();
  const dsPageId = snapshot.runtime.designSystemPage;
  const page = await browser.newPage({ viewport: { height: 1000, width: 1440 } });
  const url = new URL(web.url);
  url.hash = `#/workspace?file-id=${snapshot.runtime.file}&page-id=${dsPageId}`;
  await page.goto(url.href, { waitUntil: "domcontentloaded" });
  await page.getByTestId("viewport").waitFor({ timeout: 30000 });
  await page.getByRole("tab", { name: /Assets/i }).first().click();
  await page.waitForTimeout(2500);
  const panel = page.getByTestId("dse-insert-panel");
  console.log("aside:", await page.locator("aside").count());
  console.log("panel:", await panel.count(), "status:", await panel.getAttribute("data-status").catch(() => "n/a"));
} catch (e) { console.log("DBG FAIL", String(e).slice(0, 250)); }
finally { await browser.close(); await web.close?.(); await background.close?.(); await rm(scratch, { recursive: true, force: true }); }
