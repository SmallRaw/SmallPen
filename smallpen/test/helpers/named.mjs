// Name-based lookups for tests: packages store no ids, so tests find pages,
// versions, elements, Tokens and components by the names their files use.
import { cp, mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve as resolvePath } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
export const fixturesDir = join(here, "..", "fixtures");

export function screenEntry(snapshot, name) {
  const entry = snapshot.manifest.entries.screens.find((key) => snapshot.entries[key].name === name);
  if (!entry) throw new Error(`No page ${name}; pages: ${snapshot.manifest.entries.screens.map((key) => snapshot.entries[key].name).join(", ")}`);
  return entry;
}

export function screenOf(snapshot, name) {
  return snapshot.entries[screenEntry(snapshot, name)];
}

export function presentationOf(snapshotOrScreen, name, platform = "desktop") {
  const screen = name === undefined ? snapshotOrScreen : screenOf(snapshotOrScreen, name);
  const presentation = screen.presentations.find((candidate) => candidate.platform === platform) ?? screen.presentations[0];
  if (!presentation) throw new Error(`Page ${screen.name} has no versions`);
  return presentation;
}

// The node named `name` (a "A / B" path from the root also works).
export function nodeOf(presentation, name) {
  const nodes = presentation.nodes;
  if (name.includes(" / ")) {
    let current = nodes[presentation.rootId];
    for (const part of name.split(" / ")) {
      if (current.name === part && current.id === presentation.rootId) continue;
      current = (current.children ?? []).map((id) => nodes[id]).find((node) => node.name === part);
      if (!current) throw new Error(`No element ${name}`);
    }
    return current;
  }
  const node = Object.values(nodes).find((candidate) => candidate.name === name);
  if (!node) throw new Error(`No element ${name}; elements: ${Object.values(nodes).map((candidate) => candidate.name).join(", ")}`);
  return node;
}

export function nodeIdOf(presentation, name) {
  return nodeOf(presentation, name).id;
}

export function tokenIdOf(snapshot, path) {
  for (const [id, token] of snapshot.domain.tokens) if (token.path === path) return id;
  throw new Error(`No Token ${path}`);
}

export function componentOf(snapshot, name) {
  for (const set of snapshot.domain.componentSets.values()) if (set.name === name) return set;
  throw new Error(`No component ${name}`);
}

// A writable copy of a fixture package in a fresh temporary folder.
export async function copyFixture(name, target) {
  const parent = target ? dirname(target) : await mkdtemp(join(tmpdir(), "smallpen-fixture-"));
  const path = target ?? join(parent, `${name}.smallpen`);
  await mkdir(dirname(path), { recursive: true });
  await cp(join(fixturesDir, `${name}.smallpen`), path, { recursive: true });
  return path;
}

// Writes a package from { path: content } with a default index.html and
// tokens.css. keepIndex adds files to an existing package instead.
export async function writePackage(path, files, { name = "Test", packageId = "pkg_test", keepIndex = false } = {}) {
  const all = {
    ...(!keepIndex && {
      "index.html": `<!doctype html>\n<html>\n<head>\n  <meta charset="utf-8">\n  <title>${name}</title>\n  <meta name="smallpen:package-id" content="${packageId}">\n</head>\n<body></body>\n</html>\n`,
      "tokens.css": ":root {\n}\n",
    }),
    ...files,
  };
  for (const [file, content] of Object.entries(all)) {
    const target = join(path, file);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, content);
  }
  return path;
}

// A page document around a <body>.
export function pageHtml(body, { title = "Page", depth = 1 } = {}) {
  return `<!doctype html>\n<html>\n<head>\n  <meta charset="utf-8">\n  <title>${title}</title>\n  <link rel="stylesheet" href="${"../".repeat(depth)}tokens.css">\n</head>\n${body}\n</html>\n`;
}

// Recorded App sessions (penpot-*-commits.json) and some tests name the ids
// the fixtures had before they became HTML. Seeding the identity map of a
// copied fixture makes the package read back with exactly those ids.
export async function seedLegacyIds(packagePath, name) {
  const { readFile } = await import("node:fs/promises");
  const { writeIdentity, packageIdOf } = await import("../../packages/local-package/src/html-store.mjs");
  const rows = JSON.parse(await readFile(join(fixturesDir, "model", `${name}.identity.json`), "utf8"));
  const index = await readFile(join(packagePath, "index.html"));
  await writeIdentity(packagePath, packageIdOf(new Map([["index.html", index]])), new Map(rows));
  return packagePath;
}

// copyFixture + seedLegacyIds: a writable fixture copy with its old ids.
export async function copyLegacyFixture(name, target) {
  const path = await copyFixture(name, target);
  return seedLegacyIds(path, name);
}

// Entry lookups that do not depend on entry keys, so one assertion works on
// a model snapshot (legacy keys) and on an HTML package (new keys). The
// fixtures hold one page, one Token library, one component file, one asset
// library each.
const onlyOf = (snapshot, kind) => {
  const keys = snapshot.manifest.entries[kind];
  return keys.length ? snapshot.entries[keys[0]] : undefined;
};
export const onlyScreen = (snapshot) => onlyOf(snapshot, "screens");
export const tokenEntry = (snapshot) => onlyOf(snapshot, "tokens");
export const componentEntry = (snapshot) => onlyOf(snapshot, "components");
export const assetEntry = (snapshot) => onlyOf(snapshot, "assets");

// Gives a copied package another package id (index.html <meta>).
export async function setPackageId(packagePath, packageId) {
  const { readFile } = await import("node:fs/promises");
  const file = join(packagePath, "index.html");
  const source = await readFile(file, "utf8");
  await writeFile(file, source.replace(/(<meta name="smallpen:package-id" content=")[^"]*(")/, `$1${packageId}$2`));
  return packagePath;
}

// Writes in-memory model values (the test/fixtures/model shape) as an HTML
// package, with an identity map so the package reads back with the same ids.
// Remote libraries are dropped: a package stands alone.
export async function writeModelPackage(path, values, { locator = "memory://model.smallpen" } = {}) {
  const { encodePackage, loadPackageFromValues } = await import("@smallpen/core");
  const { writeIdentity } = await import("../../packages/local-package/src/html-store.mjs");
  const copy = new Map([...values].map(([key, value]) => [key, value instanceof Uint8Array ? value : structuredClone(value)]));
  delete copy.get("manifest.json").libraries;
  const snapshot = await loadPackageFromValues(locator, copy);
  const { files, assets, identity } = encodePackage(snapshot);
  for (const [file, content] of files) {
    await mkdir(dirname(join(path, file)), { recursive: true });
    await writeFile(join(path, file), content);
  }
  for (const [file, blob] of assets) {
    await mkdir(dirname(join(path, file)), { recursive: true });
    await writeFile(join(path, file), snapshot.blobs.get(blob));
  }
  await writeIdentity(path, snapshot.manifest.packageId, identity);
  const keys = new Map();
  for (const [key, value] of values) if (key.startsWith("screens/")) keys.set(key, value.id);
  modelKeys.set(resolvePath(path), keys);
  return path;
}

const modelKeys = new Map();

// What a test that once read a JSON file of the package reads now: the same
// entry of the package as SmallPen reads it from its HTML files. Model keys
// map to entries: manifest.json, the Token library, the asset library,
// components/<file>.json and the screens writeModelPackage wrote.
export async function readModelEntry(packagePath, key) {
  // A model directory (test/fixtures/model/<name>) still holds the JSON.
  const { readFile } = await import("node:fs/promises");
  const directory = packagePath instanceof URL ? fileURLToPath(packagePath) : String(packagePath);
  if (key.endsWith(".json")) {
    try {
      return JSON.parse(await readFile(join(directory, key), "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT" && error?.code !== "ENOTDIR") throw error;
    }
  }
  packagePath = directory;
  const { openPackage } = await import("@smallpen/local-package");
  const snapshot = await openPackage(packagePath);
  return structuredClone(modelEntryOf(snapshot, key, modelKeys.get(resolvePath(packagePath))));
}

export function modelEntryOf(snapshot, key, screenIds) {
  const { manifest, entries } = snapshot;
  if (key === "manifest.json") return manifest;
  if (Object.hasOwn(entries, key)) return entries[key];
  if (key.startsWith("tokens/")) return entries[manifest.entries.tokens[0]];
  if (key.startsWith("assets/")) return entries[manifest.entries.assets[0]];
  if (key.startsWith("components/")) {
    const file = key.replace(/\.json$/, ".html");
    return entries[manifest.entries.components.find((entry) => entry === file) ?? manifest.entries.components[0]];
  }
  if (key.startsWith("screens/")) {
    const id = screenIds?.get(key);
    const entry = manifest.entries.screens.find((candidate) => entries[candidate].id === id) ?? (manifest.entries.screens.length === 1 ? manifest.entries.screens[0] : undefined);
    if (!entry) throw new Error(`No page for ${key}`);
    return entries[entry];
  }
  throw new Error(`No entry for ${key}`);
}

// Renames an element of a page file in place (the way an agent edits it).
export async function renameInPage(packagePath, pageFile, from, to) {
  const { readFile } = await import("node:fs/promises");
  const file = join(packagePath, "pages", pageFile);
  const escape = (text) => text.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");
  const source = await readFile(file, "utf8");
  const pattern = `data-name="${escape(from)}"`;
  if (!source.includes(pattern)) throw new Error(`No element ${from} in ${pageFile}`);
  await writeFile(file, source.replace(pattern, `data-name="${escape(to)}"`));
}
