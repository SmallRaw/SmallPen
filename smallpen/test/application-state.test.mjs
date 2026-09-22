import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { LocalApplicationState } from "../apps/background/src/application-state.mjs";

test("local application preferences and recent packages persist outside Package data", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "smallpen-application-state-"));
  const statePath = join(directory, "state.json");
  context.after(() => rm(directory, { force: true, recursive: true }));
  const openedAt = [
    "2026-08-28T01:00:00.000Z",
    "2026-08-28T02:00:00.000Z",
    "2026-08-28T03:00:00.000Z",
  ];
  const application = await LocalApplicationState.open({
    now: () => openedAt.shift(),
    statePath,
  });

  await application.updatePreferences({
    language: "zh_hant",
    renderer: "wasm",
    theme: "system",
  });
  await application.recordPackage({
    locator: "/tmp/first.smallpen",
    name: "First",
    packageId: "pkg_first",
    role: "foundation",
  });
  await application.recordPackage({
    locator: "/tmp/second.smallpen",
    name: "Second",
    packageId: "pkg_second",
    role: "product",
  });
  await application.recordPackage({
    locator: "/tmp/first.smallpen",
    name: "First renamed",
    packageId: "pkg_first",
    role: "foundation",
  });

  const restored = await LocalApplicationState.open({ statePath });
  assert.deepEqual(restored.preferences, {
    language: "zh_hant",
    renderer: "wasm",
    theme: "system",
  });
  assert.deepEqual(restored.recentPackages, [
    {
      lastOpenedAt: "2026-08-28T03:00:00.000Z",
      locator: "/tmp/first.smallpen",
      name: "First renamed",
      packageId: "pkg_first",
      role: "foundation",
    },
    {
      lastOpenedAt: "2026-08-28T02:00:00.000Z",
      locator: "/tmp/second.smallpen",
      name: "Second",
      packageId: "pkg_second",
      role: "product",
    },
  ]);
});

test("local application preferences reject unsupported values without mutation", async () => {
  const application = await LocalApplicationState.open();

  await assert.rejects(
    application.updatePreferences({ language: "../../not-a-locale" }),
    (error) => error?.code === "invalid_application_preferences",
  );
  await assert.rejects(
    application.updatePreferences({ theme: "remote" }),
    (error) => error?.code === "invalid_application_preferences",
  );
  await assert.rejects(
    application.updatePreferences({ renderer: "canvas-2d" }),
    (error) => error?.code === "invalid_application_preferences",
  );
  assert.deepEqual(application.preferences, {
    language: "",
    renderer: "svg",
    theme: "dark",
  });
});

test("independent application state instances merge concurrent writes", async (context) => {
  const directory = await mkdtemp(join(tmpdir(), "smallpen-application-state-race-"));
  const statePath = join(directory, "state.json");
  context.after(() => rm(directory, { force: true, recursive: true }));
  const first = await LocalApplicationState.open({ statePath });
  const second = await LocalApplicationState.open({ statePath });

  await Promise.all([
    first.recordPackage({
      locator: "/tmp/first.smallpen",
      name: "First",
      packageId: "pkg_first",
      role: "foundation",
    }),
    second.recordPackage({
      locator: "/tmp/second.smallpen",
      name: "Second",
      packageId: "pkg_second",
      role: "product",
    }),
  ]);

  const restored = await LocalApplicationState.open({ statePath });
  assert.deepEqual(
    new Set(restored.recentPackages.map(({ locator }) => locator)),
    new Set(["/tmp/first.smallpen", "/tmp/second.smallpen"]),
  );
});

test("an empty application state lock directory is recoverable", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "smallpen-app-state-empty-lock-"));
  const statePath = join(parent, "state.json");
  const lockPath = join(parent, ".state.json.write-lock");
  context.after(() => rm(parent, { force: true, recursive: true }));
  await mkdir(lockPath, { recursive: true });
  const first = await LocalApplicationState.open({ statePath });
  const second = await LocalApplicationState.open({ statePath });

  await Promise.all([
    first.recordPackage({
      locator: "/tmp/first.smallpen",
      name: "First",
      packageId: "pkg_first",
      role: "foundation",
    }),
    second.recordPackage({
      locator: "/tmp/second.smallpen",
      name: "Second",
      packageId: "pkg_second",
      role: "product",
    }),
  ]);

  const restored = await LocalApplicationState.open({ statePath });
  assert.deepEqual(
    new Set(restored.recentPackages.map(({ locator }) => locator)),
    new Set(["/tmp/first.smallpen", "/tmp/second.smallpen"]),
  );
});

test("a malformed application state lock owner is recoverable", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "smallpen-app-state-bad-lock-"));
  const statePath = join(parent, "state.json");
  const lockPath = join(parent, ".state.json.write-lock");
  const ownerPath = join(lockPath, "owner.json");
  context.after(() => rm(parent, { force: true, recursive: true }));
  await mkdir(lockPath, { recursive: true });
  await writeFile(ownerPath, "not-json", "utf8");
  const stale = new Date(Date.now() - 60_000);
  await utimes(ownerPath, stale, stale);
  const application = await LocalApplicationState.open({ statePath });

  const updated = await application.updatePreferences({ theme: "light" });

  assert.equal(updated.preferences.theme, "light");
});

test("concurrent state writers atomically replace one stale owner", async (context) => {
  const parent = await mkdtemp(join(tmpdir(), "smallpen-app-state-stale-race-"));
  const statePath = join(parent, "state.json");
  const lockPath = join(parent, ".state.json.write-lock");
  const ownerPath = join(lockPath, "owner.json");
  context.after(() => rm(parent, { force: true, recursive: true }));
  await mkdir(lockPath, { recursive: true });
  await writeFile(
    ownerPath,
    JSON.stringify({
      createdAt: "2026-01-01T00:00:00.000Z",
      pid: 2147483647,
      processIdentity: "stale",
      token: "stale-owner",
    }),
    "utf8",
  );
  const first = await LocalApplicationState.open({ statePath });
  const second = await LocalApplicationState.open({ statePath });

  await Promise.all([
    first.recordPackage({
      locator: "/tmp/first.smallpen",
      name: "First",
      packageId: "pkg_first",
      role: "foundation",
    }),
    second.recordPackage({
      locator: "/tmp/second.smallpen",
      name: "Second",
      packageId: "pkg_second",
      role: "product",
    }),
  ]);

  const restored = await LocalApplicationState.open({ statePath });
  assert.deepEqual(
    new Set(restored.recentPackages.map(({ locator }) => locator)),
    new Set(["/tmp/first.smallpen", "/tmp/second.smallpen"]),
  );
});
