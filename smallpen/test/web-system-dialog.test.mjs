import assert from "node:assert/strict";
import test from "node:test";
import { chooseWithSystemDialog } from "../apps/web/src/system-dialog.mjs";

test("the system dialog runs on macOS and passes words only as arguments", async () => {
  for (const platform of ["linux", "win32"])
    assert.equal(
      await chooseWithSystemDialog("open", {
        platform,
        run: () => assert.fail("no dialog on this system"),
      }),
      undefined,
    );
  let call;
  const path = "/Users/me/设计 稿/App.smallpen";
  const result = await chooseWithSystemDialog("create", {
    chinese: true,
    directory: "/Users/me",
    platform: "darwin",
    run: async (file, args, options) => {
      call = { file, args, options };
      return `${encodeURIComponent(path)}\n`;
    },
  });
  assert.equal(result, path);
  assert.equal(call.file, "osascript");
  assert.deepEqual(call.args.slice(0, 3), ["-l", "JavaScript", "-e"]);
  assert.deepEqual(call.args.slice(4), [
    "create",
    "给新设计包起个名字",
    "新建",
    "/Users/me",
    "Untitled.smallpen",
  ]);
  assert.doesNotMatch(call.args[3], /Users|设计/);
});

test("the system dialog tells cancel, failure and a closed page apart", async () => {
  const mac = (run, signal) =>
    chooseWithSystemDialog("open", { platform: "darwin", run, signal });
  assert.equal(await mac(async () => "\n"), null);
  assert.equal(
    await mac(async () => {
      throw new Error("osascript failed");
    }),
    undefined,
  );
  assert.equal(await mac(async () => "%E0%A4%A\n"), undefined);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    mac(async () => {
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    }, controller.signal),
    { name: "AbortError" },
  );
  await assert.rejects(chooseWithSystemDialog("delete"), /Unknown file action/);
});
