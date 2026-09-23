import { startDesktopHost } from "./host.mjs";

// One shared Node-capable utility process; no extra Node executable or renderer.
const host = await startDesktopHost({
  frontendRoot: process.argv[2],
  applicationStatePath:
    process.env.SMALLPEN_APPLICATION_STATE_PATH || undefined,
});
process.parentPort.on("message", async ({ data }) => {
  if (data !== "close") return;
  await host.close();
  process.exit(0);
});
process.parentPort.postMessage({ status: "ready", url: host.url });
