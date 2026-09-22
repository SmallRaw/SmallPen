// Debug: drive the create flow and watch reproject logs + board rows.
import { createRequire } from "node:module";
import { cp, mkdtemp, rm } from "node:fs/promises";
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

const scratch = await mkdtemp(join(tmpdir(), "smallpen-dbg3-"));
const packagePath = join(scratch, "design-system.smallpen");
await cp("/private/tmp/smallpen-live-demo/design-system.smallpen", packagePath, { recursive: true });
const bg = await serveLocalPackage({ packagePath, port: 0 });
const web = await servePenpotFrontend({ backendUrl: bg.url, frontendRoot, port: 0 });
const snapshot = await (await fetch(`${bg.url.replace(/\/$/, "")}/v1/workspace`)).json();
const fileId = snapshot.runtime.file;
const base = new URL(web.url);
base.hash = `#/design-system?file-id=${fileId}`;

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { height: 1000, width: 1440 } });
page.on("console", (msg) => {
  const t = msg.text();
  if (t.includes("dse-debug") || t.includes("Unexpected") || t.includes("assoc") || msg.type() === "error") {
    console.log(`[${msg.type()}]`, t.slice(0, 400));
  }
});
page.on("pageerror", (err) => console.log("[pageerror]", String(err).slice(0, 300)));

await page.goto(base.href, { waitUntil: "domcontentloaded" });
for (let i = 0; i < 20; i += 1) {
  await page.waitForTimeout(2000);
  if (await page.getByTestId("viewport").count().catch(() => 0)) break;
}
console.log("workspace mounted");
await page.waitForTimeout(2500);

// switch to assets layout
const url = new URL(page.url());
url.hash = url.hash.includes("layout=")
  ? url.hash.replace(/layout=[^&]*/, "layout=assets")
  : `${url.hash}&layout=assets`;
await page.evaluate((h) => { window.location.hash = h; }, url.hash.substring(url.hash.indexOf("#") + 1));
const panel = page.getByTestId("dse-insert-panel");
await panel.waitFor({ timeout: 20_000 });
await page.waitForTimeout(1200);
await panel.getByTestId("dse-insert-target").evaluate((el) => {
  const option = el.options[1];
  el.value = option.value;
  el.dispatchEvent(new Event("change", { bubbles: true }));
});
await panel.getByTestId("dse-create-button").click();
console.log("create clicked");

// Back to the layers layout and expand the board tree.
const url2 = new URL(page.url());
url2.hash = url2.hash.includes("layout=")
  ? url2.hash.replace(/layout=[^&]*/, "layout=layers")
  : `${url2.hash}&layout=layers`;
await page.evaluate((h) => { window.location.hash = h; }, url2.hash.substring(url2.hash.indexOf("#") + 1));
await page.waitForTimeout(1500);
const board = page.getByTestId("layer-row").filter({ hasText: "Design System" }).first();
await board.waitFor({ timeout: 20_000 }).catch(() => {});
for (let round = 0; round < 40; round += 1) {
  const collapsed = page
    .locator('[data-testid="layer-row"] [data-testid="toggle-content"]:not([aria-expanded="true"])')
    .first();
  if ((await collapsed.count().catch(() => 0)) === 0) break;
  await collapsed.click().catch(() => {});
  await page.waitForTimeout(120);
}

for (let i = 0; i < 20; i += 1) {
  await page.waitForTimeout(1500);
  const ws = await (await fetch(`${bg.url.replace(/\/$/, "")}/v1/workspace`)).json();
  let count = 0;
  for (const entry of ws.manifest.entries.components ?? []) {
    const value = ws.entries[entry];
    count += Array.isArray(value?.componentSets) ? value.componentSets.length : 1;
  }
  const rows = await page.getByTestId("layer-row").count().catch(() => 0);
  const newRow = await page.getByTestId("layer-row").filter({ hasText: "New Component" }).count().catch(() => 0);
  console.log(`t+${(i + 1) * 1.5}s sourceComponents=${count} layerRows=${rows} newRow=${newRow}`);
  if (newRow > 0) { console.log("ROW APPEARED"); break; }
}

const sourceCount = async () => {
  const ws = await (await fetch(`${bg.url.replace(/\/$/, "")}/v1/workspace`)).json();
  let count = 0;
  for (const entry of ws.manifest.entries.components ?? []) {
    const value = ws.entries[entry];
    count += Array.isArray(value?.componentSets) ? value.componentSets.length : 1;
  }
  return count;
};

// undo the creation, then redo it
await page.keyboard.press("ControlOrMeta+z");
for (let i = 0; i < 8; i += 1) {
  await page.waitForTimeout(1500);
  console.log(`undo t+${(i + 1) * 1.5}s components=${await sourceCount()}`);
  if ((await sourceCount()) < 2) break;
}
await page.keyboard.press("ControlOrMeta+Shift+z");
for (let i = 0; i < 8; i += 1) {
  await page.waitForTimeout(1500);
  const count = await sourceCount();
  console.log(`redo t+${(i + 1) * 1.5}s components=${count}`);
  if (count >= 2) { console.log("REDO OK"); break; }
}
// Probe: which shape is the unmapped one?
{
  const ws = await (await fetch(`${bg.url.replace(/\/$/, "")}/v1/workspace`)).json();
  const rd = ws.runtime.reverseDesignSystem ?? {};
  const keys = Object.keys(rd);
  console.log("reverseDesignSystem size:", keys.length);
  const probe = keys.filter((k) => k && k.startsWith("4488ee9e"));
  console.log("probe 4488ee9e:", probe.length ? JSON.stringify(rd[probe[0]]) : "NOT PRESENT");
  const caps = keys.filter((k) => rd[k]?.kind === "label");
  console.log("label-kind keys:", JSON.stringify(caps));
  const fams = ws.runtime.designSystemRefs?.families ?? [];
  console.log("families:", JSON.stringify(fams.map((f) => ({ kind: f.kind, caption: f.caption, label: f.label }))));
}
await page.screenshot({ path: join(scratch, "dbg-create.png") }).catch(() => {});
await browser.close(); await bg.close(); await web.close();
await rm(scratch, { recursive: true, force: true }).catch(() => {});
process.exit(0);
