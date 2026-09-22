import {
  defaultApplicationStatePath,
  serveLocalPackage,
} from "@smallpen/background";
import { servePenpotFrontend } from "@smallpen/web";

export async function startDesktopHost({
  applicationStatePath = defaultApplicationStatePath(),
  backgroundPort = 0,
  frontendRoot,
  host = "127.0.0.1",
  packagePath,
  webPort = 0,
}) {
  const background = await serveLocalPackage({
    applicationStatePath,
    host,
    packagePath,
    port: backgroundPort,
  });
  try {
    const web = await servePenpotFrontend({
      backendUrl: background.url,
      desktop: true,
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
      // The browser entry point may start at `/` and let the router redirect,
      // but the native shell needs a deterministic first paint. Loading the
      // explicit local Home route also avoids Penpot's unauthenticated root
      // bootstrap while no Package is open yet.
      url: web.workspaceUrl ?? new URL("#/smallpen", web.url).href,
      async close() {
        if (closed) return;
        closed = true;
        await web.close();
        await background.close();
      },
    };
  } catch (error) {
    await background.close();
    throw error;
  }
}
