// Live demo server for the DSE rework review: serves the design-system
// fixture (with sizing/stroke/shadow token sets injected) plus the freshly
// built frontend. Keeps running until killed.
import { cp, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { serveLocalPackage } from "@smallpen/background";
import { servePenpotFrontend } from "@smallpen/web";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const frontendRoot = join(root, "..", "frontend", "resources", "public");
const live = "/tmp/smallpen-live-demo";
const target = join(live, "design-system.smallpen");

await cp(
  join(root, "test", "fixtures", "design-system.smallpen"),
  target,
  { recursive: true, force: true },
);
const manifestPath = join(target, "manifest.json");
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
delete manifest.libraries;
await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

const tokensPath = join(target, "tokens", "tokens.json");
const tokens = JSON.parse(await readFile(tokensPath, "utf8"));
tokens.sets.push(
  {
    description: "Control sizing Cells (live demo).",
    id: "tset_demo_sizing",
    name: "sizing/md",
    tokens: [{ description: "", id: "tok_demo_sizing_control", name: "control", type: "sizing", value: 40 }],
  },
  {
    description: "Stroke width Cells (live demo).",
    id: "tset_demo_stroke",
    name: "stroke/md",
    tokens: [{ description: "", id: "tok_demo_stroke_border", name: "border-width", type: "stroke-width", value: 1 }],
  },
  {
    description: "Elevation effect Cells (live demo).",
    id: "tset_demo_effect",
    name: "effect/md",
    tokens: [{
      description: "",
      id: "tok_demo_effect_elevation",
      name: "elevation-1",
      type: "shadow",
      value: { color: "rgba(0, 0, 0, 0.24)", offsetX: 0, offsetY: 2, blur: 4, spread: 0 },
    }],
  },
);
await writeFile(tokensPath, JSON.stringify(tokens, null, 2));

const bg = await serveLocalPackage({ packagePath: target, port: 0 });
const web = await servePenpotFrontend({
  backendUrl: bg.url,
  frontendRoot,
  port: 0,
});
const snapshot = await (await fetch(`${bg.url.replace(/\/$/, "")}/v1/workspace`)).json();
const base = new URL(web.url);
console.log("DEMO URL:", `${base.href}#/design-system?file-id=${snapshot.runtime.file}`);
console.log("SCREEN PAGE:", `${base.href}#/screen?file-id=${snapshot.runtime.file}&page-id=${snapshot.runtime.pages.scr_design_system}`);
console.log("(backend:", bg.url + ", Ctrl+C to stop)");
