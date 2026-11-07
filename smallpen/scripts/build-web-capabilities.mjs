// Writes the Web projection capabilities the App checks against the
// Background (frontend smallpen/web_capabilities.json) from core, so the
// App never keeps its own copy. --check fails when the file is out of date.
import { readFile, writeFile } from "node:fs/promises";
import { SMALLPEN_FORMAT_CAPABILITIES } from "../packages/core/src/index.mjs";

const target = new URL("../../frontend/src/app/main/smallpen/web_capabilities.json", import.meta.url);
const content = `${JSON.stringify(SMALLPEN_FORMAT_CAPABILITIES.webProjection, null, 2)}\n`;

if (process.argv.includes("--check")) {
  const current = await readFile(target, "utf8").catch(() => "");
  if (current !== content) {
    console.error("frontend/src/app/main/smallpen/web_capabilities.json is out of date; run npm run build:web-capabilities");
    process.exit(1);
  }
} else {
  await writeFile(target, content);
  console.log(`wrote ${target.pathname}`);
}
