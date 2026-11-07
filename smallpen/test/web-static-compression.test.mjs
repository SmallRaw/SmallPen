import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { get as httpGet } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { brotliDecompressSync, gunzipSync } from "node:zlib";

import { serveLocalPackage } from "@smallpen/background";
import { servePenpotFrontend } from "@smallpen/web";

function raw(base, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = httpGet(new URL(path, base), { headers }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () =>
        resolve({ body: Buffer.concat(chunks), headers: response.headers }),
      );
    });
    request.once("error", reject);
  });
}

test("the Web host sends its bundles compressed when the browser accepts it", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "smallpen-web-compression-"));
  const background = await serveLocalPackage({ port: 0 });
  context.after(async () => {
    await background.close();
    await rm(parent, { force: true, recursive: true });
  });
  const frontendRoot = join(parent, "penpot-frontend");
  await mkdir(join(frontendRoot, "js"), { recursive: true });
  await writeFile(join(frontendRoot, "index.html"), "<!doctype html><p>Penpot");
  const script = `var bundle = ${JSON.stringify("penpot ".repeat(20000))};\n`;
  await writeFile(join(frontendRoot, "js", "main.js"), script);
  await writeFile(join(frontendRoot, "logo.png"), Buffer.alloc(4096, 1));
  const web = await servePenpotFrontend({
    backendUrl: background.url,
    frontendRoot,
    port: 0,
  });
  context.after(() => web.close());

  const plain = await raw(web.url, "/js/main.js");
  assert.equal(plain.headers["content-encoding"], undefined);
  assert.equal(plain.body.toString("utf8"), script);
  for (const [encoding, decode] of [
    ["br", brotliDecompressSync],
    ["gzip", gunzipSync],
  ]) {
    // The second read is served from the kept compressed form.
    for (let read = 0; read < 2; read += 1) {
      const encoded = await raw(web.url, "/js/main.js", {
        "accept-encoding": encoding,
      });
      assert.equal(encoded.headers["content-encoding"], encoding);
      assert.equal(encoded.headers.vary, "accept-encoding");
      assert.equal(Number(encoded.headers["content-length"]), encoded.body.length);
      assert.ok(encoded.body.length < script.length / 20);
      assert.equal(decode(encoded.body).toString("utf8"), script);
    }
  }
  // Images are already compressed.
  const image = await raw(web.url, "/logo.png", { "accept-encoding": "br" });
  assert.equal(image.headers["content-encoding"], undefined);
  assert.equal(image.body.length, 4096);
});
