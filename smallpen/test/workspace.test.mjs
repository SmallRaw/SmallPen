import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  applyOperationBatch,
  openWorkspace,
  resolveWorkspace,
} from "@smallpen/local-package";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "roundtrip.smallpen");

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function workspaceFixture() {
  const root = await mkdtemp(join(tmpdir(), "smallpen-workspace-test-"));
  const productPath = join(root, "app.smallpen");
  const foundationPath = join(root, "foundation.smallpen");
  await cp(fixture, productPath, { recursive: true });
  await cp(fixture, foundationPath, { recursive: true });
  const foundationManifestPath = join(foundationPath, "manifest.json");
  const foundationManifest = JSON.parse(
    await readFile(foundationManifestPath, "utf8"),
  );
  foundationManifest.name = "Foundation";
  foundationManifest.packageId = "pkg_foundation";
  await writeJson(foundationManifestPath, foundationManifest);
  const productManifestPath = join(productPath, "manifest.json");
  const productManifest = JSON.parse(
    await readFile(productManifestPath, "utf8"),
  );
  productManifest.dependencies = [
    { packageId: "pkg_foundation", path: "foundation.smallpen" },
  ];
  productManifest.name = "Product";
  productManifest.packageId = "pkg_product";
  productManifest.role = "product";
  await writeJson(productManifestPath, productManifest);
  return { foundationPath, productPath, root };
}

test("a Product resolves exactly one same-workspace Foundation without a lock", async () => {
  const paths = await workspaceFixture();
  const first = await openWorkspace(paths.productPath);
  assert.equal(first.product.manifest.packageId, "pkg_product");
  assert.equal(first.foundation.manifest.packageId, "pkg_foundation");
  assert.equal(Object.hasOwn(first.product.manifest, "lock"), false);
  const beforeRevision = first.foundation.revision;

  const screenPath = join(paths.foundationPath, "screens/roundtrip.json");
  const screen = JSON.parse(await readFile(screenPath, "utf8"));
  screen.name = "Updated Foundation";
  await writeJson(screenPath, screen);
  const second = await openWorkspace(paths.productPath);
  assert.notEqual(second.foundation.revision, beforeRevision);
  assert.equal(
    second.foundation.entries["screens/roundtrip.json"].name,
    "Updated Foundation",
  );
});

test("Foundation path, Package ID, and role conflicts return typed Repair choices", async () => {
  const missingPaths = await workspaceFixture();
  const missingManifestPath = join(missingPaths.productPath, "manifest.json");
  const missingManifest = JSON.parse(
    await readFile(missingManifestPath, "utf8"),
  );
  missingManifest.dependencies[0].path = "missing.smallpen";
  await writeJson(missingManifestPath, missingManifest);
  const missing = await resolveWorkspace(missingPaths.productPath);
  assert.equal(missing.status, "repair");
  assert.deepEqual(missing.conflicts[0], {
    choices: [
      {
        action: "choose-foundation",
        currentPath: "missing.smallpen",
        expectedPackageId: "pkg_foundation",
      },
    ],
    code: "foundation_unavailable",
    message: missing.conflicts[0].message,
    path: "manifest.json.dependencies[0].path",
    severity: "error",
  });

  const idPaths = await workspaceFixture();
  const idManifestPath = join(idPaths.productPath, "manifest.json");
  const idManifest = JSON.parse(await readFile(idManifestPath, "utf8"));
  idManifest.dependencies[0].packageId = "pkg_other";
  await writeJson(idManifestPath, idManifest);
  const mismatched = await resolveWorkspace(idPaths.productPath);
  assert.equal(mismatched.status, "repair");
  assert.equal(mismatched.conflicts[0].code, "dependency_id_mismatch");
  assert.equal(
    mismatched.conflicts[0].path,
    "manifest.json.dependencies[0].packageId",
  );

  const rolePaths = await workspaceFixture();
  const roleManifestPath = join(rolePaths.foundationPath, "manifest.json");
  const roleManifest = JSON.parse(await readFile(roleManifestPath, "utf8"));
  roleManifest.role = "product";
  roleManifest.dependencies = [
    { packageId: "pkg_unused", path: "unused.smallpen" },
  ];
  await writeJson(roleManifestPath, roleManifest);
  const wrongRole = await resolveWorkspace(rolePaths.productPath);
  assert.equal(wrongRole.status, "repair");
  assert.equal(wrongRole.conflicts[0].code, "dependency_not_foundation");
});

test("a Foundation outside the workspace opens with a portability warning", async () => {
  const paths = await workspaceFixture();
  const outside = await mkdtemp(join(tmpdir(), "smallpen-outside-foundation-"));
  const outsidePackage = join(outside, "outside.smallpen");
  await cp(fixture, outsidePackage, { recursive: true });
  const outsideManifestPath = join(outsidePackage, "manifest.json");
  const outsideManifest = JSON.parse(
    await readFile(outsideManifestPath, "utf8"),
  );
  outsideManifest.name = "Foundation";
  outsideManifest.packageId = "pkg_foundation";
  await writeJson(outsideManifestPath, outsideManifest);
  const linkPath = join(paths.root, "linked.smallpen");
  await symlink(outsidePackage, linkPath);
  const manifestPath = join(paths.productPath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.dependencies[0].path = "linked.smallpen";
  await writeJson(manifestPath, manifest);
  const resolution = await resolveWorkspace(paths.productPath);
  assert.equal(resolution.status, "ready");
  assert.equal(
    resolution.workspace.foundation.locator,
    await realpath(outsidePackage),
  );
  assert.equal(resolution.warnings[0].code, "external_foundation_path");
});

test("a Package resolves multiple local Libraries without changing its Foundation", async () => {
  const paths = await workspaceFixture();
  const libraryPath = join(paths.root, "icons.smallpen");
  await cp(fixture, libraryPath, { recursive: true });
  const libraryManifestPath = join(libraryPath, "manifest.json");
  const libraryManifest = JSON.parse(
    await readFile(libraryManifestPath, "utf8"),
  );
  libraryManifest.name = "Icons";
  libraryManifest.packageId = "pkg_icons";
  await writeJson(libraryManifestPath, libraryManifest);

  const manifestPath = join(paths.productPath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.libraries = [
    {
      packageId: "pkg_icons",
      source: { path: "icons.smallpen", type: "local" },
    },
  ];
  await writeJson(manifestPath, manifest);

  const resolution = await resolveWorkspace(paths.productPath);
  assert.equal(resolution.status, "ready");
  assert.equal(
    resolution.workspace.foundation.manifest.packageId,
    "pkg_foundation",
  );
  assert.deepEqual(
    resolution.workspace.libraries.map(
      ({ manifest: value }) => value.packageId,
    ),
    ["pkg_icons"],
  );
  assert.deepEqual(resolution.workspace.librarySources, [
    {
      direct: true,
      fileId: resolution.workspace.libraries[0].runtime.file,
      name: "Icons",
      packageId: "pkg_icons",
      revision: resolution.workspace.libraries[0].revision,
      role: "foundation",
      source: { path: "icons.smallpen", type: "local" },
    },
  ]);
});

test("a Package resolves a URL Library and reopens its verified cache offline", async () => {
  const paths = await workspaceFixture();
  const remoteManifest = JSON.parse(
    await readFile(join(fixture, "manifest.json"), "utf8"),
  );
  remoteManifest.name = "Remote Icons";
  remoteManifest.packageId = "pkg_remote_icons";
  const remoteValues = new Map([["manifest.json", remoteManifest]]);
  for (const entry of Object.values(remoteManifest.entries).flat()) {
    remoteValues.set(
      entry,
      JSON.parse(await readFile(join(fixture, entry), "utf8")),
    );
  }
  const sourceUrl = "https://design.example/icons/";
  const manifestPath = join(paths.productPath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.libraries = [
    {
      packageId: "pkg_remote_icons",
      source: { type: "url", url: sourceUrl },
    },
  ];
  await writeJson(manifestPath, manifest);
  const fetchImpl = async (url) => {
    const path = new URL(url).pathname.replace("/icons/", "");
    const value = remoteValues.get(path);
    return value === undefined
      ? new Response("missing", { status: 404 })
      : new Response(JSON.stringify(value), { status: 200 });
  };
  const libraryCacheRoot = join(paths.root, ".library-cache");

  const online = await resolveWorkspace(paths.productPath, {
    fetchImpl,
    libraryCacheRoot,
    refreshRemoteLibraries: true,
  });
  assert.equal(online.status, "ready");
  assert.equal(
    online.workspace.libraries[0].manifest.packageId,
    "pkg_remote_icons",
  );
  assert.equal(online.workspace.libraries[0].remote.cache, "refreshed");

  const offline = await resolveWorkspace(paths.productPath, {
    fetchImpl: async () => {
      throw new Error("offline");
    },
    libraryCacheRoot,
  });
  assert.equal(offline.status, "ready");
  assert.equal(offline.workspace.libraries[0].remote.cache, "hit");
  assert.equal(offline.workspace.librarySources[0].source.url, sourceUrl);
});

test("a deleted Foundation asset enters Repair with executable choices", async () => {
  const paths = await workspaceFixture();
  const foundationManifestPath = join(paths.foundationPath, "manifest.json");
  const foundationManifest = JSON.parse(
    await readFile(foundationManifestPath, "utf8"),
  );
  foundationManifest.entries.tokens = ["tokens/design.json"];
  await writeJson(foundationManifestPath, foundationManifest);
  await mkdir(join(paths.foundationPath, "tokens"), { recursive: true });
  const tokenPath = join(paths.foundationPath, "tokens/design.json");
  const tokenLibrary = {
    activeSetIds: ["tset_foundation"],
    activeThemeIds: [],
    id: "tlib_foundation",
    sets: [
      {
        description: "Foundation",
        id: "tset_foundation",
        name: "Foundation",
        tokens: [
          {
            description: "Brand",
            id: "tok_foundation_brand",
            name: "color.brand",
            type: "color",
            value: "#6750a4",
          },
        ],
      },
    ],
    themes: [],
  };
  await writeJson(tokenPath, tokenLibrary);

  const screenPath = join(paths.productPath, "screens/roundtrip.json");
  const screen = JSON.parse(await readFile(screenPath, "utf8"));
  screen.presentations[0].nodes.node_rectangle.tokenBindings = {
    fill: {
      assetId: "tok_foundation_brand",
      packageId: "pkg_foundation",
    },
  };
  await writeJson(screenPath, screen);
  assert.equal((await resolveWorkspace(paths.productPath)).status, "ready");

  tokenLibrary.sets[0].tokens = [];
  await writeJson(tokenPath, tokenLibrary);
  const missing = await resolveWorkspace(paths.productPath);
  assert.equal(missing.status, "repair");
  assert.deepEqual(missing.conflicts[0], {
    choices: [
      {
        action: "retarget-reference",
        reference: {
          assetId: "tok_foundation_brand",
          packageId: "pkg_foundation",
        },
        referencePath:
          "screens/roundtrip.json.presentations[0].nodes.node_rectangle.tokenBindings.fill",
      },
      {
        action: "recreate-product-asset",
        assetKind: "token",
        reference: {
          assetId: "tok_foundation_brand",
          packageId: "pkg_foundation",
        },
        referencePath:
          "screens/roundtrip.json.presentations[0].nodes.node_rectangle.tokenBindings.fill",
      },
      {
        action: "remove-dependent-usage",
        referencePath:
          "screens/roundtrip.json.presentations[0].nodes.node_rectangle.tokenBindings.fill",
      },
    ],
    code: "missing_foundation_asset",
    message: "Foundation asset is missing: tok_foundation_brand",
    path: "screens/roundtrip.json.presentations[0].nodes.node_rectangle.tokenBindings.fill",
    reference: {
      assetId: "tok_foundation_brand",
      packageId: "pkg_foundation",
    },
    severity: "error",
  });
});

test("a missing external Component variant is detected by workspace projection", async () => {
  const paths = await workspaceFixture();
  const manifestPath = join(paths.foundationPath, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  manifest.entries.components = ["components/button.json"];
  await writeJson(manifestPath, manifest);
  await mkdir(join(paths.foundationPath, "components"), { recursive: true });
  await writeJson(join(paths.foundationPath, "components/button.json"), {
    componentSets: [
      {
        axes: [
          {
            domain: ["sm", "lg"],
            id: "axis_size",
            name: "Size",
            role: "configuration",
          },
        ],
        id: "cmp_foundation_button",
        name: "Button",
        variants: [
          {
            id: "var_foundation_button_sm",
            nodes: {
              node_foundation_button: {
                children: [],
                height: 40,
                id: "node_foundation_button",
                name: "Button",
                type: "COMPONENT",
                width: 120,
                x: 0,
                y: 0,
              },
            },
            rootId: "node_foundation_button",
            selection: { axis_size: "sm" },
          },
        ],
        visibility: "public",
      },
    ],
  });
  const screenPath = join(paths.productPath, "screens/roundtrip.json");
  const screen = JSON.parse(await readFile(screenPath, "utf8"));
  const node = screen.presentations[0].nodes.node_rectangle;
  node.type = "INSTANCE";
  node.instance = {
    component: {
      assetId: "cmp_foundation_button",
      packageId: "pkg_foundation",
    },
    variant: { axis_size: "sm" },
  };
  await writeJson(screenPath, screen);
  assert.equal((await resolveWorkspace(paths.productPath)).status, "ready");

  node.instance.variant.axis_size = "lg";
  await writeJson(screenPath, screen);
  const resolution = await resolveWorkspace(paths.productPath);
  assert.equal(resolution.status, "repair");
  assert.equal(resolution.conflicts[0].code, "missing_variant");
  assert.deepEqual(resolution.conflicts[0].choices, [
    {
      action: "retarget-reference",
      reference: {
        assetId: "cmp_foundation_button",
        packageId: "pkg_foundation",
      },
      referencePath:
        "screens/roundtrip.json.presentations[0].nodes.node_rectangle.instance.component",
    },
    {
      action: "recreate-product-asset",
      assetKind: "component",
      reference: {
        assetId: "cmp_foundation_button",
        packageId: "pkg_foundation",
      },
      referencePath:
        "screens/roundtrip.json.presentations[0].nodes.node_rectangle.instance.component",
    },
    {
      action: "remove-dependent-usage",
      referencePath:
        "screens/roundtrip.json.presentations[0].nodes.node_rectangle",
    },
  ]);
  await applyOperationBatch(paths.productPath, {
    baseRevision: resolution.product.revision,
    batchId: "batch_remove_missing_variant_usage",
    operations: [
      {
        action: "remove-dependent-usage",
        referencePath:
          "screens/roundtrip.json.presentations[0].nodes.node_rectangle",
        type: "repair-reference",
      },
    ],
  });
  assert.equal((await resolveWorkspace(paths.productPath)).status, "ready");
  const repaired = JSON.parse(await readFile(screenPath, "utf8"));
  assert.deepEqual(repaired.presentations[0].nodes.node_canvas.children, []);
  assert.equal(
    Object.hasOwn(repaired.presentations[0].nodes, "node_rectangle"),
    false,
  );
});

test("a reference to an undeclared Package enters Repair", async () => {
  const paths = await workspaceFixture();
  const screenPath = join(paths.productPath, "screens/roundtrip.json");
  const screen = JSON.parse(await readFile(screenPath, "utf8"));
  screen.presentations[0].nodes.node_rectangle.tokenBindings = {
    fill: { assetId: "tok_elsewhere", packageId: "pkg_elsewhere" },
  };
  await writeJson(screenPath, screen);
  const resolution = await resolveWorkspace(paths.productPath);
  assert.equal(resolution.status, "repair");
  assert.equal(resolution.conflicts[0].code, "undeclared_package_reference");
  assert.equal(
    resolution.conflicts[0].path,
    "screens/roundtrip.json.presentations[0].nodes.node_rectangle.tokenBindings.fill",
  );
});
