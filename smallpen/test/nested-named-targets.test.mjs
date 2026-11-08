// Copies nested three levels deep, written as HTML: overrides, variant swaps
// and links reach parts by the names on the path, and nested copies keep
// their size when their variant changes.
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { inspectProjection, openPackage } from "@smallpen/local-package";
import { checkPackageFiles, flowLinks, projectScreen } from "@smallpen/core";
import { componentReferenceLookup, instanceSourceTree } from "../packages/core/src/named-targets.mjs";
import { componentOf, pageHtml, writePackage } from "./helpers/named.mjs";

const COMPONENTS = `<sp-component name="Action" props="State: idle | busy; Tone: plain | bold">
  <div class="flex flex-row w-fit h-fit">
    <p data-name="Label" class="text-[#111111]">Go</p>
  </div>
  <sp-variant when="State: busy">
    <p data-name="Label">Wait</p>
  </sp-variant>
</sp-component>

<sp-component name="Panel">
  <div class="flex flex-col w-fit h-fit">
    <sp-use component="Action" data-name="Action"></sp-use>
  </div>
</sp-component>

<sp-component name="Shell">
  <div class="flex flex-col w-fit h-fit">
    <sp-use component="Panel" data-name="Panel"></sp-use>
  </div>
</sp-component>

<sp-component name="Pair">
  <div class="flex flex-row w-fit h-fit">
    <sp-use component="Action" data-name="First"></sp-use>
    <sp-use component="Action" data-name="Second"></sp-use>
  </div>
</sp-component>

<sp-component name="Contact">
  <div class="flex flex-row w-fit h-fit">
    <p data-name="hello@example.com">Mail</p>
  </div>
</sp-component>

<sp-component name="Envelope">
  <div class="flex flex-row w-fit h-fit">
    <sp-use component="Contact" data-name="Contact"></sp-use>
  </div>
</sp-component>

<sp-component name="SizedIcon" props="Name: arrow | close; Tone: default | muted; Size: normal | large">
  <div class="w-[24px] h-[24px]">
    <div data-name="Glyph" class="left-[0px] top-[0px] w-[24px] h-[24px] bg-[#111111] pin-x-scale pin-y-scale"></div>
  </div>
  <sp-variant when="Size: large" class="w-[48px] h-[48px]">
    <div data-name="Glyph" class="w-[48px] h-[48px]"></div>
  </sp-variant>
</sp-component>

<sp-component name="IconRow">
  <div class="flex flex-row gap-[8px] w-[300px] h-[64px]">
    <sp-use component="SizedIcon" data-name="Chevron" class="w-[12px] h-[12px]"></sp-use>
    <sp-use component="SizedIcon" data-name="Small" class="w-[14px] h-[14px]"></sp-use>
    <sp-use component="SizedIcon" data-name="Action" class="w-[20px] h-[20px]"></sp-use>
  </div>
</sp-component>

<sp-component name="IconShell">
  <div class="flex flex-row w-[300px] h-[64px]">
    <sp-use component="IconRow" data-name="Row"></sp-use>
  </div>
</sp-component>
`;

const page = (copy) => pageHtml(`<body class="w-[390px] h-[300px] bg-[#ffffff]">
${copy}
</body>`, { title: "Probe" });

async function probePackage(copy) {
  const root = await mkdtemp(join(tmpdir(), "smallpen-nested-"));
  const path = join(root, "nested.smallpen");
  await writePackage(path, { "components/components.html": COMPONENTS, "pages/Probe.html": page(copy) });
  return openPackage(path);
}

function projected(snapshot) {
  const screen = snapshot.entries[snapshot.manifest.entries.screens[0]];
  return Object.values(projectScreen(snapshot, screen.id).nodes);
}

const shell = (inner) => `  <sp-use component="Shell" data-name="Shell" class="left-[0px] top-[0px]">
    <sp-use data-name="Panel">
      <sp-use data-name="Action"${inner.props ? ` props="${inner.props}"` : ""}>
        ${inner.label}
      </sp-use>
    </sp-use>
  </sp-use>`;

test("overrides reach text and fields through three component levels", async () => {
  const snapshot = await probePackage(shell({ label: '<p data-name="Label" class="font-[600] text-[#ff0000]">Save</p>' }));
  const label = projected(snapshot).find((node) => node.name === "Label");
  assert.equal(label.text, "Save");
  assert.equal(label.textStyle.fontWeight, 600);
  assert.equal(label.fills[0].color, "#ff0000");
});

test("a nested copy's variant swap keeps the override on its part", async () => {
  const swapped = await probePackage(shell({ props: "State: busy", label: "" }));
  assert.equal(projected(swapped).find((node) => node.name === "Label").text, "Wait");
  const overridden = await probePackage(shell({ props: "State: busy; Tone: bold", label: '<p data-name="Label">Working</p>' }));
  assert.equal(projected(overridden).find((node) => node.name === "Label").text, "Working");
});

test("a link on a deep copy part is listed by its full name", async () => {
  const snapshot = await probePackage(shell({ label: '<p data-name="Label" data-click="back"></p>' }));
  const links = flowLinks(snapshot).links;
  assert.equal(links.length, 1);
  assert.equal(links[0].element, "Shell / Panel / Action / Label");
});

test("part names keep literal dots and at signs", async () => {
  const snapshot = await probePackage(`  <sp-use component="Envelope" data-name="Shell" class="left-[0px] top-[0px]">
    <sp-use data-name="Contact">
      <p data-name="hello@example.com">Nested mail</p>
    </sp-use>
  </sp-use>`);
  assert.equal(projected(snapshot).find((node) => node.name === "hello@example.com").text, "Nested mail");
});

test("an override must follow the path to its part; a leaf name alone never matches", async () => {
  const files = new Map([
    ["index.html", Buffer.from('<!doctype html>\n<html>\n<head>\n  <meta charset="utf-8">\n  <title>T</title>\n  <meta name="smallpen:package-id" content="pkg_t">\n</head>\n<body></body>\n</html>\n')],
    ["tokens.css", Buffer.from(":root {\n}\n")],
    ["components/components.html", Buffer.from(COMPONENTS)],
    ["pages/Probe.html", Buffer.from(page(`  <sp-use component="Pair" data-name="Pair" class="left-[0px] top-[0px]">
    <p data-name="Label">Wrong</p>
  </sp-use>`))],
  ]);
  const { issues } = await checkPackageFiles(files);
  const error = issues.find((issue) => issue.severity === "error");
  assert.ok(error, "an override with a missing path is an error");
  assert.equal(error.file, "pages/Probe.html");
  assert.match(error.message, /Label/);
});

test("source-tree lookup rejects missing variants, owners and component cycles without falling back", async () => {
  const snapshot = await probePackage(shell({ label: "" }));
  const componentsByRef = componentReferenceLookup(snapshot);
  const reference = (name) => ({ assetId: componentOf(snapshot, name).id, packageId: snapshot.manifest.packageId });
  const action = componentOf(snapshot, "Action");
  const [state, tone] = action.axes.map((axis) => axis.id);
  assert.throws(
    () => instanceSourceTree({ component: reference("Action"), variant: { [state]: "missing", [tone]: "plain" } }, componentsByRef),
    (error) => error.code === "missing_variant",
  );
  assert.throws(
    () => instanceSourceTree({ component: { ...reference("Shell"), packageId: "missing" }, variant: {} }, componentsByRef),
    (error) => error.code === "missing_component",
  );
  const cyclic = structuredClone(snapshot);
  const cyclicShell = componentOf(cyclic, "Shell");
  Object.values(cyclicShell.variants[0].nodes).find((node) => node.instance).instance.component = reference("Shell");
  assert.throws(
    () => instanceSourceTree({ component: reference("Shell"), variant: {} }, componentReferenceLookup(cyclic)),
    (error) => error.code === "component_instance_cycle",
  );
});

async function sizedIcons(row) {
  const snapshot = await probePackage(`  <sp-use component="IconShell" data-name="Shell" class="left-[0px] top-[0px]">
    <sp-use data-name="Row">
${row}
    </sp-use>
  </sp-use>`);
  const screen = snapshot.entries[snapshot.manifest.entries.screens[0]];
  const projection = projectScreen(snapshot, screen.id);
  const native = await inspectProjection(snapshot, projection);
  return { projection, native };
}

function assertIconSize(result, name, width, height = width) {
  const icon = Object.values(result.projection.nodes).find((node) => node.name === name);
  const glyph = result.projection.nodes[icon.children[0]];
  assert.deepEqual([icon.width, icon.height], [width, height], `${name}: projected copy retains its size`);
  assert.deepEqual([glyph.width, glyph.height], [width, height], `${name}: scaled glyph follows its copy`);
  for (const node of [icon, glyph]) {
    const bounds = result.native.snapshot.nodes[node.id].bounds;
    assert.deepEqual([bounds.width, bounds.height], [width, height], `${name}: native bounds match projection`);
  }
}

test("nested Name and Tone props preserve 12, 14 and 20px instance and glyph sizes in native layout", async () => {
  const result = await sizedIcons(`      <sp-use data-name="Chevron" props="Name: close"></sp-use>
      <sp-use data-name="Small" props="Tone: muted"></sp-use>
      <sp-use data-name="Action" props="Name: close; Tone: muted"></sp-use>`);
  assertIconSize(result, "Chevron", 12);
  assertIconSize(result, "Small", 14);
  assertIconSize(result, "Action", 20);
});

test("nested size variants retain copy scale and explicit dimension overrides win in native layout", async () => {
  const result = await sizedIcons(`      <sp-use data-name="Chevron" props="Size: large"></sp-use>
      <sp-use data-name="Small" props="Size: large"></sp-use>
      <sp-use data-name="Action" props="Size: large" class="w-[18px]"></sp-use>`);
  assertIconSize(result, "Chevron", 24);
  assertIconSize(result, "Small", 28);
  assertIconSize(result, "Action", 18, 40);
});
