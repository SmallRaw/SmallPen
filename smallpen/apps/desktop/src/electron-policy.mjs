import { resolve } from "node:path";

export const windowPreferences = Object.freeze({
  sandbox: true,
  contextIsolation: true,
  nodeIntegration: false,
  nodeIntegrationInWorker: false,
  nodeIntegrationInSubFrames: false,
  webviewTag: false,
  webSecurity: true,
  allowRunningInsecureContent: false,
  backgroundThrottling: true,
});

export function navigationAllowed(raw, origin) {
  try {
    const url = new URL(raw);
    return (
      url.origin === origin &&
      url.protocol === "http:" &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

export function desktopAction(raw, source, origin) {
  if (!navigationAllowed(source, origin)) return undefined;
  try {
    const url = new URL(raw);
    if (
      url.protocol !== "smallpen:" ||
      url.username ||
      url.password ||
      url.port ||
      (url.pathname && url.pathname !== "/") ||
      url.search ||
      url.hash
    )
      return undefined;
    return ["open", "create"].includes(url.hostname) ? url.hostname : undefined;
  } catch {
    return undefined;
  }
}

// Package paths from a command line. A second instance reports the directory
// it started in, so relative paths resolve against that, not our own cwd.
export function packagePathArguments(argv, workingDirectory) {
  return argv
    .filter(
      (arg) =>
        typeof arg === "string" &&
        !arg.startsWith("-") &&
        arg.toLowerCase().endsWith(".smallpen"),
    )
    .map((arg) =>
      workingDirectory ? resolve(workingDirectory, arg) : resolve(arg),
    );
}

export function workspaceFileId(raw) {
  try {
    const url = new URL(raw);
    let query;
    if (url.searchParams.get("screen") === "workspace") {
      query = url.searchParams;
    } else if (url.hash.startsWith("#/workspace?")) {
      // Legacy hash route, still emitted by older SmallPen builds.
      query = new URLSearchParams(url.hash.slice("#/workspace?".length));
    } else {
      return undefined;
    }
    return query.get("file-id") || undefined;
  } catch {
    return undefined;
  }
}
