import assert from "node:assert/strict";
import test from "node:test";
import {
  navigationAllowed,
  desktopAction,
  windowPreferences,
} from "../apps/desktop/src/electron-policy.mjs";

const origin = "http://127.0.0.1:12345";
test("desktop navigation stays on its exact local origin", () => {
  assert.equal(navigationAllowed(`${origin}/#/workspace`, origin), true);
  for (const url of [
    "https://example.com",
    "file:///etc/passwd",
    "http://127.0.0.1:12346",
    "http://127.0.0.1.evil.test:12345",
    "javascript:alert(1)",
    "not a URL",
    `http://user@127.0.0.1:12345/`,
  ]) {
    assert.equal(navigationAllowed(url, origin), false, url);
  }
});
test("only exact native actions from the local main frame are accepted", () => {
  assert.equal(
    desktopAction("smallpen://open", `${origin}/#/smallpen`, origin),
    "open",
  );
  assert.equal(
    desktopAction("smallpen://create", `${origin}/#/smallpen`, origin),
    "create",
  );
  for (const url of [
    "smallpen://open?path=/secret",
    "smallpen://open/extra",
    "smallpen://delete",
    "smallpen://user@open",
    "smallpen://open#x",
  ]) {
    assert.equal(desktopAction(url, origin, origin), undefined, url);
  }
  assert.equal(
    desktopAction("smallpen://open", "https://example.com", origin),
    undefined,
  );
});
test("web renderer has sandboxing but no Node, preload, or webview bridge", () => {
  assert.equal(windowPreferences.sandbox, true);
  assert.equal(windowPreferences.contextIsolation, true);
  assert.equal(windowPreferences.nodeIntegration, false);
  assert.equal(windowPreferences.webviewTag, false);
  assert.equal(windowPreferences.webSecurity, true);
  assert.equal(windowPreferences.backgroundThrottling, true);
  assert.equal(windowPreferences.preload, undefined);
});
