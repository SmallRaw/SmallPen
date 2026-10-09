import {
  defaultApplicationStatePath,
  serveLocalPackage,
} from "@smallpen/background";
import { servePenpotFrontend } from "./server.mjs";

// Browser and Desktop share service startup, persistence and shutdown.
export async function startWebHost({
  applicationStatePath = defaultApplicationStatePath(),
  backgroundPort = 0,
  desktop = false,
  directoryRoot = process.cwd(),
  frontendRoot,
  host = "127.0.0.1",
  packagePath,
  webPort = 0,
} = {}) {
  const background = await serveLocalPackage({
    applicationStatePath,
    host,
    packagePath,
    port: backgroundPort,
  });
  try {
    const web = await servePenpotFrontend({
      backendUrl: background.url,
      desktop,
      directoryRoot,
      localFiles: !desktop,
      ...(frontendRoot ? { frontendRoot } : {}),
      host,
      port: webPort,
    });
    let closed = false;
    return {
      backgroundUrl: background.url,
      frontendRoot: web.frontendRoot,
      origin: web.origin,
      packageName: background.backend?.snapshot.manifest.name,
      packagePath: background.backend?.snapshot.locator,
      revision: background.backend?.snapshot.revision,
      url: web.workspaceUrl ?? new URL("?screen=smallpen-home", web.url).href,
      async close() {
        if (closed) return;
        closed = true;
        try {
          await web.close();
        } finally {
          await background.close();
        }
      },
    };
  } catch (error) {
    await background.close();
    throw error;
  }
}
