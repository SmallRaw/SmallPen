// Capture the full boot crash stack.
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

const scratch = await mkdtemp(join(tmpdir(), "smallpen-dbg2-"));
const packagePath = join(scratch, "design-system.smallpen");
await cp("/private/tmp/smallpen-live-demo/design-system.smallpen", packagePath, { recursive: true });
const bg = await serveLocalPackage({ packagePath, port: 0 });
const web = await servePenpotFrontend({ backendUrl: bg.url, frontendRoot, port: 0 });
const snapshot = await (await fetch(`${bg.url.replace(/\/$/, "")}/v1/workspace`)).json();
const base = new URL(web.url);
base.hash = `#/design-system?file-id=${snapshot.runtime.file}`;
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { height: 1000, width: 1440 } });
page.on("console", (msg) => {
  const text = msg.text();
  if (text.includes("Vector") || text.includes("assoc") || text.includes("$APP")) {
    console.log("=== console group ===");
    console.log(text.slice(0, 5000));
  }
});
await page.goto(base.href, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(12000);
await browser.close();
await bg.close();
await web.close();
await rm(scratch, { recursive: true, force: true });
process.exit(0);
