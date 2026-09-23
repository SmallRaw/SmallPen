import {
  app,
  BrowserWindow,
  dialog,
  Menu,
  session,
  utilityProcess,
} from "electron";
import { existsSync } from "node:fs";
import { realpath, stat, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  desktopAction,
  navigationAllowed,
  windowPreferences,
} from "./electron-policy.mjs";

const started = performance.now();
const args = process.argv.slice(app.isPackaged ? 1 : 2);
const smoke = args.includes("--smoke") || args.includes("--smoke-home");
const windows = new Map();
const pendingPaths = [];
let ready;
let service;
let serviceStopped = false;
let quitting = false;
let choosing = false;
const opening = new Map();

if (smoke) {
  if (!process.env.SMALLPEN_SMOKE_PROFILE || !process.env.SMALLPEN_SMOKE_REPORT)
    throw new Error("Smoke tests require a disposable profile and report path");
  app.setPath("userData", process.env.SMALLPEN_SMOKE_PROFILE);
}
if (!app.requestSingleInstanceLock()) app.exit(0);

function fail(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (smoke) {
    void writeFile(
      process.env.SMALLPEN_SMOKE_REPORT,
      JSON.stringify({ status: "error", message }),
    ).finally(() => app.exit(1));
  } else dialog.showErrorBox("SmallPen", message);
}

async function request(action, body) {
  const response = await fetch(
    new URL(`/desktop/${action}-package`, ready.url),
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    },
  );
  if (!response.ok)
    throw new Error(`Unable to ${action} package (${response.status})`);
  return response.json();
}

async function openPackage(rawPath, action = "open", home) {
  const path = resolve(rawPath);
  if (!path.toLowerCase().endsWith(".smallpen"))
    throw new Error("Choose a .smallpen package");
  if (action === "create" && existsSync(path))
    throw new Error("Choose a new path; existing files are never replaced");
  if (action === "open" && !(await stat(path)).isDirectory())
    throw new Error("A .smallpen package must be a directory");
  const locator = action === "open" ? await realpath(path) : path;
  if (opening.has(locator)) return opening.get(locator);
  for (const [window, binding] of windows) {
    if (binding?.locator === locator) {
      window.show();
      window.focus();
      return window;
    }
  }
  const operation = request(action, { locator }).then(async (result) => {
    if (!navigationAllowed(result.url, new URL(ready.url).origin))
      throw new Error("Invalid workspace URL from local host");
    // Reuse only an unbound Home window. Never replace another package's session.
    if (home && windows.has(home) && !windows.get(home)) {
      windows.set(home, { locator, url: result.url });
      await home.loadURL(result.url);
      return home;
    }
    return openWindow(result.url, { locator, url: result.url });
  });
  opening.set(locator, operation);
  try {
    return await operation;
  } finally {
    opening.delete(locator);
  }
}

async function choose(action, window = BrowserWindow.getFocusedWindow()) {
  if (choosing) return;
  choosing = true;
  try {
    if (action === "open") {
      const result = await dialog.showOpenDialog(...(window ? [window] : []), {
        title: "Open SmallPen package",
        properties: ["openDirectory", "treatPackageAsDirectory"],
      });
      if (!result.canceled)
        await openPackage(result.filePaths[0], "open", window);
    } else {
      const result = await dialog.showSaveDialog(...(window ? [window] : []), {
        title: "New SmallPen package",
        defaultPath: "Untitled.smallpen",
      });
      if (!result.canceled && result.filePath) {
        const path = result.filePath.toLowerCase().endsWith(".smallpen")
          ? result.filePath
          : `${result.filePath}.smallpen`;
        await openPackage(path, "create", window);
      }
    }
  } finally {
    choosing = false;
  }
}

function openWindow(url, binding) {
  const origin = new URL(ready.url).origin;
  const window = new BrowserWindow({
    title: "SmallPen",
    width: 1440,
    height: 960,
    minWidth: 800,
    minHeight: 600,
    show: false,
    backgroundColor: "#18191b",
    webPreferences: windowPreferences,
  });
  windows.set(window, binding);
  window.once("ready-to-show", () => window.show());
  window.webContents.on("will-navigate", (event) => {
    const target = event.url;
    if (navigationAllowed(target, origin)) return;
    event.preventDefault();
    const action =
      event.initiator === window.webContents.mainFrame
        ? desktopAction(target, window.webContents.getURL(), origin)
        : undefined;
    if (action) void choose(action, window).catch(fail);
  });
  window.webContents.on("will-frame-navigate", (event) => {
    if (!event.isMainFrame && !navigationAllowed(event.url, origin))
      event.preventDefault();
  });
  window.webContents.on("will-redirect", (event) => {
    if (!navigationAllowed(event.url, origin)) event.preventDefault();
  });
  window.webContents.on("will-attach-webview", (event) =>
    event.preventDefault(),
  );
  window.webContents.setWindowOpenHandler(({ url: target }) => {
    if (navigationAllowed(target, origin)) openWindow(target);
    return { action: "deny" };
  });
  window.webContents.on("render-process-gone", (_event, details) => {
    if (!quitting && details.reason !== "clean-exit")
      fail(new Error(`Workspace stopped: ${details.reason}`));
  });
  // Recent files can enter a workspace without a native Open dialog.
  window.webContents.on(
    "did-navigate-in-page",
    (_event, target, isMainFrame) => {
      if (!isMainFrame || !navigationAllowed(target, origin)) return;
      const url = new URL(target);
      if (!url.hash.startsWith("#/workspace?")) return;
      const fileId = new URLSearchParams(url.hash.split("?")[1]).get("file-id");
      if (!fileId) return;
      const previous = windows.get(window);
      const previousId =
        previous &&
        new URLSearchParams(new URL(previous.url).hash.split("?")[1]).get(
          "file-id",
        );
      if (previousId === fileId) return;
      windows.set(window, { url: target });
      if (previous) void request("close", { url: previous.url }).catch(fail);
    },
  );
  window.once("closed", () => {
    const original = windows.get(window);
    windows.delete(window);
    if (original && !quitting)
      void request("close", { url: original.url }).catch(fail);
  });
  void window.loadURL(url).catch(fail);
  return window;
}

async function smokeCheck(window, ui) {
  const selector =
    ui === "home"
      ? '[data-testid="smallpen-home"]'
      : "#workspace .viewport, .workspace .viewport, .viewport";
  const deadline = Date.now() + 90000;
  while (Date.now() < deadline) {
    if (window.isDestroyed())
      throw new Error("Smoke window closed before readiness");
    const loaded = await window.webContents
      .executeJavaScript(
        `Boolean(document.querySelector(${JSON.stringify(selector)}))`,
      )
      .catch(() => false);
    if (loaded) {
      const startupMs = Math.round(performance.now() - started);
      // Sample after load, with no permanent polling in production.
      await new Promise((resolveWait) => setTimeout(resolveWait, 3000));
      const metrics = app
        .getAppMetrics()
        .map(({ type, cpu, memory }) => ({ type, cpu, memory }));
      await writeFile(
        process.env.SMALLPEN_SMOKE_REPORT,
        JSON.stringify(
          {
            status: "ready",
            ui,
            startupMs,
            metrics,
            servicePid: service.pid,
            url: ready.url,
          },
          null,
          2,
        ),
      );
      app.quit();
      return;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for ${ui}`);
}

app.on("open-file", (event, path) => {
  event.preventDefault();
  if (ready) void openPackage(path).catch(fail);
  else pendingPaths.push(path);
});
app.on("second-instance", (_event, argv) => {
  const paths = argv.filter(
    (arg) => !arg.startsWith("-") && arg.toLowerCase().endsWith(".smallpen"),
  );
  if (!ready) pendingPaths.push(...paths);
  else if (paths.length) {
    for (const path of paths) void openPackage(path).catch(fail);
  } else {
    const window = [...windows.keys()][0] ?? (ready && openWindow(ready.url));
    window?.show();
    window?.focus();
  }
});
app.on("window-all-closed", () => {
  if (process.platform !== "darwin" || smoke) app.quit();
});
app.on("activate", () => {
  if (ready && windows.size === 0) openWindow(ready.url);
});
app.on("will-quit", (event) => {
  if (!service || serviceStopped || quitting) return;
  event.preventDefault();
  quitting = true;
  const timer = setTimeout(() => {
    service.kill();
    app.exit(1);
  }, 5000);
  service.once("exit", () => {
    clearTimeout(timer);
    app.exit(0);
  });
  service.postMessage("close");
});

await app.whenReady();
try {
  const frontend = app.isPackaged
    ? join(process.resourcesPath, "frontend", "resources", "public")
    : fileURLToPath(
        new URL("../../../../../frontend/resources/public", import.meta.url),
      );
  service = utilityProcess.fork(
    fileURLToPath(new URL("./electron-service.mjs", import.meta.url)),
    [frontend],
    {
      serviceName: "SmallPen local service",
      stdio: "pipe",
    },
  );
  service.stderr?.on("data", (chunk) => process.stderr.write(chunk));
  service.stdout?.on("data", (chunk) => process.stdout.write(chunk));
  service.on("exit", (code) => {
    serviceStopped = true;
    if (!quitting) {
      fail(new Error(`Local service stopped (${code})`));
      app.quit();
    }
  });
  ready = await new Promise((resolveReady, reject) => {
    const timer = setTimeout(
      () => reject(new Error("Local service startup timed out")),
      30000,
    );
    service.once("message", (message) => {
      clearTimeout(timer);
      resolveReady(message);
    });
    service.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Local service failed to start"));
    });
  });
  const origin = new URL(ready.url).origin;
  if (!/^http:\/\/127\.0\.0\.1:\d+$/.test(origin))
    throw new Error("Local service returned a non-loopback URL");
  session.defaultSession.setPermissionCheckHandler(() => false);
  session.defaultSession.setPermissionRequestHandler(
    (_contents, _permission, callback) => callback(false),
  );
  session.defaultSession.on("will-download", (event, item, contents) => {
    const target = item.getURL();
    if (
      !contents ||
      !navigationAllowed(contents.getURL(), origin) ||
      !(
        navigationAllowed(target, origin) ||
        target.startsWith(`blob:${origin}/`)
      )
    ) {
      event.preventDefault();
      return;
    }
    item.setSaveDialogOptions({
      defaultPath: basename(item.getFilename()).replaceAll("\\", "_"),
    });
  });
  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      ...(process.platform === "darwin" ? [{ role: "appMenu" }] : []),
      {
        label: "File",
        submenu: [
          {
            label: "New Package",
            accelerator: "CmdOrCtrl+N",
            click: () => void choose("create").catch(fail),
          },
          {
            label: "Open Package",
            accelerator: "CmdOrCtrl+O",
            click: () => void choose("open").catch(fail),
          },
          { role: "close" },
          ...(process.platform === "darwin" ? [] : [{ role: "quit" }]),
        ],
      },
      { role: "editMenu" },
      {
        label: "View",
        submenu: [{ role: "reload" }, { role: "togglefullscreen" }],
      },
    ]),
  );
  pendingPaths.push(
    ...args.filter(
      (arg) => !arg.startsWith("-") && arg.toLowerCase().endsWith(".smallpen"),
    ),
  );
  let initial;
  for (const path of pendingPaths) initial = await openPackage(path);
  if (!initial) initial = openWindow(ready.url);
  if (smoke) {
    if (args.includes("--smoke") && !pendingPaths.length)
      throw new Error("--smoke requires a package path");
    await smokeCheck(
      initial,
      args.includes("--smoke-home") ? "home" : "penpot",
    );
  }
} catch (error) {
  fail(error);
  if (!smoke) app.quit();
}
