import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, execFileSync, spawn } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import { existsSync } from "node:fs";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const publicPackages = [
  "packages/core",
  "packages/local-package",
  "apps/cli",
  "apps/npm-cli",
];
const publicNames = [
  "@smallpen/core",
  "@smallpen/local-package",
  "@smallpen/cli",
  "smallpen",
];
const registry = "https://registry.npmjs.org";
const json = async (path) => JSON.parse(await readFile(path, "utf8"));
const save = (path, value) =>
  writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
export function commandLine(command, args) {
  if (command !== "npm") return [command, args];
  const npm = [
    process.env.npm_execpath,
    join(dirname(process.execPath), "node_modules/npm/bin/npm-cli.js"),
    resolve(
      dirname(process.execPath),
      "../lib/node_modules/npm/bin/npm-cli.js",
    ),
  ].find((path) => path && existsSync(path));
  if (!npm)
    throw new Error(
      "Cannot locate npm-cli.js beside Node; install Node with npm",
    );
  return [process.execPath, [npm, ...args]];
}
const run = (command, args, cwd = root) => {
  const [executable, argv] = commandLine(command, args);
  return execFileSync(executable, argv, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
};

export function validateRelease(version, channel) {
  assert.ok(
    /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-(alpha|beta|rc)\.(0|[1-9]\d*))?$/.test(
      version,
    ),
    "Invalid release version",
  );
  assert.ok(
    ["alpha", "beta", "rc", "latest"].includes(channel),
    "Invalid release channel",
  );
  assert.equal(
    version.includes("-") ? version.split("-")[1].split(".")[0] : "latest",
    channel,
    "Version/channel mismatch",
  );
}

export function publicationAction(existing, integrity) {
  if (!existing) return "publish";
  assert.equal(
    existing.dist?.integrity,
    integrity,
    "Published version has different integrity; use a new version",
  );
  return "existing";
}

export async function readRelease(directory = root) {
  const pkg = await json(join(directory, "package.json"));
  const version = pkg.version;
  const channel = version?.includes("-")
    ? version.split("-")[1].split(".")[0]
    : "latest";
  validateRelease(version, channel);
  const lock = await json(join(directory, "package-lock.json"));
  assert.equal(lock.version, version, "Lock version mismatch");
  const paths = Object.keys(lock.packages).filter(
    (path) => !path || /^(apps|packages)\//.test(path),
  );
  const manifests = await Promise.all(
    paths.map((path) => json(join(directory, path, "package.json"))),
  );
  const names = new Set(manifests.map((entry) => entry.name));
  for (const [i, path] of paths.entries()) {
    const manifest = manifests[i];
    assert.equal(manifest.version, version, `${path}: version mismatch`);
    assert.equal(
      lock.packages[path].version,
      version,
      `${path}: lock version mismatch`,
    );
    assert.deepEqual(
      lock.packages[path].dependencies,
      manifest.dependencies,
      `${path}: lock dependencies mismatch`,
    );
    for (const [name, dependency] of Object.entries(
      manifest.dependencies ?? {},
    )) {
      if (names.has(name))
        assert.equal(dependency, version, `${path}: ${name} version mismatch`);
    }
  }
  return { version, channel };
}

// Only edits the disposable checkout used for this run. No source commit or tag.
async function prepare(version, channel) {
  validateRelease(version, channel);
  const lock = await json(join(root, "package-lock.json"));
  const paths = Object.keys(lock.packages).filter(
    (path) => !path || /^(apps|packages)\//.test(path),
  );
  const manifests = await Promise.all(
    paths.map((path) => json(join(root, path, "package.json"))),
  );
  const names = new Set(manifests.map((pkg) => pkg.name));
  for (let i = 0; i < paths.length; i++) {
    const pkg = manifests[i];
    pkg.version = version;
    for (const name of Object.keys(pkg.dependencies ?? {})) {
      if (names.has(name)) pkg.dependencies[name] = version;
    }
    if (publicNames.includes(pkg.name)) {
      pkg.repository = {
        type: "git",
        url: "git+https://github.com/SmallRaw/SmallPen.git",
        directory: `smallpen/${paths[i]}`,
      };
    }
    await save(join(root, paths[i], "package.json"), pkg);
    lock.packages[paths[i]].version = version;
    if (pkg.dependencies)
      lock.packages[paths[i]].dependencies = pkg.dependencies;
  }
  lock.version = version;
  await save(join(root, "package-lock.json"), lock);
}

async function pack(dir, version, channel, commit) {
  validateRelease(version, channel);
  assert.match(commit, /^[a-f0-9]{40}$/);
  await mkdir(dir, { recursive: true });
  const packages = [];
  for (const path of publicPackages) {
    const pkg = await json(join(root, path, "package.json"));
    assert.equal(pkg.version, version, "Run prepare before pack");
    const [result] = JSON.parse(
      run(
        "npm",
        ["pack", "--ignore-scripts", "--json", "--pack-destination", dir],
        join(root, path),
      ),
    );
    packages.push({
      name: pkg.name,
      version,
      filename: result.filename,
      integrity: result.integrity,
    });
  }
  await save(join(dir, "manifest.json"), {
    version,
    channel,
    commit,
    packages,
  });
  await verifyManifest(dir, commit);
}

export async function packWeb(
  dir,
  version,
  channel,
  commit,
  web = join(root, "dist/SmallPen-Web"),
) {
  const manifest = await verifyManifest(dir, commit);
  assert.equal(manifest.version, version, "Web release version mismatch");
  assert.equal(manifest.channel, channel, "Web release channel mismatch");
  const pkg = await json(join(web, "package.json"));
  assert.equal(pkg.name, "@smallpen/web");
  assert.equal(pkg.version, version, "Run build:web after prepare");
  assert.notEqual(pkg.private, true, "Pack the built Web distribution");
  const [result] = JSON.parse(
    run(
      "npm",
      ["pack", "--ignore-scripts", "--json", "--pack-destination", dir],
      web,
    ),
  );
  manifest.packages.push({
    name: pkg.name,
    version,
    filename: result.filename,
    integrity: result.integrity,
  });
  await save(join(dir, "manifest.json"), manifest);
  await verifyManifest(dir, commit, true);
}

export async function verifyManifest(dir, commit, includeWeb = false) {
  const manifest = await json(join(dir, "manifest.json"));
  assert.equal(manifest.commit, commit, "Artifact commit mismatch");
  validateRelease(manifest.version, manifest.channel);
  assert.deepEqual(
    manifest.packages.map((pkg) => pkg.name),
    includeWeb ? [...publicNames, "@smallpen/web"] : publicNames,
    "Unexpected release packages",
  );
  for (const pkg of manifest.packages) {
    assert.equal(pkg.version, manifest.version, "Package version mismatch");
    assert.equal(
      basename(pkg.filename),
      pkg.filename,
      "Invalid artifact filename",
    );
    assert.match(pkg.filename, /^[a-z0-9.-]+\.tgz$/);
    const hash = createHash("sha512")
      .update(await readFile(join(dir, pkg.filename)))
      .digest("base64");
    assert.equal(
      `sha512-${hash}`,
      pkg.integrity,
      "Artifact integrity mismatch",
    );
  }
  return manifest;
}

// Renders text and a WebP image with the installed CLI: the packed tree must
// carry the bundled fonts and the WebP decoder, not only the JavaScript.
export async function smokeRender(cli, temp) {
  const packagePath = join(temp, "render-smoke.smallpen");
  await cp(join(root, "test/fixtures/roundtrip.smallpen"), packagePath, {
    recursive: true,
  });
  const imported = JSON.parse(
    run(
      process.execPath,
      [
        cli,
        "asset",
        "media",
        "import",
        packagePath,
        "--file",
        join(root, "test/fixtures/quadrant-lossy.webp"),
        "--name",
        "Smoke",
        // The smoke edits stored JSON directly, so it needs the media id.
        "--full",
        "--json",
      ],
      temp,
    ),
  );
  const screenPath = join(packagePath, "screens/roundtrip.json");
  const screen = await json(screenPath);
  const nodes = screen.presentations[0].nodes;
  nodes.node_rectangle.fills = [
    { mediaRef: imported.descriptor.id, type: "image" },
  ];
  nodes.node_canvas.children.push("node_smoke_text");
  nodes.node_smoke_text = {
    children: [],
    fills: [{ color: "#111827", type: "solid" }],
    height: 40,
    id: "node_smoke_text",
    name: "Smoke text",
    text: "Smoke",
    textStyle: {
      fontFamily: "sourcesanspro",
      fontId: "sourcesanspro",
      fontSize: 32,
      fontStyle: "normal",
      fontWeight: 700,
      letterSpacing: 0,
      lineHeight: 1.2,
      textAlign: "left",
      verticalAlign: "top",
    },
    type: "TEXT",
    width: 200,
    x: 400,
    y: 96,
  };
  await save(screenPath, screen);
  const evidence = JSON.parse(
    run(
      process.execPath,
      [
        cli,
        "export",
        packagePath,
        "--format",
        "png",
        "--evidence",
        "--output",
        join(temp, "render-smoke"),
        "--json",
      ],
      temp,
    ),
  );
  assert.deepEqual(evidence.diagnostics, [], "Render smoke diagnostics");
  const png = await readFile(evidence.imagePath);
  assert.equal(
    png.subarray(1, 4).toString("latin1"),
    "PNG",
    "Render smoke did not write a PNG",
  );
}

async function smoke(dir, commit) {
  const manifest = await verifyManifest(dir, commit);
  const temp = await mkdtemp(join(tmpdir(), "smallpen-npm-smoke-"));
  let server;
  try {
    // A loopback registry tests installing ONLY the public entry, even before
    // its dependencies exist on npm. It serves only this run's tarballs and
    // the exact locked external artifacts; install cannot silently fall back.
    const lock = await json(join(root, "package-lock.json"));
    const entries = new Map();
    const tarballs = new Map();
    for (let i = 0; i < publicPackages.length; i++) {
      const pkg = await json(join(root, publicPackages[i], "package.json"));
      const artifact = manifest.packages[i];
      entries.set(pkg.name, {
        ...pkg,
        dist: {
          integrity: artifact.integrity,
          tarball: `/tarballs/${artifact.filename}`,
        },
      });
      tarballs.set(
        `/tarballs/${artifact.filename}`,
        await readFile(join(dir, artifact.filename)),
      );
    }
    for (const [path, pkg] of Object.entries(lock.packages)) {
      if (!path.startsWith("node_modules/") || pkg.link) continue;
      const name = path.slice("node_modules/".length);
      const [packed] = JSON.parse(
        run(
          "npm",
          [
            "pack",
            `${name}@${pkg.version}`,
            "--registry",
            registry,
            "--ignore-scripts",
            "--json",
            "--pack-destination",
            temp,
          ],
          temp,
        ),
      );
      assert.equal(
        packed.integrity,
        pkg.integrity,
        `External integrity mismatch: ${name}`,
      );
      entries.set(name, {
        name,
        version: pkg.version,
        dependencies: pkg.dependencies,
        bin: pkg.bin,
        dist: {
          integrity: pkg.integrity,
          tarball: `/tarballs/${packed.filename}`,
        },
      });
      tarballs.set(
        `/tarballs/${packed.filename}`,
        await readFile(join(temp, packed.filename)),
      );
    }
    let address;
    server = createServer((request, response) => {
      const path = decodeURIComponent(new URL(request.url, address).pathname);
      if (tarballs.has(path)) return response.end(tarballs.get(path));
      const pkg = entries.get(path.slice(1));
      if (!pkg) {
        response.writeHead(404);
        return response.end();
      }
      const version = {
        ...pkg,
        dist: { ...pkg.dist, tarball: `${address}${pkg.dist.tarball}` },
      };
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          name: pkg.name,
          "dist-tags": { latest: pkg.version, [manifest.channel]: pkg.version },
          versions: { [pkg.version]: version },
        }),
      );
    });
    await new Promise((resolveListen, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolveListen);
    });
    address = `http://127.0.0.1:${server.address().port}`;
    const [npmExecutable, npmArgs] = commandLine("npm", [
      "install",
      "--global",
      "--prefix",
      temp,
      "--cache",
      join(temp, "cache"),
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--registry",
      address,
      `smallpen@${manifest.version}`,
    ]);
    await promisify(execFile)(npmExecutable, npmArgs, {
      cwd: temp,
      timeout: 120_000,
    });
    const windows = process.platform === "win32";
    const cli = join(
      temp,
      windows ? "node_modules" : "lib/node_modules",
      "smallpen/bin/smallpen.cjs",
    );
    if (windows)
      assert.match(
        await readFile(join(temp, "smallpen.cmd"), "utf8"),
        /node_modules[\\/]smallpen[\\/]bin[\\/]smallpen.cjs/,
      );
    else
      assert.equal(
        await realpath(join(temp, "bin/smallpen")),
        await realpath(cli),
      );
    await save(join(temp, "package.json"), {
      private: true,
      scripts: {
        verify: windows ? ".\\smallpen.cmd --help" : "./bin/smallpen --help",
      },
    });
    run("npm", ["run", "verify"], temp);
    const validated = JSON.parse(
      run(
        process.execPath,
        [
          cli,
          "validate",
          join(root, "test/fixtures/roundtrip.smallpen"),
          "--json",
        ],
        temp,
      ),
    );
    assert.equal(validated.status, "valid");
    await smokeRender(cli, temp);
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
    await rm(temp, { recursive: true, force: true });
  }
}

export async function smokeWeb(dir, commit) {
  const manifest = await verifyManifest(dir, commit, true);
  const temp = await mkdtemp(join(tmpdir(), "smallpen-web-smoke-"));
  let child;
  let stopped;
  try {
    const pkg = manifest.packages.find(
      (entry) => entry.name === "@smallpen/web",
    );
    run(
      "npm",
      [
        "install",
        "--offline",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--cache",
        join(temp, "cache"),
        join(dir, pkg.filename),
      ],
      temp,
    );
    child = spawn(
      process.execPath,
      [
        join(temp, "node_modules/@smallpen/web/bin/smallpen-web.cjs"),
        "--no-open",
        "--json",
      ],
      {
        cwd: temp,
        env: {
          ...process.env,
          SMALLPEN_APPLICATION_STATE_PATH: join(temp, "state.json"),
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    stopped = new Promise((resolve) => child.once("close", resolve));
    let stderr = "";
    child.stderr.on("data", (data) => {
      stderr += data;
    });
    const ready = await new Promise((resolve, reject) => {
      let output = "";
      const timer = setTimeout(
        () => reject(new Error(`Web startup timed out: ${stderr}`)),
        30000,
      );
      child.stdout.on("data", (data) => {
        output += data;
        for (const line of output.split("\n")) {
          if (line.startsWith('{"status":"ready"')) {
            clearTimeout(timer);
            resolve(JSON.parse(line));
          }
        }
      });
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        reject(new Error(`Web exited ${code}: ${stderr}`));
      });
    });
    const html = await fetch(ready.url).then((response) => response.text());
    assert.match(html, /smallpenLocalFilesReady/);
    assert.equal(
      (await fetch(new URL("/js/main-workspace.js", ready.url))).status,
      200,
    );
    assert.equal(
      (
        await fetch(new URL("/local/directories", ready.url), {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: "{}",
        })
      ).status,
      200,
    );
  } finally {
    if (child?.exitCode === null) child.kill("SIGTERM");
    if (stopped) await stopped;
    await rm(temp, { recursive: true, force: true });
  }
}

async function published(name, version) {
  const response = await fetch(
    `${registry}/${encodeURIComponent(name)}/${version}`,
    { signal: AbortSignal.timeout(30_000) },
  );
  if (response.status === 404) return undefined;
  assert.ok(response.ok, `Registry lookup failed: ${response.status}`);
  return response.json();
}

async function publish(dir, commit) {
  assert.equal(
    process.env.GITHUB_ACTIONS,
    "true",
    "Publish only from the approved GitHub workflow",
  );
  const manifest = await verifyManifest(dir, commit, true);
  const [major, minor, patch] = run("npm", ["--version"])
    .trim()
    .split(".")
    .map(Number);
  assert.ok(
    major > 11 || (major === 11 && (minor > 5 || (minor === 5 && patch >= 1))),
    "Trusted publishing requires npm >=11.5.1",
  );
  // Preflight every package before any writes; never hide a conflicting version.
  const actions = await Promise.all(
    manifest.packages.map(async (pkg) =>
      publicationAction(await published(pkg.name, pkg.version), pkg.integrity),
    ),
  );
  for (let i = 0; i < manifest.packages.length; i++) {
    const pkg = manifest.packages[i];
    if (actions[i] === "publish") {
      run("npm", [
        "publish",
        join(dir, pkg.filename),
        "--ignore-scripts",
        "--access",
        "public",
        "--provenance",
        "--tag",
        manifest.channel,
        "--registry",
        registry,
      ]);
    }
    console.log(`${pkg.name}@${pkg.version}: ${actions[i]}`);
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "info") {
    const { version, channel } = await readRelease();
    console.log(`version=${version}\nchannel=${channel}`);
    return;
  }
  if (command === "prepare") return prepare(...args);
  if (command === "pack") return pack(resolve(args[0]), ...args.slice(1));
  if (command === "pack-web")
    return packWeb(resolve(args[0]), ...args.slice(1));
  if (command === "verify") return verifyManifest(resolve(args[0]), args[1]);
  if (command === "smoke") return smoke(resolve(args[0]), args[1]);
  if (command === "smoke-web") return smokeWeb(resolve(args[0]), args[1]);
  if (command === "publish") return publish(resolve(args[0]), args[1]);
  throw new Error(
    "Expected info, prepare, pack, pack-web, verify, smoke, smoke-web or publish",
  );
}

if (
  process.argv[1] &&
  (await realpath(process.argv[1])) === fileURLToPath(import.meta.url)
) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
