import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  listPackageEntries,
  loadPackageFromValues,
  projectEffectiveSnapshot,
} from "@smallpen/core";
import { compilePenpotChanges } from "@smallpen/penpot-adapter";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "roundtrip.smallpen");

async function fixtureValues() {
  const manifest = JSON.parse(await readFile(join(fixture, "manifest.json"), "utf8"));
  const { entries } = listPackageEntries(manifest);
  const values = new Map([["manifest.json", manifest]]);
  for (const entry of entries) values.set(entry, JSON.parse(await readFile(join(fixture, entry), "utf8")));
  return values;
}

const cell = (id, name, type, value) => ({ description: "", id, name, type, value });

// A text bound to a string Token and a shape bound to a boolean Token, in a
// Language group with English and Chinese options.
async function languageSnapshot(active) {
  const values = await fixtureValues();
  values.set("tokens/tokens.json", {
    activeSetIds: [],
    activeThemeIds: [active],
    id: "tlib_default",
    sets: [
      { description: "", id: "tset_en", name: "Language/en", tokens: [
        cell("tok_greeting_en", "text.greeting", "string", "Hello"),
        cell("tok_badge_en", "flag.badge", "boolean", true),
      ] },
      { description: "", id: "tset_zh", name: "Language/zh", tokens: [
        cell("tok_greeting_zh", "text.greeting", "string", "你好"),
        cell("tok_badge_zh", "flag.badge", "boolean", false),
      ] },
    ],
    themes: [
      { description: "", externalId: "", group: "Language", id: "theme_en", isSource: false, name: "en", setIds: ["tset_en"] },
      { description: "", externalId: "", group: "Language", id: "theme_zh", isSource: false, name: "zh", setIds: ["tset_zh"] },
    ],
  });
  const node = values.get("screens/roundtrip.json").presentations[0].nodes.node_rectangle;
  node.type = "TEXT";
  node.text = "Hello";
  node.growType = "auto-width";
  node.tokenBindings = {
    text: { assetId: "tok_greeting_en", packageId: "pkg_roundtrip" },
    visible: { assetId: "tok_badge_en", packageId: "pkg_roundtrip" },
  };
  return loadPackageFromValues("memory://language.smallpen", values);
}

const nodeOf = (snapshot) =>
  snapshot.entries["screens/roundtrip.json"].presentations[0].nodes.node_rectangle;

test("text and visibility follow string and boolean Tokens under the selected language", async () => {
  const english = nodeOf(projectEffectiveSnapshot(await languageSnapshot("theme_en")));
  assert.equal(english.text, "Hello");
  assert.equal(english.visible, true);
  const chinese = nodeOf(projectEffectiveSnapshot(await languageSnapshot("theme_zh")));
  assert.equal(chinese.text, "你好", "the App shows the language its selected theme names");
  assert.equal(chinese.visible, false);
});

function textContent(text) {
  return {
    children: [{
      children: [{
        children: [{
          fills: [{ "fill-color": "#000000", "fill-opacity": 1 }],
          "font-family": "sourcesanspro", "font-id": "sourcesanspro", "font-size": "14",
          "font-style": "normal", "font-variant-id": "regular", "font-weight": "400",
          "letter-spacing": "0", "line-height": "1.2", text,
          "text-decoration": "none", "text-transform": "none",
        }],
        "text-align": "left", "text-direction": "ltr", type: "paragraph",
      }],
      type: "paragraph-set",
    }],
    type: "root",
    "vertical-align": "top",
  };
}

test("editing bound text in the App sets the person's text and drops only the text binding", async () => {
  const snapshot = projectEffectiveSnapshot(await languageSnapshot("theme_en"));
  const loaded = await loadPackageFromValues(
    "memory://language-edit.smallpen",
    new Map(Object.entries({ "manifest.json": snapshot.manifest, ...snapshot.entries })),
  );
  const runtimeId = loaded.runtime.nodes.scr_roundtrip.pres_desktop.node_rectangle;
  const edit = (text) =>
    compilePenpotChanges(loaded, {
      changes: [{ id: runtimeId, operations: [{ attr: "content", type: "set", val: textContent(text) }], type: "mod-obj" }],
      commitId: `edit-${text}`,
    });
  const changed = edit("Hi there").operations[0].changes;
  assert.equal(changed.text, "Hi there");
  assert.deepEqual(changed.tokenBindings, { visible: { assetId: "tok_badge_en", packageId: "pkg_roundtrip" } });
  const same = edit("Hello").operations[0]?.changes ?? {};
  assert.equal(same.tokenBindings, undefined, "showing the Token's own text keeps the binding");
});
