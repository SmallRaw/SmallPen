import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { promisify } from "node:util";
import {
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
const run = (command, args, cwd = root) =>
  execFileSync(command, args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });

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
  const plist = join(root, "apps/desktop/native/macos/Info.plist");
  const content = await readFile(plist, "utf8");
  await writeFile(
    plist,
    content.replace(
      /(<key>CFBundleShortVersionString<\/key>\s*<string>)[^<]+/,
      `$1${version.split("-")[0]}`,
    ),
  );
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

export async function verifyManifest(dir, commit) {
  const manifest = await json(join(dir, "manifest.json"));
  assert.equal(manifest.commit, commit, "Artifact commit mismatch");
  validateRelease(manifest.version, manifest.channel);
  assert.deepEqual(
    manifest.packages.map((pkg) => pkg.name),
    publicNames,
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
    await promisify(execFile)(
      "npm",
      [
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
      ],
      { cwd: temp, timeout: 120_000 },
    );
    const cli = join(temp, "bin", "smallpen");
    assert.ok(
      (await realpath(cli)).endsWith("/smallpen/bin/smallpen.cjs"),
      "The short package must own the smallpen command",
    );
    run(cli, ["--help"], temp);
    assert.equal(run(cli, ["version"], temp).trim(), manifest.version);
    const validated = JSON.parse(
      run(
        cli,
        ["validate", join(root, "test/fixtures/roundtrip.smallpen"), "--json"],
        temp,
      ),
    );
    assert.equal(validated.status, "valid");
  } finally {
    if (server) {
      server.closeAllConnections();
      await new Promise((done) => server.close(done));
    }
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
  const manifest = await verifyManifest(dir, commit);
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
    assert.equal(
      publicationAction(await published(pkg.name, pkg.version), pkg.integrity),
      "existing",
      "Published package is not visible; retry this job",
    );
    const response = await fetch(
      `${registry}/-/package/${encodeURIComponent(pkg.name)}/dist-tags`,
      { signal: AbortSignal.timeout(30_000) },
    );
    assert.ok(response.ok, `Cannot verify dist-tag for ${pkg.name}`);
    const tags = await response.json();
    assert.equal(
      tags[manifest.channel],
      manifest.version,
      `Dist-tag differs for ${pkg.name}; refusing to move a possibly newer release`,
    );
    console.log(`${pkg.name}@${pkg.version}: ${actions[i]}`);
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (command === "prepare") return prepare(...args);
  if (command === "pack") return pack(resolve(args[0]), ...args.slice(1));
  if (command === "verify") return verifyManifest(resolve(args[0]), args[1]);
  if (command === "smoke") return smoke(resolve(args[0]), args[1]);
  if (command === "publish") return publish(resolve(args[0]), args[1]);
  throw new Error("Expected prepare, pack, verify, smoke or publish");
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
