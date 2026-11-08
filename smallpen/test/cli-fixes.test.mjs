import assert from "node:assert/strict";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { spawn } from "node:child_process";
import { openPackage } from "@smallpen/local-package";
import { onlyScreen, readModelEntry, seedLegacyIds } from "./helpers/named.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const cli = join(here, "..", "apps", "cli", "bin", "smallpen-check.cjs");
const fixture = join(here, "fixtures", "roundtrip.smallpen");

function runCli(args) {
  // Schema and full-value checks opt into stdout; fixed-file transport is tested separately.
  if (
    (args[0] === "schema" || args.includes("--full")) &&
    !args.includes("--stdout")
  )
    args = [...args, "--stdout"];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [cli, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.once("error", reject);
    child.once("close", (code) => resolve({ code, stderr, stdout }));
  });
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function workspaceFixture() {
  const root = await mkdtemp(join(tmpdir(), "smallpen-cli-fixes-"));
  const productPath = join(root, "app.smallpen");
  const foundationPath = join(root, "foundation.smallpen");
  await cp(fixture, productPath, { recursive: true });
  await seedLegacyIds(productPath, "roundtrip");
  await cp(fixture, foundationPath, { recursive: true });
  await seedLegacyIds(foundationPath, "roundtrip");
  const foundationManifest = await readModelEntry(foundationPath, "manifest.json");
  foundationManifest.name = "Foundation";
  foundationManifest.packageId = "pkg_foundation";
  await writeJson(join(foundationPath, "manifest.json"), foundationManifest);
  const productManifest = await readModelEntry(productPath, "manifest.json");
  productManifest.dependencies = [
    { packageId: "pkg_foundation", path: "foundation.smallpen" },
  ];
  productManifest.name = "Product";
  productManifest.packageId = "pkg_product";
  productManifest.role = "product";
  await writeJson(join(productPath, "manifest.json"), productManifest);
  return { foundationPath, productPath, root };
}

// Stored state is read directly; the CLI no longer reads by ID.
async function revisionOf(path) {
  return (await openPackage(path)).revision;
}

async function clonePackage(path, name) {
  const root = await mkdtemp(join(tmpdir(), "smallpen-cli-clone-"));
  const target = join(root, name);
  await cp(path, target, { recursive: true });
  return target;
}

test("the public launcher gates Node version before ESM instantiation (SP-050)", async () => {
  const gate = await readFile(
    join(here, "..", "apps", "cli", "bin", "smallpen-check.cjs"),
    "utf8",
  );
  assert.match(gate, /unsupported_node_runtime/);
  assert.match(gate, /major < 24/);
  // The public launcher passes through to the CLI on the current runtime.
  const result = await runCli(["version"]);
  assert.equal(result.code, 0);
  const metadata = JSON.parse(
    await readFile(join(here, "..", "apps", "cli", "package.json"), "utf8"),
  );
  assert.deepEqual(JSON.parse(result.stdout), {
    name: metadata.name,
    version: metadata.version,
  });
});

async function componentWorkspace() {
  const { foundationPath, productPath, root } = await workspaceFixture();
  const foundationManifest = await readModelEntry(foundationPath, "manifest.json");
  foundationManifest.entries.components = ["components/shared.json"];
  await writeJson(join(foundationPath, "manifest.json"), foundationManifest);
  await mkdir(join(foundationPath, "components"), { recursive: true });
  await writeJson(join(foundationPath, "components/shared.json"), {
    componentSets: [
      {
        axes: [
          {
            domain: ["idle"],
            id: "axis_state",
            name: "State",
            role: "state",
          },
        ],
        id: "cmp_shared_button",
        name: "Shared Button",
        variants: [
          {
            id: "var_shared_idle",
            nodes: {
              node_shared_root: {
                children: [],
                fills: [{ color: "#2563eb", type: "solid" }],
                height: 40,
                id: "node_shared_root",
                name: "Shared Button",
                type: "COMPONENT",
                width: 120,
                x: 0,
                y: 0,
              },
            },
            rootId: "node_shared_root",
            selection: { axis_state: "idle" },
          },
        ],
        visibility: "public",
      },
    ],
  });
  const screenPath = join(productPath, "screens/roundtrip.json");
  const screen = JSON.parse(await readFile(screenPath, "utf8"));
  screen.presentations[0].nodes.node_shared_instance = {
    children: [],
    height: 40,
    id: "node_shared_instance",
    instance: {
      component: { assetId: "cmp_shared_button", packageId: "pkg_foundation" },
      variant: { axis_state: "idle" },
    },
    name: "Shared instance",
    type: "INSTANCE",
    width: 120,
    x: 400,
    y: 300,
  };
  screen.presentations[0].nodes.node_canvas.children.push(
    "node_shared_instance",
  );
  await writeJson(screenPath, screen);
  return { foundationPath, productPath, root };
}

// RV-003-A/B: --explain/--diff/--confirm-unmatched are order-independent flags.
// RV-003-C: explain/diff are read-only previews in every combination.
// RV-003-D: unknown options and value-less options are rejected cleanly in any
// position around the new flags.
// RV-004-C: read the stale error's recovery queries, then rebuild a scoped
// edit from the current design and preserve concurrent fields.
// RV-004-D: execute the token-removal recovery chain end to end with the
// commands the error response returns and the Token's name.
