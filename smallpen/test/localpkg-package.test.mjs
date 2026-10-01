import assert from "node:assert/strict";
import {
  cp,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  truncate,
  utimes,
  writeFile,
} from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import {
  applyOperationBatch,
  importFontVariant,
  importMedia,
  openPackage,
  removeMedia,
  updateFontFamily,
} from "@smallpen/local-package";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = join(here, "fixtures", "roundtrip.smallpen");
const pixel = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
  "base64",
);

async function copyFixture(context) {
  const parent = await mkdtemp(join(tmpdir(), "smallpen-localpkg-"));
  context.after(() => rm(parent, { force: true, recursive: true }));
  const requested = join(parent, "roundtrip.smallpen");
  await cp(fixture, requested, { recursive: true });
  return (await openPackage(requested)).locator;
}

function opacityBatch(revision, opacity, batchId) {
  return {
    baseRevision: revision,
    batchId,
    operations: [
      {
        changes: { opacity },
        nodeId: "node_rectangle",
        presentationId: "pres_desktop",
        screenId: "scr_roundtrip",
        type: "update-presentation-node",
      },
    ],
  };
}

const mediaInput = {
  bytes: pixel,
  height: 1,
  id: "media_aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa",
  mimeType: "image/png",
  name: "Pixel",
  width: 1,
};

test("Media import, removal, and re-import each write a new revision (H1)", async (context) => {
  const packagePath = await copyFixture(context);
  const first = await importMedia(packagePath, mediaInput);
  const removed = await removeMedia(packagePath, mediaInput.id);
  const again = await importMedia(packagePath, mediaInput);

  assert.equal(first.result.alreadyApplied, undefined);
  assert.equal(again.result.alreadyApplied, undefined);
  assert.notEqual(first.result.batchId, again.result.batchId);
  assert.notEqual(again.result.revision, removed.revision);
  const reopened = await openPackage(packagePath);
  assert.equal(reopened.revision, again.result.revision);
  assert.deepEqual(
    reopened.entries["assets/assets.json"].media.map(({ id }) => id),
    [mediaInput.id],
  );
});

test("a Font family renamed A to B and back to A writes every step (H1)", async (context) => {
  const packagePath = await copyFixture(context);
  await importFontVariant(packagePath, {
    family: "Alpha",
    files: { woff: { bytes: new Uint8Array([119, 79, 70, 70]), mimeType: "font/woff" } },
    fontId: "font_aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa",
    id: "fvar_bbbbbbbbbbbb4bbb8bbbbbbbbbbbbbbb",
    name: "Alpha Regular",
    style: "normal",
    weight: 400,
  });
  const fontId = "font_aaaaaaaaaaaa4aaa8aaaaaaaaaaaaaaa";
  const toB = await updateFontFamily(packagePath, fontId, "Beta");
  const backToA = await updateFontFamily(packagePath, fontId, "Alpha");

  assert.equal(toB.alreadyApplied, undefined);
  assert.equal(backToA.alreadyApplied, undefined);
  assert.notEqual(backToA.revision, toB.revision);
  const reopened = await openPackage(packagePath);
  assert.equal(reopened.revision, backToA.revision);
  assert.equal(reopened.entries["assets/assets.json"].fonts[0].family, "Alpha");
});

test("the batch ledger keys identities by base revision and operations (H1)", async (context) => {
  const packagePath = await copyFixture(context);
  const base = (await openPackage(packagePath)).revision;
  const batch = opacityBatch(base, 0.4, "batch_ledger_identity");
  const first = await applyOperationBatch(packagePath, batch);

  const replay = await applyOperationBatch(packagePath, batch);
  assert.equal(replay.alreadyApplied, true);
  assert.equal(replay.revision, first.revision);

  // Same ID and operations prepared against another revision is a new
  // intent, never a silent replay.
  await assert.rejects(
    applyOperationBatch(packagePath, { ...batch, baseRevision: first.revision }),
    (error) => error?.code === "batch_id_conflict",
  );
  assert.equal((await openPackage(packagePath)).revision, first.revision);
});

test("an unreadable batch ledger does not block writes and the ledger stays bounded", async (context) => {
  const packagePath = await copyFixture(context);
  const ledgerPath = `${packagePath}.batches.json`;
  await writeFile(ledgerPath, "{ not json");
  const warnings = [];
  const onWarning = (warning) => warnings.push(warning.code);
  process.on("warning", onWarning);
  context.after(() => process.off("warning", onWarning));

  const base = (await openPackage(packagePath)).revision;
  const written = await applyOperationBatch(
    packagePath,
    opacityBatch(base, 0.3, "batch_after_corrupt_ledger"),
  );
  assert.notEqual(written.revision, base);
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(warnings.includes("SMALLPEN_BATCH_LEDGER_UNREADABLE"));

  const stale = {};
  for (let index = 0; index < 600; index += 1) {
    stale[`batch_old_${index}`] = {
      committedAt: new Date(Date.UTC(2000, 0, 1, 0, 0, index)).toISOString(),
      identityHash: "0".repeat(64),
      result: {},
      revision: "old",
    };
  }
  await writeFile(ledgerPath, JSON.stringify(stale));
  await applyOperationBatch(
    packagePath,
    opacityBatch(written.revision, 0.35, "batch_newest"),
  );
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  assert.equal(Object.keys(ledger).length, 500);
  assert.ok(ledger.batch_newest);
  assert.equal(ledger.batch_old_0, undefined);
});

test("an oversized batch ledger is skipped without being buffered", async (context) => {
  const packagePath = await copyFixture(context);
  const ledgerPath = `${packagePath}.batches.json`;
  // A sparse 1 GiB file: reading it whole would allocate the full gigabyte.
  await writeFile(ledgerPath, "");
  await truncate(ledgerPath, 1024 * 1024 * 1024);
  const warnings = [];
  const onWarning = (warning) => warnings.push(warning);
  process.on("warning", onWarning);
  context.after(() => process.off("warning", onWarning));

  const base = (await openPackage(packagePath)).revision;
  const before = process.memoryUsage().arrayBuffers;
  const written = await applyOperationBatch(
    packagePath,
    opacityBatch(base, 0.4, "batch_after_oversized_ledger"),
  );
  assert.ok(process.memoryUsage().arrayBuffers - before < 256 * 1024 * 1024);
  assert.notEqual(written.revision, base);
  await new Promise((resolve) => setImmediate(resolve));
  const warning = warnings.find(({ code }) => code === "SMALLPEN_BATCH_LEDGER_UNREADABLE");
  assert.match(warning?.message ?? "", /exceeds/);
  // The next recorded commit replaced the ledger with a bounded one.
  const ledger = JSON.parse(await readFile(ledgerPath, "utf8"));
  assert.ok(ledger.batch_after_oversized_ledger);
});

test("commits never write through to the inodes of the previous Package (M1)", async (context) => {
  const packagePath = await copyFixture(context);
  const screenPath = join(packagePath, "screens/roundtrip.json");
  const original = await readFile(screenPath, "utf8");
  // A reader holding the pre-commit inode must keep seeing the old bytes.
  const held = join(dirname(packagePath), "held-screen.json");
  await link(screenPath, held);

  const base = (await openPackage(packagePath)).revision;
  const result = await applyOperationBatch(
    packagePath,
    opacityBatch(base, 0.25, "batch_hard_link_safety"),
  );

  assert.ok(result.changedFiles.includes("screens/roundtrip.json"));
  assert.equal(await readFile(held, "utf8"), original);
  assert.notEqual(await readFile(screenPath, "utf8"), original);
  const reopened = await openPackage(packagePath);
  assert.equal(reopened.revision, result.revision);
  assert.deepEqual(
    reopened.entries["tokens/tokens.json"],
    JSON.parse(await readFile(join(fixture, "tokens/tokens.json"), "utf8")),
  );
});

test("a live PID claim without a verifiable identity expires once it stops refreshing (M2)", async (context) => {
  const packagePath = await copyFixture(context);
  const before = await openPackage(packagePath);
  const lockPath = join(
    dirname(packagePath),
    `.${basename(packagePath)}.write-lock`,
  );
  await mkdir(lockPath, { recursive: true });
  const claimPath = join(lockPath, "owner.json");
  // process.pid is alive, so only the claim age can prove it abandoned (the
  // Windows PID-reuse case, where no process identity is available).
  await writeFile(
    claimPath,
    JSON.stringify({ createdAt: new Date().toISOString(), pid: process.pid }),
  );
  const past = new Date(Date.now() - 60000);
  await utimes(claimPath, past, past);

  const started = Date.now();
  const result = await applyOperationBatch(
    packagePath,
    opacityBatch(before.revision, 0.65, "batch_unverified_claim"),
  );
  assert.notEqual(result.revision, before.revision);
  assert.ok(Date.now() - started < 10000);
});

test("a commit never writes through a symlinked directory in the Package", async (context) => {
  const packagePath = await copyFixture(context);
  const outside = join(dirname(packagePath), "outside");
  await mkdir(outside);
  await writeFile(join(outside, "more.json"), "keep\n");
  await symlink(outside, join(packagePath, "themes"));
  const opened = await openPackage(packagePath);

  await assert.rejects(
    applyOperationBatch(packagePath, {
      baseRevision: opened.revision,
      batchId: "symlinked_directory",
      operations: [
        {
          definition: {
            $extensions: { smallpen: { id: "tok_ink" } },
            $type: "color",
            $value: "#000000",
          },
          filePath: "themes/more.json",
          path: "ink.base",
          tokenId: "tok_ink",
          type: "put-token",
        },
      ],
    }),
    (error) => error?.code === "invalid_entry_path",
  );
  assert.equal(await readFile(join(outside, "more.json"), "utf8"), "keep\n");
  assert.equal((await openPackage(packagePath)).revision, opened.revision);
});

test("a symlinked write lock never removes files in the folder it points at", async (context) => {
  const packagePath = await copyFixture(context);
  const outside = join(dirname(packagePath), "outside");
  await mkdir(outside);
  await writeFile(join(outside, "owner.json"), "not a claim");
  await writeFile(join(outside, "active"), "not a claim");
  const lockPath = join(dirname(packagePath), `.${basename(packagePath)}.write-lock`);
  await rm(lockPath, { force: true, recursive: true });
  await symlink(outside, lockPath);
  await utimes(join(outside, "owner.json"), new Date(0), new Date(0));

  await assert.rejects(
    openPackage(packagePath),
    (error) => error?.code === "invalid_write_lock",
  );
  assert.deepEqual((await readdir(outside)).sort(), ["active", "owner.json"]);
});

test("a FIFO in a Package fails the read instead of blocking it", { skip: process.platform === "win32" }, async (context) => {
  const packagePath = await copyFixture(context);
  const entry = join(packagePath, "screens/roundtrip.json");
  await rm(entry);
  execFileSync("mkfifo", [entry]);
  const ledger = `${packagePath}.batches.json`;
  execFileSync("mkfifo", [ledger]);
  await assert.rejects(
    openPackage(packagePath),
    (error) => error?.code === "invalid_entry_json",
  );
  await rm(ledger);
  const lockPath = join(dirname(packagePath), `.${basename(packagePath)}.write-lock`);
  execFileSync("mkfifo", [join(lockPath, "owner.json")]);
  await assert.rejects(
    openPackage(packagePath),
    (error) => error?.code === "invalid_entry_json",
  );
});
