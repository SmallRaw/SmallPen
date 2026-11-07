#!/usr/bin/env node
import { spawn } from "node:child_process";
import {
  access,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { stagePayload } from "./stage-payload.mjs";

const root = fileURLToPath(new URL("../", import.meta.url));
const smallpen = resolve(root, "../..");
const args = process.argv.slice(2);
const option = (name) =>
  args.includes(name) ? args[args.indexOf(name) + 1] : undefined;
const platform = process.platform;
const arch = process.arch;

async function main() {
  if (!(
    (platform === "darwin" && arch === "arm64") ||
    (platform === "win32" && arch === "x64")
  ))
    throw new Error("Build Desktop on macOS arm64 or Windows x64");
  const { packager } =
    await import("../tools/node_modules/@electron/packager/dist/index.js");
  const { flipFuses, FuseVersion, FuseV1Options } =
    await import("../tools/node_modules/@electron/fuses/dist/index.js");
  const { version: electronVersion } = JSON.parse(
    await readFile(join(root, "electron.json")),
  );
  const metadata = JSON.parse(await readFile(join(root, "package.json")));
  const output = resolve(
    option("--output") ??
      join(
        root,
        "dist",
        platform === "darwin" ? "SmallPen.app" : "SmallPen-Windows-x64",
      ),
  );
  try {
    await access(output);
    throw new Error(
      `Output already exists: ${output}. Choose a new --output path.`,
    );
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  await mkdir(dirname(output), { recursive: true });
  const staging = await mkdtemp(join(dirname(output), ".smallpen-electron-"));
  const resources = join(staging, "payload");
  await stagePayload(
    smallpen,
    resources,
    resolve(
      option("--frontend-root") ??
        join(smallpen, "../frontend/resources/public"),
    ),
  );
  const appRoot = join(resources, "app");
  await cp(join(smallpen, "../LICENSE"), join(appRoot, "LICENSE"));
  await writeFile(
    join(appRoot, "package.json"),
    JSON.stringify(
      {
        name: "smallpen-desktop",
        productName: "SmallPen",
        version: metadata.version,
        type: "module",
        main: "apps/desktop/src/electron-main.mjs",
      },
      null,
      2,
    ),
  );
  const paths = await packager({
    dir: appRoot,
    out: join(staging, "built"),
    name: "SmallPen",
    platform,
    arch,
    electronVersion,
    appVersion: metadata.version,
    appBundleId: "app.smallpen.desktop",
    appCategoryType: "public.app-category.graphics-design",
    asar: true,
    // The staging allowlist already contains only required modules. Its root
    // deliberately has no npm dependency graph for a pruner to re-resolve.
    prune: false,
    extraResource: [join(resources, "frontend")],
    extendInfo: {
      CFBundleDocumentTypes: [
        {
          CFBundleTypeExtensions: ["smallpen"],
          CFBundleTypeName: "SmallPen Package",
          CFBundleTypeRole: "Editor",
          LSTypeIsPackage: true,
        },
      ],
    },
  });
  const built = paths[0];
  const app = platform === "darwin" ? join(built, "SmallPen.app") : built;
  if (platform === "darwin") {
    // Packager places Electron's notices beside the .app. Our archive contains
    // only the .app, so keep the notices inside its Resources before signing.
    for (const name of ["LICENSE", "LICENSES.chromium.html"]) {
      try {
        await cp(join(built, name), join(app, "Contents/Resources", name));
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
    }
  }
  await flipFuses(platform === "darwin" ? app : join(app, "SmallPen.exe"), {
    version: FuseVersion.V1,
    [FuseV1Options.RunAsNode]: false,
    [FuseV1Options.EnableNodeOptionsEnvironmentVariable]: false,
    [FuseV1Options.EnableNodeCliInspectArguments]: false,
    [FuseV1Options.EnableEmbeddedAsarIntegrityValidation]: true,
    [FuseV1Options.OnlyLoadAppFromAsar]: true,
  });
  if (platform === "darwin") {
    await new Promise((resolveSign, reject) => {
      const child = spawn(
        "codesign",
        [
          "--force",
          "--deep",
          "--preserve-metadata=entitlements",
          "--sign",
          "-",
          app,
        ],
        { stdio: "inherit" },
      );
      child.once("error", reject);
      child.once("exit", (code) =>
        code === 0
          ? resolveSign()
          : reject(new Error(`codesign exited ${code}`)),
      );
    });
  }
  await rename(app, output);
  // Keep staging recoverable for inspection; never erase a prior build.
  console.log(
    JSON.stringify({ status: "built", app: output, electronVersion, staging }),
  );
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
