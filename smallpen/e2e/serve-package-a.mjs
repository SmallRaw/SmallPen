// Launches a persistent local server for reviewing Delivery Package A:
// copies the user's actual package to a scratch dir, applies the SAME
// coverage extension the e2e evidence runs use, serves the normal editor
// and prints the Design System panorama URL. The original package is never
// touched. Ctrl-C to stop.
import { createRequire } from "node:module";
import { cp, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { serveLocalPackage } from "@smallpen/background";
import { servePenpotFrontend } from "@smallpen/web";

const here = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = join(here, "..", "..");
const actualPackage = "/private/tmp/smallpen-live-demo/design-system.smallpen";
const require = createRequire(join(repositoryRoot, "frontend", "package.json"));
const frontendRoot = join(repositoryRoot, "frontend", "resources", "public");

const scratch = await mkdtemp(join(tmpdir(), "smallpen-package-a-review-"));
const packagePath = join(scratch, "design-system.smallpen");
await cp(actualPackage, packagePath, { recursive: true });

const tokensPath = join(packagePath, "tokens/tokens.json");
const library = JSON.parse(await readFile(tokensPath, "utf8"));
if (!library.sets.some((s) => s.id === "tset_reference_coverage")) {
  const cells = [
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
  library.sets.push({
    description: "Coverage Cells for the 20 canonical token types",
    id: "tset_reference_coverage",
    name: "reference/coverage",
    tokens: cells,
  });
  library.sets.push({
    description: "Archived Cells covered by no combination",
    id: "tset_reference_archived",
    name: "reference/archived",
    tokens: [{ description: "", id: "tok_reference_archived_color", name: "legacy.color", type: "color", value: "#cccccc" }],
  });
  library.activeSetIds.push("tset_reference_coverage");
  await writeFile(tokensPath, JSON.stringify(library, null, 2));
}

const bg = await serveLocalPackage({ packagePath, port: 0 });
const web = await servePenpotFrontend({ backendUrl: bg.url, frontendRoot, port: 0 });
const snapshot = await fetch(`${bg.url.replace(/\/+$/, "")}/v1/workspace`).then((r) => r.json());
const url = new URL(web.url);
url.hash = `#/design-system?file-id=${snapshot.runtime.file}`;
console.log("REVIEW URL:", url.href);
console.log("scratch copy:", packagePath, "(original package untouched)");
