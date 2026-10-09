#!/usr/bin/env node

import {
  access,
  chmod,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, parse, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { copyRuntimeDependencies } from "./copy-runtime-dependencies.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const defaultOutput = join(root, "dist", "SmallPen-Web");

export async function buildWeb({
  output = defaultOutput,
  frontendRoot = resolve(root, "../frontend/resources/public"),
} = {}) {
  output = resolve(output);
  frontendRoot = resolve(frontendRoot);
  if (output === parse(output).root)
    throw new Error("Web output cannot be a filesystem root");
  const insideFrontend = relative(frontendRoot, output);
  if (!insideFrontend.startsWith("..") && !parse(insideFrontend).root)
    throw new Error("Web output cannot be inside the frontend input");
  if (output !== defaultOutput) {
    try {
      if (!(await stat(output)).isDirectory() || (await readdir(output)).length)
        throw new Error(`Output already exists: ${output}`);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  for (const required of ["index.html", "js/main.js", "js/main-workspace.js"])
    await access(join(frontendRoot, required));
  await mkdir(dirname(output), { recursive: true });
  const transaction = await mkdtemp(
    join(dirname(output), ".smallpen-web-build-"),
  );
  const candidate = join(transaction, "package");
  try {
    await mkdir(join(candidate, "bin"), { recursive: true });
    const web = join(candidate, "app", "apps", "web");
    await mkdir(web, { recursive: true });
    for (const name of ["package.json", "bin", "src"])
      await cp(join(root, "apps/web", name), join(web, name), {
        recursive: true,
      });
    const dependencies = {};
    for (const [name, source, files] of [
      ["background", "apps/background", ["package.json", "src"]],
      ["core", "packages/core", ["package.json", "src"]],
      [
        "local-package",
        "packages/local-package",
        ["package.json", "src", "assets"],
      ],
      ["penpot-adapter", "packages/penpot-adapter", ["package.json", "src"]],
    ]) {
      const target = join(candidate, "node_modules", "@smallpen", name);
      await mkdir(target, { recursive: true });
      for (const file of files)
        await cp(join(root, source, file), join(target, file), {
          recursive: true,
        });
      dependencies[`@smallpen/${name}`] = JSON.parse(
        await readFile(join(target, "package.json")),
      ).version;
    }
    await copyRuntimeDependencies(root, candidate);
    for (const name of ["opentype.js", "@jsquash/webp", "wasm-feature-detect"])
      dependencies[name] = JSON.parse(
        await readFile(join(candidate, "node_modules", name, "package.json")),
      ).version;
    await cp(frontendRoot, join(candidate, "frontend", "resources", "public"), {
      recursive: true,
      dereference: true,
    });
    await cp(resolve(root, "../LICENSE"), join(candidate, "LICENSE"));
    const metadata = JSON.parse(
      await readFile(join(root, "apps/web/package.json")),
    );
    await writeFile(
      join(candidate, "package.json"),
      JSON.stringify(
        {
          name: "@smallpen/web",
          version: metadata.version,
          description: "SmallPen browser editor and local file service",
          type: "module",
          license: "MPL-2.0",
          engines: { node: ">=24" },
          bin: { "smallpen-web": "./bin/smallpen-web.cjs" },
          files: ["app", "frontend", "bin", "LICENSE", "README.md"],
          dependencies,
          bundleDependencies: Object.keys(dependencies),
          publishConfig: { access: "public" },
          repository: {
            type: "git",
            url: "git+https://github.com/SmallRaw/SmallPen.git",
            directory: "smallpen/apps/web",
          },
        },
        null,
        2,
      ) + "\n",
    );
    await writeFile(
      join(candidate, "bin/smallpen-web.cjs"),
      `#!/usr/bin/env node
if (Number(process.versions.node.split(".")[0]) < 24) {
  console.error("SmallPen Web requires Node.js 24 or newer");
  process.exit(1);
}
import("../app/apps/web/bin/smallpen-web.mjs").catch(function (error) {
  console.error(error.message);
  process.exitCode = 1;
});
`,
    );
    await chmod(join(candidate, "bin/smallpen-web.cjs"), 0o755);
    await writeFile(
      join(candidate, "README.md"),
      `# SmallPen Web

Requires Node.js 24 or newer.

Run \`npx @smallpen/web@alpha\` to open the browser editor.
Run \`npx @smallpen/web@alpha ./project.smallpen\` to open a local package.

The local service opens and saves the original folder. Select folders in
the editor; no browser file permission or upload is needed. Ctrl+C stops
the service. Use \`--no-open\` to start without launching a browser.

This package includes the editor and local runtime. AI CLI and Electron
are separate products.
`,
    );
    await rm(output, { recursive: true, force: true });
    await rename(candidate, output);
    return {
      status: "built",
      output,
      name: "@smallpen/web",
      version: metadata.version,
    };
  } finally {
    await rm(transaction, { recursive: true, force: true });
  }
}

if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  const options = {};
  const args = process.argv.slice(2);
  for (let i = 0; i < args.length; i++) {
    const name = args[i];
    if (
      !["--output", "--frontend-root"].includes(name) ||
      !args[i + 1] ||
      args[i + 1].startsWith("--")
    )
      throw new Error(`Unknown or incomplete option: ${name}`);
    options[name === "--output" ? "output" : "frontendRoot"] = args[++i];
  }
  buildWeb(options)
    .then((result) => console.log(JSON.stringify(result)))
    .catch((error) => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
