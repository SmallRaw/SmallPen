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
