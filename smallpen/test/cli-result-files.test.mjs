import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { openPackage } from "@smallpen/local-package";

const cli = fileURLToPath(
  new URL("../apps/cli/bin/smallpen.mjs", import.meta.url),
);
const fixture = new URL("./fixtures/roundtrip.smallpen", import.meta.url);
const page = ["--page", "Round Trip"];
// The PNG export that every scratch-file test drives.
const png = (path) => ["export", path, ...page, "--format", "png", "--json"];
async function run(argv, cwd, env) {
  const reply = await promisify(execFile)(process.execPath, [cli, ...argv], {
    cwd,
    env: env && { ...process.env, ...env },
  });
  return { ...reply, value: JSON.parse(reply.stdout) };
}

test("large full results use unique searchable files in one folder; stdout is explicit", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-result-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packagePath = join(root, "app.smallpen");
  await cp(fixture, packagePath, { recursive: true });
  const screenPath = join(packagePath, "screens/roundtrip.json");
  const screen = JSON.parse(await readFile(screenPath, "utf8"));
  const argv = ["view", packagePath, ...page, "--full", "--json"];
  let previous;
  for (const marker of ["First\n", "Second\n"]) {
    screen.presentations[0].nodes.node_rectangle.name = marker.repeat(8000);
    await writeFile(screenPath, JSON.stringify(screen));
    const reply = await run(argv, root);
    assert.ok(Buffer.byteLength(reply.stdout) <= 8192);
    assert.equal(reply.stdout, JSON.stringify(reply.value) + "\n");
    const file = reply.value.resultFile;
    assert.equal(file.format, "json");
    const bytes = await readFile(file.path);
    assert.equal(file.sha256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(file.bytes, bytes.length);
    assert.ok(JSON.parse(bytes).text.includes(marker.repeat(8000)));
    if (previous) {
      assert.notEqual(file.path, previous.path);
      assert.equal(join(file.path, ".."), join(previous.path, ".."));
      assert.ok(await readFile(previous.path));
      assert.notEqual(file.sha256, previous.sha256);
    }
    previous = file;
    const inline = await run([...argv, "--stdout"], root);
    assert.ok(inline.value.text.includes(marker.repeat(8000)));
    assert.equal(inline.value.resultFile, undefined);
  }
});

test("cleanup stays inside managed scratch files and honors the native temporary folder", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-tmp-policy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nativeTemp = join(root, "system-tmp");
  await mkdir(nativeTemp);
  const env = { TMPDIR: nativeTemp, TEMP: nativeTemp, TMP: nativeTemp };
  const argv = png(fileURLToPath(fixture));
  const first = (await run(argv, root, env)).value;
  assert.ok(first.output.startsWith(nativeTemp));
  const folder = join(first.output, "..");
  const unrelated = join(folder, "user-notes.txt");
  const retained = join(root, "deliverable.png");
  await writeFile(unrelated, "keep me");
  await run([...argv, "--output", retained], root, env);
  const retainedBytes = await readFile(retained);
  await run(argv, root, env);
  assert.equal(await readFile(unrelated, "utf8"), "keep me");
  assert.deepEqual(await readFile(retained), retainedBytes);
  assert.ok((await readdir(folder)).includes("user-notes.txt"));
});

test("temporary directory failures report committed writes instead of authorizing retries", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-tmp-write-failure-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packagePath = join(root, "app.smallpen");
  await cp(fixture, packagePath, { recursive: true });
  const before = await openPackage(packagePath);
  const input = join(root, "batch.json");
  await writeFile(
    input,
    JSON.stringify({
      batchId: "write-before-result-failure",
      baseRevision: before.revision,
      operations: [
        {
          type: "update-node",
          screenId: "scr_roundtrip",
          nodeId: "node_rectangle",
          changes: { name: "Large name ".repeat(8000) },
        },
      ],
    }),
  );
  const missingTemp = join(root, "nonexistent-system-tmp");
  const env = {
    ...process.env,
    TMPDIR: missingTemp,
    TEMP: missingTemp,
    TMP: missingTemp,
  };
  await assert.rejects(
    promisify(execFile)(
      process.execPath,
      [cli, "advanced", "apply", packagePath, "--batch", input, "--full", "--json"],
      { cwd: root, env },
    ),
    (error) => {
      const reply = JSON.parse(error.stdout);
      assert.equal(reply.error.code, "artifact_directory_unavailable");
      assert.equal(reply.error.writeState, "committed");
      return true;
    },
  );
  const after = await openPackage(packagePath);
  assert.notEqual(after.revision, before.revision);
  assert.equal(
    after.entries["screens/roundtrip.json"].presentations[0].nodes
      .node_rectangle.name,
    "Large name ".repeat(8000),
  );
});

test(
  "temporary output rejects a symlinked CLI directory without touching its target",
  { skip: process.platform === "win32" },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "smallpen-tmp-symlink-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    const outside = join(root, "outside");
    const nativeTemp = join(root, "system-tmp");
    await mkdir(outside);
    await mkdir(nativeTemp);
    await writeFile(join(outside, "render.png"), "keep target");
    await symlink(
      outside,
      join(nativeTemp, `smallpen-cli-${process.getuid()}`),
    );
    const env = {
      ...process.env,
      TMPDIR: nativeTemp,
      TEMP: nativeTemp,
      TMP: nativeTemp,
    };
    await assert.rejects(
      promisify(execFile)(
        process.execPath,
        [cli, ...png(fileURLToPath(fixture))],
        { cwd: root, env },
      ),
      (error) =>
        JSON.parse(error.stdout).error.code === "invalid_artifact_directory",
    );
    assert.equal(
      await readFile(join(outside, "render.png"), "utf8"),
      "keep target",
    );
  },
);

test("large layout text is searchable as exact LF text and large help stays outside stdout", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-text-files-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packagePath = join(root, "app.smallpen");
  await cp(fixture, packagePath, { recursive: true });
  const screenPath = join(packagePath, "screens/roundtrip.json");
  const screen = JSON.parse(await readFile(screenPath, "utf8"));
  screen.presentations[0].nodes.node_rectangle.name =
    "Large layout name ".repeat(8000);
  await writeFile(screenPath, JSON.stringify(screen));
  const reply = (
    await run(
      ["view", packagePath, ...page, "--as", "wireframe", "--full", "--json"],
      root,
    )
  ).value;
  const complete = JSON.parse(await readFile(reply.resultFile.path, "utf8"));
  const text = await readFile(reply.resultFile.text.path, "utf8");
  assert.equal(text, complete.wireframe);
  assert.ok(text.includes("Large layout name ".repeat(8000)));
  assert.ok(text.includes("\n"));
  assert.equal(text.includes("\r"), false);
  const help = await promisify(execFile)(
    process.execPath,
    [cli, "advanced", "apply", "--help", "--full"],
    { cwd: root },
  );
  assert.ok(Buffer.byteLength(help.stdout) <= 8192);
  // The complete manual is larger than 8 KiB, so stdout names its file.
  assert.match(help.stdout, /^Complete text: /, help.stdout);
  const helpPath = help.stdout.split("\n")[0].replace("Complete text: ", "");
  assert.match(
    await readFile(helpPath, "utf8"),
    /Common output and error contract/,
  );
});

test("PNG exports use random names in one folder and survive subsequent calls", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-png-files-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const images = [];
  for (const scale of ["1", "0.5", "1"]) {
    const image = (
      await run([...png(fileURLToPath(fixture)), "--scale", scale], root)
    ).value;
    assert.match(image.output, /smallpen-\d{13}-[a-f0-9-]{36}-render\.png$/);
    assert.equal(image.imageBase64, undefined);
    images.push(image);
  }
  assert.equal(new Set(images.map(({ output }) => output)).size, 3);
  assert.equal(new Set(images.map(({ output }) => join(output, ".."))).size, 1);
  assert.equal(images[0].renderHash, images[2].renderHash);
  assert.notEqual(images[0].width, images[1].width);
  for (const image of images) {
    const bytes = await readFile(image.output);
    assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
    assert.equal(
      createHash("sha256").update(bytes).digest("hex"),
      image.renderHash,
    );
  }
});

test("ordinary CLI exposes no Code Mode command", async () => {
  const reply = await run(["help", "--json"]);
  assert.ok(reply.value.commands.some(({ command }) => command === "project"));
  assert.equal(
    reply.value.commands.some(({ command }) => command === "code"),
    false,
  );
  await assert.rejects(
    promisify(execFile)(process.execPath, [cli, "code", "--json"]),
    (error) => JSON.parse(error.stdout).error.code === "unknown_command",
  );
});

test("caller-owned exports cannot use the CLI scratch tree, including path aliases", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-reserved-export-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const argv = png(fileURLToPath(fixture));
  const first = (await run(argv, root)).value;
  const before = await readFile(first.output);
  for (const path of [first.output, await realpath(first.output)]) {
    await assert.rejects(
      promisify(execFile)(process.execPath, [cli, ...argv, "--output", path], {
        cwd: root,
      }),
      (error) => JSON.parse(error.stdout).error.code === "reserved_output_path",
    );
    assert.deepEqual(await readFile(first.output), before);
  }
});

test("large render diagnostics remain visible as counts and partial coverage", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-render-summary-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const packagePath = join(root, "app.smallpen");
  await cp(fixture, packagePath, { recursive: true });
  const screenPath = join(packagePath, "screens/roundtrip.json");
  const screen = JSON.parse(await readFile(screenPath, "utf8"));
  const presentation = screen.presentations[0];
  const ids = Array.from({ length: 60 }, (_, index) => `node_grid_${index}`);
  presentation.nodes[presentation.rootId].children.push(...ids);
  for (const [index, id] of ids.entries())
    presentation.nodes[id] = {
      id,
      name: `Grid ${index}`,
      type: "FRAME",
      layout: "grid",
      children: [],
      x: 0,
      y: 0,
      width: 20,
      height: 20,
    };
  await writeFile(screenPath, JSON.stringify(screen));
  const reply = (await run(png(packagePath), root)).value;
  // Sixty sizes the preview cannot compute read as one counted note.
  const limits = reply.diagnostics.find(({ code }) => code === "layout_projection_partial");
  assert.ok(limits.count >= 60, JSON.stringify(reply.diagnostics));
  assert.equal(reply.resultFile, undefined, "the counted note keeps the reply small");
  const replacements = new Map(
    ids.map((id) => [id, `${id}_${"x".repeat(1000)}`]),
  );
  for (const [oldId, id] of replacements) {
    presentation.nodes[id] = { ...presentation.nodes[oldId], id };
    delete presentation.nodes[oldId];
  }
  presentation.nodes[presentation.rootId].children = presentation.nodes[
    presentation.rootId
  ].children.map((id) => replacements.get(id) ?? id);
  await writeFile(screenPath, JSON.stringify(screen));
  const validated = (await run(["validate", packagePath, "--json"], root))
    .value;
  // Checking the whole package keeps its reply small: sizes the preview
  // cannot compute are one note, skipped checks are counted by kind.
  assert.match(validated.previewNote, /in \d+ places/);
  assert.ok(validated.outputBytes < 8128, `${validated.outputBytes} bytes`);
  assert.equal(validated.coverage.skippedCount, validated.coverage.skipped.reduce((sum, { count }) => sum + count, 0));
  assert.ok(validated.coverage.skipped.every(({ count }) => count > 0));
});

test("old CLI files are removed after 30 minutes; fresh, active and unrelated files remain", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-ttl-artifacts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nativeTemp = join(root, "system-tmp");
  await mkdir(nativeTemp);
  const env = { TMPDIR: nativeTemp, TEMP: nativeTemp, TMP: nativeTemp };
  const argv = png(fileURLToPath(fixture));
  const first = (await run(argv, root, env)).value;
  const directory = join(first.output, "..");
  const prefix = first.output.slice(0, -"-render.png".length);
  const marker = `${prefix}-owner-${process.pid}.json`;
  const oldTime = new Date(Date.now() - 31 * 60 * 1000);
  await utimes(first.output, oldTime, oldTime);
  await writeFile(marker, "");
  await utimes(marker, oldTime, oldTime);
  const unrelated = join(directory, "notes.txt");
  await writeFile(unrelated, "keep me");
  await utimes(unrelated, oldTime, oldTime);
  const retained = join(root, "retained.png");
  await run([...argv, "--output", retained], root, env);
  await utimes(retained, oldTime, oldTime);
  const second = (await run(argv, root, env)).value;
  assert.ok(await readFile(first.output));
  await rm(marker);
  await run(["help", "--json"], root, env);
  await assert.rejects(readFile(first.output), { code: "ENOENT" });
  assert.ok(await readFile(second.output));
  assert.ok(await readFile(retained));
  assert.equal(await readFile(unrelated, "utf8"), "keep me");
});

test("concurrent exports all succeed with separate matching PNGs in the same folder", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "smallpen-concurrent-artifacts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const nativeTemp = join(root, "system-tmp");
  await mkdir(nativeTemp);
  const env = { TMPDIR: nativeTemp, TEMP: nativeTemp, TMP: nativeTemp };
  const scales = [1, 0.5, 1, 0.5, 1, 0.5];
  const images = (
    await Promise.all(
      scales.map((scale) =>
        run(
          [...png(fileURLToPath(fixture)), "--scale", String(scale)],
          root,
          env,
        ),
      ),
    )
  ).map(({ value }) => value);
  assert.equal(new Set(images.map(({ output }) => output)).size, 6);
  assert.equal(new Set(images.map(({ output }) => join(output, ".."))).size, 1);
  assert.notEqual(images[0].width, images[1].width);
  for (const image of images)
    assert.equal(
      createHash("sha256")
        .update(await readFile(image.output))
        .digest("hex"),
      image.renderHash,
    );
  assert.equal(
    (await readdir(join(images[0].output, ".."))).some((name) =>
      /-owner-\d+\.json$/.test(name),
    ),
    false,
  );
});
