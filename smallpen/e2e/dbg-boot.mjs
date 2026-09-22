// Quick boot diagnostic: load the design-system route, capture console.
import { createRequire } from "node:module";
import { cp, mkdir, mkdtemp, rm } from "node:fs/promises";
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

const scratch = await mkdtemp(join(tmpdir(), "smallpen-dbg-"));
const packagePath = join(scratch, "design-system.smallpen");
await cp("/private/tmp/smallpen-live-demo/design-system.smallpen", packagePath, { recursive: true });

const bg = await serveLocalPackage({ packagePath, port: 0 });
const web = await servePenpotFrontend({ backendUrl: bg.url, frontendRoot, port: 0 });
const snapshot = await (await fetch(`${bg.url.replace(/\/$/, "")}/v1/workspace`)).json();
const fileId = snapshot.runtime.file;
const base = new URL(web.url);
base.hash = `#/design-system?file-id=${fileId}`;
console.log("URL:", base.href);

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { height: 1000, width: 1440 } });
page.on("console", (msg) => console.log(`[console:${msg.type()}]`, msg.text().slice(0, 300)));
page.on("pageerror", (err) => console.log("[pageerror]", String(err).slice(0, 500)));
page.on("requestfailed", (req) => console.log("[requestfailed]", req.url(), req.failure()?.errorText));

await page.goto(base.href, { waitUntil: "domcontentloaded" });
for (let i = 0; i < 9; i += 1) {
  await page.waitForTimeout(5000);
  const viewport = await page.getByTestId("viewport").count().catch(() => -1);
  const bodyText = await page.locator("body").innerText().then((t) => t.slice(0, 160).replace(/\n/g, " | ")).catch(() => "<no body>");
  console.log(`t=${(i + 1) * 5}s viewport=${viewport} body="${bodyText}"`);
  if (viewport > 0) break;
}
await page.screenshot({ path: join(scratch, "dbg-boot.png"), fullPage: false }).catch(() => {});
console.log("shot at", join(scratch, "dbg-boot.png"));
await browser.close().catch(() => {});
await bg.close().catch(() => {});
await web.close().catch(() => {});
await rm(scratch, { recursive: true, force: true }).catch(() => {});
process.exit(0);
