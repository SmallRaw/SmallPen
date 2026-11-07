// Read-only smoke check against a running local preview with a non-empty package.
// Usage: node e2e/design-system-canvas-smoke.mjs <design-system URL>
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(new URL("../../../frontend/package.json", import.meta.url));
const { chromium } = require("playwright");
const url = process.argv[2];
assert.ok(url, "Pass the running preview's design-system URL");
const browser = await chromium.launch({ headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && /React error|Component trace/.test(message.text())) {
      errors.push(message.text());
    }
  });
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await page.goto(url, { waitUntil: "domcontentloaded" });
    const canvas = page.getByTestId("smallpen-canvas");
    await canvas.waitFor({ timeout: 30_000 });
    const svg = canvas.locator("svg[data-testid=canvas-viewport]");
    await svg.waitFor({ timeout: 30_000 });
    const specimen = svg.locator("[data-scene-id]").filter({ has: page.locator("rect") });
    assert.ok(await specimen.count() > 0, "Source-backed canvas content must render");
    await svg.locator("[data-scene-id] [data-scene-id]").first().click();
    const source = page.getByTestId("canvas-inspector").locator("pre");
    await source.waitFor();
    assert.ok(JSON.parse(await source.innerText()).kind, "Selection must expose its source");
    assert.equal(await page.getByTestId("canvas-error").count(), 0);
    assert.deepEqual(errors, [], "Canvas mount and reload must not crash");
  }
  console.log("PASS: canvas mounts, renders, and exposes selection sources on entry and reload");
} finally {
  await browser.close();
}
