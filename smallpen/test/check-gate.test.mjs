// check as the gate for an agent's direct file edits: what passes is
// accepted, files with errors are rejected, --revert puts them back.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { applyOperationBatch, openPackage } from "@smallpen/local-package";
import { pageHtml, seedLegacyIds } from "./helpers/named.mjs";

const cli = new URL("../apps/cli/bin/smallpen.mjs", import.meta.url).pathname;
const fixture = new URL("fixtures/roundtrip.smallpen", import.meta.url).pathname;

async function check(path, ...extra) {
  try {
    const { stdout } = await promisify(execFile)(process.execPath, [cli, "check", path, ...extra, "--json"]);
    return { code: 0, ...JSON.parse(stdout) };
  } catch (error) {
    return { code: error.code, ...JSON.parse(error.stdout) };
  }
}

async function copy(context) {
  const root = await mkdtemp(join(tmpdir(), "smallpen-gate-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "gate.smallpen");
  await cp(fixture, path, { recursive: true });
  await seedLegacyIds(path, "roundtrip");
  await writeFile(join(path, "tokens.css"), ":root {\n  --color-brand: #7c3aed;\n}\n");
  const page = join(path, "pages", "Round Trip.html");
  await writeFile(page, (await readFile(page, "utf8")).replace("bg-[#7c3aed]", "bg-brand"));
  await writeFile(
    join(path, "pages", "Second.html"),
    pageHtml('<body class="bg-brand">\n  <p data-name="Title" class="left-[0px] top-[0px]">Second</p>\n</body>', { title: "Second" }),
  );
  return { root, path, page };
}

const read = (path, file) => readFile(join(path, file), "utf8");

test("a passing check accepts the files; a later check accepts good edits and rejects broken ones", async (context) => {
  const { path } = await copy(context);
  const first = await check(path);
  assert.equal(first.ok, true);

  // An agent edits three files at once: one good, one broken, one new and broken.
  const second = await read(path, "pages/Second.html");
  await writeFile(join(path, "pages", "Second.html"), second.replace(">Second<", ">Second, edited<"));
  const roundTrip = await read(path, "pages/Round Trip.html");
  await writeFile(join(path, "pages", "Round Trip.html"), roundTrip.replace("bg-brand", "bg-missing"));
  await writeFile(join(path, "pages", "Broken.html"), "<!doctype html>\n<html>\n<body><div\n</html>\n");

  const gated = await check(path);
  assert.equal(gated.code, 1);
  assert.deepEqual(gated.gate.accepted, ["pages/Second.html"]);
  assert.deepEqual(
    gated.gate.rejected.map(({ path: file, change }) => [file, change]).sort(),
    [["pages/Broken.html", "added"], ["pages/Round Trip.html", "modified"]],
  );
  assert.deepEqual(gated.gate.revert.argv.slice(-1), ["--revert"]);
  // Nothing is reverted until asked.
  assert.match(await read(path, "pages/Round Trip.html"), /bg-missing/);

  const reverted = await check(path, "--revert");
  assert.equal(reverted.ok, true);
  assert.deepEqual(
    reverted.gate.reverted.map(({ path: file, action }) => [file, action]).sort(),
    [["pages/Broken.html", "removed"], ["pages/Round Trip.html", "restored"]],
  );
  assert.equal(await read(path, "pages/Round Trip.html"), roundTrip);
  assert.match(await read(path, "pages/Second.html"), /Second, edited/, "the good edit stays");
  assert.ok(!(await readdir(join(path, "pages"))).includes("Broken.html"));
});

test("an error in an unchanged file is pinned on the shared file whose edit caused it", async (context) => {
  const { path } = await copy(context);
  assert.equal((await check(path)).ok, true);
  // The agent removes a Token two pages use, and fixes a page title.
  await writeFile(join(path, "tokens.css"), ":root {\n}\n");
  const second = await read(path, "pages/Second.html");
  await writeFile(join(path, "pages", "Second.html"), second.replace(">Second<", ">Second page<"));

  const gated = await check(path);
  assert.deepEqual(gated.gate.rejected.map(({ path: file }) => file), ["tokens.css"]);
  assert.deepEqual(gated.gate.rejected[0].breaks.sort(), ["pages/Round Trip.html", "pages/Second.html"]);
  assert.deepEqual(gated.gate.accepted, ["pages/Second.html"]);

  const reverted = await check(path, "--revert");
  assert.equal(reverted.ok, true);
  assert.match(await read(path, "tokens.css"), /--color-brand: #7c3aed;/);
  assert.match(await read(path, "pages/Second.html"), /Second page/);
});

test("--file reverts only the named files, so agents working in parallel keep theirs", async (context) => {
  const { path } = await copy(context);
  assert.equal((await check(path)).ok, true);
  const roundTrip = await read(path, "pages/Round Trip.html");
  await writeFile(join(path, "pages", "Round Trip.html"), roundTrip.replace("bg-brand", "bg-missing"));
  const second = await read(path, "pages/Second.html");
  await writeFile(join(path, "pages", "Second.html"), second.replace("bg-brand", "bg-other"));

  const mine = await check(path, "--revert", "--file", "pages/Second.html");
  assert.equal(mine.ok, false);
  assert.deepEqual(mine.gate.reverted.map(({ path: file }) => file), ["pages/Second.html"]);
  assert.equal(await read(path, "pages/Second.html"), second);
  assert.match(await read(path, "pages/Round Trip.html"), /bg-missing/, "another agent's file is left alone");
});

test("an App save is the accepted version a later revert goes back to", async (context) => {
  const { path } = await copy(context);
  assert.equal((await check(path)).ok, true);
  const before = await openPackage(path);
  await applyOperationBatch(path, {
    baseRevision: before.revision,
    batchId: "app-save",
    operations: [{
      changes: { opacity: 0.5 },
      nodeId: "node_rectangle",
      presentationId: "pres_desktop",
      screenId: "scr_roundtrip",
      type: "update-presentation-node",
    }],
  });
  const saved = await read(path, "pages/Round Trip.html");
  assert.match(saved, /opacity-\[0\.5\]/);
  await writeFile(join(path, "pages", "Round Trip.html"), saved.replace("bg-brand", "bg-missing"));
  const reverted = await check(path, "--revert");
  assert.equal(reverted.ok, true);
  assert.equal(await read(path, "pages/Round Trip.html"), saved);
});

test("a replaced image is restored from the accepted bytes", async (context) => {
  const { path, page } = await copy(context);
  const png = await readFile(new URL("fixtures/quadrant-lossy.webp", import.meta.url));
  const { mkdir } = await import("node:fs/promises");
  await mkdir(join(path, "assets"), { recursive: true });
  await writeFile(join(path, "assets", "photo.webp"), png);
  await writeFile(page, (await readFile(page, "utf8")).replace("</body>", '  <img data-name="Photo" src="../assets/photo.webp" class="w-[64px] h-[64px]">\n</body>'));
  assert.equal((await check(path)).ok, true);
  await writeFile(join(path, "assets", "photo.webp"), Buffer.from("not an image"));
  const gated = await check(path);
  assert.deepEqual(gated.gate.rejected.map(({ path: file }) => file), ["assets/photo.webp"]);
  assert.equal((await check(path, "--revert")).ok, true);
  assert.deepEqual(await readFile(join(path, "assets", "photo.webp")), png);
});

test("without an accepted version there is nothing to revert to, and it says so", async (context) => {
  const { path } = await copy(context);
  await writeFile(join(path, "pages", "Broken.html"), "<!doctype html>\n<html>\n<body><div\n</html>\n");
  const gated = await check(path, "--revert");
  assert.equal(gated.code, 1);
  assert.equal(gated.gate.rejected, undefined);
  assert.match(gated.gate.note, /No accepted version yet/);
  assert.ok((await readdir(join(path, "pages"))).includes("Broken.html"));
});

test("a package from init is accepted, so a first broken edit can be reverted", async (context) => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-gate-init-"));
  context.after(() => rm(root, { recursive: true, force: true }));
  const { stdout } = await promisify(execFile)(process.execPath, [cli, "init", join(root, "demo"), "--json"]);
  const path = JSON.parse(stdout).packagePath;
  await writeFile(join(path, "tokens.css"), ":root {\n  --color-brand: oops;\n}\n");
  const gated = await check(path);
  assert.deepEqual(gated.gate.rejected.map(({ path: file }) => file), ["tokens.css"]);
  assert.equal((await check(path, "--revert")).ok, true);
  assert.equal(await read(path, "tokens.css"), ":root {\n}\n");
});

